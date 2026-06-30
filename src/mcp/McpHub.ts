import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  BlobResourceContents,
  CallToolResult,
  CallToolResultSchema,
  Implementation,
  ListToolsResultSchema,
  Resource,
  ResourceListChangedNotificationSchema,
  ResourceTemplate,
  ResourceUpdatedNotificationSchema,
  TextResourceContents,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import _ from 'lodash';
import treeKill from 'tree-kill';

import { McpAuthOutcome } from '@industry/drool-sdk-ext/protocol/drool';
import { Metrics } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';
import { toError } from '@industry/utils/errors';
import { canonicalizeMcpServerNameMap } from '@industry/utils/mcp';

import { initializeHttpClient } from '@/mcp/clients/http';
import { McpRemoteTransport } from '@/mcp/clients/http/enums';
import { initializeStdioClient } from '@/mcp/clients/stdio';
import {
  MCP_CALL_TOOL_TIMEOUT_MS,
  MCP_SERVER_KILL_GRACE_MS,
} from '@/mcp/constants';
import { CallToolCaller, MCPNotificationMethods } from '@/mcp/enums';
import { resolveMcpSecretReferences } from '@/mcp/resolveMcpSecretReferences';
import { MCPServerNotification, ResourceChange } from '@/mcp/schema';
import {
  GetOAuthDriver,
  ILogger,
  McpReloadResult,
  McpReloadServerSettleCallback,
  McpSubserver,
} from '@/mcp/types';
import { formatToolName, isTextResourceContents } from '@/mcp/utils';
import type { McpAuthCompletedInfo } from '@/services/mcp/types';

import type { McpServerConfig } from '@industry/common/settings';

const isProcessRunning = (pid: number): boolean => {
  try {
    // Signal 0 checks whether a PID is reachable without actually terminating it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
    return code === 'EPERM';
  }
};

const getTransportPid = (transport: Transport): number | null => {
  if (!('pid' in transport)) {
    return null;
  }

  const pidValue = transport.pid;
  if (typeof pidValue !== 'number' || pidValue <= 0) {
    return null;
  }

  return pidValue;
};

function isMissingSchemaReferenceError(error: unknown): error is Error {
  return (
    error instanceof Error && error.message.includes("can't resolve reference")
  );
}

function createNullPrototypeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Aggregates multiple MCP servers into a single server-like instance.
 *
 * Emits events following the MCPServerNotificationSchema
 */
export class McpHub {
  private logger?: ILogger;

  private clientInfo?: Implementation;

  private getOAuthDriver?: GetOAuthDriver;

  private onAuthFlowCompleted?: (params: McpAuthCompletedInfo) => void;

  /** Default MCP servers independent of the user config, such as our own CLI MCP server. */
  private systemMcpConfigs: Record<string, McpServerConfig> =
    createNullPrototypeRecord();

  /** User-provided configs (only envs provided by user included), keyed by server name. */
  private userMcpConfigs: Record<string, McpServerConfig> =
    createNullPrototypeRecord();

  /** Track the clients and transports for running servers. */
  private servers: Record<string, McpSubserver> = createNullPrototypeRecord();

  /**
   * Track the resources available on each server. Updated on each call to `listResourcesForServer`.
   * serverName --> resourceUri --> resource
   */
  private availableResources: Record<string, Record<string, Resource>> =
    createNullPrototypeRecord();

  /**
   * Track notification callbacks registered by clients to instruct the McpHub how to push notifications to them.
   */
  private clientNotifiers: Record<
    string,
    (notification: MCPServerNotification) => Promise<void>
  > = {};

  /**
   * Track the client connections that are subscribed to each resource
   * serverName --> resourceUri --> client ID
   */
  private clientResourceSubscriptions: Record<
    string,
    Record<string, Set<string>>
  > = createNullPrototypeRecord();

  constructor({
    systemMcpConfigs = {},
    userMcpConfigs = {},
    logger,
    clientInfo,
    getOAuthDriver,
    onAuthFlowCompleted,
  }: {
    systemMcpConfigs?: Record<string, McpServerConfig>;
    userMcpConfigs?: Record<string, McpServerConfig>;
    logger?: ILogger;
    clientInfo?: Implementation;
    getOAuthDriver?: GetOAuthDriver;
    onAuthFlowCompleted?: (params: McpAuthCompletedInfo) => void;
  }) {
    this.systemMcpConfigs = canonicalizeMcpServerNameMap(systemMcpConfigs);
    this.userMcpConfigs = canonicalizeMcpServerNameMap(userMcpConfigs);
    this.logger = logger;
    this.clientInfo = clientInfo;
    this.getOAuthDriver = getOAuthDriver;
    this.onAuthFlowCompleted = onAuthFlowCompleted;
  }

