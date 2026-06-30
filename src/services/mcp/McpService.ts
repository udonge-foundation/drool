import crypto from 'crypto';
import EventEmitter from 'events';
import fs, { type FSWatcher } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'path';

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { type McpPolicy, type McpServerConfig } from '@industry/common/settings';
import { SandboxSideEffect } from '@industry/drool-core/tools/enums';
import { McpAuthOutcome } from '@industry/drool-sdk-ext/protocol/drool';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';
import { logException, logInfo, logWarn, Metrics } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';
import { McpOAuthCredentialStore } from '@industry/runtime/auth';
import { McpSettingsManager, SettingsManager } from '@industry/runtime/settings';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import {
  canonicalizeMcpServerNameMap,
  normalizeServerName,
} from '@industry/utils/mcp';

import packageJson from '../../../package.json';
import { getI18n } from '@/i18n';
import { McpHub } from '@/mcp/McpHub';
import { resolveMcpSecretReference } from '@/mcp/resolveMcpSecretReferences';
import type { McpTool } from '@/mcp/schema';
import type {
  ILogger,
  McpReloadResult,
  McpReloadServerSettleEvent,
  McpSubserver,
} from '@/mcp/types';
import { formatToolName } from '@/mcp/utils';
import { getFolderTrustService } from '@/services/FolderTrustService';
import { McpServiceEventType } from '@/services/mcp/enums';
import { OAuthCallbackServer } from '@/services/mcp/oauth/CallbackServer';
import { McpOAuthDriver } from '@/services/mcp/oauth/core/driver';
import { OAuthDiscovery } from '@/services/mcp/oauth/OAuthDiscovery';
import type {
  OAuthAuthorizationChallenge,
  OAuthDiscoveryResult,
} from '@/services/mcp/oauth/types';
import { getUrlOrigin } from '@/services/mcp/oauth/url';
import type {
  McpAuthRequiredInfo,
  McpServiceEventMap,
} from '@/services/mcp/types';
import { McpToolExecutor } from '@/tools/executors/client/mcp/McpToolExecutor';
import { getTUIToolRegistry } from '@/tools/registry';
import type { CliClientToolDependencies } from '@/tools/types';

