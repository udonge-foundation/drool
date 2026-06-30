import {
  DaemonRelayEvent,
  DaemonRelayGetStatusResult,
  DaemonRelayStatusChangedNotification,
  MachineType,
} from '@industry/common/daemon';
import {
  INDUSTRY_PROTOCOL_VERSION,
  LEGACY_INDUSTRY_API_VERSION,
  JSONRPC_VERSION,
} from '@industry/drool-sdk-ext/protocol/drool';
import { JsonRpcMessageType } from '@industry/drool-sdk-ext/protocol/shared';
import {
  logException,
  logInfo,
  logWarn,
  Metric,
  Metrics,
} from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { createDaemonRequestCore } from './core/createDaemonRequestCore';
import { DaemonIpcConnectionServer } from './ipc/ipc-connection-server';
import { DaemonWebSocketServer } from './web-socket-server';
import { DueRunPoller, recoverInterruptedRuns } from '../automations';
import {
  createDroolCapability,
  createManagementCapability,
  createRelayCapability,
  createSettingsCapability,
  createTerminalCapability,
} from '../capabilities';
import { RelayConnection } from '../relay/RelayConnection';
import { initializeApiClient } from '../services/ApiClient';
import { HeartbeatService } from '../services/HeartbeatService';
import { debugLog } from '../utils/debug-log';
import { MonotonicClock } from '../utils/monotonic-clock';

import type {
  ChildIpcAttacher,
  DaemonCapability,
  DaemonRequestCore,
} from './core/types';
import type { DaemonConnectionHandler } from './daemon-connection-handler';
import type { RelayControl } from './handlers/types';
import type { DaemonConfig, RelayConfig } from './types';

type CleanupStep = () => void | Promise<void>;

export class DaemonServer {
  private webSocketServer: DaemonWebSocketServer | null = null;

  private ipcConnectionServer: DaemonIpcConnectionServer | null = null;

  private core: DaemonRequestCore | null = null;

  private connectionHandler: DaemonConnectionHandler | null = null;

  private heartbeatService: HeartbeatService | null = null;

  private dueRunPoller: DueRunPoller | null = null;

  private relayConnection: RelayConnection | null = null;

  private relayComputerId: string | undefined;

  private config: DaemonConfig;

  private isRunning: boolean = false;

  private ipcActivityClock = new MonotonicClock();

  constructor(config: DaemonConfig) {
    this.config = config;

    if (this.config.debug) {
      debugLog('Daemon server initialized', {
        port: 'port' in config ? config.port : undefined,
        host: 'host' in config ? config.host : undefined,
        ipcOnly: config.ipcOnly ?? false,
        parentIpc: config.parentIpc ?? false,
        enableChildIpc: config.enableChildIpc ?? false,
      });
    }
  }

  private requireConnectionHandler(): DaemonConnectionHandler {
    if (!this.connectionHandler) {
      throw new MetaError(
        'Daemon connection handler is unavailable before start()'
      );
    }
    return this.connectionHandler;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new MetaError('Daemon server is already running');
    }

    // failure path observable.
    const startMs = Date.now();
    let outcome: 'ok' | 'error' = 'error';
    const startupCleanups: CleanupStep[] = [];
    const registerStartupCleanup = (cleanup: CleanupStep): void => {
      startupCleanups.push(cleanup);
    };