  getServers(): Record<string, McpSubserver> {
    return this.servers;
  }

  getUserMcpConfigs(): Record<string, McpServerConfig> {
    return this.userMcpConfigs;
  }

  /** Update the user MCP configurations. Reloads the servers. */
  async setUserMcpConfigs(
    newConfigs: Record<string, McpServerConfig>
  ): Promise<McpReloadResult> {
    this.userMcpConfigs = canonicalizeMcpServerNameMap(newConfigs);
    return await this.reloadServers();
  }

  /** Update the user MCP configurations without reloading servers. */
  setUserMcpConfigsWithoutReload(
    newConfigs: Record<string, McpServerConfig>
  ): void {
    this.userMcpConfigs = canonicalizeMcpServerNameMap(newConfigs);
  }

  /**
   * Reload MCP servers based on the current configuration.
   *
   * If `force` is true, all servers will be reloaded regardless of their current state.
   * Otherwise, only servers with changed configurations will be reloaded.
   *
   * Stops currently running servers that are no longer part of the configuration.
   *
   * If `onServerSettled` is provided, it will be awaited once per server as it
   * finishes its stop or start attempt. Callers can use this to push incremental
   * state updates without waiting for the whole reload to complete, which matters
   * when one server (e.g. a stalled remote host) takes far longer than the others.
   * */
  async reloadServers(opts?: {
    force?: boolean;
    excludeSystem?: boolean;
    onServerSettled?: McpReloadServerSettleCallback;
  }): Promise<McpReloadResult> {
    const onServerSettled = opts?.onServerSettled;
    const notifySettled = async (
      event: Parameters<McpReloadServerSettleCallback>[0]
    ): Promise<void> => {
      if (!onServerSettled) {
        return;
      }
      try {
        await onServerSettled(event);
      } catch (error) {
        this.logger?.error('onServerSettled callback threw', {
          error,
          server: event.serverName,
          phase: event.phase,
        });
      }
    };
    const erroredServers = new Set<string>();
    const startErroredServers = new Set<string>();
    const stopErroredServers = new Set<string>();
    const unchangedServers = new Set<string>();
    const serverErrors = new Map<string, Error>();

    // Calculate the servers that need to be stopped. Unless `force` is true, these are servers
    // that are no longer part of the configuration or servers with updated configs
    const serversToStop = Object.entries(this.servers).filter(
      ([serverName, { config }]) => {
        if (opts?.force) {
          return true;
        }

        if (
          serverName in this.systemMcpConfigs &&
          _.isEqual(config, this.systemMcpConfigs[serverName])
        ) {
          // Existing system server that hasn't been updated
          unchangedServers.add(serverName);
          return false;
        }

        if (
          serverName in this.userMcpConfigs &&
          _.isEqual(config, this.userMcpConfigs[serverName])
        ) {
          // Existing user server that hasn't been updated
          unchangedServers.add(serverName);
          return false;
        }

        return true;
      }
    );

    this.logger?.info(`Stopping stale MCP servers...`, {
      servers: serversToStop.map(([name]) => name),
    });
    await Promise.all(
      serversToStop.map(async ([serverName]) => {
        try {
          await this.removeServer(serverName);
          await notifySettled({
            phase: 'stop',
            serverName,
            success: true,
          });
        } catch (error) {
          this.logger?.error(`Error stopping MCP server`, {
            error,
            server: serverName,
          });
          erroredServers.add(serverName);
          stopErroredServers.add(serverName);
          const wrapped = toError(error);
          serverErrors.set(serverName, wrapped);
          await notifySettled({
            phase: 'stop',
            serverName,
            success: false,
            error: wrapped,
          });
        }
      })
    );

    // Start all configured servers that are not already running.
    const serversToStart = Object.entries({
      ...this.systemMcpConfigs,
      ...this.userMcpConfigs,
    }).filter(([serverName]) => !(serverName in this.servers));
    this.logger?.info(`Starting new MCP servers...`, {
      servers: serversToStart.map(([name]) => name),
    });

    // Separate remote and stdio servers
    const remoteServersToStart = serversToStart.filter(
      ([, config]) => config.type === 'http' || config.type === 'sse'
    );
    const stdioServersToStart = serversToStart.filter(
      ([, config]) => config.type !== 'http' && config.type !== 'sse'
    );

    // Start remote servers sequentially to avoid OAuth callback conflicts
    // (multiple OAuth flows can't share the same callback server simultaneously)
    for (const [serverName, config] of remoteServersToStart) {
      try {
        await this.addServer(serverName, config);
        await notifySettled({
          phase: 'start',
          serverName,
          success: true,
        });
      } catch (error) {
        this.logger?.warn(`Error starting MCP server`, {
          error,
          server: serverName,
        });
        erroredServers.add(serverName);
        startErroredServers.add(serverName);
        const wrapped = toError(error);
        serverErrors.set(serverName, wrapped);
        await notifySettled({
          phase: 'start',
          serverName,
          success: false,
          error: wrapped,
        });
      }
    }

    // Start stdio servers in parallel (no OAuth conflicts)
    await Promise.all(
      stdioServersToStart.map(async ([serverName, config]) => {
        try {
          await this.addServer(serverName, config);
          await notifySettled({
            phase: 'start',
            serverName,
            success: true,
          });
        } catch (error) {
          this.logger?.warn(`Error starting MCP server`, {
            error,
            server: serverName,
          });
          erroredServers.add(serverName);
          startErroredServers.add(serverName);
          const wrapped = toError(error);
          serverErrors.set(serverName, wrapped);
          await notifySettled({
            phase: 'start',
            serverName,
            success: false,
            error: wrapped,
          });
        }
      })
    );

    const result: McpReloadResult = {
      stoppedServers: serversToStop
        .map(([name]) => name)
        .filter((name) => !erroredServers.has(name)),
      startedServers: serversToStart
        .map(([name]) => name)
        .filter((name) => !erroredServers.has(name)),
      erroredServers: Array.from(erroredServers),
      unchangedServers: Array.from(unchangedServers),
      serverErrors,
      startAttempts: serversToStart.length,
      stopAttempts: serversToStop.length,
      startErrors: startErroredServers.size,
      stopErrors: stopErroredServers.size,
    };

    // Broadcast updated tools to all clients.
    if (serversToStop.length === 0 && serversToStart.length === 0) {
      return result;
    }

    try {
      const tools = await this.listAllTools();
      const prefixedTools = Object.entries(tools).flatMap(
        ([serverName, serverTools]) =>
          serverTools.map((tool) => ({
            ...tool,
            name: formatToolName(serverName, tool.name),
          }))
      );

      this.logger?.info('Sending toolsChange notification to all clients', {
        toolCount: prefixedTools.length,
        toolNames: prefixedTools.map((tool) => tool.name),
      });

      // Send notifications to all clients
      await this.notifyAll({
        method: MCPNotificationMethods.ToolsChange,
        params: {
          tools: prefixedTools,
        },
      });
    } catch (error) {
      this.logger?.error('Failed to broadcast toolsChange notification', {
        error,
      });
    }

    return result;
  }