import type {
  IndustryTool,
  InputJSONSchema,
  ToolImplementation,
} from '@industry/drool-core/tools/types';
import type { McpOAuthTokenEndpointAuthMethod } from '@industry/drool-sdk-ext/protocol/mcp-oauth';
import type { SettingsChangedEvent } from '@industry/runtime/settings';
import type { OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';

interface CallToolParams {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  sessionId?: string;
}

interface CreateOAuthDriverParams {
  serverName: string;
  serverUrl: string;
  showNotifications?: boolean;
  discovery?: OAuthDiscoveryResult;
  /** User-configured OAuth scopes from the MCP server config */
  configuredScopes?: string[];
  configuredClientInformation?: OAuthClientInformationMixed;
  configuredAuthorizationServerIssuer?: string;
  configuredClientMetadataUrl?: string;
  configuredTokenEndpointAuthMethod?: McpOAuthTokenEndpointAuthMethod;
  authorizationChallenge?: OAuthAuthorizationChallenge;
  replaceClientOnConnect?: boolean;
}

interface OAuthServerParams {
  serverName: string;
  serverUrl: string;
}

interface SetOAuthSupportCacheParams extends OAuthServerParams {
  result: OAuthDiscoveryResult;
}

function isRemoteMcpServer(
  config: McpServerConfig | undefined
): config is Extract<McpServerConfig, { type: 'http' | 'sse' }> {
  return !!config && (config.type === 'http' || config.type === 'sse');
}

function isOAuthEnabledRemoteMcpServer(
  config: McpServerConfig | undefined
): config is Extract<McpServerConfig, { type: 'http' | 'sse' }> {
  return isRemoteMcpServer(config) && config.oauth !== false;
}

function getOAuthOptions(
  config: Extract<McpServerConfig, { type: 'http' | 'sse' }>
): Exclude<typeof config.oauth, false> {
  return config.oauth === false ? undefined : config.oauth;
}

function getConfiguredOAuthClientInformation(
  serverName: string,
  config: Extract<McpServerConfig, { type: 'http' | 'sse' }>
): OAuthClientInformationMixed | undefined {
  const oauth = getOAuthOptions(config);
  const clientId = oauth?.clientId;
  if (!clientId) {
    return undefined;
  }

  return {
    client_id: resolveMcpSecretReference({ serverName, value: clientId }),
    ...(oauth?.clientSecret
      ? {
          client_secret: resolveMcpSecretReference({
            serverName,
            value: oauth.clientSecret,
          }),
        }
      : {}),
    ...(oauth?.tokenEndpointAuthMethod
      ? { token_endpoint_auth_method: oauth.tokenEndpointAuthMethod }
      : {}),
  } satisfies OAuthClientInformationMixed;
}

function hasOAuthEnabledRemoteMcpServers(
  configs: Record<string, McpServerConfig>
): boolean {
  return Object.values(configs).some(isOAuthEnabledRemoteMcpServer);
}

function getConfiguredOAuthCallbackPort(
  configs: Record<string, McpServerConfig>
): number | undefined {
  const callbackPorts = Object.values(configs)
    .filter(isOAuthEnabledRemoteMcpServer)
    .map((config) => getOAuthOptions(config)?.callbackPort)
    .filter((port): port is number => typeof port === 'number');

  const [firstCallbackPort, ...otherCallbackPorts] = callbackPorts;
  if (
    firstCallbackPort &&
    otherCallbackPorts.some((port) => port !== firstCallbackPort)
  ) {
    logWarn(
      '[McpService] Multiple MCP OAuth callback ports configured; using first port',
      { port: firstCallbackPort }
    );
  }

  return firstCallbackPort;
}

function isAuthenticationRequiredError(error: Error | undefined): boolean {
  return error?.message === 'Authentication required';
}

const ATOMIC_TEMP_SUFFIX = /\.tmp-\d{10}[0-9a-f]{6}$/;

function stripAtomicTempSuffix(filename: string): string {
  return filename.replace(ATOMIC_TEMP_SUFFIX, '');
}

const NON_DEFERRED_MCP_SERVER_KEYS = ['github', 'agentbrowser'] as const;

function normalizeMcpDeferPolicyKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function shouldDeferMcpTool(serverName: string): boolean {
  const serverKey = normalizeMcpDeferPolicyKey(serverName);

  return !NON_DEFERRED_MCP_SERVER_KEYS.some(
    (key) => serverKey.startsWith(key) || serverKey.includes(key)
  );
}

/** Logging shim between our Industry logging utilities and the @industry/mcp logging interface. */
function createLogger(
  name: string,
  context: Record<string, unknown> = {}
): ILogger {
  const messageWithName = (message: string) => `[${name}] ${message}`;
  return {
    debug: () => {}, // TODO: We don't have a debug logging implementation and info would be noisy
    info: (message, metadata) => {
      logInfo(messageWithName(message), { ...context, ...metadata });
    },
    warn: (message, metadata) => {
      logWarn(messageWithName(message), { ...context, ...metadata });
    },
    error: (message, metadata) => {
      if (metadata && 'error' in metadata) {
        logException(metadata.error, messageWithName(message), {
          ...context,
          ...metadata,
        });
      } else {
        // TODO: update ILogger.error to better match logException
        logException(
          new MetaError('Placeholder error'),
          messageWithName(message),
          {
            ...context,
            ...metadata,
          }
        );
      }
    },
    child: (metadata) => createLogger(name, { ...context, ...metadata }),
  };
}

/**
 * McpService manages the lifecycle of MCP servers and provides an interface for interacting with
 * them.
 */
export class McpService extends EventEmitter<McpServiceEventMap> {
  private settingsManager: SettingsManager;

  private mcpSettingsManager: McpSettingsManager;

  private mcpHub: McpHub | null = null;

  /** Track registered MCP tools by server name for cleanup */
  private registeredToolsByServer: Map<string, string[]> = new Map();

  /** OAuth infrastructure */
  private oauthStorage: McpOAuthCredentialStore;

  private callbackServer: OAuthCallbackServer;

  private oauthDrivers: Map<string, McpOAuthDriver> = new Map();

  private oauthSupportCache: Map<string, OAuthDiscoveryResult> = new Map();

  private oauthSupportWarmups: Map<string, Promise<void>> = new Map();

  private oauthServersRequiringAuth: Set<string> = new Set();

  private pendingAuthByServer: Map<string, McpAuthRequiredInfo> = new Map();

  /** Callback to add OAuth notifications to the conversation */
  private addMessageCallback?: (content: string) => void;

  /** Track if service has been initialized to make start() idempotent */
  private initialized = false;

  /** Track if initialization is in progress */
  private initializing = false;

  /** Track the in-flight initialization so concurrent callers can await the same work */
  private startPromise: Promise<void> | null = null;

  /** Track if authentication is in progress to skip config reloads */
  private authenticatingServer: string | null = null;

  /** Track if a targeted server operation is in progress to skip global config reloads */
  private targetedServerOperation: boolean = false;

  /** Track server errors from last reload */
  private lastServerErrors: Map<string, Error> = new Map();

  /** Track servers that are currently connecting */
  private connectingServers: Set<string> = new Set();

  /** Shared-credential reconnect attempts already issued by this process. */
  private sharedCredentialReconnects: Set<string> = new Set();

  private sharedCredentialReconnectFingerprints: Map<string, string> =
    new Map();

  /** Watches OAuth storage files for cross-process credential edits. */
  private oauthCredentialWatcher: FSWatcher | null = null;

  /** Debounce handle for OAuth file-change reconciliations. */
  private oauthCredentialSyncTimeout: NodeJS.Timeout | null = null;

  /** Last seen fingerprint per server from shared OAuth storage. */
  private oauthCredentialFingerprints: Map<string, string> = new Map();

  /** Track settings change listener for cleanup */
  private settingsChangeListener: (() => void) | null = null;

  /** Override redirect URI for remote/daemon sessions */
  private remoteCallbackUri?: string;

  /**
   * Execute an operation with targeted server operation handling.
   * Disables file watching during the operation to prevent global reloads.
   */
  private async withTargetedOperation<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    this.settingsManager.disableWatching();
    this.targetedServerOperation = true;
    try {
      return await operation();
    } finally {
      this.settingsManager.enableWatching();
      this.targetedServerOperation = false;
    }
  }

  /**
   * Start a server and emit the appropriate result event.
   * Handles connecting state and error tracking.
   */
  private async startServerAndEmitResult(serverName: string): Promise<void> {
    if (!this.mcpHub) {
      const serverError = new MetaError('MCP service not initialized');
      this.lastServerErrors.set(serverName, serverError);
      this.emit(McpServiceEventType.SERVER_STARTED, {
        serverName,
        success: false,
        error: serverError,
      });
      return;
    }

    // Check if server is blocked by organization's MCP policy
    const allServers = canonicalizeMcpServerNameMap(
      await this.mcpSettingsManager.getMcpServers()
    );
    const serverConfig = allServers[serverName];
    if (serverConfig) {
      const isAllowed =
        await this.mcpSettingsManager.checkServerAgainstPolicy(serverConfig);
      if (!isAllowed) {
        const serverError = new MetaError(
          "Server is not on your organization's allowlist. Contact your admin to allow it.",
          { name: serverName }
        );
        this.lastServerErrors.set(serverName, serverError);
        this.emit(McpServiceEventType.SERVER_STARTED, {
          serverName,
          success: false,
          error: serverError,
        });
        return;
      }
    }

    this.connectingServers.add(serverName);
    try {
      await this.mcpHub.retryServer(serverName);

      this.connectingServers.delete(serverName);
      this.lastServerErrors.delete(serverName);
      this.emit(McpServiceEventType.SERVER_STARTED, {
        serverName,
        success: true,
      });
    } catch (error) {
      this.connectingServers.delete(serverName);
      const serverError =
        error instanceof Error ? error : new Error(String(error));
      this.lastServerErrors.set(serverName, serverError);
      this.emit(McpServiceEventType.SERVER_STARTED, {
        serverName,
        success: false,
        error: serverError,
      });
    }
  }

  private async refreshServerToolsAfterStart(
    serverName: string
  ): Promise<void> {
    if (this.lastServerErrors.has(serverName)) {
      this.unregisterServerTools(serverName);
      return;
    }

    await this.refreshServerTools(serverName);
  }

  private static getEnabledServerConfigs(
    configs: Record<string, McpServerConfig>
  ): Record<string, McpServerConfig> {
    return Object.fromEntries(
      Object.entries(configs).filter(([, config]) => !config.disabled)
    );
  }

  private static getChangedServerNames(
    currentServers: Record<string, McpServerConfig>,
    updatedServers: Record<string, McpServerConfig>
  ): string[] {
    const enabledCurrentServers =
      McpService.getEnabledServerConfigs(currentServers);
    const allServerNames = new Set([
      ...Object.keys(enabledCurrentServers),
      ...Object.keys(updatedServers),
    ]);

    return Array.from(allServerNames).filter(
      (serverName) =>
        !isDeepStrictEqual(
          enabledCurrentServers[serverName],
          updatedServers[serverName]
        )
    );
  }

  private static getEnabledServerConfigsAllowedByPolicy(
    configs: Record<string, McpServerConfig>,
    mcpPolicy: McpPolicy | undefined
  ): Record<string, McpServerConfig> {
    return Object.fromEntries(
      Object.entries(configs).filter(([_, config]) => {
        if (config.disabled) {
          return false;
        }
        return McpSettingsManager.isServerAllowedByPolicy(config, mcpPolicy);
      })
    );
  }

  /**
   * Stop a server and emit the appropriate result event.
   */
  private async stopServerAndEmitResult(serverName: string): Promise<void> {
    if (!this.mcpHub) return;

    const servers = this.mcpHub.getServers();
    if (servers[serverName]) {
      await this.mcpHub.removeServer(serverName);
    }
    this.emit(McpServiceEventType.SERVER_STOPPED, {
      serverName,
      success: true,
    });
  }

  /**
   * Per-server callback invoked by {@link McpHub.reloadServers} as each
   * server finishes its stop or start attempt during a bulk reload.
   *
   * Mirrors the bookkeeping that {@link startServerAndEmitResult} and
   * {@link stopServerAndEmitResult} do for single-server operations so that
   * `connectingServers`, `lastServerErrors`, the tool registry, and
   * subscribers of `SERVER_STARTED` / `SERVER_STOPPED` stay in sync while
   * a bulk reload is still in flight.
   */
  private handleServerSettled = async (
    event: McpReloadServerSettleEvent
  ): Promise<void> => {
    const { phase, serverName, success, error } = event;

    // During a bulk reload we can fire SERVER_STARTED/STOPPED for every
    // server; the caller emits one consolidated TOOLS_UPDATED at the tail,
    // so individual tool refreshes suppress their own emission to avoid
    // O(N) listener work for a single reload (each TOOLS_UPDATED drives a
    // full tool-registry scan in the JSON-RPC exec runner).
    if (phase === 'stop') {
      this.unregisterServerTools(serverName, { emitToolsUpdated: false });
      if (success) {
        this.lastServerErrors.delete(serverName);
      } else if (error) {
        this.lastServerErrors.set(serverName, error);
      }
      this.emit(McpServiceEventType.SERVER_STOPPED, {
        serverName,
        success,
        error,
      });
      return;
    }

    // phase === 'start'
    this.connectingServers.delete(serverName);
    if (success) {
      this.lastServerErrors.delete(serverName);
      await this.refreshServerTools(serverName, { emitToolsUpdated: false });
    } else {
      if (error) {
        this.lastServerErrors.set(serverName, error);
      }
      this.unregisterServerTools(serverName, { emitToolsUpdated: false });
    }
    this.emit(McpServiceEventType.SERVER_STARTED, {
      serverName,
      success,
      error,
    });
  };

  /**
   * Update mcpHub config from settings without reloading servers.
   */
  private async syncConfigWithoutReload(): Promise<
    Record<string, McpServerConfig>
  > {
    const configs = canonicalizeMcpServerNameMap(
      await this.mcpSettingsManager.getEnabledMcpServers()
    );
    this.mcpHub?.setUserMcpConfigsWithoutReload(configs);
    this.scheduleOAuthCredentialSync();
    return configs;
  }

  private closeOAuthCredentialWatcher(): void {
    if (this.oauthCredentialSyncTimeout) {
      clearTimeout(this.oauthCredentialSyncTimeout);
      this.oauthCredentialSyncTimeout = null;
    }

    if (!this.oauthCredentialWatcher) {
      this.oauthCredentialFingerprints.clear();
      return;
    }

    try {
      this.oauthCredentialWatcher.close();
    } catch (error) {
      logWarn('[McpService] Failed closing MCP OAuth credential watcher', {
        cause: error,
      });
    } finally {
      this.oauthCredentialWatcher = null;
      this.oauthCredentialFingerprints.clear();
    }
  }

  private startOAuthCredentialWatcher(): void {
    if (this.oauthCredentialWatcher) {
      return;
    }

    const { dataPath, keyPath } = this.oauthStorage.getStoragePaths();
    const watchDir = path.dirname(dataPath);
    if (!fs.existsSync(watchDir)) {
      return;
    }

    const watchedFileNames = new Set([
      path.basename(dataPath),
      path.basename(keyPath),
    ]);

    try {
      this.oauthCredentialWatcher = fs.watch(
        watchDir,
        (_eventType, filename) => {
          const changedName = stripAtomicTempSuffix(filename?.toString() ?? '');
          if (changedName && !watchedFileNames.has(changedName)) {
            return;
          }
          this.scheduleOAuthCredentialSync();
        }
      );
      this.oauthCredentialWatcher.on('error', (error) => {
        logWarn('[McpService] MCP OAuth credential watcher error', {
          cause: error,
        });
        this.closeOAuthCredentialWatcher();
      });
    } catch (error) {
      logWarn('[McpService] Failed to watch MCP OAuth credential storage', {
        cause: error,
      });
      return;
    }

    this.scheduleOAuthCredentialSync();
  }

  private scheduleOAuthCredentialSync(): void {
    if (this.oauthCredentialSyncTimeout) {
      return;
    }

    this.oauthCredentialSyncTimeout = setTimeout(() => {
      this.oauthCredentialSyncTimeout = null;
      void this.syncOAuthCredentialState();
    }, 120);
    this.oauthCredentialSyncTimeout.unref?.();
  }

  private async syncOAuthCredentialState(): Promise<void> {
    if (!this.mcpHub) {
      return;
    }

    try {
      const configs = canonicalizeMcpServerNameMap(
        await this.mcpSettingsManager.getMcpServers()
      );
      const oauthServers: Array<
        [string, Extract<McpServerConfig, { type: 'http' | 'sse' }>]
      > = [];
      for (const [serverName, config] of Object.entries(configs)) {
        if (isOAuthEnabledRemoteMcpServer(config)) {
          oauthServers.push([serverName, config]);
        }
      }

      const nextFingerprints = new Map<string, string>();
      for (const [serverName, config] of oauthServers) {
        const normalizedName = normalizeServerName(serverName);
        const fingerprint =
          await this.getValidOAuthCredentialFingerprintForConfig(
            normalizedName,
            config
          );
        if (fingerprint) {
          nextFingerprints.set(normalizedName, fingerprint);
        }
      }

      const previousFingerprints = this.oauthCredentialFingerprints;
      const changedServers = new Set<string>();
      for (const serverName of previousFingerprints.keys()) {
        if (
          previousFingerprints.get(serverName) !==
          nextFingerprints.get(serverName)
        ) {
          changedServers.add(serverName);
        }
      }
      for (const serverName of nextFingerprints.keys()) {
        if (
          nextFingerprints.get(serverName) !==
          previousFingerprints.get(serverName)
        ) {
          changedServers.add(serverName);
        }
      }

      this.oauthCredentialFingerprints = nextFingerprints;
      if (changedServers.size === 0) {
        return;
      }

      const runningServers = new Set(
        Object.keys(this.listServers()).map(normalizeServerName)
      );

      for (const serverName of changedServers) {
        this.emit(McpServiceEventType.OAUTH_SUPPORT_UPDATED, serverName);
        const previousFingerprint = previousFingerprints.get(serverName);
        const fingerprint = this.oauthCredentialFingerprints.get(serverName);

        if (runningServers.has(serverName)) {
          // Credentials were externally removed/invalidated while this process
          // still has an active connection. Disconnect this server so status
          // accurately transitions to auth-required instead of stale connected.
          if (previousFingerprint && !fingerprint) {
            this.callbackServer.cancelPendingCallbacksForServer(serverName);
            this.pendingAuthByServer.delete(serverName);
            this.oauthDrivers.delete(serverName);

            let stopError: Error | undefined;
            try {
              await this.mcpHub.removeServer(serverName);
              this.unregisterServerTools(serverName);
              this.lastServerErrors.set(
                serverName,
                new Error('Authentication required')
              );
            } catch (error) {
              stopError =
                error instanceof Error ? error : new Error(String(error));
              this.lastServerErrors.set(serverName, stopError);
            }

            const result: McpReloadResult = stopError
              ? {
                  stoppedServers: [],
                  startedServers: [],
                  erroredServers: [serverName],
                  unchangedServers: [],
                  serverErrors: new Map([[serverName, stopError]]),
                  startAttempts: 0,
                  stopAttempts: 1,
                  startErrors: 0,
                  stopErrors: 1,
                }
              : {
                  stoppedServers: [serverName],
                  startedServers: [],
                  erroredServers: [serverName],
                  unchangedServers: [],
                  serverErrors: new Map([
                    [serverName, new Error('Authentication required')],
                  ]),
                  startAttempts: 0,
                  stopAttempts: 1,
                  startErrors: 0,
                  stopErrors: 0,
                };
            this.emit(McpServiceEventType.SERVERS_RELOADED, result);
          }
          continue;
        }

        if (
          fingerprint &&
          isAuthenticationRequiredError(this.lastServerErrors.get(serverName))
        ) {
          this.scheduleReconnectWithSharedOAuthCredentials(
            serverName,
            fingerprint
          );
        }
      }
    } catch (error) {
      logWarn(
        '[McpService] Failed syncing MCP OAuth credentials from shared storage',
        { cause: error }
      );
    }
  }

  constructor() {
    super();

    this.settingsManager = SettingsManager.getInstance();
    this.mcpSettingsManager = McpSettingsManager.getInstance();

    const oauthStorageDir = path.join(getIndustryHome(), getIndustryDirName());
    this.oauthStorage = new McpOAuthCredentialStore(oauthStorageDir);
    this.callbackServer = new OAuthCallbackServer();
  }

  /**
   * Set the callback for adding OAuth notifications to the conversation.
   * Should be called during app initialization.
   */
  public setAddMessageCallback(callback: (content: string) => void): void {
    this.addMessageCallback = callback;
  }

  /**
   * Log MCP server startup metrics from a reload result.
   * @param result - The reload result from McpHub
   * @param context - Context string to identify where the reload happened
   */
  private static logMcpServerMetrics(
    result: McpReloadResult,
    context?: string,
    durationMs?: number
  ): void {
    const startAttempts = result.startAttempts;
    const startErrors = result.startErrors;

    const stopAttempts = result.stopAttempts;
    const stopErrors = result.stopErrors;

    // Log raw counts to Axiom - percentages can be calculated via Axiom queries
    const labels = {
      ...(context && { context }),
      outcome: result.erroredServers.length > 0 ? 'error' : 'success',
    };

    Metrics.addToCounter(
      Metric.MCP_SERVERS_TO_START_COUNT,
      startAttempts,
      labels
    );
    Metrics.addToCounter(
      Metric.MCP_SERVERS_START_ERRORED_COUNT,
      startErrors,
      labels
    );
    Metrics.addToCounter(
      Metric.MCP_SERVERS_TO_STOP_COUNT,
      stopAttempts,
      labels
    );
    Metrics.addToCounter(
      Metric.MCP_SERVERS_STOP_ERRORED_COUNT,
      stopErrors,
      labels
    );
    Metrics.addToCounter(
      Metric.MCP_SERVERS_UNCHANGED_COUNT,
      result.unchangedServers.length,
      labels
    );

    Metrics.addToCounter(Metric.MCP_RELOAD_COUNT, 1, labels);
    Metrics.addToCounter(
      Metric.MCP_RELOAD_WITH_ERRORS_COUNT,
      result.erroredServers.length > 0 ? 1 : 0,
      labels
    );
    if (durationMs !== undefined) {
      Metrics.addToCounter(Metric.MCP_RELOAD_LATENCY_MS, durationMs, labels);
    }

    // Also log a human-readable message with details for debugging
    const message = context
      ? `MCP servers reload completed (${context})`
      : 'MCP servers reload completed';

    const mcpServerErrors: Record<string, string> = {};
    result.serverErrors.forEach((error, serverName) => {
      // Store a scrubbed, human-readable error summary per server
      mcpServerErrors[serverName] = error?.message ?? String(error);
    });

    logInfo(message, {
      mcpServersStarted: result.startedServers,
      mcpServersErrored: result.erroredServers,
      mcpServerErrors,
    });
  }

  public async start(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Folder trust gate (CLI-897): MCP configs are resolved from merged
    // settings, which include attacker-controlled project settings. Do not
    // start servers while the interactive trust prompt is unresolved; a
    // later start() proceeds normally once the folder is trusted.
    if (getFolderTrustService().isTrustGateActive()) {
      logInfo('[McpService] Skipping MCP start: folder not trusted yet');
      return;
    }

    if (!this.startPromise) {
      this.initializing = true;
      this.startPromise = this.runStartSequence().finally(() => {
        this.initializing = false;
        this.startPromise = null;
      });
    }

    await this.startPromise;
  }

  private async startOAuthCallbackServerIfNeeded(
    servers: Record<string, McpServerConfig>
  ): Promise<void> {
    const start = performance.now();
    let attempted = false;
    let outcome = 'skipped';
    let skippedReason: string | undefined;

    if (this.remoteCallbackUri) {
      skippedReason = 'remote-callback-uri';
    } else if (!hasOAuthEnabledRemoteMcpServers(servers)) {
      skippedReason = 'no-remote-mcp-servers';
    }

    if (skippedReason) {
      Metrics.addToCounter(
        Metric.MCP_CALLBACK_SERVER_START_LATENCY_MS,
        performance.now() - start,
        { attempted, outcome, skippedReason }
      );
      return;
    }

    const callbackPort = getConfiguredOAuthCallbackPort(servers);
    if (callbackPort) {
      const currentPort = this.callbackServer.getPort();
      if (this.callbackServer.isStarted && currentPort !== callbackPort) {
        this.callbackServer.cancelAllPendingCallbacks();
        this.callbackServer.close();
        logInfo(
          '[McpService] Restarting MCP OAuth callback server on configured port',
          {
            port: callbackPort,
          }
        );
      }
    }

    if (
      callbackPort &&
      (!this.callbackServer.isStarted ||
        this.callbackServer.getPort() !== callbackPort)
    ) {
      this.callbackServer = new OAuthCallbackServer({
        startPort: callbackPort,
        maxAttempts: 1,
      });
    }

    try {
      attempted = true;
      await this.callbackServer.start();
      outcome = 'success';
    } catch (error) {
      outcome = 'error';
      throw new MetaError('Failed to start MCP OAuth callback server', {
        cause: error,
      });
    } finally {
      Metrics.addToCounter(
        Metric.MCP_CALLBACK_SERVER_START_LATENCY_MS,
        performance.now() - start,
        {
          attempted,
          outcome,
        }
      );
    }
  }

  private async runStartSequence(): Promise<void> {
    try {
      const servers = canonicalizeMcpServerNameMap(
        await this.mcpSettingsManager.getEnabledMcpServers()
      );

      await this.startOAuthCallbackServerIfNeeded(servers);

      this.mcpHub = new McpHub({
        userMcpConfigs: servers,
        logger: createLogger('McpHub'),
        clientInfo: {
          name: 'industry-cli',
          title: 'Industry CLI',
          version: packageJson.version,
          websiteUrl: 'https://example.com/',
        },
        getOAuthDriver: (serverName, config) => {
          const driver = this.getOrCreateOAuthDriver(serverName, config);
          logInfo('[McpService] getOAuthDriver called', {
            name: serverName,
            found: !!driver,
            serverIds: Array.from(this.oauthDrivers.keys()),
          });
          return driver;
        },
        onAuthFlowCompleted: ({ serverName, outcome, message }) => {
          this.pendingAuthByServer.delete(normalizeServerName(serverName));
          this.emit(McpServiceEventType.AUTH_COMPLETED, {
            serverName,
            outcome,
            message,
          });

          if (!this.addMessageCallback) {
            return;
          }

          if (outcome === 'success') {
            this.addMessageCallback(
              getI18n().t('common:mcpAuth.authSuccessful', { serverName })
            );
          } else if (outcome === 'cancelled') {
            this.addMessageCallback(
              getI18n().t('common:mcpAuth.authCancelled', { serverName })
            );
          } else {
            this.addMessageCallback(
              getI18n().t('common:mcpAuth.authFailed', { serverName })
            );
          }
        },
      });

      // Mark configured servers as connecting before reload
      const configs = this.getUserMcpConfigs();
      const runningServers = this.listServers();
      for (const name of Object.keys(configs)) {
        if (!runningServers[name] && !configs[name].disabled) {
          this.connectingServers.add(name);
        }
      }
      this.emit(McpServiceEventType.SERVERS_RELOADING);
      const reloadStart = performance.now();
      const result = await this.mcpHub.reloadServers({
        onServerSettled: this.handleServerSettled,
      });
      const reloadDurationMs = performance.now() - reloadStart;
      // Defensive cleanup: handleServerSettled already trims these per-server
      // as each one completes, but any server that never emits (e.g. an
      // unchanged server) is cleared here.
      this.connectingServers.clear();
      this.emit(McpServiceEventType.SERVERS_RELOADED, result);

      // Log MCP server startup metrics
      McpService.logMcpServerMetrics(result, '', reloadDurationMs);

      // Emit a consolidated tools update for any tail listeners; per-server
      // refreshes have already populated the registry.
      this.emit(McpServiceEventType.TOOLS_UPDATED);

      void this.warmOAuthSupportForConfiguredServers();

      // Mark as successfully initialized
      this.initialized = true;
    } catch (error) {
      // Cleanup callback server on error
      this.callbackServer.close();
      logWarn('[McpService] Error reloading MCP servers', {
        cause: error,
      });
      this.emit(
        McpServiceEventType.ERROR,
        new MetaError('[McpService] Error reloading MCP servers', {
          cause: error,
        })
      );
      throw error;
    }

    // Listen for settings changes to reload MCP servers
    const settingsChangeHandler = async (_event: SettingsChangedEvent) => {
      if (!this.mcpHub) {
        return;
      }

      // Folder trust gate (CLI-897): a mid-session cwd change can refresh
      // settings into an untrusted workspace; do not pick up its MCP
      // configs until the trust prompt is resolved.
      if (getFolderTrustService().isTrustGateActive()) {
        logInfo('[McpService] Skipping config reload: folder not trusted yet');
        return;
      }

      // Skip config reload if authentication is in progress
      if (this.authenticatingServer) {
        logInfo(
          '[McpService] Skipping config reload - authentication in progress for',
          { name: this.authenticatingServer }
        );
        return;
      }

      // Skip config reload if a targeted server operation (enable/disable) is in progress
      // This prevents file-watcher reload handling from interfering with single-server operations
      if (this.targetedServerOperation) {
        logInfo(
          '[McpService] Skipping config reload - targeted server operation in progress'
        );
        return;
      }

      try {
        const [allUpdatedServers, mcpPolicy] = await Promise.all([
          this.mcpSettingsManager.getMcpServers(),
          this.mcpSettingsManager.getMcpPolicy(),
        ]);
        const canonicalUpdatedServers =
          canonicalizeMcpServerNameMap(allUpdatedServers);
        const updatedServers =
          McpService.getEnabledServerConfigsAllowedByPolicy(
            canonicalUpdatedServers,
            mcpPolicy
          );
        this.pruneOAuthSupportState(canonicalUpdatedServers);
        const currentServers = this.mcpHub.getUserMcpConfigs();
        const changedServerNames = McpService.getChangedServerNames(
          currentServers,
          updatedServers
        );

        // Ignore non-MCP settings changes (e.g. model/thinking/autonomy updates)
        if (changedServerNames.length === 0) {
          logInfo('[McpService] Skipping config reload - MCP config unchanged');
          return;
        }

        // Start callback server (idempotent - safe to call multiple times)
        await this.startOAuthCallbackServerIfNeeded(updatedServers);

        for (const name of changedServerNames) {
          // Keep in-flight flows for untouched servers; only changed servers
          // get their pending callbacks/state cleared.
          this.callbackServer.cancelPendingCallbacksForServer(name);
          this.pendingAuthByServer.delete(normalizeServerName(name));
        }

        for (const [name, config] of Object.entries(updatedServers)) {
          if (!isOAuthEnabledRemoteMcpServer(config)) {
            this.clearOAuthDriverState(name);
          }
        }
        for (const name of changedServerNames) {
          if (!Object.prototype.hasOwnProperty.call(updatedServers, name)) {
            this.clearOAuthDriverState(name);
            continue;
          }
          this.oauthDrivers.delete(name);
        }

        // Mark new/updated servers as connecting
        const runningServers = this.listServers();
        for (const name of Object.keys(updatedServers)) {
          if (!runningServers[name] && !updatedServers[name].disabled) {
            this.connectingServers.add(name);
          }
        }
        this.emit(McpServiceEventType.SERVERS_RELOADING);
        // Update configs and let McpHub reload only changed servers.
        this.mcpHub.setUserMcpConfigsWithoutReload(updatedServers);
        const reloadStart = performance.now();
        const result = await this.mcpHub.reloadServers({
          onServerSettled: this.handleServerSettled,
        });
        const reloadDurationMs = performance.now() - reloadStart;
        // Defensive cleanup: per-server callback has already trimmed the set.
        this.connectingServers.clear();
        this.emit(McpServiceEventType.SERVERS_RELOADED, result);

        // Log MCP server startup metrics
        McpService.logMcpServerMetrics(
          result,
          'config change',
          reloadDurationMs
        );

        // Per-server refresh already populated the registry for each started
        // server; emit a tail TOOLS_UPDATED for consumers listening once.
        this.emit(McpServiceEventType.TOOLS_UPDATED);

        void this.warmOAuthSupportForConfiguredServers(changedServerNames);
        this.scheduleOAuthCredentialSync();
      } catch (error) {
        logWarn('[McpService] Error reloading MCP servers on config change', {
          cause: error,
        });
        this.emit(
          McpServiceEventType.ERROR,
          new MetaError('[McpService] Error reloading MCP servers', {
            cause: error,
          })
        );
      }
    };

    this.settingsManager.on('settings-changed', settingsChangeHandler);
    this.settingsChangeListener = () => {
      this.settingsManager.off('settings-changed', settingsChangeHandler);
    };

    // Enable file watching
    this.settingsManager.enableWatching();
    this.startOAuthCredentialWatcher();
  }

  private async waitForInitializationIfNeeded(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
    }
  }

  /**
   * Create an OAuth driver for a server.
   * @param name - Server name
   * @param url - Server URL
   * @param showNotifications - Whether to show notifications and auto-open browser
   * @param discovery - Optional OAuth discovery result with metadata
   */
  private createOAuthDriver({
    serverName,
    serverUrl,
    showNotifications = false,
    discovery,
    configuredScopes,
    configuredClientInformation,
    configuredAuthorizationServerIssuer,
    configuredClientMetadataUrl,
    configuredTokenEndpointAuthMethod,
    authorizationChallenge,
    replaceClientOnConnect = false,
  }: CreateOAuthDriverParams): McpOAuthDriver {
    return new McpOAuthDriver({
      serverName,
      serverUrl,
      storage: this.oauthStorage,
      callbackServer: this.callbackServer,
      replaceClientOnConnect,
      onNotification: (notification) => {
        // Only show notifications when enabled
        if (showNotifications && this.addMessageCallback) {
          this.addMessageCallback(notification);
        }
      },
      onAuthRequired: (info) => {
        this.markServerRequiresOAuth({
          serverName: info.serverName,
          serverUrl,
        });
        if (!showNotifications) {
          return;
        }
        this.pendingAuthByServer.set(
          normalizeServerName(info.serverName),
          info
        );
        this.emit(McpServiceEventType.AUTH_REQUIRED, info);
        this.oauthDrivers.set(
          normalizeServerName(serverName),
          this.createOAuthDriver({
            serverName,
            serverUrl,
            discovery,
            configuredScopes,
            configuredClientInformation,
            configuredAuthorizationServerIssuer,
            configuredClientMetadataUrl,
            configuredTokenEndpointAuthMethod,
            authorizationChallenge,
          })
        );
      },
      autoOpenBrowser: showNotifications, // Auto-open browser when showing notifications
      configuredScopes,
      configuredClientInformation,
      configuredAuthorizationServerIssuer,
      configuredClientMetadataUrl,
      configuredTokenEndpointAuthMethod,
      remoteCallbackUri: this.remoteCallbackUri,
      initialAuthorizationChallenge: authorizationChallenge,
      discoveredMetadata: discovery
        ? {
            resourceMetadata: discovery.resourceMetadata,
            authServerMetadata: discovery.authServerMetadata,
            scopes: discovery.scopes,
          }
        : undefined,
    });
  }

  private clearOAuthDriverState(serverName: string): void {
    this.oauthDrivers.delete(serverName);
    this.pendingAuthByServer.delete(normalizeServerName(serverName));
    this.clearOAuthSupportState(serverName);
  }

  private getOrCreateOAuthDriver(
    serverName: string,
    config: Extract<McpServerConfig, { type: 'http' | 'sse' }>
  ): McpOAuthDriver | undefined {
    if (!isOAuthEnabledRemoteMcpServer(config)) {
      this.clearOAuthDriverState(serverName);
      return undefined;
    }

    const existingDriver = this.oauthDrivers.get(serverName);
    if (existingDriver) {
      return existingDriver;
    }

    const oauth = getOAuthOptions(config);
    const cacheKey = this.getOAuthSupportCacheKey({
      serverName,
      serverUrl: config.url,
    });
    const discovery = this.applyOAuthSupportRequiresAuthOverride(
      cacheKey,
      this.oauthSupportCache.get(cacheKey)
    );
    const driver = this.createOAuthDriver({
      serverName,
      serverUrl: config.url,
      discovery: discovery?.requiresAuth ? discovery : undefined,
      configuredScopes: oauth?.scopes,
      configuredClientInformation: getConfiguredOAuthClientInformation(
        serverName,
        config
      ),
      configuredAuthorizationServerIssuer: oauth?.authorizationServerIssuer,
      configuredClientMetadataUrl: oauth?.clientMetadataUrl,
      configuredTokenEndpointAuthMethod: oauth?.tokenEndpointAuthMethod,
    });
    this.oauthDrivers.set(serverName, driver);
    return driver;
  }

  /**
   * Set the remote callback URI for daemon sessions.
   * When set, OAuth drivers will use this URI instead of localhost.
   *
   * Drivers capture the redirect URI used for registration, so a frontend
   * switch invalidates cached drivers before the next connection attempt.
   */
  public setRemoteCallbackUri(uri: string): void {
    if (this.remoteCallbackUri === uri) {
      return;
    }
    this.remoteCallbackUri = uri;
    this.callbackServer.cancelAllPendingCallbacks();
    this.pendingAuthByServer.clear();
    this.oauthDrivers.clear();
  }

  public async cleanup(): Promise<void> {
    this.unregisterAllMcpTools();
    this.closeOAuthCredentialWatcher();

    // Close all MCP servers (terminates chrome-devtools, playwright, etc.)
    if (this.mcpHub) {
      try {
        await this.mcpHub.closeAllServers();
      } catch (error) {
        logWarn('[McpService] Error closing MCP servers', { error });
      }
    }

    if (this.settingsChangeListener) {
      this.settingsChangeListener();
      this.settingsChangeListener = null;
    }
    try {
      this.callbackServer.close();
    } catch (error) {
      logWarn('[McpService] Error closing callback server', { error });
    }
  }

  /**
   * Stop watching for config file changes.
   * Used by ACP to prevent file watcher from interfering with merged configs.
   */
  public async stopWatching(): Promise<void> {
    if (this.settingsChangeListener) {
      this.settingsChangeListener();
      this.settingsChangeListener = null;
    }
    this.settingsManager.disableWatching();
    this.closeOAuthCredentialWatcher();
    logInfo('[McpService] Stopped watching for config file changes');
  }

  /**
   * Get all available tools from all MCP servers.
   * Returns an empty object if MCP service is not initialized.
   * @param opts.includeDisabled - If true, includes tools that are disabled in the config
   */
  public async getAllTools(opts?: {
    includeDisabled?: boolean;
  }): Promise<Record<string, McpTool[]>> {
    await this.waitForInitializationIfNeeded();

    if (!this.mcpHub) {
      throw new MetaError('MCP service not initialized');
    }

    try {
      return await this.mcpHub.listAllTools(opts);
    } catch (error) {
      logException(error, '[McpService] Failed to list tools');
      return {};
    }
  }

  public async resolveFormattedToolName(
    toolName: string
  ): Promise<{ serverName: string; toolName: string } | null> {
    const allTools = await this.getAllTools();
    for (const [serverName, serverTools] of Object.entries(allTools)) {
      for (const tool of serverTools) {
        if (formatToolName(serverName, tool.name) === toolName) {
          return { serverName, toolName: tool.name };
        }
      }
    }

    return null;
  }

  /**
   * Snapshot variant of {@link getAllTools} that does NOT await MCP
   * initialization. Returns `{}` if the hub has not been constructed yet,
   * otherwise returns whatever tools are currently reachable on the hub.
   *
   * Use this on hot paths (e.g. the JSON-RPC list_mcp_tools handler) where
   * blocking on the initial bulk reload would freeze the UI. Consumers
   * should refresh via MCP_STATUS_CHANGED notifications as servers come
   * online.
   */
  public async getAllToolsSnapshot(opts?: {
    includeDisabled?: boolean;
  }): Promise<Record<string, McpTool[]>> {
    if (!this.mcpHub) {
      return {};
    }

    try {
      return await this.mcpHub.listAllTools(opts);
    } catch (error) {
      logException(error, '[McpService] Failed to list tools (snapshot)');
      return {};
    }
  }

  /**
   * Call a tool on a specific MCP server.
   */
  public async callTool({
    serverName,
    toolName,
    args,
    sessionId = 'unknown-session',
  }: CallToolParams): Promise<CallToolResult> {
    await this.waitForInitializationIfNeeded();

    if (!this.mcpHub) {
      throw new MetaError('MCP service not initialized');
    }

    return await this.mcpHub.callTool(serverName, toolName, args, sessionId);
  }

  /**
   * Check if the MCP service is initialized and ready.
   */
  public isInitialized(): boolean {
    return this.mcpHub !== null;
  }

  /**
   * Get the list of currently running MCP servers.
   */
  public listServers(): Record<string, McpSubserver> {
    if (!this.mcpHub) {
      return {};
    }
    return this.mcpHub.getServers();
  }

  /**
   * Get the user's MCP server configurations.
   */
  public getUserMcpConfigs(): Record<string, McpServerConfig> {
    if (!this.mcpHub) {
      return {};
    }
    return this.mcpHub.getUserMcpConfigs();
  }

  /**
   * Enable a disabled MCP server and start only that server.
   */
  public async enableServer(
    name: string,
    settingsLevel: SettingsLevel
  ): Promise<void> {
    const normalizedName = normalizeServerName(name);
    await this.withTargetedOperation(async () => {
      const updated = await this.mcpSettingsManager.enableMcpServer(
        normalizedName,
        settingsLevel
      );
      if (!updated) {
        throw new MetaError('MCP server not found in configuration', {
          value: { serverName: normalizedName, settingsLevel },
        });
      }
      await this.syncConfigWithoutReload();
      this.oauthDrivers.delete(normalizedName);

      await this.startServerAndEmitResult(normalizedName);
      await this.refreshServerToolsAfterStart(normalizedName);
      void this.warmOAuthSupportForConfiguredServers([normalizedName]);
    });
  }

  /**
   * Disable an MCP server and stop it.
   */
  public async disableServer(
    name: string,
    settingsLevel: SettingsLevel
  ): Promise<void> {
    const normalizedName = normalizeServerName(name);
    await this.withTargetedOperation(async () => {
      // Get config before disabling to check if it's HTTP
      const configs = canonicalizeMcpServerNameMap(
        await this.mcpSettingsManager.getMcpServers()
      );
      const config = configs[normalizedName];

      const updated = await this.mcpSettingsManager.disableMcpServer(
        normalizedName,
        settingsLevel
      );
      if (!updated) {
        throw new MetaError('MCP server not found in configuration', {
          value: { serverName: normalizedName, settingsLevel },
        });
      }
      await this.syncConfigWithoutReload();

      // Disabling is a connection-lifecycle action: drop the in-memory OAuth
      // driver but keep persisted credentials so re-enabling reconnects
      // without forcing a new authorization flow.
      if (isOAuthEnabledRemoteMcpServer(config)) {
        this.oauthDrivers.delete(normalizedName);
      }

      await this.stopServerAndEmitResult(normalizedName);
      this.unregisterServerTools(normalizedName);
      this.lastServerErrors.delete(normalizedName);
      void this.warmOAuthSupportForConfiguredServers([normalizedName]);
    });
  }

  /**
   * Add a new MCP server to the user's configuration and start it.
   * This method handles file watching properly to avoid triggering global reloads.
   */
  public async addServer(name: string, config: McpServerConfig): Promise<void> {
    const normalized = normalizeServerName(name);
    await this.saveServerConfig(normalized, config);
    await this.startAddedServer(normalized);
  }

  /**
   * Save a server config to settings without starting it.
   */
  public async saveServerConfig(
    name: string,
    config: McpServerConfig
  ): Promise<void> {
    const normalizedName = normalizeServerName(name);

    await this.withTargetedOperation(async () => {
      this.clearOAuthSupportState(normalizedName);
      await this.mcpSettingsManager.addMcpServer(
        normalizedName,
        config,
        SettingsLevel.User
      );
      await this.syncConfigWithoutReload();
      this.oauthDrivers.delete(normalizedName);

      if (isOAuthEnabledRemoteMcpServer(config)) {
        void this.warmOAuthSupportForConfiguredServers([normalizedName]);
      } else {
        this.clearOAuthDriverState(normalizedName);
      }
    });
  }

  /**
   * Start a previously saved server and emit status events.
   */
  public async startAddedServer(name: string): Promise<void> {
    this.emit(McpServiceEventType.SERVERS_RELOADING);
    await this.startServerAndEmitResult(name);

    const serverError = this.lastServerErrors.get(name);
    const result: McpReloadResult = {
      stoppedServers: [],
      startedServers: serverError ? [] : [name],
      erroredServers: serverError ? [name] : [],
      unchangedServers: [],
      serverErrors: serverError ? new Map([[name, serverError]]) : new Map(),
      startAttempts: 1,
      stopAttempts: 0,
      startErrors: serverError ? 1 : 0,
      stopErrors: 0,
    };
    this.emit(McpServiceEventType.SERVERS_RELOADED, result);

    await this.refreshServerToolsAfterStart(name);
    void this.warmOAuthSupportForConfiguredServers([name]);
  }

  /**
   * Remove an MCP server from the user's configuration and stop it.
   * This method handles file watching properly to avoid triggering global reloads.
   */
  public async removeServer(
    name: string,
    settingsLevel: SettingsLevel
  ): Promise<void> {
    const normalizedName = normalizeServerName(name);
    await this.withTargetedOperation(async () => {
      const removed = await this.mcpSettingsManager.removeMcpServer(
        normalizedName,
        settingsLevel
      );
      if (!removed) {
        throw new MetaError('MCP server not found in configuration', {
          value: { serverName: normalizedName, settingsLevel },
        });
      }
      await this.syncConfigWithoutReload();
      await this.stopServerAndEmitResult(normalizedName);
      this.unregisterServerTools(normalizedName);
      this.oauthDrivers.delete(normalizedName);
      this.clearOAuthSupportState(normalizedName);
    });
  }

  /**
   * Enable or disable a specific MCP tool without triggering a full server reload.
   */
  public async toggleTool(
    serverName: string,
    toolName: string,
    enabled: boolean
  ): Promise<void> {
    const normalizedName = normalizeServerName(serverName);

    await this.withTargetedOperation(async () => {
      if (enabled) {
        await this.mcpSettingsManager.enableMcpTools(normalizedName, [
          toolName,
        ]);
      } else {
        await this.mcpSettingsManager.disableMcpTools(normalizedName, [
          toolName,
        ]);
      }
      await this.syncConfigWithoutReload();
      await this.refreshServerTools(normalizedName);
    });
  }

  /**
   * Retry connecting to a failed or disconnected MCP server.
   * @param name - Server name to retry
   */
  public async retryServer(name: string): Promise<void> {
    const normalizedName = normalizeServerName(name);
    await this.syncConfigWithoutReload();
    this.oauthDrivers.delete(normalizedName);

    await this.startServerAndEmitResult(normalizedName);
    await this.refreshServerToolsAfterStart(normalizedName);
    void this.warmOAuthSupportForConfiguredServers([normalizedName]);
  }

  /**
   * Set merged MCP configs (in-memory only, not persisted to disk).
   * Used by ACP to merge client-provided MCP servers with filesystem configs.
   */
  public async setMergedMcpConfigs(
    configs: Record<string, McpServerConfig>
  ): Promise<McpReloadResult> {
    if (!this.mcpHub) {
      throw new MetaError('MCP service not initialized');
    }
    const canonicalConfigs = canonicalizeMcpServerNameMap(configs);

    // Unregister existing MCP tools before reload
    this.unregisterAllMcpTools();

    for (const serverName of Array.from(this.oauthDrivers.keys())) {
      if (
        !Object.prototype.hasOwnProperty.call(canonicalConfigs, serverName) ||
        !isOAuthEnabledRemoteMcpServer(canonicalConfigs[serverName])
      ) {
        this.clearOAuthDriverState(serverName);
      }
    }
    this.oauthDrivers.clear();

    // Mark new servers as connecting
    const runningServers = this.listServers();
    for (const name of Object.keys(canonicalConfigs)) {
      if (!runningServers[name] && !canonicalConfigs[name].disabled) {
        this.connectingServers.add(name);
      }
    }
    this.emit(McpServiceEventType.SERVERS_RELOADING);
    const reloadStart = performance.now();
    const result = await this.mcpHub.setUserMcpConfigs(canonicalConfigs);
    const reloadDurationMs = performance.now() - reloadStart;
    // Clear connecting servers and store errors
    this.connectingServers.clear();
    this.lastServerErrors = result.serverErrors;
    this.emit(McpServiceEventType.SERVERS_RELOADED, result);

    // Log MCP server startup metrics
    McpService.logMcpServerMetrics(result, 'ACP merge', reloadDurationMs);

    // Re-register MCP tools after reload
    await this.registerAllMcpTools();
    void this.warmOAuthSupportForConfiguredServers();

    return result;
  }

  /**
   * Get server errors from the last reload.
   */
  public getServerErrors(): Map<string, Error> {
    return this.lastServerErrors;
  }

  public getPendingAuth(serverName: string): McpAuthRequiredInfo | undefined {
    return this.pendingAuthByServer.get(normalizeServerName(serverName));
  }

  /**
   * Get servers that are currently connecting.
   */
  public getConnectingServers(): Set<string> {
    return this.connectingServers;
  }

  public scheduleReconnectWithSharedOAuthCredentials(
    serverName: string,
    credentialFingerprint: string
  ): void {
    const normalizedName = normalizeServerName(serverName);
    if (
      this.sharedCredentialReconnects.has(normalizedName) ||
      this.sharedCredentialReconnectFingerprints.get(normalizedName) ===
        credentialFingerprint
    ) {
      return;
    }

    this.sharedCredentialReconnects.add(normalizedName);
    this.sharedCredentialReconnectFingerprints.set(
      normalizedName,
      credentialFingerprint
    );
    this.connectingServers.add(normalizedName);

    void this.retryServer(normalizedName)
      .catch((error) => {
        logWarn(
          '[McpService] Failed to reconnect with shared MCP OAuth credentials',
          { name: normalizedName, cause: error }
        );
      })
      .finally(() => {
        this.sharedCredentialReconnects.delete(normalizedName);
        this.connectingServers.delete(normalizedName);
      });
  }

  private getOAuthSupportCacheKey({
    serverName,
    serverUrl,
  }: OAuthServerParams): string {
    return `${normalizeServerName(serverName)}:${serverUrl}`;
  }

  private markServerRequiresOAuth({
    serverName,
    serverUrl,
  }: OAuthServerParams): void {
    const normalizedName = normalizeServerName(serverName);
    const cacheKey = this.getOAuthSupportCacheKey({
      serverName: normalizedName,
      serverUrl,
    });
    if (this.oauthServersRequiringAuth.has(cacheKey)) {
      return;
    }

    this.oauthServersRequiringAuth.add(cacheKey);
    this.emit(McpServiceEventType.OAUTH_SUPPORT_UPDATED, normalizedName);
  }

  private setOAuthSupportCache({
    serverName,
    serverUrl,
    result,
  }: SetOAuthSupportCacheParams): void {
    const normalizedName = normalizeServerName(serverName);
    const cacheKey = this.getOAuthSupportCacheKey({
      serverName: normalizedName,
      serverUrl,
    });
    const cached = this.oauthSupportCache.get(cacheKey);

    if (cached && isDeepStrictEqual(cached, result)) {
      return;
    }

    this.oauthSupportCache.set(cacheKey, result);
    this.emit(McpServiceEventType.OAUTH_SUPPORT_UPDATED, normalizedName);
  }

  private applyOAuthSupportRequiresAuthOverride(
    cacheKey: string,
    result: OAuthDiscoveryResult | undefined
  ): OAuthDiscoveryResult | undefined {
    if (!this.oauthServersRequiringAuth.has(cacheKey)) {
      return result;
    }

    if (!result) {
      return { requiresAuth: true };
    }

    return result.requiresAuth ? result : { ...result, requiresAuth: true };
  }

  private async discoverAndCacheOAuthSupport({
    serverName,
    serverUrl,
  }: OAuthServerParams): Promise<OAuthDiscoveryResult | undefined> {
    const normalizedName = normalizeServerName(serverName);
    const cacheKey = this.getOAuthSupportCacheKey({
      serverName: normalizedName,
      serverUrl,
    });
    const cached = this.oauthSupportCache.get(cacheKey);
    if (cached) {
      return this.applyOAuthSupportRequiresAuthOverride(cacheKey, cached);
    }

    const existingWarmup = this.oauthSupportWarmups.get(cacheKey);
    if (existingWarmup) {
      await existingWarmup;
      const warmedResult = this.oauthSupportCache.get(cacheKey);
      return warmedResult
        ? this.applyOAuthSupportRequiresAuthOverride(cacheKey, warmedResult)
        : undefined;
    }

    const warmup = (async () => {
      try {
        const discovered = await OAuthDiscovery.discoverOAuthSupport(serverUrl);
        if (!this.oauthSupportWarmups.has(cacheKey)) {
          return;
        }
        const result = this.applyOAuthSupportRequiresAuthOverride(
          cacheKey,
          discovered
        );
        if (result) {
          this.setOAuthSupportCache({
            serverName: normalizedName,
            serverUrl,
            result,
          });
        }
      } catch (error) {
        logWarn('[McpService] Error checking OAuth support', {
          name: normalizedName,
          error,
        });
      }
    })().finally(() => {
      this.oauthSupportWarmups.delete(cacheKey);
    });

    this.oauthSupportWarmups.set(cacheKey, warmup);
    await warmup;
    const cachedResult = this.oauthSupportCache.get(cacheKey);
    return cachedResult
      ? this.applyOAuthSupportRequiresAuthOverride(cacheKey, cachedResult)
      : undefined;
  }

  private async warmOAuthSupportForConfiguredServers(
    serverNames?: string[]
  ): Promise<void> {
    try {
      const [allConfigs, mcpPolicy] = await Promise.all([
        this.mcpSettingsManager.getMcpServers(),
        this.mcpSettingsManager.getMcpPolicy(),
      ]);
      const configs = McpService.getEnabledServerConfigsAllowedByPolicy(
        canonicalizeMcpServerNameMap(allConfigs),
        mcpPolicy
      );
      const normalizedServerNames = serverNames
        ? new Set(serverNames.map((name) => normalizeServerName(name)))
        : null;

      for (const [serverName, config] of Object.entries(configs)) {
        const normalizedServerName = normalizeServerName(serverName);
        if (
          normalizedServerNames !== null &&
          !normalizedServerNames.has(normalizedServerName)
        ) {
          continue;
        }

        if (!isOAuthEnabledRemoteMcpServer(config)) {
          continue;
        }

        void this.discoverAndCacheOAuthSupport({
          serverName: normalizedServerName,
          serverUrl: config.url,
        });
      }
    } catch (error) {
      logWarn('[McpService] Error warming OAuth support cache', {
        error,
        serverIds: serverNames,
      });
    }
  }

  private removeOAuthSupportStateWhere(
    shouldDelete: (cacheKey: string) => boolean
  ): void {
    for (const key of Array.from(this.oauthSupportCache.keys())) {
      if (shouldDelete(key)) {
        this.oauthSupportCache.delete(key);
      }
    }

    for (const key of Array.from(this.oauthSupportWarmups.keys())) {
      if (shouldDelete(key)) {
        this.oauthSupportWarmups.delete(key);
      }
    }

    for (const key of Array.from(this.oauthServersRequiringAuth)) {
      if (shouldDelete(key)) {
        this.oauthServersRequiringAuth.delete(key);
      }
    }
  }

  private pruneOAuthSupportState(
    configs: Record<string, McpServerConfig>
  ): void {
    const canonicalConfigs = canonicalizeMcpServerNameMap(configs);
    const configuredRemoteKeys = new Set<string>();
    for (const [serverName, config] of Object.entries(canonicalConfigs)) {
      if (!isOAuthEnabledRemoteMcpServer(config)) {
        continue;
      }

      configuredRemoteKeys.add(
        this.getOAuthSupportCacheKey({
          serverName,
          serverUrl: config.url,
        })
      );
    }
    this.removeOAuthSupportStateWhere((key) => !configuredRemoteKeys.has(key));
  }

  private clearOAuthSupportState(serverName: string): void {
    const normalizedName = normalizeServerName(serverName);
    const prefix = `${normalizedName}:`;
    this.removeOAuthSupportStateWhere((key) => key.startsWith(prefix));
  }

  /**
   * Check if a server supports OAuth authentication.
   * This performs OAuth discovery to determine if the server requires authentication.
   */
  public async checkOAuthSupport(
    serverName: string,
    opts?: { useCacheOnly?: boolean }
  ): Promise<OAuthDiscoveryResult | undefined> {
    const normalizedName = normalizeServerName(serverName);
    const configs = canonicalizeMcpServerNameMap(
      await this.mcpSettingsManager.getMcpServers()
    );
    const config = configs[normalizedName];

    if (!isOAuthEnabledRemoteMcpServer(config)) {
      return { requiresAuth: false };
    }

    const cacheKey = this.getOAuthSupportCacheKey({
      serverName: normalizedName,
      serverUrl: config.url,
    });
    const cached = this.oauthSupportCache.get(cacheKey);
    const requiresAuthOverride = this.oauthServersRequiringAuth.has(cacheKey);

    if (cached) {
      return this.applyOAuthSupportRequiresAuthOverride(cacheKey, cached);
    }

    if (opts?.useCacheOnly) {
      return requiresAuthOverride ? { requiresAuth: true } : undefined;
    }

    return await this.discoverAndCacheOAuthSupport({
      serverName: normalizedName,
      serverUrl: config.url,
    });
  }

  /**
   * Check if a server has valid OAuth tokens.
   */
  private async getValidOAuthCredentialFingerprintForConfig(
    serverName: string,
    config: Extract<McpServerConfig, { type: 'http' | 'sse' }>
  ): Promise<string | undefined> {
    try {
      const credential = await this.oauthStorage.readServerCredential(
        serverName,
        config.url
      );
      const hasValidTokens = Boolean(
        credential?.authorizationServerIssuer &&
          credential.clientInformation?.client_id &&
          credential.tokens?.access_token &&
          (credential.tokens.expiresAt === undefined ||
            credential.tokens.expiresAt > Date.now() ||
            Boolean(credential.tokens.refresh_token))
      );
      if (!hasValidTokens || !credential?.tokens?.access_token) {
        return undefined;
      }
      return crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            authorizationServerIssuer: credential.authorizationServerIssuer,
            accessToken: credential.tokens.access_token,
          })
        )
        .digest('hex');
    } catch (error) {
      logWarn('[McpService] Error checking OAuth tokens', { error });
      return undefined;
    }
  }

  public async getValidOAuthCredentialFingerprint(
    serverName: string
  ): Promise<string | undefined> {
    const normalizedName = normalizeServerName(serverName);
    const configs = canonicalizeMcpServerNameMap(
      await this.mcpSettingsManager.getMcpServers()
    );
    const config = configs[normalizedName];

    if (!isOAuthEnabledRemoteMcpServer(config)) {
      return undefined;
    }

    return await this.getValidOAuthCredentialFingerprintForConfig(
      normalizedName,
      config
    );
  }

  public async hasValidOAuthTokens(serverName: string): Promise<boolean> {
    return Boolean(await this.getValidOAuthCredentialFingerprint(serverName));
  }

  /**
   * Trigger authentication for a server by clearing its tokens and reloading all servers.
   * This forces the OAuth flow to run again.
   */
  public async triggerAuthentication(serverName: string): Promise<void> {
    const normalizedName = normalizeServerName(serverName);

    if (!this.mcpHub) {
      throw new MetaError('MCP service not initialized');
    }

    const configs = canonicalizeMcpServerNameMap(
      await this.mcpSettingsManager.getMcpServers()
    );
    const config = configs[normalizedName];

    if (!config) {
      throw new MetaError('Server not found');
    }

    // Check if server is blocked by organization's MCP policy
    const isAllowed =
      await this.mcpSettingsManager.checkServerAgainstPolicy(config);
    if (!isAllowed) {
      throw new MetaError(
        "Server is not on your organization's allowlist. Contact your admin to allow it.",
        { name: normalizedName }
      );
    }

    if (!isRemoteMcpServer(config)) {
      throw new MetaError(getI18n().t('common:mcpAuth.httpOnly'));
    }

    if (config.oauth === false) {
      throw new MetaError('MCP OAuth is disabled for this server');
    }
    const oauth = getOAuthOptions(config);

    const serverOrigin = getUrlOrigin(config.url);
    const authorizationChallenge =
      this.oauthDrivers.get(normalizedName)?.authorizationChallenge;

    // Discover OAuth metadata to ensure server supports OAuth
    const discovery = authorizationChallenge
      ? await OAuthDiscovery.discoverOAuthSupport(config.url, {
          challenge: authorizationChallenge,
        })
      : await OAuthDiscovery.discoverOAuthSupport(config.url);
    this.setOAuthSupportCache({
      serverName: normalizedName,
      serverUrl: config.url,
      result: discovery,
    });

    if (!discovery.requiresAuth) {
      logInfo(
        '[McpService] OAuth discovery did not indicate auth; continuing due to user request',
        {
          name: normalizedName,
          url: serverOrigin,
        }
      );
    }

    logInfo('[McpService] Server requires OAuth, initiating authentication', {
      name: normalizedName,
      url: serverOrigin,
    });

    // Set flag to prevent config reload during authentication
    this.authenticatingServer = normalizedName;

    await this.startOAuthCallbackServerIfNeeded({ [normalizedName]: config });

    // Cancel any pending OAuth callbacks for this server
    this.callbackServer.cancelPendingCallbacksForServer(normalizedName);
    this.pendingAuthByServer.delete(normalizedName);

    // Remove and recreate OAuth driver with notifications enabled and discovered metadata.
    // Stored credentials are kept and only replaced when the new authorization succeeds.
    this.oauthDrivers.delete(normalizedName);
    const driver = this.createOAuthDriver({
      serverName: normalizedName,
      serverUrl: config.url,
      showNotifications: true, // Show notifications for user-initiated authentication
      discovery: discovery.requiresAuth ? discovery : undefined,
      configuredScopes: oauth?.scopes,
      configuredClientInformation: getConfiguredOAuthClientInformation(
        normalizedName,
        config
      ),
      configuredAuthorizationServerIssuer: oauth?.authorizationServerIssuer,
      configuredClientMetadataUrl: oauth?.clientMetadataUrl,
      configuredTokenEndpointAuthMethod: oauth?.tokenEndpointAuthMethod,
      authorizationChallenge,
      replaceClientOnConnect: true,
    });
    this.oauthDrivers.set(normalizedName, driver);

    logInfo('[McpService] triggerAuthentication - driver created', {
      name: normalizedName,
      url: serverOrigin,
      serverIds: Array.from(this.oauthDrivers.keys()),
    });

    // Retry only the specific server to trigger OAuth flow with the new driver
    // This avoids restarting all servers which would disrupt other connections
    this.emit(McpServiceEventType.SERVERS_RELOADING);
    const reloadStart = performance.now();
    try {
      await this.mcpHub.retryServer(normalizedName);
      const reloadDurationMs = performance.now() - reloadStart;

      // Build a result object for metrics and status update
      const result: McpReloadResult = {
        startedServers: [normalizedName],
        stoppedServers: [normalizedName],
        erroredServers: [],
        unchangedServers: [],
        serverErrors: new Map(),
        startAttempts: 1,
        stopAttempts: 1,
        startErrors: 0,
        stopErrors: 0,
      };
      // Clear error for this server on success
      this.lastServerErrors.delete(normalizedName);
      this.emit(McpServiceEventType.SERVERS_RELOADED, result);

      // Log MCP server startup metrics
      McpService.logMcpServerMetrics(
        result,
        'authentication',
        reloadDurationMs
      );

      await this.refreshServerToolsAfterStart(normalizedName);
    } catch (error) {
      const reloadDurationMs = performance.now() - reloadStart;
      // Build error result
      const serverError =
        error instanceof Error ? error : new Error(String(error));
      const hasStoredCredentials =
        await this.hasValidOAuthTokens(normalizedName);

      // The forced retry tore down the previous connection; when usable
      // credentials are still stored, restore that connection so a cancelled
      // or failed re-authentication does not leave the server disconnected.
      let restored = false;
      if (hasStoredCredentials) {
        this.oauthDrivers.set(
          normalizedName,
          this.createOAuthDriver({
            serverName: normalizedName,
            serverUrl: config.url,
            discovery: discovery.requiresAuth ? discovery : undefined,
            configuredScopes: oauth?.scopes,
            configuredClientInformation: getConfiguredOAuthClientInformation(
              normalizedName,
              config
            ),
            configuredAuthorizationServerIssuer:
              oauth?.authorizationServerIssuer,
            configuredClientMetadataUrl: oauth?.clientMetadataUrl,
            configuredTokenEndpointAuthMethod: oauth?.tokenEndpointAuthMethod,
            authorizationChallenge,
          })
        );
        try {
          await this.mcpHub.retryServer(normalizedName);
          restored = true;
        } catch (restoreError) {
          logWarn(
            '[McpService] Failed to restore connection after failed authentication',
            { name: normalizedName, cause: restoreError }
          );
        }
      }

      const statusError =
        discovery.requiresAuth && !hasStoredCredentials
          ? new Error('Authentication required')
          : serverError;
      const result: McpReloadResult = restored
        ? {
            startedServers: [normalizedName],
            stoppedServers: [normalizedName],
            erroredServers: [],
            unchangedServers: [],
            serverErrors: new Map(),
            startAttempts: 1,
            stopAttempts: 1,
            startErrors: 0,
            stopErrors: 0,
          }
        : {
            startedServers: [],
            stoppedServers: [normalizedName],
            erroredServers: [normalizedName],
            unchangedServers: [],
            serverErrors: new Map([[normalizedName, statusError]]),
            startAttempts: 1,
            stopAttempts: 1,
            startErrors: 1,
            stopErrors: 0,
          };
      if (restored) {
        this.lastServerErrors.delete(normalizedName);
      } else {
        // Keep auth-capable servers in an auth-required state when authentication
        // did not complete, so the TUI continues to offer Authenticate instead of Retry.
        this.lastServerErrors.set(normalizedName, statusError);
      }
      this.emit(McpServiceEventType.SERVERS_RELOADED, result);

      // Log MCP server startup metrics
      McpService.logMcpServerMetrics(
        result,
        'authentication',
        reloadDurationMs
      );

      await this.refreshServerToolsAfterStart(normalizedName);

      let errorDetails = '';
      if (
        serverError instanceof MetaError &&
        serverError.metadata?.errorMessage
      ) {
        errorDetails = serverError.metadata.errorMessage;
      } else {
        errorDetails = serverError.message;
      }

      throw new MetaError(
        `Authentication failed for ${normalizedName}.${errorDetails ? `\n\n${errorDetails}` : ''}`,
        {
          name: normalizedName,
          cause: serverError,
        }
      );
    } finally {
      // Clear flag to allow config reloads again
      this.authenticatingServer = null;
    }
  }

  /**
   * Cancel a pending OAuth authentication flow for a specific server.
   *
   * This cancels any pending OAuth callbacks and clears the authenticating server flag.
   * Does NOT clear stored OAuth tokens - use clearOAuthAndDisconnect for that.
   *
   * @param serverName - The name of the server to cancel authentication for
   */
  public async cancelAuthentication(serverName: string): Promise<void> {
    const normalizedName = normalizeServerName(serverName);

    logInfo('[McpService] cancelAuthentication called', {
      name: normalizedName,
    });

    // Cancel any pending OAuth callbacks for this server
    const cancelledCount =
      this.callbackServer.cancelPendingCallbacksForServer(normalizedName);
    this.pendingAuthByServer.delete(normalizedName);

    // If we didn't actually cancel a pending callback, nothing else will emit an auth completion
    // event. Emit one here so the UI can clear any lingering pending-auth state.
    if (cancelledCount === 0) {
      this.emit(McpServiceEventType.AUTH_COMPLETED, {
        serverName: normalizedName,
        outcome: McpAuthOutcome.Cancelled,
        message: getI18n().t('common:mcpAuth.authCancelledGeneric'),
      });

      this.addMessageCallback?.(
        getI18n().t('common:mcpAuth.authCancelled', {
          serverName: normalizedName,
        })
      );
    }

    // Clear the authenticating server flag if it matches
    if (this.authenticatingServer === normalizedName) {
      this.authenticatingServer = null;
    }

    logInfo('[McpService] OAuth authentication cancelled', {
      name: normalizedName,
    });
  }

  /**
   * Submit an OAuth authorization code for a remote session.
   * Called when the daemon forwards a code from the frontend.
   * @returns true if a matching pending callback was resolved
   */
  public submitAuthCode(params: {
    serverName: string;
    code: string;
    state: string;
  }): boolean {
    logInfo('[McpService] submitAuthCode called', {
      name: params.serverName,
      hasState: Boolean(params.state),
    });

    return this.callbackServer.submitCodeForState({
      state: params.state,
      serverName: params.serverName,
      code: params.code,
    });
  }

  public submitAuthError(params: {
    serverName: string;
    error: string;
    errorDescription?: string;
    state: string;
  }): boolean {
    logInfo('[McpService] submitAuthError called', {
      name: params.serverName,
      hasState: Boolean(params.state),
    });

    return this.callbackServer.submitErrorForState({
      state: params.state,
      serverName: params.serverName,
      error: params.error,
      errorDescription: params.errorDescription,
    });
  }

  /**
   * Clear OAuth credentials for a server and disconnect it.
   */
  public async clearAuthentication(serverName: string): Promise<void> {
    const normalizedName = normalizeServerName(serverName);

    if (!this.mcpHub) {
      throw new MetaError('MCP service not initialized');
    }

    const configs = canonicalizeMcpServerNameMap(
      await this.mcpSettingsManager.getMcpServers()
    );
    const config = configs[normalizedName];

    if (!config) {
      throw new MetaError('Server not found');
    }

    if (!isRemoteMcpServer(config)) {
      throw new MetaError(getI18n().t('common:mcpAuth.clearHttpOnly'));
    }

    if (config.oauth === false) {
      throw new MetaError('MCP OAuth is disabled for this server');
    }

    // Clear all stored OAuth credentials for this server.
    await this.oauthStorage.deleteServerCredential({
      serverName: normalizedName,
      serverUrl: config.url,
    });
    this.markServerRequiresOAuth({
      serverName: normalizedName,
      serverUrl: config.url,
    });
    this.pendingAuthByServer.delete(normalizedName);

    // Cancel any pending OAuth callbacks for this server
    // Use the server-specific method to avoid affecting other servers' OAuth flows
    this.callbackServer.cancelPendingCallbacksForServer(normalizedName);

    // Remove the OAuth driver for the target server
    this.oauthDrivers.delete(normalizedName);

    // Only disconnect the specific server, don't reload all servers
    // This prevents cross-contamination of status for other connected servers
    const servers = this.mcpHub.getServers();
    if (servers[normalizedName]) {
      await this.mcpHub.removeServer(normalizedName);
    }

    // Unregister tools for this server only
    this.unregisterServerTools(normalizedName);

    // Mark the target server as requiring authentication
    this.lastServerErrors.set(
      normalizedName,
      new Error('Authentication required')
    );

    const result: McpReloadResult = {
      stoppedServers: [normalizedName],
      startedServers: [],
      erroredServers: [normalizedName],
      unchangedServers: [],
      serverErrors: new Map([
        [normalizedName, new Error('Authentication required')],
      ]),
      startAttempts: 0,
      stopAttempts: 1,
      startErrors: 0,
      stopErrors: 0,
    };

    this.emit(McpServiceEventType.SERVERS_RELOADED, result);

    // Log MCP server startup metrics
    McpService.logMcpServerMetrics(result, 'clear authentication');

    // Keep OAuth notifications suppressed to avoid auto-reconnect attempts
    // They will be re-enabled on next user-initiated authentication

    logInfo('[McpService] Cleared OAuth credentials and disconnected server');
  }

  /**
   * Cancel all pending OAuth authentication flows.
   * Used when the MCP settings modal is closed.
   */
  public cancelAllPendingAuth(): void {
    this.callbackServer.cancelAllPendingCallbacks();
  }

  /**
   * Register MCP tools from all servers with the TUI tool registry.
   * Errors are isolated per-server so one server's failure doesn't affect others.
   */
  public async registerAllMcpTools(): Promise<void> {
    if (!this.mcpHub) {
      return;
    }

    let toolsByServer: Record<string, McpTool[]>;
    try {
      toolsByServer = await this.mcpHub.listAllTools();
    } catch (error) {
      logException(error, '[McpService] Failed to list MCP tools');
      return;
    }

    for (const [serverName, tools] of Object.entries(toolsByServer)) {
      this.registerToolsForServer(serverName, tools);
    }

    this.emit(McpServiceEventType.TOOLS_UPDATED);
  }

  private registerToolsForServer(serverName: string, tools: McpTool[]): void {
    try {
      const registry = getTUIToolRegistry();
      const implementations = McpService.createMcpToolImplementations(
        serverName,
        tools
      );

      const toolIds: string[] = [];
      for (const impl of implementations) {
        registry.register(impl);
        toolIds.push(impl.tool.id);
        logInfo('Registered MCP tool', {
          toolId: impl.tool.id,
        });
      }

      this.registeredToolsByServer.set(serverName, toolIds);
    } catch (error) {
      logException(
        error,
        '[McpService] Failed to register tools for MCP server',
        {
          serviceName: serverName,
        }
      );
    }
  }

  private async refreshServerTools(
    serverName: string,
    opts?: { emitToolsUpdated?: boolean }
  ): Promise<void> {
    if (!this.mcpHub) {
      return;
    }

    let tools: McpTool[];
    try {
      tools = await this.mcpHub.listToolsForServer(serverName);
    } catch (error) {
      logException(
        error,
        '[McpService] Failed to refresh tools for MCP server',
        {
          serviceName: serverName,
        }
      );
      return;
    }

    this.unregisterServerTools(serverName, { emitToolsUpdated: false });
    this.registerToolsForServer(serverName, tools);
    if (opts?.emitToolsUpdated ?? true) {
      this.emit(McpServiceEventType.TOOLS_UPDATED);
    }
  }

  /**
   * Unregister MCP tools for a specific server.
   */
  public unregisterServerTools(
    serverName: string,
    opts?: { emitToolsUpdated?: boolean }
  ): void {
    const toolIds = this.registeredToolsByServer.get(serverName);
    if (!toolIds) {
      return;
    }

    for (const toolId of toolIds) {
      getTUIToolRegistry().unregisterTool(toolId);
    }

    this.registeredToolsByServer.delete(serverName);

    if (opts?.emitToolsUpdated ?? true) {
      this.emit(McpServiceEventType.TOOLS_UPDATED);
    }
  }

  /**
   * Unregister all MCP tools.
   */
  public unregisterAllMcpTools(): void {
    const serverNames = Array.from(this.registeredToolsByServer.keys());
    for (const serverName of serverNames) {
      this.unregisterServerTools(serverName, { emitToolsUpdated: false });
    }

    if (serverNames.length > 0) {
      this.emit(McpServiceEventType.TOOLS_UPDATED);
    }
  }

  /**
   * Convert an MCP tool to a Industry tool definition.
   */
  private static createMcpTool(
    mcpTool: McpTool,
    serverName: string
  ): IndustryTool {
    const toolId = `mcp_${serverName}_${mcpTool.name}`;
    const llmId = formatToolName(serverName, mcpTool.name);

    // Create a generic Zod schema from the MCP JSON schema
    // Since MCP provides JSON schema and we need Zod, we'll use a generic record type
    const inputZodSchema = z.record(z.unknown());

    const inputSchema: InputJSONSchema = mcpTool.inputSchema
      ? ({
          ...mcpTool.inputSchema,
          properties: mcpTool.inputSchema.properties ?? {},
        } satisfies InputJSONSchema)
      : {
          type: 'object',
          properties: {},
        };
    const deferred = shouldDeferMcpTool(serverName);

    return {
      id: toolId,
      llmId,
      displayName: `[MCP] ${serverName}:${mcpTool.name}`,
      description: mcpTool.description || `MCP tool from ${serverName}`,
      inputSchema,
      inputZodSchema,
      toolkit: `MCP:${serverName}`, // Custom toolkit name for MCP servers
      executionLocation: ToolExecutionLocation.Client,
      isMcpTool: true,
      isVisibleToUser: true,
      isTopLevelTool: true,
      requiresConfirmation: true,
      // MCP tool behavior is opaque: a server may read/write files, hit the
      // network, etc., and the protocol gives us no per-tool effect metadata.
      // ExternalService is the conservative choice because it has no sandbox
      // handler, so MCP tools fail closed under an active sandbox.
      sideEffects: [SandboxSideEffect.ExternalService],
      outputSchemas: {
        result: z.string(), // MCP tools return strings or JSON that we stringify
      },
      isToolEnabled: true,
      ...(deferred ? { deferred: true } : {}),
    };
  }

  /**
   * Create a complete tool implementation from an MCP tool.
   */
  private static createMcpToolImplementation(
    mcpTool: McpTool,
    serverName: string
  ): ToolImplementation<CliClientToolDependencies> {
    const industryTool = this.createMcpTool(mcpTool, serverName);
    return {
      tool: industryTool,
      executorIndustry: () => new McpToolExecutor(serverName, mcpTool.name),
    };
  }

  /**
   * Create multiple tool implementations from a server's tools.
   */
  private static createMcpToolImplementations(
    serverName: string,
    tools: McpTool[]
  ): ToolImplementation<CliClientToolDependencies>[] {
    return tools.map((tool) =>
      this.createMcpToolImplementation(tool, serverName)
    );
  }
}

let mcpServiceInstance: McpService | null = null;

/**
 * Get the singleton McpService instance.
 */
export function getMcpService(): McpService {
  if (!mcpServiceInstance) {
    mcpServiceInstance = new McpService();
  }
  return mcpServiceInstance;
}

export function getMcpServiceIfCreated(): McpService | null {
  return mcpServiceInstance;
}
