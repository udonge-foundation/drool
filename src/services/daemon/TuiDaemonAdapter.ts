import { v4 as uuidv4 } from 'uuid';

import {
  LOCAL_MACHINE_ID,
  MachineType,
  type DaemonAddMcpServerRequest,
  type DaemonGetContextBreakdownResult,
  type DaemonRequestPermissionResult,
  type DaemonGetDefaultSettingsResult,
  type DaemonSessionNotificationParams,
} from '@industry/common/daemon';
import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { type MissionModelSettings } from '@industry/common/settings';
import {
  DaemonAuthenticationMode,
  DaemonClient,
  DaemonSessionController,
  DroolEvent,
  InProcessDaemonClientTransport,
  IpcDaemonClientTransport,
  MultiMissionStateManager,
  MultiSessionStateManager,
  type IndustryDaemonConfig,
  type PendingAskUserRequest as DaemonPendingAskUserRequest,
  type PendingPermission,
} from '@industry/daemon-client';
import {
  createDaemonRequestCore,
  createDroolCapability,
  createManagementCapability,
  createSettingsCapability,
  DaemonIpcConnectionServer,
  IndustryApiClient,
  type DaemonConnectionHandler,
  type DaemonRequestCore,
  type DaemonUser,
} from '@industry/daemon-core/same-process';
import {
  AgentTurnCompletionReason,
  DecompSessionType,
  DroolWorkingState,
  SessionNotificationType,
  type QueuePlacement,
  type InitializeSessionResult,
  type ListMcpServersResult,
  type LoadSessionResult,
  type McpRegistryServer,
  type McpToolInfo,
  type ResolveQueuedUserMessageParams,
} from '@industry/drool-sdk-ext/protocol/drool';
import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import {
  MessageRole,
  MessageVisibility,
  type DocumentSource,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import {
  AutonomyLevel,
  DroolInteractionMode,
  JsonRpcErrorCode,
} from '@industry/drool-sdk-ext/protocol/shared';
import {
  EnvironmentVariable,
  resolveEnv,
  resolveEnvAsPositiveInt,
} from '@industry/environment';
import { logInfo, logWarn } from '@industry/logging';
import { AuthenticationError } from '@industry/logging/errors';
import {
  getAuthedUser,
  getAuthTokenOrThrow,
  type RuntimeAuthConfig,
} from '@industry/runtime/auth';
import { getFlag } from '@industry/runtime/feature-flags';
import { resolveInteractionSettingsWithLegacyFallback } from '@industry/utils';

import packageJson from '../../../package.json';
import { getEnv, getRuntimeAuthConfig } from '@/environment';
import { convertAttachmentsToBase64Images } from '@/exec/imageAttachments';
import { clearAskUserAnswersByRequestId } from '@/services/AskUserAnswerStore';
import { createSameProcessDaemonClient } from '@/services/daemon/createSameProcessDaemonClient';
import { InProcessDaemonRuntime } from '@/services/daemon/InProcessDaemonRuntime';
import {
  getCompletionReasonFromFinalOutput,
  isProcessExitNotification,
} from '@/services/daemon/processExitNotifications';
import {
  applySettingsSnapshotToStore,
  getCurrentSessionSettingsSnapshot,
  getStoreSettingsFromDaemonDefaults,
} from '@/services/daemon/session-settings/store';
import { SubagentPermissionCoordinator } from '@/services/daemon/SubagentPermissionCoordinator';
import type {
  HydrateLocalSessionStateParams,
  SessionSettingsStoreSnapshot,
} from '@/services/daemon/types';
import { upsertMissionSessionTag } from '@/services/mission/sessionTags';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { SQUAD_BOARD_TOOL_ID } from '@/services/squad/constants';
import { SquadRole } from '@/services/squad/enums';
import { buildSquadSessionTag } from '@/services/squad/sessionTags';
import type { ImageAttachment } from '@/types/types';
import { SHUTDOWN_HOOK_PRIORITY } from '@/utils/constants';
import { getEnabledQueuePlacement } from '@/utils/queuedMessagesFeatureFlag';
import {
  buildCompletedSessionBackedTask,
  buildSessionBackedTaskCompletionPrompt,
  forgetSessionBackedTaskStartTime,
  isSessionBackedTaskBackground,
  readSessionBackedTaskFinalOutput,
  waitForParentReadyForSessionBackedTaskCompletionInjection,
} from '@/utils/sessionBackedTaskState';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';

import type { SessionTag } from '@industry/drool-sdk-ext/protocol/session';

type SessionNotificationHandler = (
  notification: DaemonSessionNotificationParams['notification']
) => void | Promise<void>;

type PermissionRequestHandler = (
  permission: PendingPermission
) => void | Promise<void>;

type AskUserRequestHandler = (
  request: DaemonPendingAskUserRequest
) => void | Promise<void>;

type DisconnectHandler = (code: number, reason: string) => void;

type DefaultSettingsUpdateParams = {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  interactionMode?: DroolInteractionMode;
  autonomyLevel?: AutonomyLevel;
  specModeModelId?: string | null;
  specModeReasoningEffort?: ReasoningEffort | null;
};

// TUI sessions disable daemon inactivity timeout unless tests override it.
const DISABLE_TUI_SESSION_INACTIVITY_TIMEOUT = (() => {
  const value = resolveEnv({
    name: EnvironmentVariable.OVERRIDE_DROOL_SESSION_TIMEOUT_MS,
  });
  return value === undefined || value === '';
})();

const SESSION_BACKED_TASK_IDLE_WAKE_GRACE_MS = 1000;

/**
 * TuiDaemonAdapter bridges the DaemonSessionController API to the
 * LocalDaemonClient API used by MissionRunner and other CLI components.
 *
 * This adapter manages a DaemonSessionController instance, handles
 * connection and authentication, and exposes methods matching the
 * LocalDaemonClient interface so consumers can be migrated transparently.
 */
export class TuiDaemonAdapter {
  private readonly controller: DaemonSessionController;

  private connected = false;

  private caller: string;

  // Track notification handlers per session for cleanup
  private sessionNotificationHandlers = new Map<
    string,
    Set<SessionNotificationHandler>
  >();

  // Track permission request handlers per session
  private sessionPermissionHandlers = new Map<
    string,
    Set<PermissionRequestHandler>
  >();

  // Track AskUser request handlers per session
  private sessionAskUserHandlers = new Map<
    string,
    Set<AskUserRequestHandler>
  >();

  // Track disconnect handlers
  private disconnectHandlers = new Set<DisconnectHandler>();

  private backgroundCompletionWakeups = new Set<string>();

  private sessionBackedTaskIdleWakeTimeouts = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  // Queue for event registrations made before the controller connects.
  // When onControllerEvent() is called while controller is not yet connected,
  // the registration is queued here and replayed once openConnection()
  // completes.
  private pendingEventRegistrations: Array<{
    event: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (...args: any[]) => void;
  }> = [];

  // Bound event handler for cleanup
  private boundNotificationHandler:
    | ((params: {
        sessionId: string;
        notification: DaemonSessionNotificationParams['notification'];
      }) => void)
    | null = null;

  private boundPermissionHandler:
    | ((permission: PendingPermission) => void)
    | null = null;

  private boundAskUserHandler:
    | ((request: DaemonPendingAskUserRequest) => void)
    | null = null;

  private boundAskUserResolvedHandler: ((id: string) => void) | null = null;

  private boundDisconnectHandler:
    | ((code: number, reason: string) => void)
    | null = null;

  private boundMissionWorkerStartedHandler:
    | ((params: { sessionId: string; workerSessionId: string }) => void)
    | null = null;

  // Track connection promise to deduplicate concurrent ensureConnected() calls
  private connectingPromise: Promise<DaemonSessionController> | null = null;

  private inProcessRuntime: InProcessDaemonRuntime | null = null;

  private inProcessTransport: InProcessDaemonClientTransport | null = null;

  private readonly useSameProcessDaemon: boolean;

  private sameProcessCore: DaemonRequestCore | null = null;

  private sameProcessIpcServer: DaemonIpcConnectionServer | null = null;

  private sameProcessBuildPromise: Promise<{
    connectionHandler: DaemonConnectionHandler;
    user: DaemonUser;
  }> | null = null;

  private readonly missionStateManager = new MultiMissionStateManager();

  private readonly transportMode: 'parent' | 'ipc-child';

  private readonly activeDaemonSessionIds = new Set<string>();

  private readonly subagentPermissions = new SubagentPermissionCoordinator();

  constructor(caller: string) {
    this.caller = caller;
    this.transportMode = TuiDaemonAdapter.shouldUseIpcTransport()
      ? 'ipc-child'
      : 'parent';

    this.useSameProcessDaemon =
      this.transportMode === 'parent' &&
      TuiDaemonAdapter.shouldUseSameProcessDaemon();

    const config: IndustryDaemonConfig = {
      machineId: LOCAL_MACHINE_ID,
      machineType: MachineType.Local,
      url: 'in-process',
      maxReconnectAttempts: 0,
      reconnectInterval: 0,
      maxReconnectDelay: 0,
      reconnectBackoffFactor: 1,
      requestTimeout: 30000,
      maxQueueSize: 100,
      connectionTimeoutMs: 5000,
      maxPollAttempts: 1,
      getAccessToken: async () => {
        try {
          return await getAuthTokenOrThrow(getRuntimeAuthConfig());
        } catch (error) {
          logWarn('[TuiDaemonAdapter] Failed to resolve auth token', {
            cause: error,
          });
          throw error;
        }
      },
      onAuthenticationError: (error: Error) => {
        logWarn('[TuiDaemonAdapter] Authentication failed', { cause: error });
      },
      authenticationMode:
        this.transportMode === 'ipc-child'
          ? DaemonAuthenticationMode.Trusted
          : DaemonAuthenticationMode.Token,
      clientType: 'cli',
      supportsTerminalRestoreOnLoad: false,
      disableInactivityTimeout: DISABLE_TUI_SESSION_INACTIVITY_TIMEOUT,
      hydrateChildSessionsOnAvailable: this.transportMode === 'parent',
      ...(this.transportMode === 'parent'
        ? {
            getMissionStore: (sessionId: string) =>
              this.missionStateManager.getMissionStore(sessionId),
          }
        : {}),
    };

    this.controller = new DaemonSessionController({
      sessionStateManager: new MultiSessionStateManager(),
      config,
      daemonClient: this.createDaemonClient(config),
      missionStateManager: this.missionStateManager,
    });

    this.seedDefaultSettingsStoreFromLocalSettings();
  }

  private createDaemonClient(config: IndustryDaemonConfig): DaemonClient {
    if (this.useSameProcessDaemon) {
      const { client } = createSameProcessDaemonClient({
        connect: () => {
          this.sameProcessBuildPromise ??=
            this.buildSameProcessConnection().catch((error) => {
              this.sameProcessBuildPromise = null;
              throw error;
            });
          return this.sameProcessBuildPromise;
        },
        requestTimeout: config.requestTimeout,
      });
      return client;
    }

    this.inProcessRuntime = new InProcessDaemonRuntime();
    if (this.transportMode === 'parent') {
      this.inProcessTransport = new InProcessDaemonClientTransport({
        connect: (url) => this.inProcessRuntime!.connect(url),
        disconnect: () => this.inProcessRuntime!.disconnect(),
        sendMessage: (message) => this.inProcessRuntime!.handleMessage(message),
        onMessage: (handler) => this.inProcessRuntime!.onMessage(handler),
        setPendingSessionReady: (sessionId, promise) =>
          this.inProcessRuntime!.setPendingSessionReady(sessionId, promise),
      });
      return new DaemonClient({
        machineType: MachineType.Local,
        requestTimeout: config.requestTimeout,
        transport: this.inProcessTransport,
      });
    }

    return new DaemonClient({
      machineType: MachineType.Local,
      requestTimeout: config.requestTimeout,
      transport: new IpcDaemonClientTransport(),
    });
  }

  private seedDefaultSettingsStoreFromLocalSettings(): void {
    try {
      const settingsService = getSettingsService();
      const { interactionMode, autonomyLevel } =
        resolveInteractionSettingsWithLegacyFallback({
          interactionMode: settingsService.getInteractionMode(),
          autonomyLevel: settingsService.getAutonomyLevel(),
          autonomyMode: settingsService.getAutonomyMode(),
        });
      applySettingsSnapshotToStore(this.getSsm().getDefaultSettingsStore(), {
        modelId: settingsService.getModel(),
        reasoningEffort: settingsService.getReasoningEffort(),
        interactionMode,
        autonomyLevel,
        specModeModelId: settingsService.hasSpecModeModel()
          ? settingsService.getSpecModeModel()
          : null,
        specModeReasoningEffort: settingsService.hasSpecModeModel()
          ? settingsService.getSpecModeReasoningEffort()
          : null,
        missionSettings: settingsService.getMissionModelSettings(),
      });
    } catch (error) {
      logWarn('[TuiDaemonAdapter] Failed to seed default settings store', {
        cause: error,
      });
    }
  }

  private syncDefaultSettingsStore(
    defaults: DaemonGetDefaultSettingsResult
  ): void {
    applySettingsSnapshotToStore(
      this.getSsm().getDefaultSettingsStore(),
      getStoreSettingsFromDaemonDefaults(defaults)
    );
  }

  private applyInitialSettingsToSessionStore(
    sessionId: string,
    settings: SessionSettingsStoreSnapshot
  ): void {
    const store = this.getSsm().getSessionManager(sessionId)?.getStore();
    if (store) {
      applySettingsSnapshotToStore(store, settings);
    }
  }

  hydrateLocalSessionState({
    sessionId,
    messages = [],
    cwd,
    uiRenderCutoffMessageId,
  }: HydrateLocalSessionStateParams): void {
    const ssm = this.getSsm();
    ssm.loadSession(sessionId, LOCAL_MACHINE_ID, messages, { cwd });
    ssm
      .getSessionManager(sessionId)
      ?.setUiRenderCutoff(uiRenderCutoffMessageId ?? null);
    this.applyInitialSettingsToSessionStore(
      sessionId,
      getCurrentSessionSettingsSnapshot()
    );
  }

  private static shouldUseIpcTransport(): boolean {
    return typeof process.send === 'function';
  }

  private static shouldUseSameProcessDaemon(): boolean {
    if (getEnv().extras.runtimeAuthAirgapEnabled) {
      return true;
    }
    return getFlag(IndustryFeatureFlags.TuiUseComposableDaemonCore);
  }

  private getSsm(): MultiSessionStateManager {
    return this.controller.getSessionStateManager();
  }

  private async buildSameProcessConnection(): Promise<{
    connectionHandler: DaemonConnectionHandler;
    user: DaemonUser;
  }> {
    const env = getEnv();
    const runtimeAuthConfig = getRuntimeAuthConfig();
    const user = await this.resolveInheritedDaemonUser(runtimeAuthConfig);

    const apiClient = new IndustryApiClient(runtimeAuthConfig);

    const { core, connectionHandler } = await createDaemonRequestCore({
      machineId: LOCAL_MACHINE_ID,
      machineType: MachineType.Local,
      apiBaseUrl: env.apiBaseUrl,
      deploymentEnv: env.deploymentEnv,
      isDevelopment: !env.isProductionTier,
      droolExecPath: undefined,
      runtimeAuthConfig,
      apiClient,
      homeDir: env.extras.homeDir,
      shell: env.extras.shell,
      sessionTimeoutMsOverride: resolveEnvAsPositiveInt({
        name: EnvironmentVariable.OVERRIDE_DROOL_SESSION_TIMEOUT_MS,
      }),
      cliVersion: packageJson.version,
      connectionLabel: 'TUI',
      capabilities: [
        createDroolCapability({
          attachChildIpc: (params) =>
            this.sameProcessIpcServer?.attachChildProcess(params),
        }),
        createSettingsCapability(),
        createManagementCapability(),
      ],
      debug: false,
    });

    this.sameProcessCore = core;

    try {
      const ipcServer = new DaemonIpcConnectionServer({
        connectionHandler,
        enableParentIpc: false,
        onActivity: () => {},
      });
      this.sameProcessIpcServer = ipcServer;
      ipcServer.start();

      return { connectionHandler, user };
    } catch (error) {
      try {
        this.sameProcessIpcServer?.stop();
      } catch (stopError) {
        logWarn(
          '[TuiDaemonAdapter] same-process IPC server stop threw during build rollback',
          { cause: stopError }
        );
      }
      this.sameProcessIpcServer = null;
      try {
        await core.shutdown();
      } catch (shutdownError) {
        logWarn(
          '[TuiDaemonAdapter] same-process core shutdown threw during build rollback',
          { cause: shutdownError }
        );
      }
      this.sameProcessCore = null;
      throw error;
    }
  }

  private async resolveInheritedDaemonUser(
    runtimeAuthConfig: RuntimeAuthConfig
  ): Promise<DaemonUser> {
    const authedUser = await getAuthedUser(runtimeAuthConfig);
    const token = await getAuthTokenOrThrow(runtimeAuthConfig);
    if (!authedUser?.userId || !authedUser.orgId) {
      throw new AuthenticationError(
        'Authentication failed. Please log in using /provider or configure a provider.',
        {
          code: JsonRpcErrorCode.AUTHENTICATION_ERROR,
          reason: 'missing_authed_user_or_org',
          value: {
            hasUserId: !!authedUser?.userId,
            hasOrgId: !!authedUser?.orgId,
          },
        }
      );
    }
    return {
      userId: authedUser.userId,
      orgId: authedUser.orgId,
      token,
    };
  }

  /**
   * Ensure connected and authenticated.
   * Deduplicates concurrent calls — only one connection attempt at a time.
   */
  private async ensureConnected(): Promise<DaemonSessionController> {
    if (this.connected) {
      return this.controller;
    }

    if (!this.connectingPromise) {
      this.connectingPromise = this.openConnection().finally(() => {
        this.connectingPromise = null;
      });
    }
    return this.connectingPromise;
  }

  private async openConnection(): Promise<DaemonSessionController> {
    logInfo('[TuiDaemonAdapter] Opening in-process connection', {
      caller: this.caller,
    });

    const controller = this.controller;

    // Connect and authenticate
    await controller.attemptInitialConnection();

    // Set up notification routing
    this.boundNotificationHandler = (params) => {
      const handlers = this.sessionNotificationHandlers.get(params.sessionId);
      if (handlers && handlers.size > 0) {
        for (const handler of handlers) {
          void Promise.resolve(handler(params.notification)).catch(() => {});
        }
      }

      this.handleSessionBackedTaskCompletionNotification(params);
    };
    controller.on(
      DroolEvent.SessionNotification,
      this.boundNotificationHandler
    );

    // Set up permission request routing
    this.boundPermissionHandler = (permission: PendingPermission) => {
      const handlers = this.subagentPermissions.resolveHandlersForPermission({
        permission,
        sessionPermissionHandlers: this.sessionPermissionHandlers,
      });

      if (handlers.size > 0) {
        for (const handler of handlers) {
          void Promise.resolve(handler(permission)).catch((error) => {
            logWarn('[TuiDaemonAdapter] Permission request handler failed', {
              requestId: permission.requestId,
              sessionId: permission.sessionId,
              cause: error,
            });
          });
        }
      }
    };
    controller.on(DroolEvent.PermissionRequested, this.boundPermissionHandler);

    // Set up AskUser request routing
    this.boundAskUserHandler = (request: DaemonPendingAskUserRequest) => {
      const handlers = this.sessionAskUserHandlers.get(request.sessionId);
      if (handlers && handlers.size > 0) {
        for (const handler of handlers) {
          void Promise.resolve(handler(request)).catch(() => {});
        }
      } else {
        // No handler registered for this session — auto-cancel, mirroring
        // the permission-request fallback above. This covers worker
        // sessions whose AskUser requests are forwarded via IPC from the
        // daemon but whose orchestrator TUI never subscribes. Without
        // this, the worker subprocess would block forever on its pending
        // AskUser response.
        logWarn(
          '[TuiDaemonAdapter] Auto-cancelling ask-user request (no handler)',
          {
            requestId: request.requestId,
            sessionId: request.sessionId,
          }
        );
        void this.respondToAskUser({
          requestId: request.requestId,
          sessionId: request.sessionId,
          result: { cancelled: true, answers: [] },
        }).catch(() => {});
      }
    };
    controller.on(DroolEvent.AskUserRequested, this.boundAskUserHandler);

    // Mirror daemon-side ask-user resolutions onto the local AskUserAnswerStore
    // so dialogs opened by registerDaemonAskUserRequest() get closed when the
    // daemon auto-replays a buffered answer (see tryReplayBufferedAskUser).
    // Without this, the request id resolved server-side never propagates to
    // the CLI store keyed by toolCallId, leaving a ghost dialog on screen.
    this.boundAskUserResolvedHandler = (id: string) => {
      clearAskUserAnswersByRequestId(id);
    };
    controller.on(DroolEvent.AskUserResolved, this.boundAskUserResolvedHandler);

    // Set up disconnect handler
    this.boundDisconnectHandler = (code: number, reason: string) => {
      for (const handler of this.disconnectHandlers) {
        try {
          handler(code, reason);
        } catch {
          // Ignore handler errors
        }
      }
    };
    controller.on('disconnected', this.boundDisconnectHandler);

    this.boundMissionWorkerStartedHandler = ({
      sessionId,
      workerSessionId,
    }) => {
      this.missionStateManager.associateWorkerWithParentMission(
        sessionId,
        workerSessionId
      );
    };
    controller.on(
      DroolEvent.MissionWorkerStarted,
      this.boundMissionWorkerStartedHandler
    );

    this.connected = true;

    // Replay any event registrations that were queued before connection.
    // This handles the case where useMultiSession registers event listeners
    // at mount time before the WebSocket controller has connected.
    if (this.pendingEventRegistrations.length > 0) {
      logInfo(
        '[TuiDaemonAdapter] Replaying pending event registrations after connect',
        { count: this.pendingEventRegistrations.length }
      );
      for (const { event, handler } of this.pendingEventRegistrations) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (controller as any).on(event, handler);
      }
      this.pendingEventRegistrations = [];
    }

    logInfo('[TuiDaemonAdapter] Connected and authenticated', {
      caller: this.caller,
    });

    return controller;
  }

  /**
   * Close the connection and clean up resources. Runs synchronously; the
   * returned promise settles once the same-process daemon core (if any) has
   * finished shutting down, so exit paths can await child drool teardown.
   */
  close(): Promise<void> {
    logInfo('[TuiDaemonAdapter] close() called', {
      caller: this.caller,
      isConnected: this.connected,
    });

    if (this.connected) {
      const controller = this.controller;
      if (this.boundNotificationHandler) {
        controller.off(
          DroolEvent.SessionNotification,
          this.boundNotificationHandler
        );
        this.boundNotificationHandler = null;
      }
      if (this.boundPermissionHandler) {
        controller.off(
          DroolEvent.PermissionRequested,
          this.boundPermissionHandler
        );
        this.boundPermissionHandler = null;
      }
      if (this.boundAskUserHandler) {
        controller.off(DroolEvent.AskUserRequested, this.boundAskUserHandler);
        this.boundAskUserHandler = null;
      }
      if (this.boundAskUserResolvedHandler) {
        controller.off(
          DroolEvent.AskUserResolved,
          this.boundAskUserResolvedHandler
        );
        this.boundAskUserResolvedHandler = null;
      }
      if (this.boundDisconnectHandler) {
        controller.off('disconnected', this.boundDisconnectHandler);
        this.boundDisconnectHandler = null;
      }
      if (this.boundMissionWorkerStartedHandler) {
        controller.off(
          DroolEvent.MissionWorkerStarted,
          this.boundMissionWorkerStartedHandler
        );
        this.boundMissionWorkerStartedHandler = null;
      }
      controller.disconnect();
      this.connected = false;
    }
    const sameProcessShutdown = this.teardownSameProcessHandle();
    this.connectingPromise = null;
    this.pendingEventRegistrations = [];
    this.sessionNotificationHandlers.clear();
    this.sessionPermissionHandlers.clear();
    this.sessionAskUserHandlers.clear();
    this.disconnectHandlers.clear();
    this.backgroundCompletionWakeups.clear();
    this.activeDaemonSessionIds.clear();
    return sameProcessShutdown;
  }

  private teardownSameProcessHandle(): Promise<void> {
    try {
      this.sameProcessIpcServer?.stop();
    } catch (error) {
      logWarn('[TuiDaemonAdapter] same-process IPC server stop threw', {
        cause: error,
      });
    }
    const core = this.sameProcessCore;
    const shutdown = core
      ? core.shutdown().catch((error) => {
          logWarn('[TuiDaemonAdapter] same-process core shutdown threw', {
            cause: error,
          });
        })
      : Promise.resolve();
    this.sameProcessIpcServer = null;
    this.sameProcessCore = null;
    this.sameProcessBuildPromise = null;
    return shutdown;
  }

  /**
   * Disconnect from the daemon. Alias for close() that matches
   * the DaemonSessionController.disconnect() API used by shutdownCoordinator.
   */
  disconnect(): Promise<void> {
    return this.close();
  }

  claimBackgroundCompletionWakeup(sessionId: string): boolean {
    if (this.backgroundCompletionWakeups.has(sessionId)) {
      return false;
    }
    this.backgroundCompletionWakeups.add(sessionId);
    return true;
  }

  private clearSessionBackedTaskIdleWakeTimeout(sessionId: string): void {
    const timeout = this.sessionBackedTaskIdleWakeTimeouts.get(sessionId);
    if (!timeout) {
      return;
    }
    clearTimeout(timeout);
    this.sessionBackedTaskIdleWakeTimeouts.delete(sessionId);
  }

  private handleSessionBackedTaskCompletionNotification({
    sessionId,
    notification,
  }: DaemonSessionNotificationParams): void {
    if (
      !isSessionBackedTaskBackground({
        sessionStateManager: this.getSsm(),
        taskId: sessionId,
      })
    ) {
      return;
    }

    if (notification.type === SessionNotificationType.AGENT_TURN_COMPLETED) {
      this.clearSessionBackedTaskIdleWakeTimeout(sessionId);
      setTimeout(() => {
        void this.wakeParentForSessionBackedTask({
          taskId: sessionId,
          reason: notification.reason,
        }).catch((error) => {
          logWarn('[TuiDaemonAdapter] Failed to wake parent after task turn', {
            sessionId,
            cause: error,
          });
        });
      }, 250);
      return;
    }

    if (
      notification.type === SessionNotificationType.DROOL_WORKING_STATE_CHANGED
    ) {
      this.clearSessionBackedTaskIdleWakeTimeout(sessionId);
      if (notification.newState === DroolWorkingState.Idle) {
        const timeout = setTimeout(() => {
          this.sessionBackedTaskIdleWakeTimeouts.delete(sessionId);
          void this.wakeParentForSessionBackedTask({
            taskId: sessionId,
            reason: getCompletionReasonFromFinalOutput(
              readSessionBackedTaskFinalOutput({
                sessionStateManager: this.getSsm(),
                taskId: sessionId,
              })
            ),
          }).catch((error) => {
            logWarn('[TuiDaemonAdapter] Failed to wake parent after idle', {
              sessionId,
              cause: error,
            });
          });
        }, SESSION_BACKED_TASK_IDLE_WAKE_GRACE_MS);
        this.sessionBackedTaskIdleWakeTimeouts.set(sessionId, timeout);
      }
      return;
    }

    if (notification.type === SessionNotificationType.ERROR) {
      this.clearSessionBackedTaskIdleWakeTimeout(sessionId);
      setTimeout(() => {
        const reason = isProcessExitNotification(notification)
          ? getCompletionReasonFromFinalOutput(
              readSessionBackedTaskFinalOutput({
                sessionStateManager: this.getSsm(),
                taskId: sessionId,
              })
            )
          : AgentTurnCompletionReason.Error;
        void this.wakeParentForSessionBackedTask({
          taskId: sessionId,
          reason,
        }).catch((error) => {
          logWarn('[TuiDaemonAdapter] Failed to wake parent after task error', {
            sessionId,
            cause: error,
          });
        });
      }, 250);
    }
  }

  private async wakeParentForSessionBackedTask({
    taskId,
    reason,
  }: {
    taskId: string;
    reason: AgentTurnCompletionReason | undefined;
  }): Promise<void> {
    if (!this.claimBackgroundCompletionWakeup(taskId)) {
      return;
    }

    const task = buildCompletedSessionBackedTask({
      sessionStateManager: this.getSsm(),
      taskId,
      reason,
    });
    if (!task?.parentSessionId) {
      forgetSessionBackedTaskStartTime(taskId);
      return;
    }

    getSessionService().applyChildInclusiveTokenUsageFromSession(
      task.sessionId,
      task.parentSessionId
    );
    try {
      await this.closeSession(task.sessionId, { retainState: true });
    } finally {
      forgetSessionBackedTaskStartTime(task.sessionId);
    }
    await waitForParentReadyForSessionBackedTaskCompletionInjection({
      getSessionStateManager: () => this.getSsm(),
      parentSessionId: task.parentSessionId,
      toolCallId: task.toolCallId,
      subscribeToSessionNotifications:
        this.subscribeToSessionNotifications.bind(this),
    });
    await this.addUserMessage({
      sessionId: task.parentSessionId,
      text: buildSessionBackedTaskCompletionPrompt(task),
      role: MessageRole.System,
      visibility: MessageVisibility.LLMOnly,
    });
  }

  /**
   * Subscribe to session notifications for a specific session.
   * Returns an unsubscribe function.
   */
  subscribeToSessionNotifications(
    sessionId: string,
    handler: SessionNotificationHandler
  ): () => void {
    const handlers =
      this.sessionNotificationHandlers.get(sessionId) ?? new Set();
    handlers.add(handler);
    this.sessionNotificationHandlers.set(sessionId, handlers);

    return () => {
      const existingHandlers = this.sessionNotificationHandlers.get(sessionId);
      if (!existingHandlers) {
        return;
      }
      existingHandlers.delete(handler);
      if (existingHandlers.size === 0) {
        this.sessionNotificationHandlers.delete(sessionId);
      }
    };
  }

  /**
   * Subscribe to permission requests for a specific session.
   * Returns an unsubscribe function.
   */
  subscribeToPermissionRequests(
    sessionId: string,
    handler: PermissionRequestHandler
  ): () => void {
    const handlers = this.sessionPermissionHandlers.get(sessionId) ?? new Set();
    handlers.add(handler);
    this.sessionPermissionHandlers.set(sessionId, handlers);

    return () => {
      const existingHandlers = this.sessionPermissionHandlers.get(sessionId);
      if (!existingHandlers) return;
      existingHandlers.delete(handler);
      if (existingHandlers.size === 0) {
        this.sessionPermissionHandlers.delete(sessionId);
      }
    };
  }

  /**
   * Subscribe to AskUser requests for a specific session.
   * Returns an unsubscribe function.
   */
  subscribeToAskUserRequests(
    sessionId: string,
    handler: AskUserRequestHandler
  ): () => void {
    const handlers = this.sessionAskUserHandlers.get(sessionId) ?? new Set();
    handlers.add(handler);
    this.sessionAskUserHandlers.set(sessionId, handlers);

    return () => {
      const existingHandlers = this.sessionAskUserHandlers.get(sessionId);
      if (!existingHandlers) return;
      existingHandlers.delete(handler);
      if (existingHandlers.size === 0) {
        this.sessionAskUserHandlers.delete(sessionId);
      }
    };
  }

  /**
   * Subscribe to daemon disconnect events.
   * Returns an unsubscribe function.
   */
  onDisconnect(handler: DisconnectHandler): () => void {
    this.disconnectHandlers.add(handler);
    return () => {
      this.disconnectHandlers.delete(handler);
    };
  }

  /**
   * Spawn a worker session via the daemon.
   * Maps to DaemonSessionController.initializeSession() with worker params.
   */
  async spawnWorkerSession(params: {
    cwd: string;
    baseSessionId: string;
    modelId?: string;
    autonomyLevel?: AutonomyLevel;
    interactionMode?: DroolInteractionMode;
    reasoningEffort?: ReasoningEffort;
    inactivityTimeoutMs?: number;
    runtimeSettingsPath?: string;
    tags?: Array<{ name: string; metadata?: Record<string, string> }>;
  }): Promise<string> {
    const controller = await this.ensureConnected();
    const token = await getAuthTokenOrThrow(getRuntimeAuthConfig());

    const sessionId = uuidv4();
    controller
      .getSessionStateManager()
      .markSessionLoading(sessionId, LOCAL_MACHINE_ID);
    const missionTags = upsertMissionSessionTag(params.tags, {
      role: DecompSessionType.Worker,
      missionId: params.baseSessionId,
    });

    const result: InitializeSessionResult = await controller.initializeSession({
      token,
      machineId: LOCAL_MACHINE_ID,
      sessionId,
      cwd: params.cwd,
      modelId: params.modelId,
      autonomyLevel: params.autonomyLevel,
      interactionMode: params.interactionMode,
      reasoningEffort: params.reasoningEffort,
      inactivityTimeoutMs: params.inactivityTimeoutMs,
      runtimeSettingsPath: params.runtimeSettingsPath,
      tags: missionTags,
    });

    this.missionStateManager.associateSessionWithMission(
      result.sessionId,
      params.baseSessionId
    );
    this.activeDaemonSessionIds.add(result.sessionId);

    return result.sessionId;
  }

  /**
   * Spawn a squad agent session via the daemon.
   */
  async spawnSquadAgent(params: {
    squadId: string;
    agentId: string;
    agentName: string;
    role: SquadRole;
    cwd: string;
    modelId?: string;
    autonomyLevel?: AutonomyLevel;
    interactionMode?: DroolInteractionMode;
    reasoningEffort?: ReasoningEffort;
    inactivityTimeoutMs?: number;
  }): Promise<string> {
    const controller = await this.ensureConnected();
    const token = await getAuthTokenOrThrow(getRuntimeAuthConfig());

    const sessionId = uuidv4();
    controller
      .getSessionStateManager()
      .markSessionLoading(sessionId, LOCAL_MACHINE_ID);

    const result: InitializeSessionResult = await controller.initializeSession({
      token,
      machineId: LOCAL_MACHINE_ID,
      sessionId,
      cwd: params.cwd,
      modelId: params.modelId,
      autonomyLevel: params.autonomyLevel,
      interactionMode: params.interactionMode,
      reasoningEffort: params.reasoningEffort,
      inactivityTimeoutMs: params.inactivityTimeoutMs,
      enabledToolIds: [SQUAD_BOARD_TOOL_ID],
      tags: [
        buildSquadSessionTag({
          squadId: params.squadId,
          agentId: params.agentId,
          role: params.role,
          agentName: params.agentName,
        }),
      ],
    });

    this.activeDaemonSessionIds.add(result.sessionId);
    return result.sessionId;
  }

  async initializeSubagentSession(params: {
    sessionId?: string;
    cwd: string;
    modelId?: string;
    autonomyLevel?: AutonomyLevel;
    interactionMode?: DroolInteractionMode;
    reasoningEffort?: ReasoningEffort;
    systemPromptOverride?: string;
    inactivityTimeoutMs?: number;
    runtimeSettingsPath?: string;
    enabledToolIds?: string[];
    disabledToolIds?: string[];
    tags?: SessionTag[];
    title?: string;
  }): Promise<string> {
    const controller = await this.ensureConnected();
    const token = await getAuthTokenOrThrow(getRuntimeAuthConfig());

    const sessionId = params.sessionId ?? uuidv4();
    controller
      .getSessionStateManager()
      .markSessionLoading(sessionId, LOCAL_MACHINE_ID);

    const result: InitializeSessionResult = await controller.initializeSession({
      token,
      machineId: LOCAL_MACHINE_ID,
      sessionId,
      cwd: params.cwd,
      modelId: params.modelId,
      autonomyLevel: params.autonomyLevel,
      interactionMode: params.interactionMode,
      reasoningEffort: params.reasoningEffort,
      systemPromptOverride: params.systemPromptOverride,
      inactivityTimeoutMs: params.inactivityTimeoutMs,
      runtimeSettingsPath: params.runtimeSettingsPath,
      enabledToolIds: params.enabledToolIds,
      disabledToolIds: params.disabledToolIds,
      tags: params.tags,
      title: params.title,
    });

    this.activeDaemonSessionIds.add(result.sessionId);
    return result.sessionId;
  }

  /**
   * Send a user message to a session.
   */
  async addUserMessage(params: {
    sessionId: string;
    text: string;
    queuePlacement?: QueuePlacement;
    role?: MessageRole;
    visibility?: MessageVisibility;
  }): Promise<void> {
    await this.sendTuiMessage(params);
  }

  async resolveQueuedUserMessage(
    params: { sessionId: string } & ResolveQueuedUserMessageParams
  ): Promise<void> {
    const controller = await this.ensureConnected();
    const { sessionId, ...resolveParams } = params;
    await this.ensureSessionLoaded(controller, sessionId);
    await controller.resolveQueuedUserMessage(sessionId, resolveParams);
  }

  /**
   * Interrupt a running session.
   */
  async interruptSession(sessionId: string): Promise<void> {
    const controller = await this.ensureConnected();
    await controller.interruptSession(sessionId);
  }

  /**
   * Close a session. Used to terminate a worker session cleanly, or to
   * release the previous session when the TUI switches to a new one.
   *
   * In addition to the daemon RPC, this removes the session's state from
   * the client-side MultiSessionStateManager so we don't retain store data
   * for a session whose daemon-side process has been terminated.
   */
  async closeSession(
    sessionId: string,
    options: { retainState?: boolean } = {}
  ): Promise<void> {
    const controller = await this.ensureConnected();
    await controller.closeSession(sessionId);
    this.activeDaemonSessionIds.delete(sessionId);
    if (options.retainState) {
      return;
    }
    // this is only relevant for tui, since switching between sessions frequently
    // is not an expected behavior
    try {
      controller.getSessionStateManager().removeSession(sessionId);
    } catch (err) {
      logWarn('[TuiDaemonAdapter] Failed to remove session from SSM', {
        sessionId,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Adapter-level guard for the in-process transport.
   *
   * `DaemonSessionController` registers a `beforeRequest` hook on
   * `DaemonClient`; this adapter-level guard keeps direct adapter calls
   * consistent across parent and ipc-child modes.
   */
  private async ensureSessionLoaded(
    controller: DaemonSessionController,
    sessionId: string
  ): Promise<void> {
    await controller.ensureSessionLoaded(sessionId);
    this.activeDaemonSessionIds.add(sessionId);
  }

  /**
   * Load an existing session.
   */
  async loadSession(
    sessionId: string,
    skipPermissionsUnsafe?: boolean,
    runtimeSettingsPath?: string
  ): Promise<LoadSessionResult> {
    const controller = await this.ensureConnected();
    const result = await controller.loadSession({
      sessionId,
      skipPermissionsUnsafe,
      runtimeSettingsPath,
    });
    this.activeDaemonSessionIds.add(sessionId);
    return result;
  }

  /**
   * Restart an already-active TUI session after the parent process changes cwd.
   * A fresh child inherits the parent cwd, so cwd-local command discovery
   * matches the TUI before queued slash prompts are resolved.
   */
  async reloadSessionForCurrentCwd(
    sessionId: string
  ): Promise<LoadSessionResult> {
    const controller = await this.ensureConnected();
    await controller.closeSession(sessionId);
    this.activeDaemonSessionIds.delete(sessionId);
    const result = await controller.loadSession({ sessionId });
    this.activeDaemonSessionIds.add(sessionId);
    return result;
  }

  // ============================================================================
  // TUI Session Methods (for daemon-backed sessions in main TUI flow)
  // ============================================================================

  /**
   * Initialize a TUI session via the daemon. Used for the main interactive session
   * (not a worker session). Creates a session and returns the result.
   */
  async initializeTuiSession(params: {
    cwd: string;
    modelId?: string;
    autonomyLevel?: AutonomyLevel;
    interactionMode?: DroolInteractionMode;
    reasoningEffort?: ReasoningEffort;
    specModeModelId?: string;
    specModeReasoningEffort?: ReasoningEffort;
    missionSettings?: MissionModelSettings;
    compactionThresholdCheckEnabled?: boolean;
    tags?: Array<{ name: string; metadata?: Record<string, string> }>;
    decompSessionType?: DecompSessionType;
    decompMissionId?: string;
    sessionId?: string;
  }): Promise<InitializeSessionResult> {
    const controller = await this.ensureConnected();
    const token = await getAuthTokenOrThrow(getRuntimeAuthConfig());

    const sessionId = params.sessionId ?? uuidv4();
    const sessionStateManager = controller.getSessionStateManager();
    sessionStateManager.markSessionLoading(sessionId, LOCAL_MACHINE_ID);
    this.applyInitialSettingsToSessionStore(sessionId, {
      modelId: params.modelId,
      reasoningEffort: params.reasoningEffort,
      interactionMode: params.interactionMode,
      autonomyLevel: params.autonomyLevel,
      specModeModelId: params.specModeModelId,
      specModeReasoningEffort: params.specModeReasoningEffort,
      missionSettings: params.missionSettings ?? null,
      compactionThresholdCheckEnabled: params.compactionThresholdCheckEnabled,
    });
    const missionId =
      params.decompSessionType === DecompSessionType.Orchestrator
        ? (params.decompMissionId ?? sessionId)
        : params.decompMissionId;
    const tags =
      params.decompSessionType !== undefined && missionId !== undefined
        ? upsertMissionSessionTag(params.tags, {
            role: params.decompSessionType,
            missionId,
          })
        : params.tags;

    const result = await controller.initializeSession({
      token,
      machineId: LOCAL_MACHINE_ID,
      cwd: params.cwd,
      modelId: params.modelId,
      autonomyLevel: params.autonomyLevel,
      interactionMode: params.interactionMode,
      reasoningEffort: params.reasoningEffort,
      specModeModelId: params.specModeModelId,
      specModeReasoningEffort: params.specModeReasoningEffort,
      missionSettings: params.missionSettings,
      compactionThresholdCheckEnabled: params.compactionThresholdCheckEnabled,
      disableInactivityTimeout: DISABLE_TUI_SESSION_INACTIVITY_TIMEOUT,
      tags,
      sessionId,
    });
    if (missionId) {
      this.missionStateManager.associateSessionWithMission(
        result.sessionId,
        missionId
      );
    }
    this.activeDaemonSessionIds.add(result.sessionId);
    return result;
  }

  /**
   * Send a user message to the TUI session with full options (images, files, etc.).
   */
  async sendTuiMessage(params: {
    sessionId: string;
    text: string;
    images?: ImageAttachment[];
    files?: DocumentSource[];
    requestId?: string;
    skipAgentLoop?: boolean;
    queuePlacement?: QueuePlacement;
    role?: MessageRole;
    visibility?: MessageVisibility;
  }): Promise<void> {
    const controller = await this.ensureConnected();
    await this.ensureSessionLoaded(controller, params.sessionId);
    const base64Images = convertAttachmentsToBase64Images(params.images);
    const enabledQueuePlacement = getEnabledQueuePlacement(
      params.queuePlacement
    );
    const addUserMessageParams = {
      text: params.text,
      ...(base64Images && { images: base64Images }),
      ...(params.files && { files: params.files }),
      ...(params.skipAgentLoop && { skipAgentLoop: params.skipAgentLoop }),
      ...(enabledQueuePlacement && {
        queuePlacement: enabledQueuePlacement,
      }),
      ...(params.role && { role: params.role }),
      ...(params.visibility && { visibility: params.visibility }),
    };

    if (params.requestId) {
      await controller.addUserMessage(
        params.sessionId,
        addUserMessageParams,
        params.requestId
      );
      return;
    }

    await controller.addUserMessage(params.sessionId, addUserMessageParams);
  }

  /**
   * Respond to a permission request from the daemon.
   */
  async respondToPermission(
    params: { permissionId: string } & DaemonRequestPermissionResult
  ): Promise<void> {
    const controller = await this.ensureConnected();
    await controller.respondToPermission(params);
  }

  /**
   * Respond to an AskUser request from the daemon.
   */
  async respondToAskUser(params: {
    requestId: string;
    sessionId: string;
    result: {
      cancelled?: boolean;
      answers: Array<{ index: number; question: string; answer: string }>;
    };
  }): Promise<void> {
    const controller = await this.ensureConnected();
    await controller.respondToAskUser(params);
  }

  /**
   * Update session settings on the daemon.
   * Propagates local UI setting changes (model, reasoning effort, interaction mode,
   * autonomy level, spec mode settings, tags) to the daemon so subsequent messages use them.
   */
  async updateSessionSettings(params: {
    sessionId: string;
    modelId?: string;
    reasoningEffort?: ReasoningEffort;
    interactionMode?: DroolInteractionMode;
    autonomyLevel?: AutonomyLevel;
    specModeModelId?: string | null;
    specModeReasoningEffort?: ReasoningEffort | null;
    missionSettings?: MissionModelSettings;
    tags?: import('@industry/drool-sdk-ext/protocol/session').SessionTag[];
    enabledToolIds?: string[];
    compactionThresholdCheckEnabled?: boolean;
  }): Promise<void> {
    const controller = await this.ensureConnected();
    const { sessionId, missionSettings, ...settings } = params;

    if (missionSettings !== undefined) {
      const applyMissionSettings = (store: {
        getMissionSettings: () => MissionModelSettings | null;
        setMissionSettings: (
          nextMissionSettings: MissionModelSettings | null
        ) => void;
      }) => {
        store.setMissionSettings({
          ...(store.getMissionSettings() ?? {}),
          ...missionSettings,
        });
      };

      const sessionStateManager = controller.getSessionStateManager();
      applyMissionSettings(sessionStateManager.getPendingStore());

      const sessionStore = sessionStateManager
        .getSessionManager(sessionId)
        ?.getStore();
      if (sessionStore) {
        applyMissionSettings(sessionStore);
      }

      if (!this.activeDaemonSessionIds.has(sessionId)) {
        return;
      }
    }

    await this.ensureSessionLoaded(controller, sessionId);
    await controller.updateSessionSettings(sessionId, {
      ...settings,
      ...(missionSettings !== undefined ? { missionSettings } : {}),
    });
  }

  async getDefaultSettings(): Promise<DaemonGetDefaultSettingsResult> {
    const controller = await this.ensureConnected();
    const defaults = await controller.getDefaultSettings();
    this.syncDefaultSettingsStore(defaults);
    return defaults;
  }

  async updateDefaultSettings(
    params: DefaultSettingsUpdateParams
  ): Promise<void> {
    const settingsService = getSettingsService();

    if (params.modelId !== undefined) {
      settingsService.setModel(params.modelId, params.reasoningEffort);
    } else if (params.reasoningEffort !== undefined) {
      settingsService.setReasoningEffort(params.reasoningEffort);
    }

    if (
      params.interactionMode !== undefined ||
      params.autonomyLevel !== undefined
    ) {
      const { interactionMode, autonomyLevel } =
        resolveInteractionSettingsWithLegacyFallback({
          interactionMode:
            params.interactionMode ?? settingsService.getInteractionMode(),
          autonomyLevel:
            params.autonomyLevel ?? settingsService.getAutonomyLevel(),
          autonomyMode: settingsService.getAutonomyMode(),
        });
      settingsService.setInteractionSettings(
        interactionMode ?? DroolInteractionMode.Auto,
        autonomyLevel ?? AutonomyLevel.Off
      );
    }

    if (params.specModeModelId === null) {
      settingsService.clearSpecModeModel();
    } else if (params.specModeModelId !== undefined) {
      settingsService.setSpecModeModel(
        params.specModeModelId,
        params.specModeReasoningEffort ?? undefined
      );
    } else if (params.specModeReasoningEffort) {
      settingsService.setSpecModeReasoningEffort(
        params.specModeReasoningEffort
      );
    }

    await settingsService.persistSessionDefaultSettings();
    await settingsService.refreshFromSettingsManager();
    const controller = await this.ensureConnected();
    const defaults = await controller.getDefaultSettings();
    this.syncDefaultSettingsStore(defaults);
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
    const controller = await this.ensureConnected();
    await this.ensureSessionLoaded(controller, sessionId);
    return controller.getRewindInfo(sessionId, messageId);
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
    const controller = await this.ensureConnected();
    await this.ensureSessionLoaded(controller, sessionId);
    return controller.executeRewind(sessionId, params);
  }

  async compactSession(
    sessionId: string,
    customInstructions?: string
  ): Promise<{
    newSessionId: string;
    removedCount: number;
  }> {
    const controller = await this.ensureConnected();
    await this.ensureSessionLoaded(controller, sessionId);
    return controller.compactSession(sessionId, customInstructions);
  }

  async forkSession(sessionId: string): Promise<{
    newSessionId: string;
  }> {
    const controller = await this.ensureConnected();
    await this.ensureSessionLoaded(controller, sessionId);
    return controller.forkSession(sessionId);
  }

  warmupCache(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Get the underlying DaemonSessionController for direct event subscription.
   * Returns null if not connected.
   */
  getController(): DaemonSessionController | null {
    return this.connected ? this.controller : null;
  }

  /**
   * Get the MultiSessionStateManager for reading session state.
   * Used by useSyncExternalStore hooks to subscribe to state changes.
   */
  getSessionStateManager(): MultiSessionStateManager {
    return this.getSsm();
  }

  getMissionStateManager(): MultiMissionStateManager {
    return this.missionStateManager;
  }

  /**
   * Ensure the adapter is connected and return the controller.
   * This is useful for startup flows that need to verify the connection.
   */
  async ensureConnectedAndGetController(): Promise<DaemonSessionController> {
    return this.ensureConnected();
  }

  /**
   * Subscribe to a specific DroolEvent on the underlying controller.
   * Returns an unsubscribe function.
   */
  onControllerEvent(
    event: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (...args: any[]) => void
  ): () => void {
    if (!this.connected) {
      // Controller hasn't connected yet — queue the registration so it is
      // replayed once openConnection() completes. This handles the common
      // case where useMultiSession registers event listeners at React mount
      // time before the WebSocket connection is established.
      const registration = { event, handler };
      this.pendingEventRegistrations.push(registration);
      logInfo(
        '[TuiDaemonAdapter] Queued event registration (controller not yet connected)',
        { eventName: event }
      );
      return () => {
        // Remove from pending queue if still queued
        const idx = this.pendingEventRegistrations.indexOf(registration);
        if (idx !== -1) {
          this.pendingEventRegistrations.splice(idx, 1);
        }
        // Also remove from controller if it was already replayed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.controller as any).off(event, handler);
      };
    }
    // Use type assertion to access the generic EventEmitter methods
    // since DaemonSessionController extends EventEmitter<IndustryDroolEvents>
    // and we need dynamic event name support
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.controller as any).on(event, handler);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.controller as any).off(event, handler);
    };
  }

  /**
   * Submit a bug report via the daemon.
   */
  async submitBugReport(
    sessionId: string,
    userComment: string,
    clientLogs?: string
  ): Promise<{ bugReportId: string }> {
    const controller = await this.ensureConnected();
    return controller.submitBugReport(sessionId, userComment, clientLogs);
  }

  /**
   * Rename a session via the daemon.
   */
  async renameSession(
    sessionId: string,
    title: string
  ): Promise<{ success: boolean }> {
    const controller = await this.ensureConnected();
    return controller.renameSession(sessionId, title);
  }

  /**
   * Fetch the /context window usage breakdown for a session via the daemon.
   * The same RPC the web/desktop clients use, so the TUI and remote surfaces
   * share one path through the daemon's JSON-RPC layer.
   */
  async getContextBreakdown(
    sessionId: string
  ): Promise<DaemonGetContextBreakdownResult> {
    const controller = await this.ensureConnected();
    return controller.getContextBreakdown(sessionId);
  }

  // ============================================================================
  // MCP Methods (delegated to daemon via JSON-RPC)
  // ============================================================================

  async listMcpServers(sessionId: string): Promise<ListMcpServersResult> {
    const controller = await this.ensureConnected();
    return controller.listMcpServers(sessionId);
  }

  async listMcpTools(sessionId: string): Promise<{ tools: McpToolInfo[] }> {
    const controller = await this.ensureConnected();
    return controller.listMcpTools(sessionId);
  }

  async listMcpRegistry(
    sessionId: string
  ): Promise<{ servers: McpRegistryServer[] }> {
    const controller = await this.ensureConnected();
    return controller.listMcpRegistry(sessionId);
  }

  async addMcpServer(
    sessionId: string,
    params: Omit<DaemonAddMcpServerRequest['params'], 'sessionId'>
  ): Promise<{ success: boolean }> {
    const controller = await this.ensureConnected();
    return controller.addMcpServer({ sessionId, ...params });
  }

  async removeMcpServer(
    sessionId: string,
    serverName: string
  ): Promise<{ success: boolean }> {
    const controller = await this.ensureConnected();
    return controller.removeMcpServer({
      sessionId,
      serverName,
      settingsLevel: SettingsLevel.User,
    });
  }

  async toggleMcpServer(
    sessionId: string,
    serverName: string,
    enabled: boolean
  ): Promise<{ success: boolean }> {
    const controller = await this.ensureConnected();
    return controller.toggleMcpServer({
      sessionId,
      serverName,
      enabled,
      settingsLevel: SettingsLevel.User,
    });
  }

  async toggleMcpTool(
    sessionId: string,
    serverName: string,
    toolName: string,
    enabled: boolean
  ): Promise<{ success: boolean }> {
    const controller = await this.ensureConnected();
    return controller.toggleMcpTool(sessionId, serverName, toolName, enabled);
  }

  async authenticateMcpServer(
    sessionId: string,
    serverName: string
  ): Promise<{ success: boolean }> {
    const controller = await this.ensureConnected();
    return controller.authenticateMcpServer({ sessionId, serverName });
  }

  async cancelMcpAuth(
    sessionId: string,
    serverName: string
  ): Promise<{ success: boolean }> {
    const controller = await this.ensureConnected();
    return controller.cancelMcpAuth({ sessionId, serverName });
  }

  async clearMcpAuth(
    sessionId: string,
    serverName: string
  ): Promise<{ success: boolean }> {
    const controller = await this.ensureConnected();
    return controller.clearMcpAuth({ sessionId, serverName });
  }

  async submitMcpAuthCode(
    sessionId: string,
    serverName: string,
    code: string,
    state: string
  ): Promise<{ success: boolean }> {
    const controller = await this.ensureConnected();
    return controller.submitMcpAuthCode({ sessionId, serverName, code, state });
  }

  async submitMcpAuthError(
    sessionId: string,
    serverName: string,
    error: string,
    state: string,
    errorDescription?: string
  ): Promise<{ success: boolean }> {
    const controller = await this.ensureConnected();
    return controller.submitMcpAuthError({
      sessionId,
      serverName,
      error,
      errorDescription,
      state,
    });
  }
}

let singletonInstance: TuiDaemonAdapter | null = null;
let shutdownHookRegistered = false;

// Headroom over the drool-sdk ManagedProcess SIGTERM->SIGKILL grace (5s) so
// the same-process core can finish closing child drools before the
// coordinator's hook-chain safety net fires.
const ADAPTER_SHUTDOWN_HOOK_TIMEOUT_MS = 6_000;

export function getTuiDaemonAdapter(): TuiDaemonAdapter {
  if (!singletonInstance) {
    singletonInstance = new TuiDaemonAdapter('drool-cli');
    if (!shutdownHookRegistered) {
      shutdownHookRegistered = true;
      getShutdownCoordinator().registerHook(
        'tui-daemon-adapter-disconnect',
        async () => {
          await singletonInstance?.close();
        },
        {
          priority: SHUTDOWN_HOOK_PRIORITY.Default,
          timeoutMs: ADAPTER_SHUTDOWN_HOOK_TIMEOUT_MS,
        }
      );
    }
  }
  return singletonInstance;
}

/** Reset the singleton. Only intended for tests. */
export function _resetTuiDaemonAdapterForTesting(): void {
  if (singletonInstance) {
    void singletonInstance.close();
  }
  singletonInstance = null;
  shutdownHookRegistered = false;
}