    try {
      const config = this.config;

      const apiClient = initializeApiClient(config.runtimeAuthConfig);

      const relayControl: RelayControl | null = config.relayCapable
        ? {
            start: this.startRelay.bind(this),
            stop: () => this.stopRelay({ broadcast: true }),
            getStatus: this.getRelayStatus.bind(this),
            getComputerRegistration: async () =>
              (await this.resolveHostIdentity())?.computerRegistration ?? null,
            getApiBaseUrl: () => this.config.apiBaseUrl,
          }
        : null;

      const attachChildIpc: ChildIpcAttacher | undefined = config.enableChildIpc
        ? (params) => {
            if (!this.ipcConnectionServer) {
              throw new MetaError(
                'Child IPC is enabled but IPC connection server is unavailable'
              );
            }
            this.ipcConnectionServer.attachChildProcess(params);
          }
        : undefined;

      const capabilities: DaemonCapability[] = [
        createDroolCapability(attachChildIpc ? { attachChildIpc } : {}),
        createSettingsCapability(),
        createManagementCapability({ onUpdate: config.onIdleUpdate }),
        createTerminalCapability(),
        ...(relayControl ? [createRelayCapability({ relayControl })] : []),
      ];

      const { core, connectionHandler } = await createDaemonRequestCore({
        machineId: config.machineId,
        machineType: config.machineType ?? MachineType.Local,
        apiBaseUrl: config.apiBaseUrl,
        deploymentEnv: config.deploymentEnv,
        isDevelopment: !config.isProductionTier,
        droolExecPath: config.droolExecPath,
        runtimeAuthConfig: config.runtimeAuthConfig,
        apiClient,
        homeDir: config.homeDir,
        shell: config.shell,
        terminalEnv: config.terminalEnv,
        sessionTimeoutMsOverride: config.sessionTimeoutMsOverride,
        cliVersion: config.version,
        connectionLabel: config.ipcOnly ? 'IPC' : 'Daemon',
        capabilities,
        debug: config.debug,
      });

      this.core = core;
      this.connectionHandler = connectionHandler;

      // When no transport is configured, skip creating the WebSocket server.
      // This applies to ipc-only mode and to relay-only daemons (Drool
      // Computers) that receive inbound connections through the relay.
      const hasUnixSocket = 'unix' in config && config.unix;
      const hasTcpPort = 'port' in config && config.port != null;
      const skipWebSocket = config.ipcOnly || (!hasUnixSocket && !hasTcpPort);
      this.webSocketServer = skipWebSocket
        ? null
        : new DaemonWebSocketServer(connectionHandler, config);

      if (config.parentIpc || config.enableChildIpc) {
        this.ipcConnectionServer = new DaemonIpcConnectionServer({
          connectionHandler,
          enableParentIpc: config.parentIpc ?? false,
          onActivity: () => this.ipcActivityClock.update(),
          onParentIpcDisconnected: config.onParentIpcDisconnected,
        });
      }

      this.heartbeatService = new HeartbeatService({
        droolRegistry: core.registry,
        apiClient,
        machineId: config.machineId,
        machineType: config.machineType,
        debug: config.debug,
        getLastServerActivityAt: () =>
          Math.max(
            this.relayConnection?.getLastActivityAt() ?? 0,
            this.webSocketServer?.getLastActivityAt() ?? 0,
            this.ipcActivityClock.now()
          ),
        onIdleUpdate: config.onIdleUpdate,
        getHostIdentity: async () =>
          (await this.resolveHostIdentity()) ?? undefined,
      });

      this.dueRunPoller = new DueRunPoller({
        basePath: config.homeDir,
        pollIntervalMs: 60_000,
        dispatchFn: async (automationId: string) =>
          this.requireConnectionHandler().dispatchAutomationRun(
            automationId,
            config.homeDir
          ),
        recordDispatchFailure: async (automationId, reason) =>
          this.requireConnectionHandler().recordAutomationDispatchFailure(
            automationId,
            reason,
            config.homeDir
          ),
      });

      if (this.ipcConnectionServer) {
        registerStartupCleanup(() => this.ipcConnectionServer?.stop());
        this.ipcConnectionServer.start();
      }

      if (this.webSocketServer) {
        registerStartupCleanup(() => this.webSocketServer?.close());
        await this.webSocketServer.start();
      }

      // Recover any interrupted automation runs from previous session
      try {
        const recovered = await recoverInterruptedRuns(config.homeDir);
        if (recovered.length > 0) {
          logInfo('Recovered interrupted automation runs', {
            count: recovered.length,
          });
        }
      } catch (err) {
        // Non-blocking - recovery failure should not prevent startup
        logException(err, 'Failed to recover interrupted automation runs');
      }

      if (config.relay) {
        registerStartupCleanup(() => this.stopRelay());
        await this.startRelay(config.relay);
      }

      registerStartupCleanup(() => this.heartbeatService?.stop());
      this.heartbeatService.start();

      const isLocalMachine = config.machineType === MachineType.Local;
      if (isLocalMachine) {
        registerStartupCleanup(() => this.dueRunPoller?.stop());
        this.dueRunPoller.start();
      } else {
        logInfo('Skipping automation poller on non-local daemon');
      }

      this.isRunning = true;
      outcome = 'ok';

      if (config.debug) {
        debugLog('Daemon server started successfully');
      }
    } catch (error) {
      await this.rollbackFailedStart(startupCleanups);
      this.isRunning = false;
      throw error;
    } finally {
      const startDurationMs = Date.now() - startMs;
      logInfo('[DaemonServer] daemon-internal start complete', {
        durationMs: startDurationMs,
        platform: process.platform,
        outcome,
      });
      Metrics.recordHistogram(
        Metric.DAEMON_INTERNAL_START_DURATION_MS,
        startDurationMs,
        { os: process.platform, outcome }
      );
    }
  }

  private async rollbackFailedStart(
    startupCleanups: CleanupStep[]
  ): Promise<void> {
    for (const cleanup of startupCleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        logException(error, '[DaemonServer] Failed to rollback startup step');
      }
    }

    if (this.core) {
      try {
        await this.core.shutdown();
      } catch (error) {
        logException(
          error,
          '[DaemonServer] Failed to shut down core during rollback'
        );
      }
    }

    this.core = null;
    this.connectionHandler = null;
    this.webSocketServer = null;
    this.ipcConnectionServer = null;
    this.heartbeatService = null;
    this.dueRunPoller = null;
    this.relayConnection = null;
    this.relayComputerId = undefined;
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Daemon-internal shutdown duration. try/finally + outcome keeps
    // failure paths alertable.
    const stopStartMs = Date.now();
    let outcome: 'ok' | 'error' = 'error';
    let firstStopError: unknown;
    const stopStep = async (
      name: string,
      cleanup: CleanupStep
    ): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        firstStopError ??= error;
        logException(error, '[DaemonServer] Failed to stop service', {
          serviceName: name,
        });
      }
    };

    try {
      await stopStep('relay connection', () => this.stopRelay());

      await stopStep('due-run poller', () => this.dueRunPoller?.stop());

      await stopStep('heartbeat service', () => this.heartbeatService?.stop());
      await stopStep('IPC connection server', () =>
        this.ipcConnectionServer?.stop()
      );
      await stopStep('WebSocket server', async () => {
        await this.webSocketServer?.close();
      });
      await stopStep('request core', async () => {
        await this.core?.shutdown();
      });

      if (firstStopError) {
        throw firstStopError;
      }

      this.isRunning = false;
      outcome = 'ok';

      if (this.config.debug) {
        debugLog('Daemon server stopped successfully');
      }
    } finally {
      const stopEndMs = Date.now();
      const stopDurationMs = stopEndMs - stopStartMs;
      logInfo('[DaemonServer] daemon-internal stop complete', {
        durationMs: stopDurationMs,
        platform: process.platform,
        outcome,
      });
      Metrics.recordHistogram(
        Metric.DAEMON_INTERNAL_STOP_DURATION_MS,
        stopDurationMs,
        { os: process.platform, outcome }
      );
    }
  }

  private async startRelay(relayConfig: RelayConfig): Promise<void> {
    this.stopRelay();

    const { WebSocketRelayTransport } = await import(
      '../relay/WebSocketRelayTransport'
    );
    const transport = new WebSocketRelayTransport();

    const relayConnection = new RelayConnection(
      {
        relayUrl: relayConfig.relayUrl,
        computerId: relayConfig.computerId,
        connectionHandler: this.requireConnectionHandler(),
        resolveCredential: relayConfig.resolveCredential,
        onStatusChange: () => this.broadcastRelayStatus(),
      },
      transport
    );
    this.relayConnection = relayConnection;
    this.relayComputerId = relayConfig.computerId;

    try {
      await relayConnection.start();
      logInfo('Relay connection started', { url: relayConnection.url });
    } catch (error) {
      try {
        relayConnection.stop();
      } catch (cleanupError) {
        logException(
          cleanupError,
          '[DaemonServer] Failed to cleanup failed relay startup'
        );
      }
      this.relayConnection = null;
      this.relayComputerId = undefined;
      throw error;
    }
  }

  private stopRelay({ broadcast = false }: { broadcast?: boolean } = {}): void {
    if (!this.relayConnection) {
      return;
    }

    this.relayConnection.stop();
    this.relayConnection = null;
    this.relayComputerId = undefined;
    logInfo('Relay connection stopped');

    if (broadcast) {
      this.broadcastRelayStatus();
    }
  }

  private broadcastRelayStatus(): void {
    const status = this.getRelayStatus();
    const message: DaemonRelayStatusChangedNotification = {
      type: JsonRpcMessageType.Notification,
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      method: DaemonRelayEvent.STATUS_CHANGED,
      params: status,
    };

    const connections =
      this.connectionHandler?.getAuthenticatedConnections() ?? new Set();
    for (const context of connections) {
      try {
        context.sendMessage(JSON.stringify(message));
      } catch (err) {
        // Best-effort delivery
        logWarn('[DaemonServer] Failed to send message to connection', {
          cause: err,
        });
      }
    }
  }

  private getRelayStatus(): DaemonRelayGetStatusResult {
    if (!this.relayConnection) {
      return { connected: false };
    }
    return {
      connected: this.relayConnection.isConnected,
      url: this.relayConnection.url,
      clientCount: this.relayConnection.clientCount,
      computerId: this.relayComputerId,
    };
  }

  isServerRunning(): boolean {
    return this.isRunning;
  }

  private async resolveHostIdentity() {
    return (await this.config.getHostIdentity?.()) ?? null;
  }

  getConfig(): DaemonConfig {
    return { ...this.config };
  }
}