  private async unsubscribeClientFromResource(
    assemblySessionId: string,
    serverName: string,
    uri: string
  ) {
    const logger = this.logger?.child({ clientId: assemblySessionId });
    if (
      !this.clientResourceSubscriptions[serverName] ||
      !this.clientResourceSubscriptions[serverName][uri] ||
      !this.clientResourceSubscriptions[serverName][uri].has(assemblySessionId)
    ) {
      logger?.warn(
        `Client ${assemblySessionId} not subscribed to resource ${uri}`
      );
      return;
    }

    this.clientResourceSubscriptions[serverName][uri].delete(assemblySessionId);
    logger?.info(`Unsubscribed client from resource ${uri}`);

    // If no more subscribers, clean up
    if (this.clientResourceSubscriptions[serverName][uri].size === 0) {
      logger?.info(`No more subscribers for ${serverName}:${uri}, cleaning up`);
      await this.unsubscribeFromServerResource(serverName, uri);

      // Remove the empty set
      delete this.clientResourceSubscriptions[serverName][uri];
    }

    // Clean up empty server entries
    if (
      Object.keys(this.clientResourceSubscriptions[serverName]).length === 0
    ) {
      delete this.clientResourceSubscriptions[serverName];
    }
  }

  /**
   * Register a client with the MCPHub so it knows how to communicate notifications back to them.
   */
  addClient(
    clientId: string,
    notifier: (notification: MCPServerNotification) => Promise<void>
  ) {
    this.clientNotifiers[clientId] = notifier;
  }

  /**
   * Un-registers a client with the McpHub, cleaning up resources associated with that client.
   */
  async removeClient(clientId: string): Promise<void> {
    const logger = this.logger?.child({ clientId });
    logger?.info(`Removing client`, { clientId });

    // Remove client notifier
    delete this.clientNotifiers[clientId];

    // Clean up client resource subscriptions
    await Promise.all(
      Object.keys(this.clientResourceSubscriptions).flatMap((serverName) =>
        Object.keys(this.clientResourceSubscriptions[serverName])
          .filter((resourceUri) =>
            this.clientResourceSubscriptions[serverName][resourceUri].has(
              clientId
            )
          )
          .map((resourceUri) =>
            this.unsubscribeClientFromResource(
              clientId,
              serverName,
              resourceUri
            )
          )
      )
    );

    logger?.info(`Completed cleanup for client`, { clientId });
  }

