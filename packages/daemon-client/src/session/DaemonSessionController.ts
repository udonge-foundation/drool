import { EventEmitter } from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';

import {
  ConnectionState,
  DaemonAskUserSchema,
  DaemonDroolEvent,
  DaemonLoadSessionSpawnOptionsSchema,
  DaemonRequestPermissionSchema,
  DaemonSpecificNotificationType,
  DaemonTerminalEvent,
  type CreateTerminalRequestParams,
  type CreateTerminalResult,
  type WriteDataRequestParams,
  type WriteDataResult,
  type ResizeRequestParams,
  type ResizeResult,
  type CloseTerminalRequestParams,
  type CloseTerminalResult,
  type ListTerminalsRequestParams,
  type ListTerminalsResult,
  DaemonSessionNotificationParams,
  type DaemonInitializeSessionRequestParams,
  type DaemonLoadSessionRequestParams,
  type DaemonLoadSessionSpawnOptions,
  DaemonListOpenedSessionsResult,
  type DaemonListOpenedSessionsRequestParams,
  DaemonListAvailableSessionsResult,
  type DaemonAuthenticateResult,
  type DaemonAuthenticateMcpServerRequest,
  type DaemonCancelMcpAuthRequest,
  type DaemonClearMcpAuthRequest,
  type DaemonAddMcpServerRequest,
  DaemonListAvailableSessionsRequestParams,
  type DaemonGetDefaultSettingsResult,
  type DaemonUpdateSessionDefaultsRequestParams,
  type DaemonUpdateSessionDefaultsResult,
  type DaemonListCustomModelsResult,
  type DaemonUpsertCustomModelRequestParams,
  type DaemonUpsertCustomModelResult,
  type DaemonDeleteCustomModelRequestParams,
  type DaemonDeleteCustomModelResult,
  type DaemonTriggerUpdateResult,
  type DaemonGetMcpConfigResult,
  type DaemonRequestPermission,
  type DaemonRequestPermissionResult,
  type DaemonListMcpRegistryResult,
  type DaemonListMcpServersResult,
  type DaemonListMcpToolsResult,
  type DaemonListSkillsResult,
  type DaemonListCommandsResult,
  type DaemonListAvailablePluginsResult,
  type DaemonListInstalledPluginsResult,
  type DaemonInstallPluginResult,
  type DaemonUninstallPluginResult,
  type DaemonSetPluginEnabledResult,
  type DaemonUpdatePluginResult,
  type DaemonListMarketplacesResult,
  type DaemonAddMarketplaceResult,
  type DaemonAddMarketplaceRequestParams,
  type DaemonRemoveMarketplaceResult,
  type DaemonUpdateMarketplaceResult,
  type DaemonListAutomationsResult,
  type DaemonRunAutomationResult,
  type DaemonPauseAutomationResult,
  type DaemonResumeAutomationResult,
  type DaemonGetAutomationHistoryResult,
  type DaemonGetAutomationVisualResult,
  type DaemonCreateAutomationRequestParams,
  type DaemonCreateAutomationResult,
  type DaemonUpdateAutomationModelRequestParams,
  type DaemonUpdateAutomationModelResult,
  type DaemonUpdateAutomationPrivacyRequestParams,
  type DaemonUpdateAutomationPrivacyResult,
  type DaemonUpdateAutomationPromptRequestParams,
  type DaemonUpdateAutomationPromptResult,
  type DaemonUpdateAutomationScheduleRequestParams,
  type DaemonUpdateAutomationScheduleResult,
  type DaemonRenameAutomationRequestParams,
  type DaemonRenameAutomationResult,
  type DaemonDeleteAutomationRequestParams,
  type DaemonDeleteAutomationResult,
  type DaemonForkAutomationRequestParams,
  type DaemonForkAutomationResult,
  type DaemonListCronsRequestParams,
  type DaemonListCronsResult,
  type DaemonCreateCronRequestParams,
  type DaemonCreateCronResult,
  type DaemonUpdateCronRequestParams,
  type DaemonUpdateCronResult,
  type DaemonDeleteCronRequestParams,
  type DaemonDeleteCronResult,
  type DaemonHoldSessionCronsRequestParams,
  type DaemonHoldSessionCronsResult,
  type DaemonResumeSessionCronsRequestParams,
  type DaemonResumeSessionCronsResult,
  type DaemonRemoveMcpServerRequest,
  type DaemonRelayGetStatusResult,
  type DaemonRelayStartResult,
  type DaemonRelayStopResult,
  type DaemonGetContextBreakdownResult,
  type DaemonGetProxyTokenResult,
  type DaemonGetWorkspaceFileContentRequestParams,
  type DaemonGetWorkspaceFileContentResult,
  type DaemonToggleMcpServerRequest,
  type DaemonUpdateMcpConfigResult,
  type DaemonUpdateMcpConfigRequestParams,
  SessionLoadState,
  SessionSearchDocKind,
  MachineType,
  DaemonDroolMethod,
  DaemonTerminalMethod,
} from '@industry/common/daemon';
import {
  MachineConnectionType,
  SESSION_TAG_SUBAGENT,
} from '@industry/common/session';
import { type MissionModelSettings } from '@industry/common/settings';
import { ClientType, WebSocketCloseCode } from '@industry/common/shared';
import { TerminalStatus } from '@industry/common/terminal';
import {
  INDUSTRY_PROTOCOL_VERSION,
  SessionNotificationType,
  QueuePlacement,
  ResolveQueuedUserMessageAction,
  JSONRPC_VERSION,
  LEGACY_INDUSTRY_API_VERSION,
  AgentTurnCompletionReason,
  ToolConfirmationOutcome,
  DroolWorkingState,
  MissionState,
  ProgressLogEntryType,
  type InitializeSessionResult,
  type LoadSessionResult,
  type AddUserMessageParams as AddUserMessageRequestParams,
  type AddUserMessageResult,
  type ResolveQueuedUserMessageParams,
  type ResolveQueuedUserMessageResult,
  type InterruptSessionResult,
  type WorkerStateInfo,
  type UpdateSessionSettingsResult,
} from '@industry/drool-sdk-ext/protocol/drool';
import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import { type SessionTag } from '@industry/drool-sdk-ext/protocol/session';
import {
  IndustryDroolMessage,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import {
  AutonomyLevel,
  DroolInteractionMode,
  JsonRpcErrorCode,
} from '@industry/drool-sdk-ext/protocol/shared';
import {
  logError,
  logException,
  logInfo,
  logWarn,
  Metric,
  Metrics,
} from '@industry/logging';
import { AuthenticationError, MetaError } from '@industry/logging/errors';
import {
  ClientUiSurface,
  OtelTracing,
  SpanName,
} from '@industry/logging/tracing';
import { machineTypeToMachineConnectionType } from '@industry/utils';
import { buildUserMessageContentBlocks } from '@industry/utils/messages';
import { getSubagentCallingMetadata } from '@industry/utils/session';

import { createWebSocketDaemonClient } from '../createWebSocketDaemonClient';
import { DaemonAuthenticationMode } from '../enums';
import {
  JsonRpcRequestError as DaemonClientJsonRpcRequestError,
  RelayConnectionError,
  RequestTimeoutError as DaemonClientRequestTimeoutError,
  ComputeLimitExceededError,
} from '../errors';
import { createConnectionFailure } from './connection-failure';
import {
  INITIALIZE_SESSION_MAX_ATTEMPTS,
  INITIALIZE_SESSION_PER_ATTEMPT_TIMEOUT_MS,
  SELF_RESUME_BACKOFF_FACTOR,
  SELF_RESUME_INITIAL_DELAY_MS,
  SELF_RESUME_MAX_ATTEMPTS,
  SELF_RESUME_MAX_DELAY_MS,
} from './constants';
import { MessageRouter } from './core/MessageRouter';
import { ReconnectionStrategy } from './core/ReconnectionStrategy';
import {
  ConnectionEvent,
  ConnectionFailureReason,
  DroolEvent,
  TransportState,
} from './enums';
import {
  ConnectionFailureError,
  SessionNotFoundError,
  JsonRpcRequestError,
} from './errors';
import { AskUserRequestHandler } from './handlers/AskUserRequestHandler';
import { PendingUserActionStore } from './handlers/PendingUserActionStore';
import { PermissionRequestHandler } from './handlers/PermissionRequestHandler';
import { reconcileQueuedMessagesAfterLoad } from './queueLoadReconciliation';
import { MultiMissionStateManager } from './state/MultiMissionStateManager';
import { MultiSessionStateManager } from './state/MultiSessionStateManager';
import { getQueuedUserMessageKindForQueuePlacement } from './state/queuedUserMessageHelpers';

import type { IDaemonClient } from '../types';
import type {
  PendingAskUserRequest,
  PendingPermission,
} from './handlers/types';
import type {
  ConnectionStatus,
  IndustryDaemonConfig,
  IndustryDroolEvents,
  MachineInfo,
  MissionStoreInterface,
  TerminalMetadata,
} from './types';

/**
 * RPC methods exempt from the ensureSessionLoaded guard. Every other
 * session-scoped RPC routed through DaemonClient.sendRequest goes through
 * the guard. Without these exemptions the guard would either recurse (on
 * RPCs that themselves transition the session into Loaded) or trigger an
 * unnecessary load before operations that don't depend on the live drool
 * worker (terminals, plugins, session metadata). Entries are grouped by
 * exemption reason.
 *
 * Exported so the categorization test in DaemonSessionController.test.ts
 * can enforce that every protocol RPC method is explicitly classified.
 */
export const SKIP_ENSURE_LOADED: ReadonlySet<string> = new Set<string>([
  // Lifecycle: these RPCs themselves transition the session into Loaded.
  DaemonDroolMethod.LOAD_SESSION,
  DaemonDroolMethod.INITIALIZE_SESSION,
  // Closing: loading a session in order to close it is incoherent.
  DaemonDroolMethod.CLOSE_SESSION,
  // Session metadata served from disk; no live worker required.
  DaemonDroolMethod.ARCHIVE_SESSION,
  DaemonDroolMethod.UNARCHIVE_SESSION,
  DaemonDroolMethod.RENAME_SESSION,
  // Terminal lifecycle is tracked by TerminalManager, independent of the
  // drool worker.
  DaemonTerminalMethod.CREATE,
  DaemonTerminalMethod.WRITE_DATA,
  DaemonTerminalMethod.RESIZE,
  DaemonTerminalMethod.CLOSE,
  DaemonTerminalMethod.LIST,
  // Plugin/marketplace operations are served by PluginMarketplaceManager;
  // sessionId is passed only for cwd resolution.
  DaemonDroolMethod.LIST_AVAILABLE_PLUGINS,
  DaemonDroolMethod.LIST_INSTALLED_PLUGINS,
  DaemonDroolMethod.INSTALL_PLUGIN,
  DaemonDroolMethod.UNINSTALL_PLUGIN,
  DaemonDroolMethod.SET_PLUGIN_ENABLED,
  DaemonDroolMethod.UPDATE_PLUGIN,
  DaemonDroolMethod.LIST_MARKETPLACES,
  DaemonDroolMethod.ADD_MARKETPLACE,
  DaemonDroolMethod.REMOVE_MARKETPLACE,
  DaemonDroolMethod.UPDATE_MARKETPLACE,
  // Automation-scoped; sessionId is optional and used only for telemetry.
  DaemonDroolMethod.GET_AUTOMATION_VISUAL,
  // Workspace file reads use sessionId only for cwd resolution; the daemon
  // does not require a live worker to stat/read a file.
  DaemonDroolMethod.GET_WORKSPACE_FILE_CONTENT,
  // Cron registry operations are durable control-plane mutations; they do not
  // depend on a live worker.
  DaemonDroolMethod.LIST_CRONS,
  DaemonDroolMethod.CREATE_CRON,
  DaemonDroolMethod.UPDATE_CRON,
  DaemonDroolMethod.DELETE_CRON,
  DaemonDroolMethod.HOLD_SESSION_CRONS,
  DaemonDroolMethod.RESUME_SESSION_CRONS,
]);

type RespondToPermissionParams = {
  permissionId: string;
} & DaemonRequestPermissionResult;

interface RespondToAskUserParams {
  requestId: string;
  sessionId: string;
  result: {
    cancelled?: boolean;
    answers: Array<{ index: number; question: string; answer: string }>;
  };
}

/**
 * DaemonSessionController is the main client for WebSocket JSON-RPC communication
 * with the industry daemon server. It orchestrates all the components and provides
 * a clean API for session management.
 */
export class DaemonSessionController extends EventEmitter<IndustryDroolEvents> {
  private daemonClient: IDaemonClient;

  private messageRouter: MessageRouter;

  private permissionHandler: PermissionRequestHandler;

  private askUserHandler: AskUserRequestHandler;

  // Buffered prompt responses for inactive sessions.
  private pendingUserActionStore: PendingUserActionStore;

  // Disconnected sessions whose prompt responses should be buffered.
  private inactiveSessions = new Set<string>();

  // Sessions currently draining a batch of concurrent prompts (e.g. parallel
  // foreground subagents each relaying an Execute permission to the parent
  // session). While draining, a resume reflects one prompt being answered while
  // siblings remain genuinely pending, so resume-driven auto-clear is
  // suppressed until every prompt for the session has resolved.
  private sessionsWithConcurrentPrompts = new Set<string>();

  // Sessions with a self-resume loadSession already in flight.
  private selfResumeInFlight = new Set<string>();

  // Last loadSession spawn options, reused for self-resume.
  private sessionLoadOptions = new Map<string, DaemonLoadSessionSpawnOptions>();

  // addUserMessage responses can resolve after their CREATE_MESSAGE notification.
  // Track that ordering so an already-confirmed turn is not added to the
  // visible queue after its real user message has been rendered.
  private inFlightAddUserMessageRequests = new Set<string>();

  private confirmedInFlightAddUserMessageRequests = new Set<string>();

  // Session-backed Task children that should be cleaned up when they finish.
  private managedSubagentSessionIds = new Set<string>();

  private pendingChildSessionHydrations = new Set<string>();

  /**
   * In-flight loadSession promises keyed by sessionId. ensureSessionLoaded
   * awaits the tracked promise so concurrent guarded RPCs are gated on a
   * single load instead of racing against a session in `Loading` state.
   */
  private sessionLoadInFlight = new Map<string, Promise<unknown>>();

  private sessionStateManager: MultiSessionStateManager;

  private missionStateManager: MultiMissionStateManager | null;

  private reconnectionStrategy: ReconnectionStrategy;

  private config: IndustryDaemonConfig;

  private reconnectTimer: NodeJS.Timeout | null = null;

  private delegatedReconnectAbort: AbortController | null = null;

  private isReconnecting = false;

  private hasEverConnected = false;

  /** Tracks whether doEstablishConnection is actively polling (used for diagnostics) */
  private isPolling = false;

  private pendingConnection: Promise<boolean> | null = null;

  private _isAuthenticated = false;

  private lastConnectionFailure: ConnectionFailureError | null = null;

  private manuallyDisconnected = false;

  private authenticationPromise: Promise<DaemonAuthenticateResult> | null =
    null;

  private machineInfo: MachineInfo | null = null;

  constructor(params: {
    sessionStateManager: MultiSessionStateManager;
    config: IndustryDaemonConfig;
    daemonClient?: IDaemonClient;
    missionStateManager?: MultiMissionStateManager;
  }) {
    super();

    const { sessionStateManager, config, daemonClient, missionStateManager } =
      params;

    // Initialize config with defaults
    this.config = config;

    // Use provided client or create a WebSocket-based DaemonClient
    this.daemonClient =
      daemonClient ??
      createWebSocketDaemonClient({
        machineType: config.machineType,
        ...(config.machineType === MachineType.Computer && {
          providerType: config.providerType,
        }),
        getAccessToken: config.getAccessToken,
        requestTimeout: config.requestTimeout,
        clientSurface: DaemonSessionController.getClientSurfaceForType(
          config.clientType
        ),
        transportConfig: {
          maxConnectRetries: 0,
          initialRetryDelayMs: 0,
          maxRetryDelayMs: 0,
          connectionTimeoutMs: config.connectionTimeoutMs,
        },
      });

    this.messageRouter = new MessageRouter({
      emitReceiveSpans: config.clientType !== 'cli',
    });
    this.permissionHandler = new PermissionRequestHandler();
    this.askUserHandler = new AskUserRequestHandler();
    this.pendingUserActionStore = new PendingUserActionStore();
    this.sessionStateManager = sessionStateManager;
    this.missionStateManager = missionStateManager ?? null;
    const reconnectDelegated =
      config.machineType === MachineType.Local
        ? (config.reconnectDelegated ?? false)
        : false;
    this.reconnectionStrategy = new ReconnectionStrategy(
      this.config.maxReconnectAttempts,
      this.config.reconnectInterval,
      this.config.maxReconnectDelay,
      this.config.reconnectBackoffFactor,
      reconnectDelegated
    );

    this.daemonClient.setBeforeRequest?.(async (sessionId, method) => {
      if (SKIP_ENSURE_LOADED.has(method)) return;
      await this.ensureSessionLoaded(sessionId);
    });

    this.setupEventHandlers();
  }

  /**
   * Get the client type from config, defaulting to 'web'.
   */
  private getClientType(): 'desktop' | 'web' | 'cli' {
    return this.config.clientType ?? 'web';
  }

  private static getClientSurfaceForType(
    clientType: IndustryDaemonConfig['clientType']
  ): ClientUiSurface | undefined {
    if (clientType === 'desktop') {
      return ClientUiSurface.Desktop;
    }
    if (clientType === 'web') {
      return ClientUiSurface.Web;
    }
    return undefined;
  }

  /**
   * Get the current client interaction surface for RPC requests.
   * Uses injectable clientType from config instead of checking window.electronAPI.
   */
  private getClientSurface(): ClientUiSurface {
    return (
      DaemonSessionController.getClientSurfaceForType(this.getClientType()) ??
      ClientUiSurface.Web
    );
  }

  /**
   * Check if the client is a desktop app.
   * Uses injectable clientType from config instead of checking window.electronAPI.
   */
  private isDesktopApp(): boolean {
    return this.getClientType() === 'desktop';
  }

  /**
   * Get the mission store for a session.
   * Uses injectable getMissionStore from config if provided.
   */
  private getMissionStoreForSession(
    sessionId: string
  ): MissionStoreInterface | null {
    if (this.config.getMissionStore) {
      return this.config.getMissionStore(sessionId);
    }
    return null;
  }

  private static readonly CONNECTION_POLL_INTERVAL_MS = 1000;

  private static readonly DELEGATED_RECONNECT_MAX_POLL_ATTEMPTS = 30;

  /**
   * Minimum extra attempts granted for authentication once the WebSocket
   * connects for the first time. Prevents the poll budget from being
   * exhausted entirely on connection failures (e.g., cloud workspace boot),
   * leaving no room for auth to succeed.
   */
  private static readonly MIN_AUTH_ATTEMPTS_AFTER_CONNECT = 3;

  /**
   * Wait for connection by polling until connected.
   * If a connection attempt is already in progress, returns the pending promise.
   * @param maxAttempts - Maximum connection attempts (default: 15)
   * @returns true if connected successfully, false if max attempts reached
   */
  async pollUntilConnected(
    maxAttempts: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    // Already connected (WebSocket level) - nothing to do
    if (this.daemonClient.isConnected()) {
      return true;
    }

    // If connection attempt already in progress, return the pending promise.
    // Caller-supplied signals are honored only by the call that owns the
    // in-flight loop; joiners share its lifetime.
    if (this.pendingConnection) {
      return this.pendingConnection;
    }

    // Start new connection attempt
    this.pendingConnection = this.doEstablishConnection(maxAttempts, signal);

    try {
      return await this.pendingConnection;
    } finally {
      this.pendingConnection = null;
    }
  }

  private async doEstablishConnection(
    maxAttempts: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    logInfo('[DaemonSessionController] Waiting for connection', {
      machineId: this.config.machineId,
      numTurns: maxAttempts,
    });

    this.isPolling = true;
    try {
      let effectiveMax = maxAttempts;

      for (let attempt = 0; attempt < effectiveMax; attempt++) {
        if (signal?.aborted) {
          throw new MetaError('pollUntilConnected aborted');
        }
        const hadConnected = this.hasEverConnected;

        try {
          await this.attemptInitialConnection();
          return true;
        } catch (error) {
          logWarn(
            '[DaemonSessionController] Initial connection attempt failed',
            { cause: error }
          );
          if (error instanceof ConnectionFailureError) {
            this.lastConnectionFailure = error;
            if (!error.retryable) {
              break;
            }
          }

          // When the WebSocket connects for the first time but auth fails,
          // ensure enough remaining attempts for authentication to succeed.
          // This prevents the entire poll budget from being consumed by
          // connection failures (e.g., cloud workspace still booting).
          if (!hadConnected && this.hasEverConnected) {
            const remaining = effectiveMax - attempt - 1;
            if (
              remaining <
              DaemonSessionController.MIN_AUTH_ATTEMPTS_AFTER_CONNECT
            ) {
              effectiveMax =
                attempt +
                1 +
                DaemonSessionController.MIN_AUTH_ATTEMPTS_AFTER_CONNECT;
              logInfo(
                '[DaemonSessionController] Connection established, extending poll budget for auth',
                {
                  machineId: this.config.machineId,
                  attempt,
                  limit: effectiveMax,
                }
              );
            }
          }
        }

        // Wait before next attempt (skip wait on last attempt). Bail early
        // if the caller aborts mid-sleep.
        if (attempt < effectiveMax - 1) {
          await new Promise<void>((resolve, reject) => {
            const handle = setTimeout(() => {
              signal?.removeEventListener('abort', onAbort);
              resolve();
            }, DaemonSessionController.CONNECTION_POLL_INTERVAL_MS);
            const onAbort = () => {
              clearTimeout(handle);
              reject(new MetaError('pollUntilConnected aborted'));
            };
            if (signal?.aborted) {
              clearTimeout(handle);
              reject(new MetaError('pollUntilConnected aborted'));
              return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });
          });
        }
      }
    } finally {
      this.isPolling = false;
    }

    logInfo('[DaemonSessionController] Connection attempts reached max', {
      machineId: this.config.machineId,
      numTurns: maxAttempts,
    });
    this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());
    return false;
  }

  /**
   * Attempt initial connection.
   * Throws ConnectionFailureError on failure without retries.
   * No-op if already connected.
   */
  async attemptInitialConnection(): Promise<void> {
    if (this.daemonClient.isConnected()) {
      return;
    }
    await this.connectAndAuthenticate();
  }

  /**
   * Single path for establishing a WebSocket connection and authenticating.
   * Wraps connect errors as ConnectionFailureError(DaemonUnreachable) and delegates
   * authentication to autoAuthenticate which throws ConnectionFailureError directly.
   * Used by both initial connection and reconnection paths.
   */
  private async connectAndAuthenticate(): Promise<void> {
    // connect() handles WebSocket open + relay auth (via transport config).
    try {
      // For managed computers, ensure the sandbox is running before connecting.
      if (
        this.config.machineType === MachineType.Computer &&
        this.config.isManaged
      ) {
        const { ensureRunning } = this.config;
        await OtelTracing.trace(SpanName.COMPUTER_ENSURE_RUNNING, () =>
          ensureRunning()
        );
      }

      await this.daemonClient.connect(this.config.url);
    } catch (error) {
      if (error instanceof RelayConnectionError) {
        throw createConnectionFailure(error.reason, { cause: error });
      }
      if (error instanceof ComputeLimitExceededError) {
        throw createConnectionFailure(
          ConnectionFailureReason.ComputeLimitExceeded,
          { cause: error }
        );
      }
      throw createConnectionFailure(ConnectionFailureReason.DaemonUnreachable, {
        cause: error instanceof Error ? error : undefined,
      });
    }

    this.hasEverConnected = true;

    logInfo('[DaemonSessionController] Initial connection established', {
      machineId: this.config.machineId,
    });

    await this.autoAuthenticate();
  }

  /**
   * Emit UI events based on notification type.
   * This method is responsible ONLY for event emission, no side effects.
   */
  private emitDroolEventForNotification(
    notification: DaemonSessionNotificationParams['notification'],
    sessionId: string
  ): void {
    switch (notification.type) {
      case SessionNotificationType.CREATE_MESSAGE: {
        // Always emit MessageCreated - triggers UI update to show real message
        // The optimistic message was already removed synchronously in handleInboundMessage()
        const { type: _, ...messageNotification } = notification;
        // Include the real message count from session state for sidebar updates
        const sessionManager =
          this.sessionStateManager.getSessionManager(sessionId);
        const messagesCount = sessionManager?.getStore().getMessageCount();
        this.emit(DroolEvent.MessageCreated, {
          ...messageNotification,
          sessionId,
          messagesCount,
        });
        break;
      }

      case SessionNotificationType.TOOL_RESULT: {
        const { type: _, ...toolResultNotification } = notification;
        this.emit(DroolEvent.ToolResult, toolResultNotification);
        break;
      }

      case SessionNotificationType.TOOL_PROGRESS_UPDATE: {
        // Emit tool progress update for live streaming (e.g., Task tool subagent activity)
        const { type: _, ...progressNotification } = notification;
        this.emit(DroolEvent.ToolProgressUpdate, {
          sessionId,
          ...progressNotification,
        });
        break;
      }

      case SessionNotificationType.ERROR: {
        // No event emission needed for ERROR
        break;
      }

      case SessionNotificationType.DROOL_WORKING_STATE_CHANGED: {
        const { type: _, ...stateNotification } = notification;
        this.emit(DroolEvent.DroolWorkingStateChanged, {
          sessionId,
          newState: stateNotification.newState,
        });
        break;
      }

      case SessionNotificationType.PERMISSION_RESOLVED: {
        // Emit working state change event
        // State update happens in SessionStateManager
        this.emit(DroolEvent.DroolWorkingStateChanged, {
          sessionId,
          newState: DroolWorkingState.StreamingAssistantMessage,
        });
        break;
      }

      case SessionNotificationType.SETTINGS_UPDATED: {
        const { type: _, ...settingsNotification } = notification;
        this.emit(DroolEvent.SessionSettingsUpdated, {
          sessionId,
          settings: {
            modelId: settingsNotification.settings.modelId,
            reasoningEffort: settingsNotification.settings.reasoningEffort,
            interactionMode: settingsNotification.settings.interactionMode,
            autonomyLevel: settingsNotification.settings.autonomyLevel,
            specModeModelId: settingsNotification.settings.specModeModelId,
            specModeReasoningEffort:
              settingsNotification.settings.specModeReasoningEffort,
            missionSettings: settingsNotification.settings.missionSettings,
            tags: settingsNotification.settings.tags,
            compactionThresholdCheckEnabled:
              settingsNotification.settings.compactionThresholdCheckEnabled,
          },
        });
        break;
      }

      case SessionNotificationType.SESSION_TITLE_UPDATED: {
        const { type: _, ...titleNotification } = notification;
        this.emit(DroolEvent.SessionTitleUpdated, {
          sessionId,
          title: titleNotification.title,
        });
        break;
      }

      case DaemonSpecificNotificationType.SESSION_INACTIVITY:
      case DaemonSpecificNotificationType.SESSION_PROCESS_EXITED:
        this.emit(DroolEvent.SessionInactive, sessionId);
        break;

      case DaemonSpecificNotificationType.SESSION_CLOSED:
        break;

      case DaemonSpecificNotificationType.SESSION_UNSUBSCRIBED: {
        this.emit(DroolEvent.SessionUnsubscribed, sessionId);
        break;
      }

      case SessionNotificationType.CHILD_SESSION_AVAILABLE:
        break;

      case DaemonTerminalEvent.DATA:
        // DO NOT EMIT - handled by SessionStateManager's registry pattern
        // Data is routed to mounted terminals or buffered for unmounted ones
        break;

      case DaemonTerminalEvent.EXIT:
        this.emit(DroolEvent.TerminalExit, {
          terminalId: notification.terminalId,
          exitCode: notification.exitCode,
          signal: notification.signal,
          sessionId,
        });
        break;

      case SessionNotificationType.MCP_STATUS_CHANGED:
        // MCP status changes are emitted for UI to display
        this.emit(DroolEvent.McpStatusChanged, {
          sessionId,
          servers: notification.servers,
          summary: notification.summary,
        });
        break;

      case SessionNotificationType.ASSISTANT_TEXT_DELTA:
      case SessionNotificationType.THINKING_TEXT_DELTA:
      case SessionNotificationType.ASSISTANT_TEXT_COMPLETE:
      case SessionNotificationType.THINKING_TEXT_COMPLETE:
        // Streaming deltas are handled by SessionStateManager (via handleNotification above).
        // No additional DroolEvent emission needed here.
        // For thinking deltas, the frontend subscribes to store changes directly
        // to stream thinking traces in real-time without triggering forced scroll.
        break;

      // Mission notifications - update MissionStore directly and emit events
      case SessionNotificationType.MISSION_STATE_CHANGED: {
        const missionStore = this.getMissionStoreForSession(sessionId);
        if (missionStore) {
          const stateMap: Record<string, MissionState> = {
            planning: MissionState.Planning,
            awaiting_input: MissionState.AwaitingInput,
            initializing: MissionState.Initializing,
            running: MissionState.Running,
            paused: MissionState.Paused,
            orchestrator_turn: MissionState.OrchestratorTurn,
            completed: MissionState.Completed,
          };
          const mappedState = stateMap[notification.state];
          if (mappedState !== undefined) {
            missionStore.setState(mappedState);
          }
        }
        this.emit(DroolEvent.MissionStateChanged, {
          sessionId,
          state: notification.state,
        });
        break;
      }

      case SessionNotificationType.MISSION_FEATURES_CHANGED: {
        const missionStore = this.getMissionStoreForSession(sessionId);
        missionStore?.setFeatures(notification.features);
        this.emit(DroolEvent.MissionFeaturesChanged, {
          sessionId,
          features: notification.features,
        });
        break;
      }

      case SessionNotificationType.MISSION_PROGRESS_ENTRY: {
        const missionStore = this.getMissionStoreForSession(sessionId);
        if (missionStore) {
          missionStore.setProgressLog(notification.progressLog);
          const acceptedMissionEntry = notification.progressLog.find(
            (entry) => entry.type === ProgressLogEntryType.MissionAccepted
          );
          if (acceptedMissionEntry) {
            missionStore.setTitle?.(acceptedMissionEntry.title);
          }
        }
        this.emit(DroolEvent.MissionProgressEntry, {
          sessionId,
          progressLog: notification.progressLog,
        });
        break;
      }

      case SessionNotificationType.MISSION_HEARTBEAT:
        // Heartbeat notifications don't require store updates
        break;

      case SessionNotificationType.MISSION_WORKER_STARTED: {
        const missionStore = this.getMissionStoreForSession(sessionId);
        missionStore?.addWorker(notification.workerSessionId);
        this.emit(DroolEvent.MissionWorkerStarted, {
          sessionId,
          workerSessionId: notification.workerSessionId,
        });
        break;
      }

      case SessionNotificationType.MISSION_WORKER_COMPLETED: {
        const missionStore = this.getMissionStoreForSession(sessionId);
        missionStore?.completeWorker(
          notification.workerSessionId,
          notification.exitCode
        );
        const workerSessionManager = this.sessionStateManager.getSessionManager(
          notification.workerSessionId
        );
        if (
          workerSessionManager &&
          workerSessionManager.getDroolWorkingState() !== DroolWorkingState.Idle
        ) {
          workerSessionManager.stopStreaming();
        }
        this.emit(DroolEvent.DroolWorkingStateChanged, {
          sessionId: notification.workerSessionId,
          newState: DroolWorkingState.Idle,
        });
        this.emit(DroolEvent.MissionWorkerCompleted, {
          sessionId,
          workerSessionId: notification.workerSessionId,
          exitCode: notification.exitCode,
        });
        break;
      }

      case SessionNotificationType.SESSION_TOKEN_USAGE_CHANGED: {
        // Store token usage in session store for the current session
        if (sessionId === notification.sessionId) {
          const sessionManager =
            this.sessionStateManager.getSessionManager(sessionId);
          if (sessionManager) {
            sessionManager.getStore().setTokenUsage(notification.tokenUsage);
            sessionManager
              .getStore()
              .setLastCallTokenUsage(notification.lastCallTokenUsage ?? null);
          }
        }

        // Also update mission store if this is an orchestrator or worker session
        const missionStore = this.getMissionStoreForSession(sessionId);
        if (missionStore) {
          if (
            sessionId === notification.sessionId ||
            missionStore.hasWorkerSession(notification.sessionId)
          ) {
            missionStore.setSessionTokenUsage(
              notification.sessionId,
              notification.inclusiveTokenUsage ?? notification.tokenUsage
            );
          }
        }

        this.emit(DroolEvent.SessionTokenUsageChanged, {
          sessionId: notification.sessionId,
          tokenUsage: notification.tokenUsage,
        });
        break;
      }

      case SessionNotificationType.AGENT_TURN_COMPLETED:
        this.sessionStateManager
          .getSessionManager(sessionId)
          ?.getStore()
          .setAgentTurnCompletionReason(notification.reason);
        // Raw session-notification subscribers consume turn-completion details.
        break;

      case SessionNotificationType.MCP_AUTH_REQUIRED:
        // MCP OAuth auth required - emit event for UI to display auth URL
        this.emit(DroolEvent.McpAuthRequired, {
          sessionId,
          serverName: notification.serverName,
          authUrl: notification.authUrl,
          message: notification.message,
          state: notification.state,
        });
        break;

      case SessionNotificationType.MCP_AUTH_COMPLETED:
        this.emit(DroolEvent.McpAuthCompleted, {
          sessionId,
          serverName: notification.serverName,
          outcome: notification.outcome,
          message: notification.message,
        });
        break;

      case SessionNotificationType.HOOK_EXECUTION_STARTED:
      case SessionNotificationType.HOOK_EXECUTION_COMPLETED:
      case SessionNotificationType.STRUCTURED_OUTPUT:
      case SessionNotificationType.SESSION_COMPACTED:
        // Handled by SessionStateManager
        break;

      case SessionNotificationType.TOOL_CALL: {
        // SSM has already updated the store with the tool call.
        // Emit MessageCreated so the frontend refetches display messages,
        // giving the appearance of streaming tool calls as they arrive.
        const sessionManager =
          this.sessionStateManager.getSessionManager(sessionId);
        const lastMsg = sessionManager?.getLastMessage();
        if (lastMsg) {
          this.emit(DroolEvent.MessageCreated, {
            message: lastMsg,
            sessionId,
            messagesCount: sessionManager?.getStore().getMessageCount(),
          });
        }
        break;
      }

      case SessionNotificationType.QUEUED_MESSAGES_DISCARDED:
        this.emit(DroolEvent.QueuedMessagesDiscarded, {
          sessionId,
          text: notification.text,
          requestId: notification.requestId,
        });
        break;

      case SessionNotificationType.TOOL_EXECUTION_HEARTBEAT:
        // Internal daemon keep-alive; never reaches clients in practice
        // (suppressed at broadcast time) and has no client-side side effects.
        break;

      case SessionNotificationType.LOOP_STATE_CHANGED:
        // Deprecated legacy notification; durable cron events are the source of truth.
        break;

      default: {
        const exhaustiveCheck: never = notification;
        throw new MetaError('Unhandled notification type:', {
          type: exhaustiveCheck,
        });
      }
    }
  }

  private getAssociatedSessionIdsForPermission(sessionId: string): string[] {
    const associated = new Set<string>([sessionId]);
    let currentSessionId: string | undefined = sessionId;

    for (let depth = 0; depth < 10 && currentSessionId; depth++) {
      const manager =
        this.sessionStateManager.getSessionManager(currentSessionId);
      const parentSessionId = manager?.getStore().getCallingSessionId();
      if (!parentSessionId || associated.has(parentSessionId)) {
        break;
      }
      associated.add(parentSessionId);
      currentSessionId = parentSessionId;
    }

    return Array.from(associated);
  }

  private clearPendingUserActionsForSession(
    sessionId: string,
    options?: { preserveRelayedPermissions?: boolean }
  ): void {
    const pendingPermissionCount = this.permissionHandler
      .getPendingPermissions()
      .filter((permission) => permission.sessionId === sessionId).length;
    const pendingAskUserCount = this.askUserHandler
      .getPendingAskUserRequests()
      .filter((request) => request.sessionId === sessionId).length;

    if (pendingPermissionCount === 0 && pendingAskUserCount === 0) {
      return;
    }

    logInfo('[DaemonSessionController] Clearing pending user actions', {
      sessionId,
      pendingRequestCount: pendingPermissionCount,
      questionCount: pendingAskUserCount,
    });

    this.permissionHandler.clearSessionPermissions(sessionId, {
      emitResolved: true,
      preserveRelayed: options?.preserveRelayedPermissions,
    });
    this.askUserHandler.clearSessionAskUserRequests(sessionId);
    this.sessionsWithConcurrentPrompts.delete(sessionId);
  }

  private getPendingPermissionCountForSession(sessionId: string): number {
    return this.permissionHandler
      .getPendingPermissions()
      .filter((permission) =>
        permission.associatedSessionIds.includes(sessionId)
      ).length;
  }

  private hasPendingUserActionForSession(sessionId: string): boolean {
    return (
      this.getPendingPermissionCountForSession(sessionId) > 0 ||
      this.askUserHandler
        .getPendingAskUserRequests()
        .some((request) => request.sessionId === sessionId)
    );
  }

  private markConcurrentPermissionSurfaces(sessionIds: Iterable<string>): void {
    const pendingPermissions = this.permissionHandler.getPendingPermissions();
    for (const sessionId of sessionIds) {
      const pendingForSession = pendingPermissions.filter((permission) =>
        permission.associatedSessionIds.includes(sessionId)
      );
      if (pendingForSession.length <= 1) {
        continue;
      }
      for (const permission of pendingForSession) {
        for (const associatedSessionId of permission.associatedSessionIds) {
          this.sessionsWithConcurrentPrompts.add(associatedSessionId);
        }
      }
    }
  }

  private clearDrainedConcurrentPromptMarkers(
    sessionIds: Iterable<string>
  ): void {
    for (const sessionId of sessionIds) {
      if (
        this.sessionsWithConcurrentPrompts.has(sessionId) &&
        !this.hasPendingUserActionForSession(sessionId)
      ) {
        this.sessionsWithConcurrentPrompts.delete(sessionId);
      }
    }
  }

  /**
   * Clear a stale, abandoned prompt when the drool resumes (its working state
   * leaves WaitingForToolConfirmation) without the prompt being resolved.
   *
   * A session can have MULTIPLE concurrent prompts outstanding — e.g. two
   * parallel foreground subagents that each relay an Execute permission to the
   * parent session. There a resume means ONE prompt was answered while the
   * rest are still genuinely pending, so blanket-clearing by session would
   * strand the siblings (and a later response to them would fail with "No
   * pending permission found"). We therefore only auto-clear when a single
   * prompt of a kind is outstanding and the session is not mid-way through
   * draining a concurrent batch.
   */
  private clearStalePromptsOnResume(sessionId: string): void {
    const pendingPermissionCount =
      this.getPendingPermissionCountForSession(sessionId);
    const pendingAskUserCount = this.askUserHandler
      .getPendingAskUserRequests()
      .filter((request) => request.sessionId === sessionId).length;

    if (pendingPermissionCount === 0 && pendingAskUserCount === 0) {
      this.sessionsWithConcurrentPrompts.delete(sessionId);
      return;
    }

    // More than one prompt of either kind means a concurrent batch is in
    // flight; remember it so the eventual single-prompt tail isn't cleared.
    if (pendingPermissionCount > 1 || pendingAskUserCount > 1) {
      this.sessionsWithConcurrentPrompts.add(sessionId);
      return;
    }

    // A single remaining prompt that is the tail of a concurrent batch is a
    // legitimately pending sibling, not an abandoned prompt — keep it.
    if (this.sessionsWithConcurrentPrompts.has(sessionId)) {
      return;
    }

    this.clearPendingUserActionsForSession(sessionId, {
      preserveRelayedPermissions: true,
    });
  }

  private isManagedSubagentSession(sessionId: string): boolean {
    if (this.managedSubagentSessionIds.has(sessionId)) {
      return true;
    }

    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    const store = sessionManager?.getStore();
    return Boolean(
      store?.getCallingSessionId() && store?.getCallingToolUseId()
    );
  }

  /**
   * Handle permission-related side effects for notifications.
   * This method handles permission resolution and cleanup for inactive sessions.
   */
  private handleNotificationSideEffects(
    notification: DaemonSessionNotificationParams['notification'],
    sessionId: string
  ): void {
    switch (notification.type) {
      case SessionNotificationType.PERMISSION_RESOLVED: {
        const { type: _, ...resolvedNotification } = notification;

        // Log permission resolution
        logInfo('[DaemonSessionController] Permission resolved', {
          sessionId,
          value: resolvedNotification.selectedOption,
          requestId: resolvedNotification.requestId,
        });

        // Check if permission exists before trying to resolve
        // It might already be resolved if this client initiated the response
        const permission = this.permissionHandler.getPendingPermission(
          resolvedNotification.requestId
        );

        // The daemon has now confirmed resolution, so drop the buffered answer
        // (kept until this point so reloads could re-apply it). Prefer the
        // permission's own tool-use ids; fall back to the notification's.
        const resolvedToolUseIds = permission
          ? permission.toolUses.map((toolUse) => toolUse.toolUse.id)
          : (resolvedNotification.toolUseIds ?? []);
        for (const resolvedToolUseId of resolvedToolUseIds) {
          this.pendingUserActionStore.takeForToolUse(resolvedToolUseId);
        }

        // The other associated sessions (e.g. a relayed subagent's parent) keep
        // their real working state, driven by their own notifications; we only
        // need them here to drain concurrent-prompt markers.
        const associatedWaitingSessionIds =
          permission?.associatedSessionIds.filter((id) => id !== sessionId) ??
          [];

        if (permission) {
          // Clear the permission from our handler
          this.permissionHandler.resolvePermission(
            resolvedNotification.requestId,
            resolvedNotification.selectedOption
          );
        }

        // Once a session's concurrent prompt batch fully drains, forget the
        // suppression marker so a future lone abandoned prompt clears normally.
        this.clearDrainedConcurrentPromptMarkers([
          sessionId,
          ...associatedWaitingSessionIds,
        ]);
        // Note: State update happens in SessionStateManager.handleNotification
        break;
      }

      case DaemonSpecificNotificationType.SESSION_INACTIVITY:
      case DaemonSpecificNotificationType.SESSION_PROCESS_EXITED: {
        // Keep prompts visible; responses are buffered until reload succeeds.
        this.inactiveSessions.add(sessionId);

        const pendingPermissionCount = this.permissionHandler
          .getPendingPermissions()
          .filter((p) => p.sessionId === sessionId).length;
        const pendingAskUserCount = this.askUserHandler
          .getPendingAskUserRequests()
          .filter((r) => r.sessionId === sessionId).length;

        logInfo(
          '[DaemonSessionController] Session became inactive; preserving pending prompts for later replay',
          {
            sessionId,
            pendingRequestCount: pendingPermissionCount,
            questionCount: pendingAskUserCount,
          }
        );

        // Reset working state to Idle so "Waiting for confirmation" indicator clears
        const sessionManager =
          this.sessionStateManager.getSessionManager(sessionId);
        if (sessionManager) {
          sessionManager.stopStreaming();
          this.emit(DroolEvent.DroolWorkingStateChanged, {
            sessionId,
            newState: DroolWorkingState.Idle,
          });
        }
        break;
      }

      case DaemonSpecificNotificationType.SESSION_CLOSED: {
        const shouldRetainSubagentSnapshot =
          this.isManagedSubagentSession(sessionId);
        this.inactiveSessions.delete(sessionId);
        this.sessionLoadOptions.delete(sessionId);
        this.managedSubagentSessionIds.delete(sessionId);
        this.clearPendingUserActionsForSession(sessionId, {
          preserveRelayedPermissions: shouldRetainSubagentSnapshot,
        });
        if (shouldRetainSubagentSnapshot) {
          break;
        }
        // Drop any buffered relayed-answer entries for this session. Once it is
        // fully closed (not retained for subagent replay) a buffered answer
        // whose PERMISSION_RESOLVED never arrived would otherwise leak for the
        // controller's lifetime.
        this.pendingUserActionStore.clearSession(sessionId);
        this.sessionStateManager.removeSession(sessionId);
        break;
      }

      case SessionNotificationType.DROOL_WORKING_STATE_CHANGED: {
        if (
          notification.newState !== DroolWorkingState.WaitingForToolConfirmation
        ) {
          this.clearStalePromptsOnResume(sessionId);
        }
        break;
      }

      case SessionNotificationType.AGENT_TURN_COMPLETED:
        this.sessionStateManager
          .getSessionManager(sessionId)
          ?.getStore()
          .setAgentTurnCompletionReason(notification.reason);
        break;

      case SessionNotificationType.ERROR:
        this.sessionStateManager
          .getSessionManager(sessionId)
          ?.getStore()
          .setAgentTurnCompletionReason(AgentTurnCompletionReason.Error);
        break;
      case SessionNotificationType.CHILD_SESSION_AVAILABLE:
        this.handleChildSessionAvailable(notification, sessionId);
        break;
      case SessionNotificationType.SESSION_COMPACTED:
      case SessionNotificationType.SETTINGS_UPDATED:
      case SessionNotificationType.SESSION_TITLE_UPDATED:
      case SessionNotificationType.MCP_STATUS_CHANGED:
      case SessionNotificationType.ASSISTANT_TEXT_DELTA:
      case SessionNotificationType.STRUCTURED_OUTPUT:
      case SessionNotificationType.THINKING_TEXT_DELTA:
      case SessionNotificationType.ASSISTANT_TEXT_COMPLETE:
      case SessionNotificationType.THINKING_TEXT_COMPLETE:
      case SessionNotificationType.MCP_AUTH_REQUIRED:
      case SessionNotificationType.MCP_AUTH_COMPLETED:
      case DaemonSpecificNotificationType.SESSION_UNSUBSCRIBED:
      case DaemonTerminalEvent.DATA:
      case DaemonTerminalEvent.EXIT:
      case SessionNotificationType.MISSION_STATE_CHANGED:
      case SessionNotificationType.MISSION_FEATURES_CHANGED:
      case SessionNotificationType.MISSION_PROGRESS_ENTRY:
      case SessionNotificationType.MISSION_HEARTBEAT:
      case SessionNotificationType.MISSION_WORKER_STARTED:
      case SessionNotificationType.MISSION_WORKER_COMPLETED:
      case SessionNotificationType.SESSION_TOKEN_USAGE_CHANGED:
      case SessionNotificationType.HOOK_EXECUTION_STARTED:
      case SessionNotificationType.HOOK_EXECUTION_COMPLETED:
      case SessionNotificationType.CREATE_MESSAGE:
      case SessionNotificationType.TOOL_RESULT:
      case SessionNotificationType.TOOL_PROGRESS_UPDATE:
      case SessionNotificationType.TOOL_CALL:
      case SessionNotificationType.QUEUED_MESSAGES_DISCARDED:
      case SessionNotificationType.LOOP_STATE_CHANGED:
      case SessionNotificationType.TOOL_EXECUTION_HEARTBEAT:
        // No side effects for these notification types
        break;
      default: {
        const exhaustiveCheck: never = notification;
        logError(
          '[DaemonSessionController] Unhandled notification type in side effects:',
          {
            type: exhaustiveCheck,
          }
        );
        break;
      }
    }
  }

  private handleChildSessionAvailable(
    notification: Extract<
      DaemonSessionNotificationParams['notification'],
      { type: SessionNotificationType.CHILD_SESSION_AVAILABLE }
    >,
    parentSessionId: string
  ): void {
    const { childSessionId, toolUseId } = notification;
    this.managedSubagentSessionIds.add(childSessionId);
    this.sessionStateManager.registerOptimisticChildSession({
      parentSessionId,
      childSessionId,
      machineId: this.config.machineId,
      toolUseId,
    });

    if (this.config.hydrateChildSessionsOnAvailable === false) {
      return;
    }

    this.hydrateChildSession(childSessionId);
  }

  private hydrateChildSession(sessionId: string): void {
    if (
      this.sessionStateManager.getSessionLoadState(sessionId) !==
        SessionLoadState.NotLoaded ||
      this.pendingChildSessionHydrations.has(sessionId)
    ) {
      return;
    }

    this.pendingChildSessionHydrations.add(sessionId);
    void this.loadSession({ sessionId })
      .catch((error) => {
        logWarn('[DaemonSessionController] Failed to hydrate child session', {
          sessionId,
          cause: error,
        });
      })
      .finally(() => {
        this.pendingChildSessionHydrations.delete(sessionId);
      });
  }

  /** Replay a buffered permission response matched by toolUseId. */
  private async tryReplayBufferedPermission(
    sessionId: string,
    requestId: string
  ): Promise<void> {
    const pending = this.permissionHandler.getPendingPermission(requestId);
    if (!pending) return;
    const toolUseId = pending.toolUses[0]?.toolUse.id;
    if (!toolUseId) return;

    // Peek (don't consume): the buffered answer must survive until the daemon
    // confirms resolution (PERMISSION_RESOLVED), so a later reload of any
    // associated session can re-apply it instead of re-surfacing the prompt.
    const stored = this.pendingUserActionStore.getForToolUse(toolUseId);
    if (!stored) return;

    const validOption = pending.options.some(
      (opt) => opt.value === stored.selectedOption
    );
    if (!validOption) {
      logWarn(
        '[DaemonSessionController] Discarding buffered permission: selectedOption no longer valid',
        {
          sessionId,
          toolUseId,
          selectedOptionLabel: stored.selectedOption,
        }
      );
      this.pendingUserActionStore.takeForToolUse(toolUseId);
      return;
    }

    try {
      await this.daemonClient.sendPermissionResponse(requestId, {
        sessionId,
        selectedOption: stored.selectedOption,
        comment: stored.comment,
        ...(stored.editedSpecContent !== undefined && {
          editedSpecContent: stored.editedSpecContent,
        }),
      });
      this.permissionHandler.resolvePermission(
        requestId,
        stored.selectedOption
      );
      logInfo(
        '[DaemonSessionController] Replayed buffered permission response',
        {
          sessionId,
          requestId,
          toolUseId,
          selectedOptionLabel: stored.selectedOption,
        }
      );
    } catch (error) {
      logException(
        error,
        '[DaemonSessionController] Failed to replay buffered permission response',
        { sessionId, requestId }
      );
    }
  }

  /**
   * During loadSession, replay a buffered permission response WITHOUT surfacing
   * the reloaded prompt. Returns true when a buffered answer was applied (so the
   * caller must not re-add the prompt); false when there is nothing to replay or
   * the buffered option is stale (so the caller should surface it normally).
   *
   * The buffer is keyed globally by tool-use id and is NOT consumed here — it
   * persists until the daemon confirms resolution (PERMISSION_RESOLVED) so every
   * reload (self-resume plus a manual open) keeps suppressing the already-
   * answered prompt instead of re-rendering it.
   */
  private async replayBufferedPermissionOnLoad({
    sessionId,
    requestId,
    toolUseId,
    options,
  }: {
    sessionId: string;
    requestId: string;
    toolUseId: string;
    options: ReadonlyArray<{ value: ToolConfirmationOutcome }>;
  }): Promise<boolean> {
    const stored = this.pendingUserActionStore.getForToolUse(toolUseId);
    if (!stored) {
      return false;
    }

    const validOption = options.some(
      (opt) => opt.value === stored.selectedOption
    );
    if (!validOption) {
      // The option set changed since the answer was recorded; drop the stale
      // record and surface the prompt so the user can re-answer.
      this.pendingUserActionStore.takeForToolUse(toolUseId);
      logWarn(
        '[DaemonSessionController] Discarding buffered permission on load: selectedOption no longer valid',
        {
          sessionId,
          requestId,
          toolUseId,
          selectedOptionLabel: stored.selectedOption,
        }
      );
      return false;
    }

    try {
      await this.daemonClient.sendPermissionResponse(requestId, {
        sessionId,
        selectedOption: stored.selectedOption,
        comment: stored.comment,
        ...(stored.editedSpecContent !== undefined && {
          editedSpecContent: stored.editedSpecContent,
        }),
      });
      logInfo(
        '[DaemonSessionController] Replayed buffered permission response on load',
        {
          sessionId,
          requestId,
          toolUseId,
          selectedOptionLabel: stored.selectedOption,
        }
      );
      return true;
    } catch (error) {
      // Leave the record in place for a later retry and surface the prompt so
      // the session is never silently stranded.
      logException(
        error,
        '[DaemonSessionController] Failed to replay buffered permission on load',
        { sessionId, requestId, toolUseId }
      );
      return false;
    }
  }

  /** Replay a buffered AskUser response matched by toolCallId. */
  private async tryReplayBufferedAskUser(
    sessionId: string,
    requestId: string
  ): Promise<void> {
    const pending = this.askUserHandler.getPendingAskUserRequest(requestId);
    if (!pending) return;

    const stored = this.pendingUserActionStore.takeForToolCall(
      sessionId,
      pending.toolCallId
    );
    if (!stored) return;

    if (stored.result.cancelled !== true) {
      const validIndices = new Set(pending.questions.map((q) => q.index));
      const allValid = stored.result.answers.every((a) =>
        validIndices.has(a.index)
      );
      if (!allValid) {
        logWarn(
          '[DaemonSessionController] Discarding buffered ask-user answer: question set changed',
          { sessionId, toolCallId: pending.toolCallId }
        );
        return;
      }
    }

    try {
      await this.daemonClient.sendAskUserResponse(requestId, {
        sessionId,
        ...stored.result,
      });
      this.askUserHandler.resolveAskUser(requestId, stored.result);
      logInfo('[DaemonSessionController] Replayed buffered ask-user response', {
        sessionId,
        requestId,
        toolCallId: pending.toolCallId,
      });
    } catch (error) {
      logException(
        error,
        '[DaemonSessionController] Failed to replay buffered ask-user response',
        { sessionId, requestId }
      );
      this.pendingUserActionStore.saveAskUser(stored);
    }
  }

  /** Replay buffered permission responses returned by loadSession. */
  private async replayBufferedPermissionResponses(
    sessionId: string,
    pendingPermissions: ReadonlyArray<{ requestId: string }>
  ): Promise<void> {
    if (
      this.pendingUserActionStore.getPermissionsForSession(sessionId).length ===
      0
    ) {
      return;
    }
    await Promise.allSettled(
      pendingPermissions.map((p) =>
        this.tryReplayBufferedPermission(sessionId, p.requestId)
      )
    );
  }

  /** Replay buffered AskUser responses returned by loadSession. */
  private async replayBufferedAskUserResponses(
    sessionId: string,
    pendingAskUserRequests: ReadonlyArray<{ requestId: string }>
  ): Promise<void> {
    if (
      this.pendingUserActionStore.getAskUsersForSession(sessionId).length === 0
    ) {
      return;
    }
    await Promise.allSettled(
      pendingAskUserRequests.map((r) =>
        this.tryReplayBufferedAskUser(sessionId, r.requestId)
      )
    );
  }

  private setupEventHandlers(): void {
    // DaemonClient connection events
    this.daemonClient.onConnectionOpen(async () => {
      await this.handleConnectionOpen();
    });

    this.daemonClient.onConnectionClose((code: number, reason: string) => {
      this.handleConnectionClose(code, reason);
    });

    this.daemonClient.onMessage((data: string) => {
      this.handleWebSocketMessage(data);
    });

    this.daemonClient.onConnectionError((error: Error) => {
      this.emit('error', error);
    });

    // Message router events - responses are now handled by DaemonClient internally
    // We only need to route notifications
    this.messageRouter.on('response', ({ response, requestId }) => {
      // DaemonClient handles responses internally via its pendingRequests map
      // This is only for logging/debugging
      if (!requestId) {
        this.emit(
          'error',
          new MetaError('Response missing requestId', { cause: response })
        );
      }
    });

    this.messageRouter.on('notification', ({ notification, sessionId }) => {
      const associatedPermissionSessionIds =
        notification.type === SessionNotificationType.PERMISSION_RESOLVED
          ? (this.permissionHandler
              .getPendingPermission(notification.requestId)
              ?.associatedSessionIds.filter((id) => id !== sessionId) ?? [])
          : [];
      const params = {
        sessionId,
        notification,
      };

      // Track notification metric
      Metrics.addToCounter(Metric.INDUSTRY_APP_JSONRPC_NOTIFICATION_COUNT, 1, {
        type: notification.type,
        machineConnectionType: this.getMachineConnectionType(),
        clientSurface: this.getClientSurface(),
      });

      // Emit raw notification event for subscribers that need all notification types
      this.emit(DroolEvent.SessionNotification, {
        sessionId,
        notification,
      });

      if (
        notification.type === SessionNotificationType.CREATE_MESSAGE &&
        notification.requestId &&
        this.inFlightAddUserMessageRequests.has(notification.requestId)
      ) {
        this.confirmedInFlightAddUserMessageRequests.add(
          notification.requestId
        );
      }

      // Delegate all state management to SessionStateManager
      this.sessionStateManager.handleNotification(params);

      // Handle side effects (permission management, session cleanup)
      this.handleNotificationSideEffects(notification, sessionId);

      // Emit UI events after side effects are complete
      // For optimistic updates, the real message will replace the optimistic one
      // which was already removed synchronously in MessageRouter.handleInboundMessage()
      this.emitDroolEventForNotification(notification, sessionId);

      for (const associatedSessionId of associatedPermissionSessionIds) {
        this.emit(DroolEvent.SessionNotification, {
          sessionId: associatedSessionId,
          notification,
        });
      }
    });

    // Connection status notification (no sessionId)
    this.messageRouter.on('connectionStatus', (params) => {
      // Store machine info for later retrieval
      this.machineInfo = {
        isDroolCLIInPath: params.isDroolCLIInPath,
        droolCLIVersion: params.droolCLIVersion,
        homedir: params.homedir,
        platform: params.platform,
      };

      // Emit event for components that want to listen
      this.emit('connectionStatus', params);
    });

    this.messageRouter.on('relayStatusChanged', (params) => {
      this.emit(DroolEvent.RelayStatusChanged, params);
    });

    this.messageRouter.on('cronStateChanged', (params) => {
      this.emit(DroolEvent.CronStateChanged, params);
    });

    this.messageRouter.on(
      'permissionRequest',
      ({ request, requestId, sessionId }) => {
        logInfo('[DaemonSessionController] Received permission request', {
          requestId,
          sessionId,
          toolCount: request.params.toolUses.length,
        });

        // Filter out permission requests for sessions we're not managing.
        // Previously these were silently dropped, which could wedge a
        // worker subprocess waiting forever for its permission response
        // (e.g. after the session was evicted or cleaned up). Now we
        // auto-cancel so the daemon propagates a definite Cancel back to
        // the worker and it can make progress.
        if (!this.sessionStateManager.getSessionManager(sessionId)) {
          logWarn(
            '[DaemonSessionController] Auto-cancelling permission request for unknown session',
            { sessionId, requestId }
          );
          // Best-effort send: guard against both synchronous throws (e.g. an IPC
          // transport disconnecting between request and response) and async
          // rejections. Either would otherwise escape this handler and
          // reintroduce the "worker wedged forever" failure mode.
          try {
            void Promise.resolve(
              this.daemonClient.sendPermissionResponse(requestId, {
                sessionId,
                selectedOption: ToolConfirmationOutcome.Cancel,
              })
            ).catch((error) => {
              logException(
                error,
                '[DaemonSessionController] Failed to auto-cancel permission for unknown session',
                { sessionId, requestId }
              );
            });
          } catch (error) {
            logException(
              error,
              '[DaemonSessionController] Failed to auto-cancel permission for unknown session (sync)',
              { sessionId, requestId }
            );
          }
          return;
        }

        const associatedSessionIds = Array.from(
          new Set([
            sessionId,
            ...(request.params.associatedSessionIds ?? []),
            ...this.getAssociatedSessionIdsForPermission(sessionId),
          ])
        );

        const requestWithAssociatedSessions: DaemonRequestPermission = {
          ...request,
          params: {
            ...request.params,
            sessionId,
            associatedSessionIds,
          },
        };

        logInfo(
          '[DaemonSessionController] Forwarding permission request to handler',
          {
            requestId,
            sessionId,
            sessionIds: associatedSessionIds,
          }
        );
        this.permissionHandler.handlePermissionRequest(
          requestWithAssociatedSessions,
          requestId,
          sessionId
        );
        this.markConcurrentPermissionSurfaces(
          new Set([sessionId, ...associatedSessionIds])
        );

        void this.tryReplayBufferedPermission(sessionId, requestId);
      }
    );

    this.messageRouter.on(
      'askUserRequest',
      ({ request, requestId, sessionId }) => {
        logInfo('[DaemonSessionController] Received ask-user request', {
          requestId,
          sessionId,
          questionCount: request.params.questions.length,
          toolCallId: request.params.toolCallId,
        });

        // Filter out ask-user requests for sessions we're not managing.
        // Same reasoning as the permission path above: auto-cancel
        // instead of silently dropping so the worker is never stranded.
        if (!this.sessionStateManager.getSessionManager(sessionId)) {
          logWarn(
            '[DaemonSessionController] Auto-cancelling ask-user request for unknown session',
            { sessionId, requestId }
          );
          // Best-effort send: guard against both synchronous throws and async
          // rejections so a transport failure here can never wedge the worker.
          try {
            void Promise.resolve(
              this.daemonClient.sendAskUserResponse(requestId, {
                sessionId,
                cancelled: true,
                answers: [],
              })
            ).catch((error) => {
              logException(
                error,
                '[DaemonSessionController] Failed to auto-cancel ask-user for unknown session',
                { sessionId, requestId }
              );
            });
          } catch (error) {
            logException(
              error,
              '[DaemonSessionController] Failed to auto-cancel ask-user for unknown session (sync)',
              { sessionId, requestId }
            );
          }
          return;
        }

        // Treat this as a "waiting for user" state similar to tool confirmation
        const sessionManager =
          this.sessionStateManager.getSessionManager(sessionId);
        sessionManager?.setWaitingForConfirmation();
        this.emit(DroolEvent.DroolWorkingStateChanged, {
          sessionId,
          newState: DroolWorkingState.WaitingForToolConfirmation,
        });

        this.askUserHandler.handleAskUserRequest(request, requestId, sessionId);

        void this.tryReplayBufferedAskUser(sessionId, requestId);
      }
    );

    // Permission handler events - forward to client
    this.permissionHandler.on('permissionRequested', (permission) => {
      this.emit(DroolEvent.PermissionRequested, permission);
    });

    this.permissionHandler.on('permissionResolved', (id, option) => {
      this.emit(DroolEvent.PermissionResolved, id, option);
    });

    this.permissionHandler.on('permissionTimeout', (id) => {
      this.emit(DroolEvent.PermissionTimeout, id);
    });

    // Ask-user handler events
    this.askUserHandler.on('askUserRequested', (req) => {
      this.emit(DroolEvent.AskUserRequested, req);
    });

    this.askUserHandler.on('askUserResolved', (id, result) => {
      this.emit(DroolEvent.AskUserResolved, id, result);
    });

    this.messageRouter.on('unsupportedSessionNotification', (event) => {
      this.emit(DroolEvent.UnsupportedSessionNotification, event);
    });
  }

  private handleWebSocketMessage(data: string): void {
    try {
      const parsed = JSON.parse(data);
      this.messageRouter.route(parsed);
    } catch (error) {
      logWarn('Error parsing in handleWebSocketMessage', {
        cause: error,
      });
      this.emit(
        'error',
        error instanceof Error ? error : new Error('Parse error')
      );
    }
  }

  private handleConnectionOpen(): void {
    this.isReconnecting = false;
    this.manuallyDisconnected = false;
    this.reconnectionStrategy.reset();
  }

  /**
   * Authenticate with the daemon after connection is established.
   * Emits Connected + statusChanged on success.
   * On failure, stores the failure in lastConnectionFailure, emits statusChanged,
   * disconnects, and re-throws so callers can react.
   */
  private async autoAuthenticate(): Promise<void> {
    if (this.config.authenticationMode === DaemonAuthenticationMode.Trusted) {
      this._isAuthenticated = true;
      this.lastConnectionFailure = null;
      logInfo('Trusted daemon IPC connection using inherited auth', {
        machineId: this.config.machineId,
      });
      this.emit(ConnectionState.Connected);
      this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());
      return;
    }

    // Track total authentication attempts
    Metrics.addToCounter(
      Metric.INDUSTRY_APP_JSONRPC_AUTHENTICATION_TOTAL_COUNT,
      1,
      {
        machineConnectionType: this.getMachineConnectionType(),
        clientSurface: this.getClientSurface(),
      }
    );

    try {
      const token = await this.config.getAccessToken();
      if (!token) {
        throw createConnectionFailure(ConnectionFailureReason.NoToken);
      }

      const actAsGrant = await this.config.getActAsGrant?.();

      await this.authenticateDaemon(token, actAsGrant);

      this.lastConnectionFailure = null;

      // Track authentication success metric
      Metrics.addToCounter(
        Metric.INDUSTRY_APP_JSONRPC_AUTHENTICATION_SUCCESS_COUNT,
        1,
        {
          machineConnectionType: this.getMachineConnectionType(),
          clientSurface: this.getClientSurface(),
        }
      );

      logInfo('Auto-authentication successful on connection', {
        machineId: this.config.machineId,
      });
      this.emit(ConnectionState.Connected);
      this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());
    } catch (error) {
      const failure =
        error instanceof ConnectionFailureError
          ? error
          : error instanceof AuthenticationError
            ? createConnectionFailure(ConnectionFailureReason.NoToken, {
                cause: error,
              })
            : createConnectionFailure(ConnectionFailureReason.Unknown, {
                cause: error instanceof Error ? error : undefined,
              });

      this.lastConnectionFailure = failure;
      logWarn('[DaemonSessionController] Daemon authentication failed', {
        reason: failure.reason,
        retryable: failure.retryable,
        cause: failure.originalError ?? failure,
      });
      if (!failure.retryable) {
        this.config.onAuthenticationError?.(failure);
      }
      this.daemonClient.disconnect();
      this.emit('error', failure);
      this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());

      throw failure;
    }
  }

  /**
   * Authenticate with the daemon. Translates daemon auth errors into
   * ConnectionFailureError.
   */
  private async authenticateDaemon(
    token: string,
    actAsGrant?: string
  ): Promise<void> {
    try {
      await this.authenticate(token, { actAsGrant });
    } catch (error) {
      if (error instanceof DaemonClientJsonRpcRequestError) {
        throw createConnectionFailure(
          error.error.code === JsonRpcErrorCode.AUTHENTICATION_ERROR
            ? ConnectionFailureReason.AuthRejected
            : ConnectionFailureReason.Unknown,
          { cause: error }
        );
      }
      if (error instanceof AuthenticationError) {
        throw createConnectionFailure(ConnectionFailureReason.AuthRejected, {
          cause: error,
        });
      }
      if (error instanceof DaemonClientRequestTimeoutError) {
        throw createConnectionFailure(ConnectionFailureReason.DaemonTimeout, {
          cause: error,
        });
      }
      throw createConnectionFailure(ConnectionFailureReason.Unknown, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  private handleConnectionClose(code: number, reason: string): void {
    // Reset authentication state on disconnect
    this._isAuthenticated = false;
    this.authenticationPromise = null;

    // If no explicit failure was recorded (e.g. unexpected close), record ConnectionLost
    if (!this.lastConnectionFailure && !this.manuallyDisconnected) {
      this.lastConnectionFailure = createConnectionFailure(
        ConnectionFailureReason.ConnectionLost
      );
    }

    // Emit disconnected event first so handlers can access pending requests if needed
    this.emit(ConnectionState.Disconnected, code, reason);
    this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());

    // DaemonClient handles clearing its own pending requests on close

    // Don't clear permissions on connection close - they should persist across reconnects
    // Permissions are tied to daemon state, not connection state
    // They will timeout naturally or be cleared on manual disconnect

    // Clear all queued messages for all sessions
    this.sessionStateManager.clearAllQueues();

    // Auto-reconnect for non-computer connections (local, workspace).
    // Computer connections skip auto-reconnect to avoid waking hibernating
    // machines: an idle pre-connected tab must not resume a paused sandbox and
    // incur compute. Interactive reconnection is instead triggered by
    // handleUserActivity in the active session page, and automation create/run
    // wakes the computer server-side (verifyComputerReady -> ensureRunning and
    // the backend connect path), independent of this client.
    if (
      this.config.machineType !== MachineType.Computer &&
      this.hasEverConnected &&
      !this.isReconnecting &&
      this.isRetryAllowed() &&
      !this.manuallyDisconnected
    ) {
      if (this.reconnectionStrategy.isReconnectDelegated()) {
        void this.runDelegatedReconnect();
      } else if (this.reconnectionStrategy.shouldReconnect()) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.reconnectionStrategy.shouldReconnect()) {
      this.emit('error', new Error('Max reconnection attempts reached'));
      this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());
      return;
    }

    this.isReconnecting = true;
    this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());

    // Exponential backoff for reconnection
    const delay = this.reconnectionStrategy.getNextDelay();

    this.reconnectionStrategy.incrementAttempts();

    this.reconnectTimer = setTimeout(() => {
      void this.attemptReconnect();
    }, delay);
  }

  private async attemptReconnect(): Promise<void> {
    // Check if already connected (race condition: initial connection succeeded after scheduling reconnect)
    if (this.daemonClient.isConnected()) {
      logInfo(
        '[DaemonSessionController] Already connected, skipping reconnection attempt',
        {
          machineId: this.config.machineId,
        }
      );
      this.isReconnecting = false;
      return;
    }

    // Note: attempts were already incremented in scheduleReconnect()
    const attempt = this.reconnectionStrategy.getAttempts();

    logInfo('[DaemonSessionController] Attempting connection', {
      machineId: this.config.machineId,
      attempt,
    });

    try {
      await this.connectAndAuthenticate();

      // Reset reconnection state on success
      this.isReconnecting = false;
      this.reconnectionStrategy.reset();
      this.reconnectTimer = null;
    } catch (error) {
      logWarn('[DaemonSessionController] Reconnection attempt failed', {
        machineId: this.config.machineId,
        attempt,
        cause: error,
      });

      // Non-retryable failures (auth rejected, no token) should stop immediately
      const shouldRetry =
        error instanceof ConnectionFailureError
          ? error.retryable
          : this.isRetryAllowed();

      if (shouldRetry && this.reconnectionStrategy.shouldReconnect()) {
        this.scheduleReconnect();
      } else {
        this.emit(
          'error',
          new MetaError('Failed to connect after max attempts')
        );
        this.emit(
          ConnectionState.Disconnected,
          WebSocketCloseCode.NORMAL_CLOSURE,
          'Max reconnection attempts reached'
        );
        this.isReconnecting = false;
        this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());
      }
    }
  }

  private async runDelegatedReconnect(): Promise<void> {
    if (this.isReconnecting) {
      return;
    }
    this.isReconnecting = true;
    this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());

    const abortController = new AbortController();
    this.delegatedReconnectAbort = abortController;

    let recovered = false;
    try {
      recovered = await this.pollUntilConnected(
        DaemonSessionController.DELEGATED_RECONNECT_MAX_POLL_ATTEMPTS,
        abortController.signal
      );
    } catch (error) {
      logWarn('[DaemonSessionController] Delegated reconnect poll aborted', {
        machineId: this.config.machineId,
        cause: error,
      });
    } finally {
      if (this.delegatedReconnectAbort === abortController) {
        this.delegatedReconnectAbort = null;
      }
    }

    // A manual disconnect/teardown during the poll aborts the loop; don't fight
    // it by reconnecting or emitting a terminal Disconnected after teardown.
    if (abortController.signal.aborted) {
      return;
    }

    if (recovered) {
      this.isReconnecting = false;
      return;
    }

    this.isReconnecting = false;
    logWarn(
      '[DaemonSessionController] Delegated reconnect exhausted; daemon did not recover',
      { machineId: this.config.machineId }
    );
    this.emit(
      ConnectionState.Disconnected,
      WebSocketCloseCode.NORMAL_CLOSURE,
      'Daemon did not recover after restart'
    );
    this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());
  }

  async connect(): Promise<void> {
    // Reset attempt counter for fresh connection session on manual connection
    this.reconnectionStrategy.reset();
    await this.daemonClient.connect(this.config.url);
  }

  /**
   * Reset reconnection attempts counter.
   * Should be called when user manually triggers a reconnection.
   */
  resetReconnectionAttempts(): void {
    this.reconnectionStrategy.reset();
  }

  /**
   * Check if the connection is authenticated
   */
  get isAuthenticated(): boolean {
    return this._isAuthenticated;
  }

  /**
   * Authenticate the WebSocket connection with the daemon.
   * ]\\\--st be called after connect() and before any session operations.
   * Prevents concurrent authentication attempts.
   * @param token - WorkOS JWT access token
   * @param options.actAsGrant - act-as delegation grant (`fdg-...`). When
   *   provided, the operator's `token` plus this grant authenticate the
   *   connection as the target service account on an SA-owned daemon.
   */
  async authenticate(
    token: string,
    options?: { actAsGrant?: string }
  ): Promise<void> {
    // If already authenticated, return immediately
    if (this._isAuthenticated) {
      logInfo('Already authenticated, skipping duplicate authenticate call');
      return;
    }

    // If authentication is already in progress, wait for it to complete
    if (this.authenticationPromise) {
      logInfo('Authentication in progress, waiting for completion');
      await this.authenticationPromise;
      return;
    }

    // Start authentication and store the promise. metadata.tracing
    // carries client app + machine context so daemon spans have it
    // even when the browser's OTLP export fails (ad blockers).
    const connectionId = this.daemonClient.getConnectionId();
    this.authenticationPromise = this.daemonClient.authenticate({
      token,
      ...(options?.actAsGrant && { actAsGrant: options.actAsGrant }),
      ...(connectionId && { connectionId }),
      caller: this.isDesktopApp() ? ClientType.WebDesktop : ClientType.WebApp,
      metadata: {
        tracing: {
          ...this.daemonClient.getTracingMetadata(),
          app: this.getClientSurface(),
        },
      },
    });

    try {
      const result = await this.authenticationPromise;
      this._isAuthenticated = true;
      logInfo('Daemon connection authenticated', {
        machineId: this.config.machineId,
        userId: result?.userId,
        orgId: result?.orgId,
      });
    } finally {
      // Clear the promise whether success or failure
      this.authenticationPromise = null;
    }
  }

  async logout(): Promise<void> {
    if (!this._isAuthenticated) {
      return;
    }

    await this.daemonClient.logout();
    this._isAuthenticated = false;
    this.authenticationPromise = null;
    this.permissionHandler.clearAllPermissions();
    this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());
  }

  disconnect(): void {
    this.manuallyDisconnected = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.delegatedReconnectAbort?.abort();
    this.delegatedReconnectAbort = null;
    this.isReconnecting = false;
    this._isAuthenticated = false;
    this.authenticationPromise = null;
    this.permissionHandler.clearAllPermissions();
    this.daemonClient.destroy();
    this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());
  }

  /**
   * Send `initialize_session` to the daemon, transparently retrying on
   * RequestTimeoutError up to INITIALIZE_SESSION_MAX_ATTEMPTS. Other errors
   * (auth failure, JSON-RPC error, transport closed) are not retried — they
   * indicate a non-transient problem the user must see immediately.
   *
   * On the daemon side, `handleInitializeSession` is keyed by `sessionId`
   * (which is generated client-side and reused across retries), so a retry
   * with the same sessionId will be deduped if the previous attempt
   * eventually succeeded; otherwise it spawns a fresh attempt.
   */
  private async initializeSessionWithRetry(
    params: DaemonInitializeSessionRequestParams,
    options?: { timeout?: number }
  ): Promise<InitializeSessionResult> {
    const perAttemptTimeout =
      options?.timeout ?? INITIALIZE_SESSION_PER_ATTEMPT_TIMEOUT_MS;
    const maxAttempts = INITIALIZE_SESSION_MAX_ATTEMPTS;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.daemonClient.initializeSession(params, {
          timeout: perAttemptTimeout,
        });
      } catch (error) {
        lastError = error;
        const isTimeout = error instanceof DaemonClientRequestTimeoutError;
        const willRetry = isTimeout && attempt < maxAttempts;
        if (!willRetry) {
          throw error;
        }
        logWarn(
          '[DaemonSessionController] initializeSession timed out; retrying',
          {
            sessionId: params.sessionId,
            machineId: params.machineId,
            attempt,
            maxAttempts,
            timeout: perAttemptTimeout,
          }
        );
      }
    }
    // Unreachable: the loop either returns or throws on the final attempt.
    throw lastError instanceof Error
      ? lastError
      : new Error('initializeSession failed without error');
  }

  async initializeSession(
    params: DaemonInitializeSessionRequestParams,
    options?: { timeout?: number }
  ): Promise<InitializeSessionResult> {
    const initPromise = this.performInitializeSession(params, options);
    if (params.sessionId !== undefined) {
      this.sessionLoadInFlight.set(params.sessionId, initPromise);
      this.daemonClient.setPendingSessionReady?.(params.sessionId, initPromise);
      try {
        return await initPromise;
      } finally {
        if (this.sessionLoadInFlight.get(params.sessionId) === initPromise) {
          this.sessionLoadInFlight.delete(params.sessionId);
        }
      }
    }
    return initPromise;
  }

  private async performInitializeSession(
    params: DaemonInitializeSessionRequestParams,
    options?: { timeout?: number }
  ): Promise<InitializeSessionResult> {
    // Note: Machine ID was already set by markSessionLoading
    // No need to set it again here
    let result: InitializeSessionResult;
    try {
      result = await this.initializeSessionWithRetry(params, options);
    } catch (error) {
      logWarn('[DaemonSessionController] Session initialization failed', {
        sessionId: params.sessionId,
        cause: error,
      });
      throw error;
    }
    if (result.session.title) {
      this.sessionStateManager
        .getSessionManager(result.sessionId)
        ?.getStore()
        .setTitle(result.session.title);
    }
    this.sessionStateManager.initializeSession(
      result.sessionId,
      result.session.messages
    );

    // When the daemon created a worktree for this session, its actual
    // working directory is the worktree path, not the parent repo path the
    // caller passed in. Seed the session store + SessionInitialized event
    // with the worktree path so consumers (e.g. the title bar) reflect the
    // real cwd from the first render after init resolves, without waiting
    // for a sidebar refresh.
    const effectiveCwd = result.worktree?.path ?? params.cwd;
    const sessionManager = this.sessionStateManager.getSessionManager(
      result.sessionId
    );
    sessionManager?.getStore().setCwd(effectiveCwd ?? null);
    const { callingSessionId, callingToolUseId } = getSubagentCallingMetadata(
      params.tags
    );
    if (result.session.title) {
      sessionManager?.getStore().setTitle(result.session.title);
    }
    if (callingSessionId) {
      sessionManager?.getStore().setCallingSessionId(callingSessionId);
    }
    if (callingToolUseId) {
      sessionManager?.getStore().setCallingToolUseId(callingToolUseId);
    }
    if (
      callingSessionId &&
      params.tags?.some((tag) => tag.name === SESSION_TAG_SUBAGENT)
    ) {
      this.managedSubagentSessionIds.add(result.sessionId);
    }

    // Seed spawn options so ensureSessionLoaded can replay them on re-load.
    this.sessionLoadOptions.set(
      result.sessionId,
      DaemonLoadSessionSpawnOptionsSchema.parse({
        disableInactivityTimeout: params.disableInactivityTimeout,
        runtimeSettingsPath: params.runtimeSettingsPath,
      })
    );

    // Emit AFTER terminal is created so listeners see the terminal already exists
    this.emit(DroolEvent.SessionInitialized, {
      sessionId: result.sessionId,
      hostId: result.hostId,
      cwd: effectiveCwd,
      repoRoot: result.worktree?.repoRoot,
      selectedWorkspaceId: params.workspaceId,
      callingSessionId,
      callingToolUseId,
      decompSessionType: params.decompSessionType,
      tags: params.tags,
    });

    logInfo('[DaemonSessionController] Session initialized', {
      sessionId: result.sessionId,
    });

    // Populate SSM store with initial settings from the daemon response
    if (sessionManager) {
      const store = sessionManager.getStore();
      const s = result.settings;
      if (s.modelId !== undefined) store.setModelId(s.modelId);
      if (s.reasoningEffort !== undefined)
        store.setReasoningEffort(s.reasoningEffort);
      if (s.interactionMode !== undefined)
        store.setInteractionMode(s.interactionMode);
      if (s.autonomyLevel !== undefined)
        store.setAutonomyLevel(s.autonomyLevel);
      if (s.specModeModelId !== undefined)
        store.setSpecModeModelId(s.specModeModelId ?? null);
      if (s.specModeReasoningEffort !== undefined)
        store.setSpecModeReasoningEffort(s.specModeReasoningEffort ?? null);
      store.setMissionSettings(s.missionSettings ?? null);
      if (s.tags !== undefined || params.tags !== undefined) {
        store.setTags(s.tags ?? params.tags ?? null);
      }
      if (s.compactionThresholdCheckEnabled !== undefined) {
        store.setCompactionThresholdCheckEnabled(
          s.compactionThresholdCheckEnabled
        );
      }
      if (result.availableModels) {
        store.setAvailableModels(result.availableModels);
      }
      store.notify();
    }

    this.emit(DroolEvent.SessionSettingsUpdated, {
      sessionId: result.sessionId,
      settings: result.settings,
    });

    return result;
  }

  /**
   * Auto-loads sessions that the controller has previously loaded but that
   * have since transitioned out of `Loaded` (e.g. daemon-side inactivity
   * cleanup). Sessions with no registered manager, or sessions whose
   * `Loading` state is owned by another in-flight loadSession or
   * initializeSession, are passed through without a speculative load.
   */
  async ensureSessionLoaded(sessionId: string): Promise<void> {
    const manager = this.sessionStateManager.getSessionManager(sessionId);
    if (!manager) {
      return;
    }
    const loadState = manager.getLoadState();
    if (loadState === SessionLoadState.Loaded) {
      return;
    }
    const inFlight = this.sessionLoadInFlight.get(sessionId);
    if (inFlight) {
      await inFlight;
      return;
    }
    if (loadState !== SessionLoadState.NotLoaded) {
      return;
    }
    const stashed = this.sessionLoadOptions.get(sessionId) ?? {};
    await this.loadSession({ ...stashed, sessionId });
  }

  async loadSession(
    params: Omit<DaemonLoadSessionRequestParams, 'token'>
  ): Promise<LoadSessionResult> {
    const loadPromise = this.performLoadSession(params);
    this.sessionLoadInFlight.set(params.sessionId, loadPromise);
    try {
      return await loadPromise;
    } finally {
      // Reference check: a newer concurrent load may have replaced this entry.
      if (this.sessionLoadInFlight.get(params.sessionId) === loadPromise) {
        this.sessionLoadInFlight.delete(params.sessionId);
      }
    }
  }

  private async performLoadSession(
    params: Omit<DaemonLoadSessionRequestParams, 'token'>
  ): Promise<LoadSessionResult> {
    // Register session as loading if it's currently inactive
    this.sessionStateManager.markSessionLoading(
      params.sessionId,
      this.config.machineId
    );

    const fetched = await this.config.getAccessToken();
    if (fetched === null) {
      throw new MetaError('No access token available for loadSession', {
        sessionId: params.sessionId,
      });
    }

    const resolvedParams: DaemonLoadSessionRequestParams = {
      ...params,
      token: fetched,
      loadAllMessages:
        this.getClientType() === 'cli' ? params.loadAllMessages : true,
      disableInactivityTimeout:
        params.disableInactivityTimeout ?? this.config.disableInactivityTimeout,
    };

    // Preserve spawn options for later self-resume.
    this.sessionLoadOptions.set(
      params.sessionId,
      DaemonLoadSessionSpawnOptionsSchema.parse({
        disableInactivityTimeout: resolvedParams.disableInactivityTimeout,
        skipPermissionsUnsafe: resolvedParams.skipPermissionsUnsafe,
        runtimeSettingsPath: resolvedParams.runtimeSettingsPath,
      })
    );

    let result: LoadSessionResult;
    // Share the in-flight load with in-process transports.
    const loadPromise = this.daemonClient.loadSession(resolvedParams);
    this.daemonClient.setPendingSessionReady?.(params.sessionId, loadPromise);
    try {
      result = await loadPromise;
      // inactiveSessions flag is cleared after replay below (see try/finally).
      this.sessionStateManager.loadSession(
        params.sessionId,
        this.config.machineId,
        result.session.messages,
        { cwd: result.cwd ?? null }
      );
    } catch (error) {
      // Check if this is a "Session not found" error using JSON-RPC error code.
      // Note: DaemonClient throws its own JsonRpcRequestError (from ../errors)
      // which is different from the session-level JsonRpcRequestError (from ./errors).
      // We check both to handle errors from either source.
      const sessionRpcError =
        error instanceof JsonRpcRequestError ? error.rpcError : undefined;
      const daemonRpcError =
        error instanceof DaemonClientJsonRpcRequestError
          ? error.error
          : undefined;
      const errorCode =
        sessionRpcError?.code ?? daemonRpcError?.code ?? undefined;
      const isSessionNotFound = errorCode === JsonRpcErrorCode.ENTITY_NOT_FOUND;

      if (isSessionNotFound) {
        // Mark session as not found in state manager (persists across remounts)
        this.sessionStateManager.markSessionNotFound(params.sessionId);
        this.emit(DroolEvent.SessionNotFound, params.sessionId);
        throw new SessionNotFoundError();
      }
      throw error;
    }

    // Store settings in the session store
    const sessionManager = this.sessionStateManager.getSessionManager(
      params.sessionId
    );
    if (sessionManager && result.settings) {
      if (result.settings.modelId !== undefined) {
        sessionManager.getStore().setModelId(result.settings.modelId);
      }
      if (result.settings.reasoningEffort !== undefined) {
        sessionManager
          .getStore()
          .setReasoningEffort(result.settings.reasoningEffort);
      }
      sessionManager.applyInteractionSettings(result.settings);
      if (result.settings.specModeModelId !== undefined) {
        sessionManager
          .getStore()
          .setSpecModeModelId(result.settings.specModeModelId);
      }
      if (result.settings.specModeReasoningEffort !== undefined) {
        sessionManager
          .getStore()
          .setSpecModeReasoningEffort(result.settings.specModeReasoningEffort);
      }
      sessionManager
        .getStore()
        .setMissionSettings(result.settings.missionSettings ?? null);
      if (result.settings.tags !== undefined) {
        sessionManager.getStore().setTags(result.settings.tags);
      }
      if (result.settings.compactionThresholdCheckEnabled !== undefined) {
        sessionManager
          .getStore()
          .setCompactionThresholdCheckEnabled(
            result.settings.compactionThresholdCheckEnabled
          );
      }
    }

    // Store token usage from load response (ensures it's available even without notification)
    if (sessionManager && result.tokenUsage) {
      sessionManager.getStore().setTokenUsage(result.tokenUsage);
    }

    this.emit(DroolEvent.SessionSettingsUpdated, {
      sessionId: params.sessionId,
      settings: result.settings,
    });

    // Drain buffered responses before clearing inactiveSessions so user
    // clicks during the restore+replay window can't race the replay.
    let hasPendingAskUserRequests = false;
    try {
      // Clear any stale permissions for this session before restoring from daemon
      // This ensures we don't keep permissions that the daemon lost (e.g., after
      // restart). Relayed subagent permissions are preserved: they belong to a
      // child session and are never returned by the parent's loadSession, so
      // clearing them here would drop a still-pending prompt when returning to
      // the parent.
      this.permissionHandler.clearSessionPermissions(params.sessionId, {
        preserveRelayed: true,
      });

      // Restore any pending permissions from the loaded session
      // (Need to do this before setting working state)
      const reloadedPermissions = result.pendingPermissions ?? [];
      // Counts only prompts actually surfaced to the UI. Permissions already
      // answered (buffered by tool-use id) are replayed silently below and must
      // not leave the session in WaitingForToolConfirmation or flash a prompt.
      let surfacedPermissionCount = 0;

      if (reloadedPermissions.length > 0) {
        const invalidPermissions: Array<{
          requestId: string;
          toolUseId: string;
          error: string;
        }> = [];

        for (const permissionRequest of reloadedPermissions) {
          const reloadedToolUseId =
            permissionRequest.toolUses?.[0]?.toolUse?.id;
          if (reloadedToolUseId) {
            const replayed = await this.replayBufferedPermissionOnLoad({
              sessionId: params.sessionId,
              requestId: permissionRequest.requestId,
              toolUseId: reloadedToolUseId,
              options: permissionRequest.options,
            });
            if (replayed) {
              continue;
            }
          }

          const associatedSessionIds = Array.from(
            new Set([
              params.sessionId,
              ...(permissionRequest.associatedSessionIds ?? []),
              ...(result.callingSessionId ? [result.callingSessionId] : []),
              ...this.getAssociatedSessionIdsForPermission(params.sessionId),
            ])
          );
          // Validate server data before constructing permission object
          const request = DaemonRequestPermissionSchema.safeParse({
            type: 'request' as const,
            jsonrpc: JSONRPC_VERSION,
            industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
            industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
            id: permissionRequest.requestId,
            method: DaemonDroolEvent.REQUEST_PERMISSION,
            params: {
              sessionId: params.sessionId,
              associatedSessionIds,
              options: permissionRequest.options,
              toolUses: permissionRequest.toolUses,
            },
          });

          if (!request.success) {
            logError(
              '[DaemonSessionController] Invalid permission data from server',
              {
                sessionId: params.sessionId,
                requestId: permissionRequest.requestId,
                error: request.error,
              }
            );

            // Track invalid permission for auto-rejection
            invalidPermissions.push({
              requestId: permissionRequest.requestId,
              toolUseId:
                permissionRequest.toolUses?.[0]?.toolUse?.id ?? 'unknown',
              error: request.error.message,
            });
            continue;
          }

          // Reuse existing handler logic (sets up state, emits events)
          this.permissionHandler.handlePermissionRequest(
            request.data,
            permissionRequest.requestId,
            params.sessionId
          );
          surfacedPermissionCount += 1;
        }

        // Auto-reject invalid permissions to prevent session from hanging
        // If auto-rejection fails, daemon will timeout on its own
        if (invalidPermissions.length > 0) {
          await Promise.allSettled(
            invalidPermissions.map(async (invalid) => {
              try {
                await this.daemonClient.sendPermissionResponse(
                  invalid.requestId,
                  {
                    sessionId: params.sessionId,
                    selectedOption: ToolConfirmationOutcome.Cancel,
                  }
                );
              } catch (error) {
                // Auto-rejection failed - daemon will timeout
                logException(
                  error,
                  '[DaemonSessionController] Failed to auto-reject invalid permission - daemon will timeout',
                  {
                    sessionId: params.sessionId,
                    requestId: invalid.requestId,
                  }
                );
              }
            })
          );
        }

        logInfo(
          '[DaemonSessionController] Restored pending permissions on load',
          {
            sessionId: params.sessionId,
            totalCount: reloadedPermissions.length,
            succeeded: surfacedPermissionCount,
            errorCount: invalidPermissions.length,
          }
        );

        // Defensive: drain any buffered responses not consumed above (e.g. a
        // surfaced prompt whose buffered answer arrived during this load).
        await this.replayBufferedPermissionResponses(
          params.sessionId,
          reloadedPermissions
        );
      }

      // Clear any stale ask-user requests for this session before restoring from daemon
      this.askUserHandler.clearSessionAskUserRequests(params.sessionId);

      // Restore any pending ask-user requests from the loaded session
      hasPendingAskUserRequests = !!(
        result.pendingAskUserRequests &&
        result.pendingAskUserRequests.length > 0
      );

      if (hasPendingAskUserRequests) {
        for (const askUserRequest of result.pendingAskUserRequests!) {
          const request = DaemonAskUserSchema.safeParse({
            type: 'request' as const,
            jsonrpc: JSONRPC_VERSION,
            industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
            industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
            id: askUserRequest.requestId,
            method: DaemonDroolEvent.ASK_USER,
            params: {
              sessionId: params.sessionId,
              toolCallId: askUserRequest.toolCallId,
              questions: askUserRequest.questions,
            },
          });

          if (!request.success) {
            logError(
              '[DaemonSessionController] Invalid ask-user data from server',
              {
                sessionId: params.sessionId,
                requestId: askUserRequest.requestId,
                error: request.error,
              }
            );
            continue;
          }

          this.askUserHandler.handleAskUserRequest(
            request.data,
            askUserRequest.requestId,
            params.sessionId
          );
        }

        logInfo(
          '[DaemonSessionController] Restored pending ask-user requests on load',
          {
            sessionId: params.sessionId,
            count: result.pendingAskUserRequests!.length,
          }
        );

        await this.replayBufferedAskUserResponses(
          params.sessionId,
          result.pendingAskUserRequests!
        );
      }
    } finally {
      this.inactiveSessions.delete(params.sessionId);
    }

    if (sessionManager) {
      await reconcileQueuedMessagesAfterLoad({
        daemonClient: this.daemonClient,
        result,
        sessionId: params.sessionId,
        sessionManager,
      });
    }

    // Handle agent loop state from load.
    // A pending permission ASSOCIATED with this session (including a relayed
    // subagent permission preserved across reload) means we are waiting for
    // confirmation — even if this session's own agent loop isn't "in progress"
    // (e.g. returning to a parent whose subagent is blocked on approval).
    // Otherwise, if the agent loop is in progress, we're streaming.
    const hasAssociatedPendingPermission =
      this.permissionHandler.getPendingPermissionsForSession(params.sessionId)
        .length > 0;
    if (hasAssociatedPendingPermission || hasPendingAskUserRequests) {
      sessionManager?.setWaitingForConfirmation();
      this.emit(DroolEvent.DroolWorkingStateChanged, {
        sessionId: params.sessionId,
        newState: DroolWorkingState.WaitingForToolConfirmation,
      });
      logInfo(
        '[DaemonSessionController] Agent waiting for user input on load',
        {
          sessionId: params.sessionId,
          pendingRequestCount: hasAssociatedPendingPermission ? 1 : 0,
          questionCount: hasPendingAskUserRequests ? 1 : 0,
        }
      );
    } else if (result.isAgentLoopInProgress) {
      sessionManager?.startStreaming();
      this.emit(DroolEvent.DroolWorkingStateChanged, {
        sessionId: params.sessionId,
        newState: DroolWorkingState.StreamingAssistantMessage,
      });
      logInfo('[DaemonSessionController] Agent loop in progress on load', {
        sessionId: params.sessionId,
      });
    } else if (
      sessionManager &&
      sessionManager.getDroolWorkingState() !== DroolWorkingState.Idle
    ) {
      sessionManager.stopStreaming();
      this.emit(DroolEvent.DroolWorkingStateChanged, {
        sessionId: params.sessionId,
        newState: DroolWorkingState.Idle,
      });
    }

    // Load any existing terminals for the session when the current transport
    // supports terminal restoration on load.
    if (this.config.supportsTerminalRestoreOnLoad !== false) {
      await this.loadTerminals(params.sessionId);
    }

    // Store available models if provided
    if (sessionManager && result.availableModels) {
      sessionManager.getStore().setAvailableModels(result.availableModels);
    }

    if (sessionManager && result.session.title) {
      sessionManager.getStore().setTitle(result.session.title);
    }

    // Store decomposition session type if provided
    if (sessionManager && result.decompSessionType) {
      sessionManager.getStore().setDecompSessionType(result.decompSessionType);
    }

    // Store calling session ID if provided
    if (sessionManager && result.callingSessionId) {
      sessionManager.getStore().setCallingSessionId(result.callingSessionId);
    }
    if (sessionManager && result.callingToolUseId) {
      sessionManager.getStore().setCallingToolUseId(result.callingToolUseId);
    }
    if (
      result.callingSessionId &&
      result.settings?.tags?.some((tag) => tag.name === SESSION_TAG_SUBAGENT)
    ) {
      this.managedSubagentSessionIds.add(params.sessionId);
    }

    // Store session tags if provided so consumers (e.g. the automation
    // backlink) can read them for live sessions whose backend query is
    // disabled while the daemon manager is the source of truth.
    if (sessionManager && result.settings?.tags !== undefined) {
      sessionManager.getStore().setTags(result.settings.tags);
    }

    // Populate mission store if this session has mission state
    if (result.mission) {
      const missionStore = this.getMissionStoreForSession(params.sessionId);
      if (missionStore) {
        missionStore.setTitle?.(result.mission.title ?? null);
        missionStore.setState(result.mission.state);
        missionStore.setFeatures(result.mission.features);
        missionStore.setProgressLog(result.mission.progressLog);
        missionStore.setTokenUsageBySessionId(
          result.mission.tokenUsageBySessionId ?? {}
        );

        // Populate workers with their completion status from workerStates
        const workerStates = (
          result.mission as {
            workerStates?: Record<string, WorkerStateInfo>;
          }
        ).workerStates;
        for (const workerSessionId of result.mission.workerSessionIds) {
          const workerState = workerStates?.[workerSessionId];
          if (workerState) {
            missionStore.addWorkerWithState(workerSessionId, workerState);
          } else {
            missionStore.addWorker(workerSessionId);
          }
        }
      }
    }

    // Keep mission association bookkeeping consistent across consumers.
    if (this.missionStateManager) {
      if (result.mission) {
        this.missionStateManager.associateSessionWithMission(
          params.sessionId,
          params.sessionId
        );
        for (const workerSessionId of result.mission.workerSessionIds) {
          this.missionStateManager.associateSessionWithMission(
            workerSessionId,
            params.sessionId
          );
        }
      } else if (result.callingSessionId) {
        this.missionStateManager.associateWorkerWithParentMission(
          result.callingSessionId,
          params.sessionId
        );
      }
    }

    this.emit(DroolEvent.SessionLoaded, {
      sessionId: params.sessionId,
      hostId: result.hostId,
      cwd: result.cwd,
      callingSessionId: result.callingSessionId,
      callingToolUseId: result.callingToolUseId,
      decompSessionType: result.decompSessionType,
      tags: result.settings?.tags,
    });
    logInfo('[DaemonSessionController] Session loaded', {
      sessionId: params.sessionId,
    });
    return result;
  }

  async addUserMessage(
    sessionId: string,
    params: AddUserMessageRequestParams,
    externalRequestId?: string
  ): Promise<AddUserMessageResult> {
    // Check if drool is idle before sending - if so, skip queued state
    let sessionManager = this.sessionStateManager.getSessionManager(sessionId);

    // Use caller-provided requestId if available (enables optimistic message tracking)
    const requestId = externalRequestId ?? uuidv4();

    const content = buildUserMessageContentBlocks({
      text: params.text,
      images: params.images,
      files: params.files,
    });

    // Debug logging for file attachments
    if (params.files && params.files.length > 0) {
      const fileInfo = params.files.map((f) => ({
        name: f.name,
        type: f.type,
        mediaType: f.mediaType,
        hasData: Boolean(f.data),
        dataLength: f.data?.length ?? 0,
        hasParsedData: 'parsedData' in f && Boolean(f.parsedData),
        parsedDataLength: 'parsedData' in f ? (f.parsedData?.length ?? 0) : 0,
      }));
      logInfo('[DaemonSessionController] Sending files with message', {
        sessionId,
        fileCount: params.files.length,
        data: fileInfo,
      });
    }

    // Send request with explicit ID
    this.inFlightAddUserMessageRequests.add(requestId);
    let result: AddUserMessageResult;
    try {
      result = await this.daemonClient.addUserMessage(
        {
          ...params,
          sessionId,
        },
        requestId
      );
    } catch (error) {
      this.inFlightAddUserMessageRequests.delete(requestId);
      this.confirmedInFlightAddUserMessageRequests.delete(requestId);
      throw error;
    }
    this.inFlightAddUserMessageRequests.delete(requestId);
    const wasConfirmedWhileRequestPending =
      this.confirmedInFlightAddUserMessageRequests.delete(requestId);

    // Compute idle state AFTER the await — beforeRequest may auto-load
    // the session and restore streaming/waiting state.
    sessionManager =
      this.sessionStateManager.getSessionManager(sessionId) ?? sessionManager;
    const isDroolIdle =
      sessionManager?.getDroolWorkingState() === DroolWorkingState.Idle;
    const wasOptimisticallySubmittedWhileIdle =
      sessionManager?.getOptimisticMessage(requestId) !== undefined;

    if (params.skipAgentLoop) {
      // Message was persisted without starting the agent loop.
      // No working state change needed.
      logInfo(
        '[DaemonSessionController] User message added without agent loop',
        { sessionId, requestId }
      );
    } else if (wasConfirmedWhileRequestPending) {
      // The daemon's CREATE_MESSAGE notification beat this RPC response, so
      // the daemon has already started processing the turn and emits its own
      // working-state notifications. Skip the optimistic startStreaming /
      // queue transitions below to avoid re-adding an already-confirmed turn.
      logInfo(
        '[DaemonSessionController] User message already confirmed before request completed',
        { sessionId, requestId }
      );
    } else if (
      params.queuePlacement !== QueuePlacement.EndOfLoop &&
      (isDroolIdle || wasOptimisticallySubmittedWhileIdle)
    ) {
      if (isDroolIdle) {
        // Drool was idle - message will be processed immediately
        // Skip queued state and go straight to streaming
        sessionManager?.startStreaming();
        this.emit(DroolEvent.MessageAdded, true);
        this.emit(DroolEvent.DroolWorkingStateChanged, {
          sessionId,
          newState: DroolWorkingState.StreamingAssistantMessage,
        });
      }

      logInfo('[DaemonSessionController] User message processing immediately', {
        sessionId,
        requestId,
        state: sessionManager?.getDroolWorkingState(),
        reason: wasOptimisticallySubmittedWhileIdle
          ? 'optimistically_submitted_while_idle'
          : 'drool_idle',
      });
    } else {
      // Drool is busy - message is queued for UI display until the daemon
      // either processes it or discards it during an interrupt. Client-local
      // post-ESC deferrals use LocalDeferredAfterEsc and auto-drain separately.
      this.sessionStateManager.queueUserMessage({
        sessionId,
        requestId,
        content,
        kind: getQueuedUserMessageKindForQueuePlacement(params.queuePlacement),
      });

      // Create full message for event emission only
      const queuedMessage: IndustryDroolMessage = {
        id: `queued-${requestId}`,
        role: params.role ?? MessageRole.User,
        content,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(params.visibility && { visibility: params.visibility }),
      };

      // Emit queued event
      this.emit(DroolEvent.MessageQueued, {
        sessionId,
        requestId,
        message: queuedMessage,
      });

      logInfo(
        '[DaemonSessionController] User message queued (drool was busy)',
        {
          sessionId,
          requestId,
        }
      );
    }

    return result;
  }

  async resolveQueuedUserMessage(
    sessionId: string,
    params: ResolveQueuedUserMessageParams
  ): Promise<ResolveQueuedUserMessageResult> {
    const result = await this.daemonClient.resolveQueuedUserMessage({
      sessionId,
      ...params,
    });

    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    if (!sessionManager) {
      return result;
    }

    if (params.action === ResolveQueuedUserMessageAction.Delete) {
      sessionManager.clearQueuedMessage(params.requestId);
      return result;
    }

    const queuedMessage = sessionManager.getQueuedMessage(params.requestId);
    if (!queuedMessage) {
      return result;
    }

    sessionManager.restoreQueuedMessageToFront({
      ...queuedMessage,
      kind: getQueuedUserMessageKindForQueuePlacement(params.queuePlacement),
    });
    return result;
  }

  async interruptSession(sessionId: string): Promise<InterruptSessionResult> {
    const result = await this.daemonClient.interruptSession({
      sessionId,
    });

    // Get permissions for this session before clearing (to emit events for UI update)
    const permissionsToClose = this.permissionHandler
      .getPendingPermissions()
      .filter((p) => p.sessionId === sessionId);

    // Clear pending permissions for this session (user cancelled by stopping)
    this.permissionHandler.clearSessionPermissions(sessionId);

    // Emit PermissionResolved for each so the UI state updates
    for (const permission of permissionsToClose) {
      this.emit(
        DroolEvent.PermissionResolved,
        permission.requestId,
        ToolConfirmationOutcome.Cancel
      );
    }

    // Cancel pending ask-user requests for this session (user cancelled by stopping)
    const askUserToClose = this.askUserHandler
      .getPendingAskUserRequests()
      .filter((r) => r.sessionId === sessionId);

    for (const req of askUserToClose) {
      try {
        this.askUserHandler.cancelAskUser(req.requestId);
      } catch (error) {
        logException(
          error,
          'Failed to cancel pending ask-user request on interrupt'
        );
      }
    }

    // Remove in-progress streaming messages so partial assistant text
    // is not rendered after cancellation. The daemon will send a finalized
    // CREATE_MESSAGE if needed, which re-adds the message to the store.
    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    if (sessionManager) {
      const streamingIds = sessionManager.getStreamingMessageIds();
      if (streamingIds.length > 0) {
        const store = sessionManager.getStore();
        for (const id of streamingIds) {
          store.removeMessage(id);
        }
        store.notify();
      }

      // QUEUED_MESSAGES_DISCARDED can race with this client-side cleanup.
      // Drop steering entries and pause queued end-of-loop remainders in the
      // canonical post-Esc local state.
      sessionManager.pauseDaemonQueuedMessagesAfterEsc();
    }

    this.emit(DroolEvent.SessionInterrupted, true);
    return result;
  }

  /**
   * Kill a worker session. This is different from interruptSession in that it:
   * - Logs WorkerFailed with "Killed by user" reason
   * - Requeues the feature to Pending
   * - Sets mission state to OrchestratorTurn
   * - Interrupts both the worker and orchestrator sessions
   */
  async killWorkerSession(
    sessionId: string,
    workerSessionId: string
  ): Promise<void> {
    await this.daemonClient.killWorkerSession({
      sessionId,
      workerSessionId,
    });
  }

  /**
   * Close a session. Used to terminate a worker session cleanly.
   */
  async closeSession(sessionId: string): Promise<void> {
    await this.daemonClient.closeSession({ sessionId });
    this.sessionLoadOptions.delete(sessionId);
    this.sessionLoadInFlight.delete(sessionId);
  }

  /**
   * List all opened sessions from the daemon registry (fast, in-memory)
   */
  async listOpenedSessions(
    params: DaemonListOpenedSessionsRequestParams = {}
  ): Promise<DaemonListOpenedSessionsResult['sessions']> {
    const result = await this.daemonClient.listOpenedSessions(params);
    return result.sessions;
  }

  /**
   * List all available sessions from filesystem with pagination support
   */
  async listAvailableSessions(
    params: DaemonListAvailableSessionsRequestParams
  ): Promise<DaemonListAvailableSessionsResult> {
    return this.daemonClient.listAvailableSessions(params);
  }

  /**
   * Get MCP configuration from daemon
   */
  async getMcpConfig(): Promise<DaemonGetMcpConfigResult> {
    return this.daemonClient.getMcpConfig();
  }

  /**
   * Update MCP configuration via daemon
   */
  async updateMcpConfig(
    params: DaemonUpdateMcpConfigRequestParams
  ): Promise<DaemonUpdateMcpConfigResult> {
    return this.daemonClient.updateMcpConfig(params);
  }

  async createTerminal(
    sessionId: string,
    params: CreateTerminalRequestParams
  ): Promise<CreateTerminalResult> {
    const sessionManagerForCwd =
      this.sessionStateManager.getSessionManager(sessionId);
    const cwd = sessionManagerForCwd?.getStore().getCwd();

    const requestParams = {
      ...params,
      sessionId,
    };

    if (cwd !== null && cwd !== undefined) {
      requestParams.cwd = cwd;
    }

    const result = await this.daemonClient.createTerminal(requestParams);

    // Add terminal to session store
    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    if (sessionManager) {
      sessionManager.addTerminal({
        id: params.terminalId,
        status: TerminalStatus.CONNECTED,
      });
    }

    this.emit(DroolEvent.TerminalCreated, params.terminalId);
    return result;
  }

  async getGitDiff({
    baseBranch,
    sessionId,
    statsOnly,
  }: {
    baseBranch?: string;
    sessionId: string;
    statsOnly?: boolean;
  }) {
    return this.daemonClient.getGitDiff({
      sessionId,
      baseBranch,
      ...(statsOnly !== undefined ? { statsOnly } : {}),
    });
  }

  async inspectMissionReadiness(cwd: string) {
    return this.daemonClient.inspectMissionReadiness({ cwd });
  }

  async gitPush(sessionId: string) {
    return this.daemonClient.gitPush({ sessionId });
  }

  async gitCommit(sessionId: string, message: string) {
    return this.daemonClient.gitCommit({ sessionId, message });
  }

  async createPR(params: {
    sessionId: string;
    title: string;
    body?: string;
    baseBranch: string;
    draft?: boolean;
    linkedTicketIds?: string[];
    linkedTicketUrls?: string[];
    jiraIssueKeys?: string[];
    linearIssueIds?: string[];
  }) {
    return this.daemonClient.createPR(params);
  }

  async getSemanticDiffCache(params: {
    currentBranch: string;
    baseBranch: string;
  }) {
    return this.daemonClient.getSemanticDiffCache(params);
  }

  async saveSemanticDiffCache(params: {
    currentBranch: string;
    baseBranch: string;
    commitHash: string;
    content: string;
    truncated: boolean;
  }) {
    return this.daemonClient.saveSemanticDiffCache(params);
  }

  async generateSemanticDiff(params: {
    sessionId: string;
    diff: string;
    baseBranch: string;
    currentBranch: string;
    commitHash?: string;
    modelId?: string;
  }) {
    return this.daemonClient.generateSemanticDiff(params);
  }

  async getProxyToken(): Promise<DaemonGetProxyTokenResult> {
    return this.daemonClient.getProxyToken();
  }

  async getWorkspaceFileContent(
    params: DaemonGetWorkspaceFileContentRequestParams
  ): Promise<DaemonGetWorkspaceFileContentResult> {
    return this.daemonClient.getWorkspaceFileContent(params);
  }

  private async loadTerminals(sessionId: string): Promise<void> {
    const daemonTerminals = await this.listTerminals(sessionId, {});

    if (daemonTerminals.terminals.length > 0) {
      // Restore terminals to frontend state
      const sessionManager =
        this.sessionStateManager.getSessionManager(sessionId);
      if (sessionManager) {
        for (const terminalInfo of daemonTerminals.terminals) {
          // Add terminal metadata to frontend state
          sessionManager.addTerminal({
            id: terminalInfo.id,
            status: TerminalStatus.CONNECTED,
          });

          // Store the daemon's terminal state so it can be restored when component mounts
          // The daemon's serialized state is the source of truth and already includes
          // any data that may have been buffered on the frontend during disconnect
          if (terminalInfo.state) {
            sessionManager.storeTerminalState(terminalInfo.id, {
              serialized: terminalInfo.state.serialized,
              cols: terminalInfo.state.cols,
              rows: terminalInfo.state.rows,
              timestamp: terminalInfo.state.timestamp.getTime(),
              cursorHidden: terminalInfo.state.cursorHidden,
            });

            // Clear any buffered data since it's already included in daemon's serialized state
            // This prevents duplicate output when the terminal component mounts
            sessionManager.clearTerminalBufferedData(terminalInfo.id);
          }
        }
      }
    }
  }

  async writeTerminalData(
    sessionId: string,
    params: WriteDataRequestParams
  ): Promise<WriteDataResult> {
    const result = await this.daemonClient.writeTerminalData({
      ...params,
      sessionId,
    });
    this.emit(
      DroolEvent.TerminalDataWritten,
      params.terminalId,
      result.success
    );
    return result;
  }

  async resizeTerminal(
    sessionId: string,
    params: ResizeRequestParams
  ): Promise<ResizeResult> {
    const result = await this.daemonClient.resizeTerminal({
      ...params,
      sessionId,
    });

    this.emit(DroolEvent.TerminalResized, params.terminalId, result.success);
    return result;
  }

  async closeTerminal(
    sessionId: string,
    params: CloseTerminalRequestParams
  ): Promise<CloseTerminalResult> {
    const result = await this.daemonClient.closeTerminal({
      ...params,
      sessionId,
    });

    this.emit(DroolEvent.TerminalClosed, params.terminalId, result.success);
    return result;
  }

  removeTerminalFromStore(sessionId: string, terminalId: string): void {
    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    if (sessionManager) {
      sessionManager.removeTerminal(terminalId);
    }
  }

  updateTerminalStatus(
    sessionId: string,
    terminalId: string,
    status: TerminalStatus
  ): void {
    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    if (sessionManager) {
      sessionManager.updateTerminalStatus(terminalId, status);
    }
  }

  async listTerminals(
    sessionId: string,
    params: ListTerminalsRequestParams
  ): Promise<ListTerminalsResult> {
    const result = await this.daemonClient.listTerminals({
      ...params,
      sessionId,
    });
    this.emit(DroolEvent.TerminalsListed, result.terminals.length);
    return result;
  }

  getTerminals(sessionId: string): Map<string, TerminalMetadata> {
    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    if (!sessionManager) {
      return new Map();
    }
    return sessionManager.getTerminals();
  }

  setActiveTerminalId(sessionId: string, terminalId: string | null): void {
    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    if (sessionManager) {
      sessionManager.setActiveTerminalId(terminalId);
    }
  }

  getActiveTerminalId(sessionId: string): string | null {
    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    return sessionManager?.getActiveTerminalId() ?? null;
  }

  async updateSessionSettings(
    sessionId: string,
    params: {
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
      interactionMode?: DroolInteractionMode;
      autonomyLevel?: AutonomyLevel;
      specModeModelId?: string | null;
      specModeReasoningEffort?: ReasoningEffort | null;
      missionSettings?: MissionModelSettings;
      tags?: SessionTag[];
      enabledToolIds?: string[];
      compactionThresholdCheckEnabled?: boolean;
    }
  ): Promise<UpdateSessionSettingsResult> {
    // Build request params, converting null → empty string (sentinel for "clear")
    const requestParams: {
      sessionId: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
      interactionMode?: DroolInteractionMode;
      autonomyLevel?: AutonomyLevel;
      specModeModelId?: string | null;
      specModeReasoningEffort?: ReasoningEffort | null;
      missionSettings?: MissionModelSettings;
      tags?: SessionTag[];
      enabledToolIds?: string[];
      compactionThresholdCheckEnabled?: boolean;
    } = {
      sessionId,
    };

    // Only include fields that are explicitly provided
    if (params.modelId !== undefined) {
      requestParams.modelId = params.modelId;
    }
    if (params.reasoningEffort !== undefined) {
      requestParams.reasoningEffort = params.reasoningEffort;
    }
    if (params.interactionMode !== undefined) {
      requestParams.interactionMode = params.interactionMode;
    }
    if (params.autonomyLevel !== undefined) {
      requestParams.autonomyLevel = params.autonomyLevel;
    }
    if (params.specModeModelId !== undefined) {
      requestParams.specModeModelId = params.specModeModelId;

      // When clearing model (null), don't send reasoning effort
      // This allows it to follow the main model's reasoning effort
      // Only send reasoning effort when setting an explicit model
      if (
        params.specModeModelId !== null &&
        params.specModeReasoningEffort !== undefined
      ) {
        requestParams.specModeReasoningEffort = params.specModeReasoningEffort;
      }
    } else if (params.specModeReasoningEffort !== undefined) {
      // Only updating reasoning effort without changing model
      requestParams.specModeReasoningEffort = params.specModeReasoningEffort;
    }
    if (params.missionSettings !== undefined) {
      requestParams.missionSettings = params.missionSettings;
    }
    if (params.tags !== undefined) {
      requestParams.tags = params.tags;
    }
    if (params.enabledToolIds !== undefined) {
      requestParams.enabledToolIds = params.enabledToolIds;
    }
    if (params.compactionThresholdCheckEnabled !== undefined) {
      requestParams.compactionThresholdCheckEnabled =
        params.compactionThresholdCheckEnabled;
    }

    const result = await this.daemonClient.updateSessionSettings(requestParams);
    return result;
  }

  async getRewindInfo(
    sessionId: string,
    messageId: string
  ): Promise<{
    availableFiles: Array<{
      filePath: string;
      contentHash: string;
      size: number;
    }>;
    createdFiles: Array<{ filePath: string }>;
    evictedFiles: Array<{ filePath: string; reason: string }>;
  }> {
    return this.daemonClient.getRewindInfo({ sessionId, messageId });
  }

  async executeRewind(
    sessionId: string,
    params: {
      messageId: string;
      filesToRestore: Array<{
        filePath: string;
        contentHash: string;
        size: number;
      }>;
      filesToDelete: Array<{ filePath: string }>;
      forkTitle: string;
    }
  ): Promise<{
    newSessionId: string;
    restoredCount: number;
    deletedCount: number;
    failedRestoreCount: number;
    failedDeleteCount: number;
  }> {
    return this.daemonClient.executeRewind({
      sessionId,
      ...params,
    });
  }

  async compactSession(
    sessionId: string,
    customInstructions?: string
  ): Promise<{
    newSessionId: string;
    removedCount: number;
  }> {
    return this.daemonClient.compactSession({
      sessionId,
      customInstructions,
    });
  }

  async forkSession(
    sessionId: string,
    options?: {
      title?: string;
      tags?: Array<{ name: string; metadata?: Record<string, string> }>;
    }
  ): Promise<{
    newSessionId: string;
  }> {
    return this.daemonClient.forkSession({
      sessionId,
      title: options?.title,
      tags: options?.tags,
    });
  }

  async getContextBreakdown(
    sessionId: string
  ): Promise<DaemonGetContextBreakdownResult> {
    return this.daemonClient.getContextBreakdown({ sessionId });
  }

  warmupCache(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Get default settings when no session is active.
   * This reads the settings.json file directly via the daemon.
   */
  async getDefaultSettings(): Promise<DaemonGetDefaultSettingsResult> {
    const result = await this.daemonClient.getDefaultSettings();
    return result;
  }

  async updateSessionDefaults(
    params: DaemonUpdateSessionDefaultsRequestParams
  ): Promise<DaemonUpdateSessionDefaultsResult> {
    return this.daemonClient.updateSessionDefaults(params);
  }

  async listCustomModels(): Promise<DaemonListCustomModelsResult> {
    return this.daemonClient.listCustomModels();
  }

  async upsertCustomModel(
    params: DaemonUpsertCustomModelRequestParams
  ): Promise<DaemonUpsertCustomModelResult> {
    return this.daemonClient.upsertCustomModel(params);
  }

  async deleteCustomModel(
    params: DaemonDeleteCustomModelRequestParams
  ): Promise<DaemonDeleteCustomModelResult> {
    return this.daemonClient.deleteCustomModel(params);
  }

  async triggerUpdate(): Promise<DaemonTriggerUpdateResult> {
    return this.daemonClient.triggerUpdate();
  }

  async startRelay(): Promise<DaemonRelayStartResult> {
    return this.daemonClient.startRelay();
  }

  async stopRelay(): Promise<DaemonRelayStopResult> {
    return this.daemonClient.stopRelay();
  }

  async getRelayStatus(): Promise<DaemonRelayGetStatusResult> {
    return this.daemonClient.getRelayStatus();
  }

  async validateWorkingDirectory(
    workingDirectory: string
  ): Promise<{ isValid: boolean; error?: string; resolvedPath?: string }> {
    const result = await this.daemonClient.validateWorkingDirectory({
      workingDirectory,
    });
    return result;
  }

  async toggleMcpServer(
    params: DaemonToggleMcpServerRequest['params']
  ): Promise<{ success: boolean }> {
    const result = await this.daemonClient.toggleMcpServer(params);
    return result;
  }

  async authenticateMcpServer(
    params: DaemonAuthenticateMcpServerRequest['params']
  ): Promise<{ success: boolean }> {
    const result = await this.daemonClient.authenticateMcpServer(params);
    return result;
  }

  async cancelMcpAuth(
    params: DaemonCancelMcpAuthRequest['params']
  ): Promise<{ success: boolean }> {
    const result = await this.daemonClient.cancelMcpAuth(params);
    return result;
  }

  async clearMcpAuth(
    params: DaemonClearMcpAuthRequest['params']
  ): Promise<{ success: boolean }> {
    const result = await this.daemonClient.clearMcpAuth(params);
    return result;
  }

  /**
   * List all files in a session's working directory.
   * Used for fuzzy file search in chat input.
   */
  async listFiles(sessionId: string, showHidden?: boolean): Promise<string[]> {
    const result = await this.daemonClient.listFiles({
      sessionId,
      showHidden: showHidden ?? false,
    });
    return result.files;
  }

  /**
   * Search files in a session's working directory with fuzzy matching.
   * Runs ripgrep and FuseSearch on daemon side for fresh results.
   */
  async searchFiles(
    sessionId: string,
    query: string,
    maxResults?: number,
    showHidden?: boolean
  ): Promise<string[]> {
    const result = await this.daemonClient.searchFiles({
      sessionId,
      query,
      maxResults: maxResults ?? 50,
      showHidden: showHidden ?? false,
    });
    return result.files;
  }

  /**
   * Search across all sessions for matching content.
   * Returns sessions with matching hits including context snippets.
   */
  async searchSessions(params: {
    query: string;
    kind?: SessionSearchDocKind | 'all';
    limitSessions?: number;
    limitHitsPerSession?: number;
    contextChars?: number;
  }) {
    return this.daemonClient.searchSessions(params);
  }

  /**
   * Archive a session (persists to .settings.json on daemon).
   * Returns the timestamp when the session was archived.
   */
  async archiveSession(
    sessionId: string
  ): Promise<{ success: boolean; archivedAt: string }> {
    return this.daemonClient.archiveSession({ sessionId });
  }

  /**
   * Unarchive a session (updates .settings.json on daemon).
   */
  async unarchiveSession(sessionId: string): Promise<{ success: boolean }> {
    return this.daemonClient.unarchiveSession({ sessionId });
  }

  /**
   * Rename a session (updates title in .jsonl on daemon).
   */
  async renameSession(
    sessionId: string,
    title: string
  ): Promise<{ success: boolean }> {
    return this.daemonClient.renameSession({ sessionId, title });
  }

  async addMcpServer(
    params: DaemonAddMcpServerRequest['params']
  ): Promise<{ success: boolean }> {
    const result = await this.daemonClient.addMcpServer(params);
    return result;
  }

  async removeMcpServer(
    params: DaemonRemoveMcpServerRequest['params']
  ): Promise<{ success: boolean }> {
    const result = await this.daemonClient.removeMcpServer(params);
    return result;
  }

  async listMcpRegistry(
    sessionId: string
  ): Promise<DaemonListMcpRegistryResult> {
    const result = await this.daemonClient.listMcpRegistry({
      sessionId,
    });
    return result;
  }

  async listMcpServers(sessionId: string): Promise<DaemonListMcpServersResult> {
    const result = await this.daemonClient.listMcpServers({
      sessionId,
    });
    return result;
  }

  async listMcpTools(sessionId: string): Promise<DaemonListMcpToolsResult> {
    const result = await this.daemonClient.listMcpTools({
      sessionId,
    });
    return result;
  }

  async toggleMcpTool(
    sessionId: string,
    serverName: string,
    toolName: string,
    enabled: boolean
  ): Promise<{ success: boolean }> {
    const result = await this.daemonClient.toggleMcpTool({
      sessionId,
      serverName,
      toolName,
      enabled,
    });
    return result;
  }

  async submitMcpAuthCode(params: {
    sessionId: string;
    serverName: string;
    code: string;
    state: string;
  }): Promise<{ success: boolean }> {
    const result = await this.daemonClient.submitMcpAuthCode(params);
    return result;
  }

  async submitMcpAuthError(params: {
    sessionId: string;
    serverName: string;
    error: string;
    errorDescription?: string;
    state: string;
  }): Promise<{ success: boolean }> {
    const result = await this.daemonClient.submitMcpAuthError(params);
    return result;
  }

  async listSkills(sessionId: string): Promise<DaemonListSkillsResult> {
    const result = await this.daemonClient.listSkills({
      sessionId,
    });
    return result;
  }

  async listCommands(sessionId: string): Promise<DaemonListCommandsResult> {
    const result = await this.daemonClient.listCommands({
      sessionId,
    });
    return result;
  }

  async listAvailablePlugins(
    sessionId: string
  ): Promise<DaemonListAvailablePluginsResult> {
    return this.daemonClient.listAvailablePlugins({ sessionId });
  }

  async listInstalledPlugins(
    sessionId: string,
    scope?: string
  ): Promise<DaemonListInstalledPluginsResult> {
    return this.daemonClient.listInstalledPlugins({ sessionId, scope });
  }

  async installPlugin(
    sessionId: string,
    marketplace: string,
    pluginName: string,
    scope: string
  ): Promise<DaemonInstallPluginResult> {
    return this.daemonClient.installPlugin({
      sessionId,
      marketplace,
      pluginName,
      scope,
    });
  }

  async uninstallPlugin(
    sessionId: string,
    pluginId: string,
    scope: string
  ): Promise<DaemonUninstallPluginResult> {
    return this.daemonClient.uninstallPlugin({ sessionId, pluginId, scope });
  }

  async setPluginEnabled(
    sessionId: string,
    pluginId: string,
    scope: string,
    enabled: boolean
  ): Promise<DaemonSetPluginEnabledResult> {
    return this.daemonClient.setPluginEnabled({
      sessionId,
      pluginId,
      scope,
      enabled,
    });
  }

  async updatePlugin(
    sessionId: string,
    pluginId?: string,
    scope?: string
  ): Promise<DaemonUpdatePluginResult> {
    return this.daemonClient.updatePlugin({ sessionId, pluginId, scope });
  }

  async listMarketplaces(
    sessionId: string
  ): Promise<DaemonListMarketplacesResult> {
    return this.daemonClient.listMarketplaces({ sessionId });
  }

  async addMarketplace(
    sessionId: string,
    source: DaemonAddMarketplaceRequestParams['source']
  ): Promise<DaemonAddMarketplaceResult> {
    return this.daemonClient.addMarketplace({ sessionId, source });
  }

  async removeMarketplace(
    sessionId: string,
    name: string
  ): Promise<DaemonRemoveMarketplaceResult> {
    return this.daemonClient.removeMarketplace({ sessionId, name });
  }

  async updateMarketplace(
    sessionId: string,
    name?: string
  ): Promise<DaemonUpdateMarketplaceResult> {
    return this.daemonClient.updateMarketplace({ sessionId, name });
  }

  async listAutomations(
    basePath?: string
  ): Promise<DaemonListAutomationsResult> {
    const result = await this.daemonClient.listAutomations({
      basePath,
    });
    return result;
  }

  async submitBugReport(
    sessionId: string,
    userComment: string,
    clientLogs?: string
  ): Promise<{ bugReportId: string }> {
    const result = await this.daemonClient.submitBugReport({
      sessionId,
      userComment,
      clientLogs,
    });
    return result;
  }

  async runAutomation(
    automationId: string,
    basePath?: string,
    computerId?: string
  ): Promise<DaemonRunAutomationResult> {
    return this.daemonClient.runAutomation({
      automationId,
      automationDirName: automationId,
      basePath,
      computerId,
    });
  }

  async pauseAutomation(
    automationId: string,
    basePath?: string
  ): Promise<DaemonPauseAutomationResult> {
    return this.daemonClient.pauseAutomation({
      automationId,
      automationDirName: automationId,
      basePath,
    });
  }

  async resumeAutomation(
    automationId: string,
    basePath?: string
  ): Promise<DaemonResumeAutomationResult> {
    return this.daemonClient.resumeAutomation({
      automationId,
      automationDirName: automationId,
      basePath,
    });
  }

  async getAutomationHistory(
    automationId: string,
    limit?: number,
    offset?: number,
    basePath?: string
  ): Promise<DaemonGetAutomationHistoryResult> {
    return this.daemonClient.getAutomationHistory({
      automationId,
      automationDirName: automationId,
      limit,
      offset,
      basePath,
    });
  }

  async getAutomationVisual(
    automationId: string,
    basePath?: string,
    sessionId?: string
  ): Promise<DaemonGetAutomationVisualResult> {
    return this.daemonClient.getAutomationVisual({
      automationId,
      automationDirName: automationId,
      basePath,
      ...(sessionId ? { sessionId } : {}),
    });
  }

  async createAutomation(
    params: DaemonCreateAutomationRequestParams
  ): Promise<DaemonCreateAutomationResult> {
    return this.daemonClient.createAutomation(params);
  }

  async updateAutomationModel(
    params: DaemonUpdateAutomationModelRequestParams
  ): Promise<DaemonUpdateAutomationModelResult> {
    return this.daemonClient.updateAutomationModel(params);
  }

  async updateAutomationPrivacy(
    params: DaemonUpdateAutomationPrivacyRequestParams
  ): Promise<DaemonUpdateAutomationPrivacyResult> {
    return this.daemonClient.updateAutomationPrivacy(params);
  }

  async updateAutomationPrompt(
    params: DaemonUpdateAutomationPromptRequestParams
  ): Promise<DaemonUpdateAutomationPromptResult> {
    return this.daemonClient.updateAutomationPrompt(params);
  }

  async updateAutomationSchedule(
    params: DaemonUpdateAutomationScheduleRequestParams
  ): Promise<DaemonUpdateAutomationScheduleResult> {
    return this.daemonClient.updateAutomationSchedule(params);
  }

  async renameAutomation(
    params: DaemonRenameAutomationRequestParams
  ): Promise<DaemonRenameAutomationResult> {
    return this.daemonClient.renameAutomation(params);
  }

  async deleteAutomation(
    params: DaemonDeleteAutomationRequestParams
  ): Promise<DaemonDeleteAutomationResult> {
    return this.daemonClient.deleteAutomation(params);
  }

  async forkAutomation(
    params: DaemonForkAutomationRequestParams
  ): Promise<DaemonForkAutomationResult> {
    return this.daemonClient.forkAutomation(params);
  }

  async listCrons(
    params: DaemonListCronsRequestParams = {}
  ): Promise<DaemonListCronsResult> {
    return this.daemonClient.listCrons(params);
  }

  async createCron(
    params: DaemonCreateCronRequestParams
  ): Promise<DaemonCreateCronResult> {
    return this.daemonClient.createCron(params);
  }

  async updateCron(
    params: DaemonUpdateCronRequestParams
  ): Promise<DaemonUpdateCronResult> {
    return this.daemonClient.updateCron(params);
  }

  async deleteCron(
    params: DaemonDeleteCronRequestParams
  ): Promise<DaemonDeleteCronResult> {
    return this.daemonClient.deleteCron(params);
  }

  async holdSessionCrons(
    params: DaemonHoldSessionCronsRequestParams
  ): Promise<DaemonHoldSessionCronsResult> {
    return this.daemonClient.holdSessionCrons(params);
  }

  async resumeSessionCrons(
    params: DaemonResumeSessionCronsRequestParams
  ): Promise<DaemonResumeSessionCronsResult> {
    return this.daemonClient.resumeSessionCrons(params);
  }

  /**
   * Resume an inactive session after buffering a user response.
   *
   * Uses bounded retry with exponential backoff to recover from transient
   * loadSession failures (network blip, daemon respawn). If all attempts
   * fail, emits {@link DroolEvent.SelfResumeFailed} so the UI can re-surface
   * the prompt with the buffered answer pre-filled and let the user retry.
   * The buffered response itself remains in pendingUserActionStore and will
   * be replayed on any later successful loadSession.
   */
  private triggerSelfResume(sessionId: string): void {
    if (this.selfResumeInFlight.has(sessionId)) {
      return;
    }
    this.selfResumeInFlight.add(sessionId);
    void this.runSelfResumeWithRetry(sessionId).finally(() => {
      this.selfResumeInFlight.delete(sessionId);
    });
  }

  private async runSelfResumeWithRetry(sessionId: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SELF_RESUME_MAX_ATTEMPTS; attempt++) {
      const stashed = this.sessionLoadOptions.get(sessionId) ?? {};
      try {
        await this.loadSession({ sessionId, ...stashed });
        return;
      } catch (err) {
        lastError = err;
        logWarn('[DaemonSessionController] Self-resume loadSession failed', {
          cause: err,
          sessionId,
          attempt,
          maxAttempts: SELF_RESUME_MAX_ATTEMPTS,
        });
        if (attempt < SELF_RESUME_MAX_ATTEMPTS) {
          const delayMs = Math.min(
            SELF_RESUME_INITIAL_DELAY_MS *
              SELF_RESUME_BACKOFF_FACTOR ** (attempt - 1),
            SELF_RESUME_MAX_DELAY_MS
          );
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }
      }
    }

    logException(
      lastError,
      '[DaemonSessionController] Self-resume exhausted retries; surfacing recoverable failure',
      { sessionId, maxAttempts: SELF_RESUME_MAX_ATTEMPTS }
    );
    this.emit(DroolEvent.SelfResumeFailed, {
      sessionId,
      attempt: SELF_RESUME_MAX_ATTEMPTS,
      maxAttempts: SELF_RESUME_MAX_ATTEMPTS,
    });
  }

  /**
   * Optimistically clear a relayed subagent permission the moment it is
   * answered, instead of waiting for the worker session to broadcast its
   * post-wait activity. A relayed permission is surfaced on multiple associated
   * sessions (the worker plus the parent that approves it), and the worker is
   * frequently backgrounded/reaped when the parent answers. Without this, the
   * subagent keeps showing a stale "Waiting" sidebar status and re-renders the
   * already-answered prompt when opened before it finishes reloading.
   *
   * No-op for non-relayed (single-session) permissions, which already resolve
   * promptly via the daemon's own PERMISSION_RESOLVED broadcast.
   */
  private clearRelayedSubagentPermission(
    permission: PendingPermission,
    selectedOption: ToolConfirmationOutcome
  ): void {
    const isRelayed = permission.associatedSessionIds.some(
      (id) => id !== permission.sessionId
    );
    if (!isRelayed) {
      return;
    }

    // Remove the prompt from every associated surface (keyed by requestId, so
    // a single resolve clears the parent and subagent views together).
    if (this.permissionHandler.getPendingPermission(permission.requestId)) {
      this.permissionHandler.resolvePermission(
        permission.requestId,
        selectedOption
      );
    }

    // The local resolve above means the daemon's PERMISSION_RESOLVED will find
    // no pending permission and skip the parent surface; drain the markers here
    // so the parent is not left stuck in sessionsWithConcurrentPrompts.
    this.clearDrainedConcurrentPromptMarkers(permission.associatedSessionIds);
  }

  async respondToPermission({
    permissionId,
    selectedOption,
    sessionId,
    comment,
    editedSpecContent,
  }: RespondToPermissionParams): Promise<void> {
    const permission =
      this.permissionHandler.getPendingPermission(permissionId);
    if (!permission) {
      throw new MetaError('No pending permission found with ID', {
        requestId: permissionId,
      });
    }
    const executionSessionId = permission.sessionId;
    if (!permission.associatedSessionIds.includes(sessionId)) {
      logWarn(
        '[DaemonSessionController] Permission response came from non-associated session surface',
        {
          requestId: permissionId,
          sessionId,
          workerSessionId: executionSessionId,
        }
      );
    }

    // While inactive, buffer the response and close the local prompt.
    if (this.inactiveSessions.has(executionSessionId)) {
      const toolUseId = permission.toolUses[0]?.toolUse.id;
      if (toolUseId) {
        this.pendingUserActionStore.savePermission({
          kind: 'permission',
          sessionId: executionSessionId,
          requestId: permissionId,
          toolUseId,
          selectedOption,
          comment,
          ...(editedSpecContent !== undefined && { editedSpecContent }),
          storedAt: Date.now(),
        });
      } else {
        logWarn(
          '[DaemonSessionController] Cannot buffer permission while inactive: missing toolUseId',
          { sessionId: executionSessionId, requestId: permissionId }
        );
      }

      this.permissionHandler.resolvePermission(permissionId, selectedOption);
      this.clearRelayedSubagentPermission(permission, selectedOption);
      this.triggerSelfResume(executionSessionId);
      return;
    }

    // Record the answer (keyed globally by tool-use id) for relayed subagent
    // permissions BEFORE sending: the daemon's PERMISSION_RESOLVED can arrive
    // (and drain the buffer) during the await below, so saving afterwards would
    // leave a stale entry that never clears and could replay on a later reload.
    // The buffer lets a reload of any associated session that happens before the
    // daemon persists the resolution re-apply the answer instead of re-surfacing
    // the prompt. Cleared on the daemon's PERMISSION_RESOLVED.
    const isRelayedPermission = permission.associatedSessionIds.some(
      (id) => id !== executionSessionId
    );
    const responseToolUseId = permission.toolUses[0]?.toolUse.id;
    if (isRelayedPermission && responseToolUseId) {
      this.pendingUserActionStore.savePermission({
        kind: 'permission',
        sessionId: executionSessionId,
        requestId: permissionId,
        toolUseId: responseToolUseId,
        selectedOption,
        comment,
        ...(editedSpecContent !== undefined && { editedSpecContent }),
        storedAt: Date.now(),
      });
    }

    // Send the response to the daemon
    await this.daemonClient.sendPermissionResponse(permissionId, {
      sessionId: executionSessionId,
      selectedOption,
      comment,
      ...(editedSpecContent !== undefined && { editedSpecContent }),
    });

    // For a relayed subagent permission, clear it across associated surfaces
    // now rather than waiting for the (possibly backgrounded) worker to
    // broadcast post-wait activity. Non-relayed permissions still clear via the
    // daemon's PERMISSION_RESOLVED broadcast.
    this.clearRelayedSubagentPermission(permission, selectedOption);
  }

  async respondToAskUser({
    requestId,
    sessionId,
    result,
  }: RespondToAskUserParams): Promise<void> {
    const pending = this.askUserHandler.getPendingAskUserRequest(requestId);
    if (!pending) {
      throw new MetaError('No pending ask-user request found with ID', {
        requestId,
      });
    }

    // While inactive, buffer the answer and close the local prompt.
    if (this.inactiveSessions.has(sessionId)) {
      this.pendingUserActionStore.saveAskUser({
        kind: 'askUser',
        sessionId,
        requestId,
        toolCallId: pending.toolCallId,
        result,
        storedAt: Date.now(),
      });

      this.askUserHandler.resolveAskUser(requestId, result);
      this.triggerSelfResume(sessionId);
      return;
    }

    // Send the response to the daemon
    await this.daemonClient.sendAskUserResponse(requestId, {
      sessionId,
      ...result,
    });
  }

  getPendingPermissions(): PendingPermission[] {
    return this.permissionHandler.getPendingPermissions();
  }

  /**
   * Pending permissions a given session should render, including relayed
   * subagent permissions whose `associatedSessionIds` include this session
   * (e.g. a child's Execute prompt surfaced on its parent). Use this rather
   * than filtering `getPendingPermissions()` by `sessionId`, which misses
   * relayed prompts and hides them when returning to the parent session.
   */
  getPendingPermissionsForSession(sessionId: string): PendingPermission[] {
    return this.permissionHandler.getPendingPermissionsForSession(sessionId);
  }

  getPendingAskUserRequests(): PendingAskUserRequest[] {
    return this.askUserHandler.getPendingAskUserRequests();
  }

  getConnectionStatus(): ConnectionStatus {
    const transport = this.daemonClient.isConnected()
      ? TransportState.Connected
      : TransportState.Disconnected;

    const recovery =
      this.isReconnecting || this.reconnectionStrategy.isMaxAttemptsReached()
        ? {
            isReconnecting: this.isReconnecting,
            exhausted: this.reconnectionStrategy.isMaxAttemptsReached(),
          }
        : null;

    return {
      transport,
      lastConnectionFailure: this.lastConnectionFailure,
      recovery,
      isAuthenticated: this._isAuthenticated,
    };
  }

  /**
   * Reset reconnection state and attempt a fresh connection.
   * Intended to be called when the user explicitly triggers a retry.
   */
  resetAndRetry(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.lastConnectionFailure = null;
    this.reconnectionStrategy.reset();
    this.isReconnecting = false;
    this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());
    void this.connectAndAuthenticate().catch((error) => {
      // autoAuthenticate stores failure in lastConnectionFailure + emits statusChanged,
      // but connect() failures throw before autoAuthenticate runs.
      if (
        !this.lastConnectionFailure &&
        error instanceof ConnectionFailureError
      ) {
        this.lastConnectionFailure = error;
        this.emit(ConnectionEvent.StatusChanged, this.getConnectionStatus());
      }
    });
  }

  /**
   * Whether auto-reconnection is allowed based on the last failure.
   * Returns true when there's no failure, or the failure is retryable.
   */
  private isRetryAllowed(): boolean {
    return this.lastConnectionFailure?.retryable !== false;
  }

  /**
   * Check if WebSocket is connected (regardless of authentication state).
   */
  isConnected(): boolean {
    return this.daemonClient.isConnected();
  }

  /**
   * Check if fully connected (WebSocket connected AND authenticated).
   * Use this when you need to ensure RPC requests can be sent.
   */
  isFullyConnected(): boolean {
    return this.daemonClient.isConnected() && this.isAuthenticated;
  }

  /**
   * Get the machine ID for this daemon client.
   */
  getMachineId(): string {
    return this.config.machineId;
  }

  /**
   * Get the machine type for this daemon client.
   */
  getMachineType(): MachineType {
    return this.config.machineType;
  }

  /**
   * Get the machine connection type for this daemon client.
   *
   * @deprecated Retained for telemetry labels only; prefer `getMachineType`.
   */
  getMachineConnectionType(): MachineConnectionType {
    return machineTypeToMachineConnectionType(this.config.machineType);
  }

  /**
   * Get the WebSocket URL this client is configured to connect to.
   */
  getWebSocketUrl(): string {
    return this.config.url;
  }

  /**
   * Get the HTTP base URL derived from the WebSocket URL.
   * Converts ws:// to http:// and wss:// to https://.
   */
  getHttpBaseUrl(): string {
    return this.config.url
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://');
  }

  /**
   * Get machine information (CLI installation status, platform, etc.)
   * Returns null if connection status notification has not been received yet
   */
  getMachineInfo(): MachineInfo | null {
    return this.machineInfo;
  }

  // ============ Terminal Serialization Methods ============

  /**
   * Register a terminal's write handler (called on mount).
   * This marks the terminal as mounted and enables direct data routing.
   * Also flushes any buffered data that arrived while unmounted.
   */
  registerTerminalWriteHandler(
    sessionId: string,
    terminalId: string,
    writeHandler: (data: string) => void
  ): void {
    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    if (sessionManager) {
      sessionManager.registerTerminal(terminalId, writeHandler);
    }
  }

  /**
   * Unregister a terminal's write handler (called on unmount).
   * This marks the terminal as unmounted - future data will be buffered.
   */
  unregisterTerminalWriteHandler(sessionId: string, terminalId: string): void {
    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    if (sessionManager) {
      sessionManager.unregisterTerminal(terminalId);
    }
  }

  /**
   * Store terminal state when unmounting.
   * Preserves the serialized terminal content and dimensions.
   */
  storeTerminalState(
    sessionId: string,
    terminalId: string,
    state: {
      serialized: string;
      cols: number;
      rows: number;
      cursorHidden?: boolean;
    }
  ): void {
    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    if (sessionManager) {
      sessionManager.storeTerminalState(terminalId, {
        ...state,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Get serialized terminal state for restoration.
   * Returns the serialized content and dimensions from when terminal was unmounted.
   */
  getTerminalSerializedState(
    sessionId: string,
    terminalId: string
  ):
    | {
        serialized: string;
        cols: number;
        rows: number;
        timestamp: number;
        cursorHidden?: boolean;
      }
    | undefined {
    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    return sessionManager?.getTerminalSerializedState(terminalId);
  }

  /**
   * Get buffered data that arrived while terminal was unmounted.
   */
  getTerminalBufferedData(
    sessionId: string,
    terminalId: string
  ): string | undefined {
    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    return sessionManager?.getTerminalBufferedData(terminalId);
  }

  /**
   * Clear restoration state after terminal is successfully restored.
   * Should be called after serialized state and buffered data are written to xterm.
   */
  clearTerminalRestorationState(sessionId: string, terminalId: string): void {
    const sessionManager =
      this.sessionStateManager.getSessionManager(sessionId);
    if (sessionManager) {
      sessionManager.clearTerminalRestorationState(terminalId);
    }
  }

  getSessionStateManager(): MultiSessionStateManager {
    return this.sessionStateManager;
  }

  /**
   * Destroy the client and clean up resources
   */
  destroy(): void {
    this.disconnect();
    this.removeAllListeners();
    this.messageRouter.removeAllListeners();
    this.permissionHandler.destroy();
    this.askUserHandler.destroy();
    this.sessionLoadInFlight.clear();
  }
}