  async subscribeClientToResources({
    clientSessionId,
    resources,
  }: {
    clientSessionId: string;
    resources: { server: string; uri: string }[];
  }) {
    const logger = this.logger?.child({
      clientSessionId,
    });
    await Promise.all(
      resources.map(async ({ server: serverName, uri }) => {
        // Initialize subscription tracking structures if needed
        if (!this.clientResourceSubscriptions[serverName]) {
          this.clientResourceSubscriptions[serverName] =
            createNullPrototypeRecord();
        }
        if (!this.clientResourceSubscriptions[serverName][uri]) {
          this.clientResourceSubscriptions[serverName][uri] = new Set();
        }

        // If this is the first subscriber, the McpHub needs to subscribe to the resource so it can
        // receive notifications to forward to clients.
        const isFirstSubscriber =
          this.clientResourceSubscriptions[serverName][uri].size === 0;
        if (isFirstSubscriber) {
          logger?.info(
            `First subscription request for ${uri}. Requesting subscription from MCP server ${serverName}`
          );
          await this.subscribeToServerResource(serverName, uri);
          logger?.info(`Successfully subscribed self to MCP server resource`, {
            server: serverName,
            uri,
          });
        }

        this.clientResourceSubscriptions[serverName][uri].add(clientSessionId);
        logger?.info(`successfully subscribed client to resource`, {
          server: serverName,
          uri,
          clientId: clientSessionId,
        });
      })
    );
  }

  /** Initialize and connect to each of the configured MCP servers. */
  private async addServer(
    name: string,
    config: McpServerConfig
  ): Promise<void> {
    const start = performance.now();
    const serverKind =
      config.type === 'http' || config.type === 'sse' ? 'remote' : 'stdio';
    let outcome = 'success';

    try {
      const existingServer = this.servers[name];

      if (existingServer) {
        const trackedResources = Object.keys(
          this.availableResources[name] ?? {}
        );
        const trackedSubscriptions = Object.keys(
          this.clientResourceSubscriptions[name] ?? {}
        );

        // A stale server entry exists (e.g., from a failed removal during SSE disconnect).
        // Clean it up before proceeding to avoid leaving the hub in a broken state.
        this.logger?.warn(
          `Server "${name}" already exists in hub state; removing stale entry before re-adding`,
          {
            name,
            transportPid: getTransportPid(existingServer.transport),
            type: existingServer.config.type,
            trackedResourceCount: trackedResources.length,
            trackedSubscriptionCount: trackedSubscriptions.length,
          }
        );
        try {
          await this.removeServer(name);
        } catch (error) {
          // removeServer already guarantees cleanup of this.servers[name] in its finally block,
          // so we can safely proceed even if the removal itself had transport errors.
          this.logger?.warn(
            `Error removing stale server "${name}" (proceeding with add)`,
            {
              error,
              name,
              remainingServerEntry: Boolean(this.servers[name]),
            }
          );
        }
      }

      // Initialize client based on transport type
      let client: Client;
      let transport: Transport;

      if (config.type !== 'http' && config.type !== 'sse') {
        const configuredEnv = resolveMcpSecretReferences({
          serverName: name,
          values: config.env,
        });

        // Merge process.env with server-specific environment variables
        // This ensures the server inherits the current environment plus any custom variables
        const mergedEnv = {
          ...process.env,
          ...(configuredEnv ?? {}),
        };

        // Filter out undefined values and ensure all env values are strings
        const sanitizedEnv = mergedEnv
          ? Object.fromEntries(
              Object.entries(mergedEnv || {})
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => [k, String(v)])
            )
          : undefined;

        ({ client, transport } = await initializeStdioClient({
          serverArgs: {
            name,
            command: config.command,
            args: config.args ?? [],
            env: sanitizedEnv,
          },
          logger: this.logger?.child({ name }),
          clientInfo: this.clientInfo,
        }));
      } else {
        // config.type === 'http' || config.type === 'sse'
        const oauthDriver = this.getOAuthDriver?.(name, config);

        this.logger?.info('OAuth driver check', {
          name,
          hasOAuthDriver: !!oauthDriver,
          enableInteractiveAuth: oauthDriver?.enableInteractiveAuth ?? false,
        });

        ({ client, transport } = await initializeHttpClient({
          serverArgs: {
            name,
            url: config.url,
            headers: resolveMcpSecretReferences({
              serverName: name,
              values: config.headers,
            }),
          },
          transportKind:
            config.type === 'sse'
              ? McpRemoteTransport.Sse
              : McpRemoteTransport.StreamableHttp,
          logger: this.logger?.child({ name }),
          oauthDriver,
          clientInfo: this.clientInfo,
          onAuthFlowCompleted: (result: {
            outcome: McpAuthOutcome;
            message: string;
          }) => {
            this.onAuthFlowCompleted?.({ serverName: name, ...result });
          },
        }));
      }

      this.servers[name] = {
        name,
        config,
        client,
        transport,
      };

      // Initialize the resource list for this server
      this.availableResources[name] = createNullPrototypeRecord();

      // Forward notifications to Industry clients
      client.setNotificationHandler(
        ResourceUpdatedNotificationSchema,
        async (notification) => {
          this.logger?.info(
            `Received ResourceUpdatedNotification from MCP server`,
            { notification, server: name }
          );
          await this.handleResourceUpdate(name, notification.params.uri);
        }
      );

      client.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        async (notification) => {
          this.logger?.info(`Received ResourceListChanged from MCP server`, {
            notification,
            server: name,
          });

          // We have custom metadata in the CLI MCP server to communicate the assemblySessionId, so
          // use it if it exists.
          await this.handleResourceListChanged(
            name,
            notification.params?._meta?.assemblySessionId as string | undefined
          );
        }
      );
    } catch (error) {
      outcome = 'error';
      throw error;
    } finally {
      Metrics.addToCounter(
        Metric.MCP_SERVER_START_LATENCY_MS,
        performance.now() - start,
        { outcome, type: serverKind }
      );
    }
  }

  /**
   * Remove/stop a specific MCP server.
   * @param name - The name of the server to remove
   */
  async removeServer(name: string): Promise<void> {
    if (!this.servers[name]) {
      throw new MetaError('Server does not exist', { name });
    }

    const server = this.servers[name];
    const transport = server.transport;
    const transportPid = getTransportPid(transport);
    const transportErrors: unknown[] = [];
    let cleanupError: unknown;

    try {
      if (transport && typeof transport.close === 'function') {
        try {
          await transport.close();
          this.logger?.info(`Successfully stopped MCP server: ${name}`);
        } catch (error) {
          transportErrors.push(error);
        }

        if (transportPid !== null) {
          const shouldKill =
            transportErrors.length > 0 || isProcessRunning(transportPid);
          if (shouldKill) {
            await this.killServerProcessTree(transportPid, name);
          }
        }
      } else {
        this.logger?.warn(
          `Cannot stop MCP server ${name}: transport not available or missing close method`
        );
      }
    } catch (error) {
      transportErrors.push(error);
    } finally {
      // Always remove the server entry first to prevent "Server already exists" errors
      // during subsequent addServer/reload calls, even if subscription cleanup fails.
      delete this.servers[name];
      delete this.availableResources[name];

      try {
        // Clean up client resource subscriptions (best-effort)
        const subscriptions = this.clientResourceSubscriptions[name];
        if (subscriptions) {
          await Promise.all(
            Object.keys(subscriptions).flatMap((resourceUri) =>
              Array.from(subscriptions[resourceUri]).map((clientId) =>
                this.unsubscribeClientFromResource(clientId, name, resourceUri)
              )
            )
          );
        }
      } catch (error) {
        cleanupError = error;
        this.logger?.warn('Failed to cleanup MCP server state', {
          error: cleanupError,
          server: name,
        });
      }
    }

    const allErrors = cleanupError
      ? [...transportErrors, cleanupError]
      : transportErrors;

    if (allErrors.length > 0) {
      throw new AggregateError(
        allErrors,
        `Failed to remove MCP server: ${name}`
      );
    }
  }

  private async killServerProcessTree(
    pid: number,
    serverName: string
  ): Promise<void> {
    const sendSignal = async (
      signal: NodeJS.Signals
    ): Promise<NodeJS.ErrnoException | null> =>
      new Promise((resolve) => {
        treeKill(pid, signal, (error) => {
          resolve((error ?? null) as NodeJS.ErrnoException | null);
        });
      });

    const termError = await sendSignal('SIGTERM');
    if (termError) {
      if (termError.code === 'ESRCH' || termError.code === 'ENOENT') {
        this.logger?.debug('MCP server process already exited', {
          server: serverName,
          pid,
        });
        return;
      }

      this.logger?.warn('Failed to send SIGTERM to MCP server process', {
        server: serverName,
        pid,
        signal: 'SIGTERM',
        error: termError.message,
      });
    }

    const killGraceMs = MCP_SERVER_KILL_GRACE_MS;
    await new Promise((resolve) => {
      setTimeout(resolve, killGraceMs);
    });

    if (!isProcessRunning(pid)) {
      return;
    }

    this.logger?.warn(
      'MCP server still running after SIGTERM; sending SIGKILL',
      {
        server: serverName,
        pid,
        signal: 'SIGKILL',
        timeout: killGraceMs,
      }
    );

    const killError = await sendSignal('SIGKILL');
    if (killError) {
      if (killError.code === 'ESRCH' || killError.code === 'ENOENT') {
        this.logger?.debug('MCP server process already exited', {
          server: serverName,
          pid,
        });
      } else {
        this.logger?.warn('Failed to send SIGKILL to MCP server process', {
          server: serverName,
          pid,
          signal: 'SIGKILL',
          error: killError.message,
        });
      }
    }
  }

  /**
   * Close all MCP servers and clean up resources.
   * Should be called when shutting down the McpHub.
   */
  async closeAllServers(): Promise<void> {
    const serverNames = Object.keys(this.servers);
    if (serverNames.length === 0) {
      return;
    }

    this.logger?.info(`Closing all MCP servers...`, { servers: serverNames });

    await Promise.all(
      serverNames.map(async (serverName) => {
        try {
          await this.removeServer(serverName);
        } catch (error) {
          this.logger?.error(`Error closing MCP server`, {
            error,
            server: serverName,
          });
        }
      })
    );

    this.logger?.info(`All MCP servers closed`);
  }

  /**
   * Retry connecting to a specific MCP server.
   * Stops the server if it exists and restarts it.
   */
  async retryServer(name: string): Promise<void> {
    const config =
      this.userMcpConfigs[name] ?? this.systemMcpConfigs[name] ?? null;

    if (!config) {
      throw new MetaError('Server configuration not found', { name });
    }

    // Stop the server if it exists
    if (this.servers[name]) {
      this.logger?.info(`Stopping MCP server for retry: ${name}`);
      await this.removeServer(name);
    }

    // Restart the server
    this.logger?.info(`Restarting MCP server: ${name}`);
    await this.addServer(name, config);
  }

  async listToolsForServer(
    serverName: string,
    opts?: { includeDisabled?: boolean }
  ): Promise<Tool[]> {
    if (!this.servers[serverName]) {
      throw new MetaError('Server does not exist', { name: serverName });
    }
    let result: Awaited<ReturnType<Client['listTools']>>;
    try {
      result = await this.servers[serverName].client.listTools();
    } catch (error) {
      if (isMissingSchemaReferenceError(error)) {
        this.logger?.warn(
          'MCP server returned a tool with an unresolvable $ref; listing tools without output-schema cache',
          { server: serverName, error: error.message }
        );
        result = await this.servers[serverName].client.request(
          { method: 'tools/list' },
          ListToolsResultSchema
        );
      } else {
        throw error;
      }
    }
    if (!result.tools) {
      throw new MetaError('Server did not return tools', { name: serverName });
    }

    if (opts?.includeDisabled) {
      return result.tools;
    }

    // Filter out disabled tools based on config
    const config =
      this.userMcpConfigs[serverName] ?? this.systemMcpConfigs[serverName];
    const disabledTools = new Set(config?.disabledTools ?? []);
    return result.tools.filter((tool) => !disabledTools.has(tool.name));
  }

  async listAllTools(opts?: {
    includeDisabled?: boolean;
  }): Promise<Record<string, Tool[]>> {
    const serverNames = Object.keys(this.servers);
    const results = await Promise.allSettled(
      serverNames.map(async (serverName) => ({
        serverName,
        tools: await this.listToolsForServer(serverName, opts),
      }))
    );

    const toolsByServer: Record<string, Tool[]> = createNullPrototypeRecord();
    results.forEach((result, index) => {
      const serverName = serverNames[index];
      if (result.status === 'fulfilled') {
        toolsByServer[result.value.serverName] = result.value.tools;
      } else {
        this.logger?.error('Failed to list tools for MCP server', {
          server: serverName,
          error: result.reason,
        });
      }
    });

    return toolsByServer;
  }

  /** Fetch the list of resources for a specific server. */
  async listResourcesForServer(
    serverName: string,
    assemblySessionId?: string
  ): Promise<Resource[]> {
    if (!this.servers[serverName]) {
      throw new MetaError('Server does not exist', { name: serverName });
    }
    const result = await this.servers[serverName].client.listResources({
      _meta: { assemblySessionId },
    });
    if (!result.resources) {
      throw new MetaError('Server did not return resources', {
        name: serverName,
      });
    }

    const resourcesByUri = createNullPrototypeRecord<Resource>();
    for (const resource of result.resources) {
      resourcesByUri[resource.uri] = resource;
    }
    this.availableResources[serverName] = resourcesByUri;
    return result.resources;
  }

  async listAllResources(
    assemblySessionId?: string,
    servers?: string[]
  ): Promise<Record<string, Resource[]>> {
    const serversToQuery = servers || Object.keys(this.servers);
    serversToQuery.forEach((serverName) => {
      if (!this.servers[serverName]) {
        throw new MetaError('Server  does not exist', { name: serverName });
      }
    });
    const resourcesByServer = createNullPrototypeRecord<Resource[]>();
    const serverResources = await Promise.all(
      serversToQuery.map(
        async (serverName) =>
          [
            serverName,
            await this.listResourcesForServer(serverName, assemblySessionId),
          ] as const
      )
    );
    for (const [serverName, resources] of serverResources) {
      resourcesByServer[serverName] = resources;
    }
    return resourcesByServer;
  }

  async listResourceTemplatesForServer(
    serverName: string
  ): Promise<ResourceTemplate[]> {
    if (!this.servers[serverName]) {
      throw new MetaError('Server  does not exist', { name: serverName });
    }
    const result =
      await this.servers[serverName].client.listResourceTemplates();
    if (!result.resourceTemplates) {
      throw new MetaError('Server  did not return resource templates', {
        name: serverName,
      });
    }
    return result.resourceTemplates;
  }

  async listAllResourceTemplates(): Promise<
    Record<string, ResourceTemplate[]>
  > {
    const templatesByServer = createNullPrototypeRecord<ResourceTemplate[]>();
    const serverTemplates = await Promise.all(
      Object.keys(this.servers).map(
        async (name) =>
          [name, await this.listResourceTemplatesForServer(name)] as const
      )
    );
    for (const [serverName, templates] of serverTemplates) {
      templatesByServer[serverName] = templates;
    }
    return templatesByServer;
  }

  /**
   * Return the content of the resource with an exact match for the given URI.
   */
  async readResource(
    serverName: string,
    resourceUri: string
  ): Promise<TextResourceContents | BlobResourceContents> {
    if (!this.servers[serverName]) {
      throw new MetaError('Server  does not exist', { name: serverName });
    }

    // TODO: try/catch the MCP error -32603: Invalid URL if the resource doesn't exist
    const result = await this.servers[serverName].client.readResource({
      uri: resourceUri,
    });
    if (!result.contents || result.contents.length === 0) {
      throw new MetaError('Server did not return resource contents', {
        name: serverName,
      });
    }
    if (result.contents.length > 1) {
      throw new MetaError('Server returned multiple resources:', {
        name: serverName,
        paths: result.contents.map((content) => content.uri),
      });
    }

    return result.contents[0];
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    assemblySessionId: string = 'unknown-session',
    caller: CallToolCaller = CallToolCaller.AGENT
  ): Promise<CallToolResult> {
    const server = this.servers[serverName];
    if (!server) {
      throw new MetaError('Server does not exist', { name: serverName });
    }
    const result = await server.client.callTool(
      {
        name: toolName,
        arguments: args,
        _meta: { assemblySessionId, caller },
      },
      CallToolResultSchema,
      {
        timeout: server.config.timeout ?? MCP_CALL_TOOL_TIMEOUT_MS,
      }
    );

    const parseResult = CallToolResultSchema.safeParse(result);
    if (!parseResult.success) {
      throw new MetaError('Invalid CallToolResult', {
        name: serverName,
        errorMessage: JSON.stringify(parseResult.error.issues),
      });
    }

    return parseResult.data;
  }

  public async notify(clients: string[], notification: MCPServerNotification) {
    await Promise.all(
      clients.map(async (clientId) => {
        if (clientId in this.clientNotifiers) {
          const notifier = this.clientNotifiers[clientId];
          await notifier(notification);
        } else {
          this.logger?.warn(`[notify] no notifier registered for client`, {
            clientId,
          });
        }
      })
    );
  }

  public async notifyAll(notification: MCPServerNotification) {
    await this.notify(Object.keys(this.clientNotifiers), notification);
  }

  // ============================================================================
  // Private methods
  // ============================================================================
  private async subscribeToServerResource(serverName: string, uri: string) {
    const server = this.servers[serverName];
    if (!server) {
      throw new MetaError('Server does not exist', { name: serverName });
    }

    // Subscribe to the resource
    await server.client.subscribeResource({ uri });
  }

  /**
   * Unsubscribe from a server resource when no clients are subscribed to it anymore
   */
  private async unsubscribeFromServerResource(serverName: string, uri: string) {
    const server = this.servers[serverName];
    if (!server) {
      this.logger?.warn(
        `Cannot unsubscribe: Server ${serverName} does not exist`
      );
      return;
    }

    // Unsubscribe from the resource
    await server.client.unsubscribeResource({ uri });
    this.logger?.info(
      `Unsubscribed from resource ${uri} on server ${serverName}`
    );
  }

  /**
   * When we receive a resource update notification from an MCP server, fetch the new contents
   * and forward the update to all clients subscribed to this resource.
   */
  private async handleResourceUpdate(serverName: string, uri: string) {
    // Get all clients subscribed to this resource
    const subscribedClients = Array.from(
      this.clientResourceSubscriptions[serverName]?.[uri] || []
    );

    if (!subscribedClients || subscribedClients.length === 0) {
      return;
    }

    const resourceContent = await this.readResource(serverName, uri);
    this.logger?.info(`successfully read updated resource`, {
      server: serverName,
      uri,
    });

    const resource = this.availableResources[serverName][uri];

    const resourceChangeData: ResourceChange = {
      type: 'upsert',
      resource: {
        server: serverName,
        uri,
        name: resource.name,
        title: resource.title,
        description: resource.description,
        icons: resource.icons,
        mimeType: resourceContent.mimeType ?? 'text/plain',
        content: isTextResourceContents(resourceContent)
          ? resourceContent.text
          : resourceContent.blob,
      },
    };

    await this.notify(subscribedClients, {
      method: MCPNotificationMethods.ResourceChange,
      params: resourceChangeData,
    });
  }

  /**
   * When we receive a resource list changed notification from an MCP server, fetch the new list of
   * resources and determine which resources have been added or removed. Broadcast these updates to
   * all clients, regardless of subscription status.
   */
  private async handleResourceListChanged(
    serverName: string,
    assemblySessionId?: string
  ) {
    const logger = this.logger?.child({
      server: serverName,
      sessionId: assemblySessionId,
    });

    // Copy the old list of resources so we can compare it to the new list
    const oldResources = { ...this.availableResources[serverName] };
    const newResources = Object.fromEntries(
      (await this.listResourcesForServer(serverName, assemblySessionId)).map(
        (r) => [r.uri, r]
      )
    );

    const oldResourceUris = new Set(Object.keys(oldResources));
    const newResourceUris = new Set(Object.keys(newResources));

    // First send 'delete' notifications for any deleted resources
    const deletedResourceUris = oldResourceUris.difference(newResourceUris);
    logger?.info(
      `[handleResourceListChanged] detected ${deletedResourceUris.size} deleted resources`,
      {
        deletedResources: Array.from(deletedResourceUris),
      }
    );

    const deletedResources = deletedResourceUris
      .entries()
      .map(([uri]) => oldResources[uri]);
    deletedResources.forEach(async (r) => {
      // If we received an assemblySessionId, only notify the client for that session
      const deletedNotification: ResourceChange = {
        type: 'delete',
        resource: {
          server: serverName,
          uri: r.uri,
          name: r.name,
        },
      };

      if (assemblySessionId) {
        if (assemblySessionId in this.clientNotifiers) {
          await this.notify([assemblySessionId], {
            method: MCPNotificationMethods.ResourceChange,
            params: deletedNotification,
          });
        } else {
          logger?.warn(
            `[handleResourceListChanged] no notifier registered for client`
          );
        }
      } else {
        await this.notify(Object.keys(this.clientNotifiers), {
          method: MCPNotificationMethods.ResourceChange,
          params: deletedNotification,
        });
      }
    });
    logger?.info(
      `[handleResourceListChanged] notified clients of deleted resources`
    );

    // Next, fetch the contents for any new resources and send 'upsert' notifications
    const addedResourceUris = newResourceUris.difference(oldResourceUris);
    logger?.info(`detected ${addedResourceUris.size} added resources`, {
      addedResources: Array.from(addedResourceUris),
    });
    const addedResources = addedResourceUris
      .entries()
      .map(([uri]) => newResources[uri]);
    addedResources.forEach(async (r) => {
      const resourceContent = await this.readResource(serverName, r.uri);

      const upsertNotification: ResourceChange = {
        type: 'upsert',
        resource: {
          server: serverName,
          uri: r.uri,
          name: r.name,
          title: r.title,
          description: r.description,
          icons: r.icons,
          mimeType: resourceContent.mimeType ?? 'text/plain',
          content: isTextResourceContents(resourceContent)
            ? resourceContent.text
            : resourceContent.blob,
        },
      };

      // If we received an assemblySessionId, only notify the client for that session
      if (assemblySessionId) {
        if (assemblySessionId in this.clientNotifiers) {
          await this.notify([assemblySessionId], {
            method: MCPNotificationMethods.ResourceChange,
            params: upsertNotification,
          });
        } else {
          logger?.warn(
            `[handleResourceListChanged] no notifier registered for client`
          );
        }
      } else {
        await this.notify(Object.keys(this.clientNotifiers), {
          method: MCPNotificationMethods.ResourceChange,
          params: upsertNotification,
        });
      }
    });
    logger?.info(
      `[handleResourceListChanged] notified clients of added resources`
    );
  }
}
