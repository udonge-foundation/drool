import path from 'path';

import { v4 as uuidv4 } from 'uuid';

import {
  DaemonCronEvent,
  type DaemonCronStateChangedNotification,
  DaemonAskUserResult,
  DaemonAddUserMessageRequestSchema,
  DaemonAuthenticateRequestSchema,
  DaemonCloseSessionRequestSchema,
  DaemonConnectionMethod,
  DaemonCreateCronRequestSchema,
  DaemonDroolEvent,
  DaemonDroolMethod,
  DaemonDeleteCronRequestSchema,
  DaemonHoldSessionCronsRequestSchema,
  DaemonInitializeSessionRequestSchema,
  DaemonInterruptSessionRequestSchema,
  DaemonKillWorkerSessionRequestSchema,
  DaemonListCronsRequestSchema,
  DaemonLoadSessionRequestSchema,
  DaemonRequestPermissionResult,
  DaemonResolveQueuedUserMessageRequestSchema,
  DaemonResumeSessionCronsRequestSchema,
  type CronRecord,
  type DaemonSessionNotification,
  DaemonSpecificNotificationType,
  DaemonUpdateCronRequestSchema,
  LOCAL_MACHINE_ID,
  MachineType,
  McpSuccessResultSchema,
} from '@industry/common/daemon';
import { SESSION_TAG_SUBAGENT } from '@industry/common/session';
import { MarketplaceSource } from '@industry/common/settings';
import {
  InProcessDaemonMethodNotFoundError,
  type DaemonClient,
  type IDaemonClient,
} from '@industry/daemon-client';
import {
  createAutomation,
  getHistory,
  getPersistedLocalAutomationHistory,
  listAutomations,
  pauseAutomation,
  resumeAutomation,
} from '@industry/daemon-core/automations';
import { CronRegistry, CronRuntime } from '@industry/daemon-core/crons';
import { DroolRegistry } from '@industry/daemon-core/drool-registry';
import {
  createInternalErrorResponse,
  createMethodNotFoundResponse,
  parseEnvelope,
} from '@industry/daemon-core/envelope-helpers';
import { shouldForwardNotificationToFilteredListener } from '@industry/daemon-core/notification-forwarding';
import {
  DroolClient,
  DroolClientEvent,
  ProcessTransport,
} from '@industry/drool-sdk';
import {
  AgentTurnCompletionReason,
  CliRequestOrNotificationSchema,
  INDUSTRY_PROTOCOL_VERSION,
  InitializeSessionResultSchema,
  LEGACY_INDUSTRY_API_VERSION,
  JSONRPC_VERSION,
  LoadSessionResultSchema,
  DroolClientMethod,
  SessionNotificationType,
  DroolErrorType,
  DecompSessionType,
  DroolWorkingState,
  type LoadSessionResult,
  type SessionNotification,
  type SessionNotificationEvent,
} from '@industry/drool-sdk-ext/protocol/drool';
import { type SessionTag } from '@industry/drool-sdk-ext/protocol/session';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import {
  JsonRpcErrorCode,
  type JsonRpcBaseRequest,
  type JsonRpcBaseResponse,
  type JsonRpcError,
} from '@industry/drool-sdk-ext/protocol/shared';
import {
  EnvironmentVariable,
  IndustryEnv,
  resolveEnvAsPositiveInt,
} from '@industry/environment';
import { logException, logInfo, logWarn } from '@industry/logging';
import { AuthenticationError, MetaError } from '@industry/logging/errors';
import {
  type Attributes,
  deriveSessionAttributionFromPlatform,
  OtelTracing,
  SessionOrigin,
  SpanAttribute,
  SpanName,
} from '@industry/logging/tracing';
import { getAuthedUser } from '@industry/runtime/auth';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { getSubagentCallingMetadata } from '@industry/utils/session';

import { getRuntimeAuthConfig, getEnv } from '@/environment';
import { InProcessDaemonDispatcher } from '@/services/daemon/InProcessDaemonDispatcher';
import { IpcConnection } from '@/services/daemon/IpcConnection';
import { isProcessExitNotification } from '@/services/daemon/processExitNotifications';
import {
  getDecompSessionTypeFromTags,
  upsertMissionSessionTag,
} from '@/services/mission/sessionTags';
import { getSessionService } from '@/services/SessionService';
import { getEnabledQueuePlacement } from '@/utils/queuedMessagesFeatureFlag';

import type { DaemonUser } from '@industry/daemon-core/server-types';
import type {
  IpcDisconnectListener,
  IpcMessageListener,
} from '@industry/drool-sdk-ext/protocol/node';
import type { ChildProcess } from 'child_process';

// industry.client.surface lives on the resource (set by initCliTracing),
// so only machine context needs to be stamped per-span.
const TUI_MACHINE_ATTRIBUTES: Attributes = {
  [SpanAttribute.INDUSTRY_MACHINE_TYPE]: MachineType.Local,
};

const connectionId = uuidv4();

interface CronPromptWaiter {
  cronId: string;
  sessionId: string;
  hasCreatedMessage: boolean;
  resolve: () => void;
}

/**
 * In-process daemon client for TUI mode.
 *
 * Instead of connecting to an external daemon process over WebSocket,
 * this client manages DroolClient+ProcessTransport instances directly
 * in the TUI process. Notifications, permission requests, and ask-user
 * requests are synthesized as JSON-RPC messages and pushed through the
 * onMessage handler so DaemonSessionController's MessageRouter can
 * process them identically to the WebSocket path.
 */

enum ChildProcessIpcEvent {
  Disconnect = 'disconnect',
  Exit = 'exit',
  Message = 'message',
}

type ChildProcessIpcListener = IpcMessageListener | IpcDisconnectListener;

function removeChildProcessListener(
  childProcess: ChildProcess,
  event: ChildProcessIpcEvent,
  listener: ChildProcessIpcListener
): void {
  if (typeof childProcess.off === 'function') {
    childProcess.off(event, listener);
    return;
  }
  childProcess.removeListener?.(event, listener);
}

interface PendingElicitationRequest {
  subagentSessionId?: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface SubagentCallingMetadata {
  callingSessionId: string;
  callingToolUseId: string;
}

function getCompleteSubagentCallingMetadata(
  tags: SessionTag[] | undefined
): SubagentCallingMetadata | undefined {
  const { callingSessionId, callingToolUseId } =
    getSubagentCallingMetadata(tags);
  if (
    typeof callingSessionId !== 'string' ||
    callingSessionId.length === 0 ||
    typeof callingToolUseId !== 'string' ||
    callingToolUseId.length === 0
  ) {
    return undefined;
  }

  return { callingSessionId, callingToolUseId };
}

function isSessionTagArray(value: unknown): value is SessionTag[] {
  return Array.isArray(value);
}

export class InProcessDaemonRuntime {
  private messageHandler: ((data: string) => void) | null = null;

  private openHandler: (() => void) | null = null;

  private closeHandler: ((code: number, reason: string) => void) | null = null;

  private errorHandler: ((error: Error) => void) | null = null;

  private pendingSessionReady = new Map<string, Promise<unknown>>();

  private pendingInitializeResults = new Map<
    string,
    ReturnType<DaemonClient['initializeSession']>
  >();

  private pendingLoadResults = new Map<
    string,
    ReturnType<DaemonClient['loadSession']>
  >();

  private readonly dispatcher = new InProcessDaemonDispatcher(this);

  // Keyed by requestId. A single requestId can have multiple in-flight entries
  // when a parent worker relays a subagent's permission/ask-user request using
  // the same requestId; entries are stored as a list and resolved by the
  // responding session id so the relay never overwrites the subagent's entry.
  private pendingPermissions = new Map<string, PendingElicitationRequest[]>();

  private pendingAskUsers = new Map<string, PendingElicitationRequest[]>();

  private beforeRequest:
    | ((sessionId: string, method: string) => Promise<void>)
    | null = null;

  private connected = false;

  private isDevelopment: boolean;

  private readonly cronRegistry: CronRegistry;

  private readonly cronRuntime: CronRuntime;

  private readonly cronPromptWaiters = new Map<string, CronPromptWaiter>();

  private readonly droolRegistry = new DroolRegistry(
    LOCAL_MACHINE_ID,
    undefined,
    {
      sessionTimeoutMsOverride: resolveEnvAsPositiveInt({
        name: EnvironmentVariable.OVERRIDE_DROOL_SESSION_TIMEOUT_MS,
      }),
    }
  );

  private tuiConnection: IpcConnection | null = null;

  constructor() {
    const environment = getEnv().env;
    this.isDevelopment = environment === IndustryEnv.Development;
    this.cronRegistry = new CronRegistry({
      cronsDir: path.join(
        getEnv().extras.homeDir,
        getIndustryDirName(),
        'crons'
      ),
      onChange: (event) => this.pushCronStateChanged(event),
    });
    this.cronRuntime = new CronRuntime({
      registry: this.cronRegistry,
      onSessionPrompt: async (cron) => this.runCronSessionPrompt(cron),
      onRootPrompt: async (cron) => this.runCronRootPrompt(cron),
      canRegister: (cron) =>
        cron.scope.type === 'session' || this.tuiConnection !== null,
    });
    this.cronRuntime.start();
  }

  private async runCronSessionPrompt(cron: CronRecord): Promise<void> {
    if (cron.kind !== 'session_prompt' || cron.scope.type !== 'session') {
      throw new MetaError('Session cron requires session scope', {
        value: cron.id,
      });
    }

    let client: DroolClient;
    try {
      client = await this.getClientOrThrow(cron.scope.sessionId);
    } catch {
      this.holdCron(cron.id, 'session-inactive');
      return;
    }

    const requestId = uuidv4();
    await new Promise<void>((resolve, reject) => {
      this.cronPromptWaiters.set(requestId, {
        cronId: cron.id,
        sessionId: cron.scope.sessionId,
        hasCreatedMessage: false,
        resolve,
      });
      void client
        .addUserMessage({ text: cron.payload.prompt }, requestId)
        .catch((error) => {
          this.cronPromptWaiters.delete(requestId);
          reject(error);
        });
    });
  }

  private async runCronRootPrompt(cron: CronRecord): Promise<void> {
    if (
      cron.kind !== 'root_prompt' ||
      cron.payload.target.type !== 'new_session'
    ) {
      throw new MetaError('Root cron requires new-session prompt target', {
        value: cron.id,
      });
    }

    const ownerConnection = this.tuiConnection;
    if (!ownerConnection) {
      this.markCronDispatchDeferred(cron, 'tui-unavailable');
      return;
    }

    const requestedSessionId = uuidv4();
    const cwd = cron.payload.target.cwd ?? process.cwd();
    const result = await this.createAndRegisterClient({
      ownerConnection,
      transportConfig: {
        cwd,
        isDevelopment: this.isDevelopment,
        droolExecExtraArgs: ['--auto', 'high'],
        enableIpc: true,
      },
      invoke: (client) =>
        client.initializeSession({
          machineId: LOCAL_MACHINE_ID,
          sessionId: requestedSessionId,
          cwd,
          modelId: cron.payload.modelId,
          reasoningEffort: cron.payload.reasoningEffort,
          title: cron.payload.target.title,
          tags: [
            {
              name: 'cron',
              metadata: {
                cronId: cron.id,
                type: 'new_session',
              },
            },
          ],
        }),
      parseResult: (rawResult) =>
        InitializeSessionResultSchema.parse(rawResult),
      getSessionId: (parsedResult) => parsedResult.sessionId,
      getHostId: (parsedResult) => parsedResult.hostId,
      errorMessage: 'Failed to initialize cron session',
    });

    const client = this.droolRegistry.getDroolClient(result.sessionId);
    if (!client) {
      throw new MetaError('Cron session client not found', {
        sessionId: result.sessionId,
      });
    }

    const stopWatchingIdle = this.unregisterRootCronSessionWhenIdle(
      client,
      result.sessionId
    );
    try {
      const addMessageResponse = await client.addUserMessage({
        text: cron.payload.prompt,
      });
      if (addMessageResponse.error) {
        throw new MetaError('Failed to dispatch cron prompt', {
          code: addMessageResponse.error.code,
          message: addMessageResponse.error.message,
        });
      }
    } catch (error) {
      stopWatchingIdle();
      await this.unregisterRootCronSessionAfterDispatchFailure(
        result.sessionId
      );
      throw error;
    }
  }

  private async unregisterRootCronSessionAfterDispatchFailure(
    sessionId: string
  ): Promise<void> {
    try {
      await this.droolRegistry.unregisterDroolClient(sessionId);
    } catch (error) {
      logException(
        error,
        '[InProcessDaemonRuntime] Failed to clean up failed cron session',
        { sessionId }
      );
    }
  }

  private markCronDispatchDeferred(cron: CronRecord, lastError: string): void {
    const latest = this.cronRegistry.getCron(cron.id) ?? cron;
    this.cronRegistry.updateCron(cron.id, {
      status: 'active',
      stats: {
        ...latest.stats,
        lastError,
      },
    });
    this.cronRuntime.sync();
  }

  private unregisterRootCronSessionWhenIdle(
    client: DroolClient,
    sessionId: string
  ): () => void {
    let hasSeenNonIdle = false;
    const idleWatcher = (event: SessionNotificationEvent) => {
      const { notification } = event.params;
      if (
        notification.type !==
        SessionNotificationType.DROOL_WORKING_STATE_CHANGED
      ) {
        return;
      }
      if (notification.newState !== DroolWorkingState.Idle) {
        hasSeenNonIdle = true;
        return;
      }
      if (!hasSeenNonIdle) {
        return;
      }
      client.off(DroolClientEvent.SESSION_NOTIFICATION, idleWatcher);
      setImmediate(() => {
        void this.droolRegistry.unregisterDroolClient(sessionId);
      });
    };
    client.on(DroolClientEvent.SESSION_NOTIFICATION, idleWatcher);
    return () => {
      client.off(DroolClientEvent.SESSION_NOTIFICATION, idleWatcher);
    };
  }

  private holdCron(cronId: string, reason: string): void {
    this.cronRegistry.updateCron(cronId, {
      status: 'held',
      heldAt: new Date().toISOString(),
      holdReason: reason,
    });
    this.cronRuntime.sync();
  }

  private holdPendingCronPromptsForSession(
    sessionId: string,
    reason: string
  ): void {
    for (const [requestId, waiter] of this.cronPromptWaiters) {
      if (waiter.sessionId !== sessionId) {
        continue;
      }
      this.cronPromptWaiters.delete(requestId);
      this.holdCron(waiter.cronId, reason);
      waiter.resolve();
    }
  }

  private handleCronPromptNotification(
    sessionId: string,
    notification: SessionNotification
  ): void {
    if (
      notification.type === SessionNotificationType.CREATE_MESSAGE &&
      notification.requestId
    ) {
      const waiter = this.cronPromptWaiters.get(notification.requestId);
      if (waiter?.sessionId === sessionId) {
        waiter.hasCreatedMessage = true;
      }
      return;
    }

    if (notification.type !== SessionNotificationType.AGENT_TURN_COMPLETED) {
      return;
    }

    for (const [requestId, waiter] of this.cronPromptWaiters) {
      if (waiter.sessionId !== sessionId || !waiter.hasCreatedMessage) {
        continue;
      }
      this.cronPromptWaiters.delete(requestId);
      waiter.resolve();
    }
  }

  /** Mirror of DaemonClient.sendRequest on the in-process TUI path. */
  private traceRpc<T>(
    method: string,
    sessionId: string | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    // No rpc.request_id: in-process spans have no cross-process
    // counterpart, so a synthesized UUID would be misleading.
    return OtelTracing.trace(SpanName.CLI_RPC_REQUEST, fn, {
      attributes: {
        [SpanAttribute.RPC_METHOD]: method,
        ...TUI_MACHINE_ATTRIBUTES,
        ...(sessionId && { [SpanAttribute.SESSION_ID]: sessionId }),
      },
    });
  }

  /** Mirror of web.receive_* spans for synthesized inbound TUI events. */
  private traceReceive(
    spanName:
      | typeof SpanName.CLI_RECEIVE_NOTIFICATION
      | typeof SpanName.CLI_RECEIVE_PERMISSION_REQUEST
      | typeof SpanName.CLI_RECEIVE_ASK_USER_REQUEST,
    sessionId: string,
    extraAttrs: Attributes,
    push: () => void
  ): void {
    OtelTracing.trace(spanName, push, {
      attributes: {
        [SpanAttribute.SESSION_ID]: sessionId,
        ...TUI_MACHINE_ATTRIBUTES,
        ...extraAttrs,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  async connect(_url: string): Promise<void> {
    this.connected = true;
    // Fire open handler asynchronously to match WebSocket behavior
    if (this.openHandler) {
      const handler = this.openHandler;
      queueMicrotask(() => handler());
    }
  }

  disconnect(): void {
    this.connected = false;
    void this.destroyAllSessions();
    if (this.closeHandler) {
      this.closeHandler(1000, 'Client disconnect');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getTracingMetadata(): {
    machineType?: string;
    machineProvider?: string;
    daemonTransport?: string;
  } {
    return { machineType: MachineType.Local };
  }

  getClientSurface(): undefined {
    return undefined;
  }

  getConnectionId(): string | null {
    return this.connected ? connectionId : null;
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  setBeforeRequest(
    hook: (sessionId: string, method: string) => Promise<void>
  ): void {
    this.beforeRequest = hook;
  }

  private async runBeforeRequest(
    sessionId: string,
    method: string
  ): Promise<void> {
    if (this.beforeRequest) {
      await this.beforeRequest(sessionId, method);
    }
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onConnectionOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  onConnectionClose(handler: (code: number, reason: string) => void): void {
    this.closeHandler = handler;
  }

  onConnectionError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  async handleRequest(request: JsonRpcBaseRequest): Promise<unknown> {
    return this.dispatcher.handleRequest(request);
  }

  async handleMessage(message: string): Promise<void> {
    const parsed = parseEnvelope(message);

    if (parsed.kind === 'parse_error') {
      this.pushMessage(JSON.stringify(this.withEnvelope(parsed.response)));
      return;
    }

    if (parsed.kind === 'response') {
      this.handleIpcResponse(parsed.response.id, parsed.response);
      return;
    }

    if (parsed.kind === 'notification') {
      return;
    }

    const { request } = parsed;

    try {
      const result = await this.dispatcher.handleRequest(request);
      this.pushMessage(
        JSON.stringify(
          this.withEnvelope({
            type: 'response',
            id: request.id,
            result,
          })
        )
      );
    } catch (error) {
      logException(error, '[InProcessDaemonRuntime] Handler threw', {
        method: request.method,
        requestId: request.id,
      });
      this.pushMessage(
        JSON.stringify(
          this.withEnvelope({
            type: 'response',
            id: request.id,
            error: InProcessDaemonRuntime.getJsonRpcError(error),
          })
        )
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  async authenticate(params: Parameters<DaemonClient['authenticate']>[0]) {
    const authedUser = await getAuthedUser(getRuntimeAuthConfig());
    if (!authedUser?.orgId) {
      throw new AuthenticationError(
        'Authentication failed. Please log in using /provider or configure a provider.',
        {
          code: JsonRpcErrorCode.AUTHENTICATION_ERROR,
          reason: 'missing_authed_user_or_org',
          value: {
            hasToken: !!params.token,
            hasApiKey: !!params.apiKey,
          },
        }
      );
    }

    if (!params.token && !params.apiKey) {
      throw new MetaError('No authentication provided', {
        code: JsonRpcErrorCode.AUTHENTICATION_ERROR,
        reason: 'missing_connection_credential',
      });
    }

    const user: DaemonUser = params.apiKey
      ? {
          userId: authedUser.userId,
          orgId: authedUser.orgId,
          apiKey: params.apiKey,
        }
      : {
          userId: authedUser.userId,
          orgId: authedUser.orgId,
          token: params.token!,
        };

    this.tuiConnection = new IpcConnection({
      user,
      connectionId: `in-process-tui-${connectionId}`,
      caller: params.caller,
      tracingMetadata: params.metadata?.tracing,
      sendMessage: (message) => {
        this.pushMessage(message);
      },
      isOpen: () => this.connected,
    });
    this.cronRuntime.sync();

    return {
      userId: user.userId,
      orgId: user.orgId,
    } as Awaited<ReturnType<DaemonClient['authenticate']>>;
  }

  async logout(): ReturnType<DaemonClient['logout']> {
    this.tuiConnection = null;
    this.cronRuntime.sync();
    return { accepted: true } as Awaited<ReturnType<DaemonClient['logout']>>;
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  async initializeSession(
    params: Parameters<DaemonClient['initializeSession']>[0],
    _options?: Parameters<DaemonClient['initializeSession']>[1]
  ): ReturnType<DaemonClient['initializeSession']> {
    return this.initializeSessionInternal(params);
  }

  async initializeSessionFromConnection(
    params: Parameters<DaemonClient['initializeSession']>[0],
    connection: IpcConnection
  ): ReturnType<DaemonClient['initializeSession']> {
    return this.initializeSessionInternal(params, connection);
  }

  private initializeSessionInternal(
    params: Parameters<DaemonClient['initializeSession']>[0],
    connection?: IpcConnection
  ): ReturnType<DaemonClient['initializeSession']> {
    const ownerConnection = connection ?? this.getTuiConnectionOrThrow();
    if (params.sessionId) {
      const pendingResult = this.pendingInitializeResults.get(params.sessionId);
      if (pendingResult) {
        return pendingResult.then(async (result) => {
          const added = await this.droolRegistry.addConnectionToSession(
            params.sessionId!,
            ownerConnection
          );
          if (!added) {
            throw new MetaError('Failed to associate session with connection', {
              sessionId: params.sessionId,
            });
          }
          this.emitChildSessionAvailableIfApplicable(
            params.sessionId!,
            ownerConnection,
            getCompleteSubagentCallingMetadata(result.settings.tags)
              ?.callingToolUseId
          );
          return result;
        });
      }
    }

    if (params.sessionId) {
      const resultPromise = this.doInitializeSession(params, ownerConnection);
      this.pendingInitializeResults.set(params.sessionId, resultPromise);
      void resultPromise
        .finally(() => {
          this.pendingInitializeResults.delete(params.sessionId!);
        })
        .catch(() => {
          // Rejection is handled by the caller via the original promise
        });
      return resultPromise;
    }

    return this.traceRpc(
      DaemonDroolMethod.INITIALIZE_SESSION,
      params.sessionId,
      () => this.doInitializeSession(params, ownerConnection)
    );
  }

  private async doInitializeSession(
    params: Parameters<DaemonClient['initializeSession']>[0],
    ownerConnection: IpcConnection
  ): ReturnType<DaemonClient['initializeSession']> {
    await this.runBeforeRequest(
      params.sessionId ?? 'new-session',
      DaemonDroolMethod.INITIALIZE_SESSION
    );

    const droolExecExtraArgs = params.skipPermissionsUnsafe
      ? ['--skip-permissions-unsafe']
      : [];
    const missionId =
      params.decompSessionType === DecompSessionType.Orchestrator
        ? (params.decompMissionId ?? params.sessionId)
        : params.decompMissionId;
    const tags =
      params.decompSessionType !== undefined && missionId !== undefined
        ? upsertMissionSessionTag(params.tags, {
            role: params.decompSessionType,
            missionId,
          })
        : params.tags;
    const decompSessionType = getDecompSessionTypeFromTags(tags);
    const sessionOriginHint: SessionOrigin | undefined =
      decompSessionType === DecompSessionType.Worker
        ? undefined
        : params.sessionSource?.platform
          ? deriveSessionAttributionFromPlatform(params.sessionSource.platform)
              .sessionOrigin
          : SessionOrigin.CliTui;

    return this.createAndRegisterClient({
      ownerConnection,
      transportConfig: {
        cwd: params.cwd,
        isDevelopment: this.isDevelopment,
        droolExecExtraArgs,
        enableIpc: true,
        env: params.runtimeSettingsPath
          ? {
              [EnvironmentVariable.INDUSTRY_RUNTIME_SETTINGS_PATH]:
                params.runtimeSettingsPath,
            }
          : undefined,
      },
      invoke: (client) =>
        client.initializeSession({
          machineId: params.machineId ?? LOCAL_MACHINE_ID,
          sessionId: params.sessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers,
          autonomyMode: params.autonomyMode,
          interactionMode: params.interactionMode,
          autonomyLevel: params.autonomyLevel,
          modelId: params.modelId,
          reasoningEffort: params.reasoningEffort,
          systemPromptOverride: params.systemPromptOverride,
          specModeModelId: params.specModeModelId,
          specModeReasoningEffort: params.specModeReasoningEffort,
          missionSettings: params.missionSettings,
          compactionThresholdCheckEnabled:
            params.compactionThresholdCheckEnabled,
          sessionLocation: params.sessionLocation,
          sessionSource: params.sessionSource,
          sessionOriginHint,
          tags,
          ...(params.privacyLevel ? { privacyLevel: params.privacyLevel } : {}),
          title: params.title,
          enabledToolIds: params.enabledToolIds,
          disabledToolIds: params.disabledToolIds,
          mcpOAuthCallbackUri: params.mcpOAuthCallbackUri,
        }),
      parseResult: (rawResult) =>
        InitializeSessionResultSchema.parse(rawResult),
      getSessionId: (parsedResult) => parsedResult.sessionId,
      getHostId: (parsedResult) => parsedResult.hostId,
      isExpectedProcessExit: () =>
        tags?.some((tag) => tag.name === SESSION_TAG_SUBAGENT) ?? false,
      getClientRegistrationState: () => ({
        cwd: params.cwd,
        tags,
        ...(getCompleteSubagentCallingMetadata(tags) ?? {}),
      }),
      errorMessage: 'Failed to initialize session',
      inactivityTimeoutMs: params.inactivityTimeoutMs,
      disableInactivityTimeout: params.disableInactivityTimeout,
      runtimeSettingsPath: params.runtimeSettingsPath,
    });
  }

  async loadSession(
    params: Parameters<DaemonClient['loadSession']>[0]
  ): ReturnType<DaemonClient['loadSession']> {
    await this.runBeforeRequest(
      params.sessionId,
      DaemonDroolMethod.LOAD_SESSION
    );
    return this.traceRpc(
      DaemonDroolMethod.LOAD_SESSION,
      params.sessionId,
      async () => this.loadSessionInternal(params)
    );
  }

  async loadSessionFromConnection(
    params: Parameters<DaemonClient['loadSession']>[0],
    connection: IpcConnection
  ): ReturnType<DaemonClient['loadSession']> {
    return this.loadSessionInternal(params, connection);
  }

  private async loadSessionInternal(
    params: Parameters<DaemonClient['loadSession']>[0],
    ownerConnection?: IpcConnection
  ): ReturnType<DaemonClient['loadSession']> {
    const activeConnection = ownerConnection ?? this.getTuiConnectionOrThrow();
    const sessionId = params.sessionId;

    // Check if we already have a client for this session
    const existing = this.droolRegistry.getDroolClient(sessionId);
    if (existing?.isConnected) {
      const response = await existing.loadSession({
        sessionId: params.sessionId,
        mcpServers: params.mcpServers,
        loadAllMessages: params.loadAllMessages,
        mcpOAuthCallbackUri: params.mcpOAuthCallbackUri,
        sessionOriginHint: params.sessionOriginHint ?? SessionOrigin.CliTui,
      });
      if (response.error) {
        throw new MetaError('Failed to load session', {
          code: response.error.code,
          message: response.error.message,
        });
      }
      const added = await this.droolRegistry.addConnectionToSession(
        sessionId,
        activeConnection
      );
      if (!added) {
        throw new MetaError('Failed to associate session with connection', {
          sessionId,
        });
      }
      const result = LoadSessionResultSchema.parse(response.result);
      this.emitChildSessionAvailableIfApplicable(
        sessionId,
        activeConnection,
        InProcessDaemonRuntime.getChildSessionToolUseId(result)
      );
      return result;
    }

    if (existing) {
      await this.droolRegistry.unregisterDroolClient(sessionId);
    }

    const pendingResult = this.pendingLoadResults.get(sessionId);
    if (pendingResult) {
      return pendingResult.then(async (result) => {
        const added = await this.droolRegistry.addConnectionToSession(
          sessionId,
          activeConnection
        );
        if (!added) {
          throw new MetaError('Failed to associate session with connection', {
            sessionId,
          });
        }
        this.emitChildSessionAvailableIfApplicable(
          sessionId,
          activeConnection,
          InProcessDaemonRuntime.getChildSessionToolUseId(result)
        );
        return result;
      });
    }

    const resultPromise = this.doLoadSession(params, activeConnection);
    this.pendingLoadResults.set(sessionId, resultPromise);

    try {
      return await resultPromise;
    } finally {
      this.pendingLoadResults.delete(sessionId);
    }
  }

  private async doLoadSession(
    params: Parameters<DaemonClient['loadSession']>[0],
    ownerConnection: IpcConnection
  ): ReturnType<DaemonClient['loadSession']> {
    return this.createAndRegisterClient({
      ownerConnection,
      transportConfig: {
        isDevelopment: this.isDevelopment,
        droolExecExtraArgs: params.skipPermissionsUnsafe
          ? ['--skip-permissions-unsafe']
          : [],
        enableIpc: true,
        env: params.runtimeSettingsPath
          ? {
              [EnvironmentVariable.INDUSTRY_RUNTIME_SETTINGS_PATH]:
                params.runtimeSettingsPath,
            }
          : undefined,
      },
      invoke: (client) =>
        client.loadSession({
          sessionId: params.sessionId,
          mcpServers: params.mcpServers,
          loadAllMessages: params.loadAllMessages,
          mcpOAuthCallbackUri: params.mcpOAuthCallbackUri,
          sessionOriginHint: params.sessionOriginHint ?? SessionOrigin.CliTui,
        }),
      parseResult: (result): LoadSessionResult =>
        LoadSessionResultSchema.parse(result),
      getSessionId: () => params.sessionId,
      getHostId: (result) => result.hostId,
      isExpectedProcessExit: (result) =>
        result.settings.tags?.some(
          (tag) => tag.name === SESSION_TAG_SUBAGENT
        ) ?? false,
      getClientRegistrationState: (result) => {
        const tagMetadata = getCompleteSubagentCallingMetadata(
          result.settings.tags
        );
        return {
          tags: result.settings.tags,
          callingSessionId:
            result.callingSessionId ?? tagMetadata?.callingSessionId,
          callingToolUseId:
            result.callingToolUseId ?? tagMetadata?.callingToolUseId,
        };
      },
      errorMessage: 'Failed to load session',
      disableInactivityTimeout: params.disableInactivityTimeout,
      runtimeSettingsPath: params.runtimeSettingsPath,
    });
  }

  async addUserMessage(
    params: Parameters<DaemonClient['addUserMessage']>[0],
    requestId?: string
  ): ReturnType<DaemonClient['addUserMessage']> {
    return this.traceRpc(
      DaemonDroolMethod.ADD_USER_MESSAGE,
      params.sessionId,
      () => this.doAddUserMessage(params, requestId)
    );
  }

  private async doAddUserMessage(
    params: Parameters<DaemonClient['addUserMessage']>[0],
    requestId?: string
  ): ReturnType<DaemonClient['addUserMessage']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const enabledQueuePlacement = getEnabledQueuePlacement(
      params.queuePlacement
    );
    const response = await client.addUserMessage(
      {
        text: params.text,
        images: params.images,
        files: params.files,
        skipAgentLoop: params.skipAgentLoop,
        ...(enabledQueuePlacement && { queuePlacement: enabledQueuePlacement }),
        userMessageSource: params.userMessageSource,
        ...(params.role && { role: params.role }),
        ...(params.visibility && { visibility: params.visibility }),
      },
      requestId
    );
    if (response.error) {
      throw new MetaError('Failed to add user message', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result!;
  }

  async resolveQueuedUserMessage(
    params: Parameters<DaemonClient['resolveQueuedUserMessage']>[0]
  ): ReturnType<DaemonClient['resolveQueuedUserMessage']> {
    return this.traceRpc(
      DaemonDroolMethod.RESOLVE_QUEUED_USER_MESSAGE,
      params.sessionId,
      () => this.doResolveQueuedUserMessage(params)
    );
  }

  private async doResolveQueuedUserMessage(
    params: Parameters<DaemonClient['resolveQueuedUserMessage']>[0]
  ): ReturnType<DaemonClient['resolveQueuedUserMessage']> {
    const { sessionId, ...resolveParams } = params;
    const client = await this.getClientOrThrow(sessionId);
    const response = await client.resolveQueuedUserMessage(resolveParams);
    if (response.error) {
      throw new MetaError('Failed to resolve queued user message', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result!;
  }

  async interruptSession(
    params: Parameters<DaemonClient['interruptSession']>[0]
  ): ReturnType<DaemonClient['interruptSession']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.interruptSession(params);
    if (response.error) {
      await this.droolRegistry.unregisterDroolClient(params.sessionId);
      this.emitNotification(params.sessionId, {
        type: SessionNotificationType.AGENT_TURN_COMPLETED,
        reason: AgentTurnCompletionReason.Cancelled,
      });
      this.emitNotification(params.sessionId, {
        type: SessionNotificationType.DROOL_WORKING_STATE_CHANGED,
        newState: DroolWorkingState.Idle,
      });
      return {};
    }
    return response.result!;
  }

  async closeSession(
    params: Parameters<DaemonClient['closeSession']>[0]
  ): ReturnType<DaemonClient['closeSession']> {
    return this.traceRpc(
      DaemonDroolMethod.CLOSE_SESSION,
      params.sessionId,
      async () => {
        this.holdPendingCronPromptsForSession(
          params.sessionId,
          'session-closed'
        );
        this.cronRegistry.holdSessionCrons(params.sessionId, 'session-closed');
        this.cronRuntime.sync();
        const removed = await this.droolRegistry.unregisterDroolClient(
          params.sessionId
        );
        if (removed) {
          this.emitNotification(params.sessionId, {
            type: DaemonSpecificNotificationType.SESSION_CLOSED,
            timestamp: Date.now(),
          });
        }
        return { success: true } as Awaited<
          ReturnType<DaemonClient['closeSession']>
        >;
      }
    );
  }

  async killWorkerSession(
    params: Parameters<DaemonClient['killWorkerSession']>[0]
  ): ReturnType<DaemonClient['killWorkerSession']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.killWorkerSession(params);
    if (response.error) {
      throw new MetaError('Failed to kill worker session', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result!;
  }

  async updateSessionSettings(
    params: Parameters<DaemonClient['updateSessionSettings']>[0],
    requestId?: string
  ): ReturnType<DaemonClient['updateSessionSettings']> {
    const { sessionId, ...updates } = params;
    const client = await this.getClientOrThrow(sessionId);
    const response = await client.updateSessionSettings(updates, requestId);
    if (response.error) {
      throw new MetaError('Failed to update session settings', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result!;
  }

  // ---------------------------------------------------------------------------
  // MCP methods
  // ---------------------------------------------------------------------------

  async toggleMcpServer(
    params: Parameters<DaemonClient['toggleMcpServer']>[0]
  ): ReturnType<DaemonClient['toggleMcpServer']> {
    const client = await this.getClientOrThrow(params.sessionId);
    await client.toggleMcpServer({
      serverName: params.serverName,
      enabled: params.enabled,
      settingsLevel: params.settingsLevel,
    });
    return { success: true };
  }

  async authenticateMcpServer(
    params: Parameters<DaemonClient['authenticateMcpServer']>[0]
  ): ReturnType<DaemonClient['authenticateMcpServer']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.authenticateMcpServer({
      serverName: params.serverName,
    });
    if (response.error) {
      throw new MetaError('Failed to authenticate MCP server', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return McpSuccessResultSchema.parse(response.result);
  }

  async clearMcpAuth(
    params: Parameters<DaemonClient['clearMcpAuth']>[0]
  ): ReturnType<DaemonClient['clearMcpAuth']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.clearMcpAuth({
      serverName: params.serverName,
    });
    if (response.error) {
      throw new MetaError('Failed to clear MCP authentication', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return McpSuccessResultSchema.parse(response.result);
  }

  async cancelMcpAuth(
    params: Parameters<DaemonClient['cancelMcpAuth']>[0]
  ): ReturnType<DaemonClient['cancelMcpAuth']> {
    const client = await this.getClientOrThrow(params.sessionId);
    await client.cancelMcpAuth({ serverName: params.serverName });
    return { success: true };
  }

  async addMcpServer(
    params: Parameters<DaemonClient['addMcpServer']>[0]
  ): ReturnType<DaemonClient['addMcpServer']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.addMcpServer({
      name: params.name,
      type: params.type,
      url: params.url,
      headers: params.headers,
      oauth: params.oauth,
      command: params.command,
      args: params.args,
      env: params.env,
    });
    if (response.error) {
      throw new MetaError('Failed to add MCP server', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return McpSuccessResultSchema.parse(response.result);
  }

  async removeMcpServer(
    params: Parameters<DaemonClient['removeMcpServer']>[0]
  ): ReturnType<DaemonClient['removeMcpServer']> {
    const client = await this.getClientOrThrow(params.sessionId);
    await client.removeMcpServer({
      serverName: params.serverName,
      settingsLevel: params.settingsLevel,
    });
    return { success: true };
  }

  async listMcpRegistry(
    params: Parameters<DaemonClient['listMcpRegistry']>[0]
  ): ReturnType<DaemonClient['listMcpRegistry']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.listMcpRegistry();
    if (response.error) {
      throw new MetaError('Failed to list MCP registry', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result as Awaited<
      ReturnType<DaemonClient['listMcpRegistry']>
    >;
  }

  async listMcpTools(
    params: Parameters<DaemonClient['listMcpTools']>[0]
  ): ReturnType<DaemonClient['listMcpTools']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.listMcpTools();
    if (response.error) {
      throw new MetaError('Failed to list MCP tools', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result as Awaited<ReturnType<DaemonClient['listMcpTools']>>;
  }

  async listMcpServers(
    params: Parameters<DaemonClient['listMcpServers']>[0]
  ): ReturnType<DaemonClient['listMcpServers']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.listMcpServers();
    if (response.error) {
      throw new MetaError('Failed to list MCP servers', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result as Awaited<
      ReturnType<DaemonClient['listMcpServers']>
    >;
  }

  async toggleMcpTool(
    params: Parameters<DaemonClient['toggleMcpTool']>[0]
  ): ReturnType<DaemonClient['toggleMcpTool']> {
    const client = await this.getClientOrThrow(params.sessionId);
    await client.toggleMcpTool(
      params.serverName,
      params.toolName,
      params.enabled
    );
    return { success: true };
  }

  async submitMcpAuthCode(
    params: Parameters<DaemonClient['submitMcpAuthCode']>[0]
  ): ReturnType<DaemonClient['submitMcpAuthCode']> {
    const client = await this.getClientOrThrow(params.sessionId);
    await client.submitMcpAuthCode(params);
    return { success: true };
  }

  async submitMcpAuthError(
    params: Parameters<DaemonClient['submitMcpAuthError']>[0]
  ): ReturnType<DaemonClient['submitMcpAuthError']> {
    const client = await this.getClientOrThrow(params.sessionId);
    await client.submitMcpAuthError(params);
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Rewind / Compact / Fork
  // ---------------------------------------------------------------------------

  async getRewindInfo(
    params: Parameters<DaemonClient['getRewindInfo']>[0]
  ): ReturnType<DaemonClient['getRewindInfo']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.getRewindInfo({
      messageId: params.messageId,
    });
    if (response.error) {
      throw new MetaError('Failed to get rewind info', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result as Awaited<
      ReturnType<DaemonClient['getRewindInfo']>
    >;
  }

  async executeRewind(
    params: Parameters<DaemonClient['executeRewind']>[0]
  ): ReturnType<DaemonClient['executeRewind']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.executeRewind({
      messageId: params.messageId,
      filesToRestore: params.filesToRestore,
      filesToDelete: params.filesToDelete,
      forkTitle: params.forkTitle,
    });
    if (response.error) {
      throw new MetaError('Failed to execute rewind', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result as Awaited<
      ReturnType<DaemonClient['executeRewind']>
    >;
  }

  async compactSession(
    params: Parameters<DaemonClient['compactSession']>[0]
  ): ReturnType<DaemonClient['compactSession']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.compactSession({
      customInstructions: params.customInstructions,
    });
    if (response.error) {
      throw new MetaError('Failed to compact session', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result as Awaited<
      ReturnType<DaemonClient['compactSession']>
    >;
  }

  async forkSession(
    params: Parameters<DaemonClient['forkSession']>[0]
  ): ReturnType<DaemonClient['forkSession']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.forkSession({
      title: params.title,
      tags: params.tags,
    });
    if (response.error) {
      throw new MetaError('Failed to fork session', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result as Awaited<ReturnType<DaemonClient['forkSession']>>;
  }

  async warmupCache(
    _params: Parameters<DaemonClient['warmupCache']>[0]
  ): ReturnType<DaemonClient['warmupCache']> {
    return {} as Awaited<ReturnType<DaemonClient['warmupCache']>>;
  }

  async getContextBreakdown(
    params: Parameters<DaemonClient['getContextBreakdown']>[0]
  ): ReturnType<DaemonClient['getContextBreakdown']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.getContextBreakdown();
    if (response.error) {
      throw new MetaError('Failed to get context breakdown', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result as Awaited<
      ReturnType<DaemonClient['getContextBreakdown']>
    >;
  }

  // ---------------------------------------------------------------------------
  // Skills / Bug Report / Rename
  // ---------------------------------------------------------------------------

  async listSkills(
    params: Parameters<DaemonClient['listSkills']>[0]
  ): ReturnType<DaemonClient['listSkills']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.listSkills();
    if (response.error) {
      throw new MetaError('Failed to list skills', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result as Awaited<ReturnType<DaemonClient['listSkills']>>;
  }

  async listCommands(
    params: Parameters<DaemonClient['listCommands']>[0]
  ): ReturnType<DaemonClient['listCommands']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.listCommands();
    if (response.error) {
      throw new MetaError('Failed to list commands', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result as Awaited<ReturnType<DaemonClient['listCommands']>>;
  }

  async submitBugReport(
    params: Parameters<DaemonClient['submitBugReport']>[0]
  ): ReturnType<DaemonClient['submitBugReport']> {
    const client = await this.getClientOrThrow(params.sessionId);
    const response = await client.submitBugReport(
      params.userComment,
      params.clientLogs
    );
    if (response.error) {
      throw new MetaError('Failed to submit bug report', {
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result as Awaited<
      ReturnType<DaemonClient['submitBugReport']>
    >;
  }

  async renameSession(
    params: Parameters<DaemonClient['renameSession']>[0],
    requestId?: string
  ): ReturnType<DaemonClient['renameSession']> {
    const sessionService = getSessionService();
    await sessionService.updateSessionTitle(params.sessionId, params.title, {
      manual: true,
    });

    const persistedTitle = sessionService.getSessionTitleText(params.sessionId);
    if (persistedTitle == null) {
      throw new MetaError('Session title update did not persist');
    }

    this.emitNotification(params.sessionId, {
      type: SessionNotificationType.SESSION_TITLE_UPDATED,
      ...(requestId !== undefined && { requestId }),
      title: persistedTitle,
    });
    return { success: true } as Awaited<
      ReturnType<DaemonClient['renameSession']>
    >;
  }

  // ---------------------------------------------------------------------------
  // Permission / AskUser responses
  // ---------------------------------------------------------------------------

  sendPermissionResponse(
    requestId: string,
    result: Parameters<DaemonClient['sendPermissionResponse']>[1]
  ): boolean {
    if (
      this.resolvePendingElicitation({
        store: this.pendingPermissions,
        requestId,
        subagentSessionId: result.sessionId,
        result,
      })
    ) {
      return true;
    }

    logWarn('[InProcessDaemonRuntime] No pending permission for request', {
      requestId,
    });
    return false;
  }

  sendAskUserResponse(
    requestId: string,
    result: Parameters<DaemonClient['sendAskUserResponse']>[1]
  ): boolean {
    if (
      this.resolvePendingElicitation({
        store: this.pendingAskUsers,
        requestId,
        subagentSessionId: result.sessionId,
        result,
      })
    ) {
      return true;
    }

    logWarn('[InProcessDaemonRuntime] No pending ask-user for request', {
      requestId,
    });
    return false;
  }

  handleIpcResponse(
    requestId: JsonRpcBaseResponse['id'],
    response: Omit<JsonRpcBaseResponse, 'id'>
  ): void {
    if (requestId === null) {
      return;
    }

    const requestKey = String(requestId);

    if (response.error) {
      const errorObj = new MetaError(`IPC error: ${response.error.message}`, {
        code: response.error.code,
      });

      if (
        this.rejectPendingElicitation({
          store: this.pendingPermissions,
          requestId: requestKey,
          error: errorObj,
        })
      ) {
        return;
      }

      if (
        this.rejectPendingElicitation({
          store: this.pendingAskUsers,
          requestId: requestKey,
          error: errorObj,
        })
      ) {
        return;
      }

      logWarn('[InProcessDaemonRuntime] IPC error with no pending request', {
        requestId: requestKey,
        code: response.error.code,
        message: response.error.message,
      });
      return;
    }

    const permissionHandled = this.sendPermissionResponse(
      requestKey,
      response.result as DaemonRequestPermissionResult
    );
    if (permissionHandled) {
      return;
    }

    const askUserHandled = this.sendAskUserResponse(
      requestKey,
      response.result as DaemonAskUserResult
    );
    if (!askUserHandled) {
      logWarn('[InProcessDaemonRuntime] No pending IPC request for response', {
        requestId: requestKey,
      });
    }
  }

  private addPendingElicitation(params: {
    store: Map<string, PendingElicitationRequest[]>;
    requestId: string;
    request: PendingElicitationRequest;
  }): void {
    const { store, requestId, request } = params;
    const existing = store.get(requestId);
    if (existing) {
      existing.push(request);
    } else {
      store.set(requestId, [request]);
    }
  }

  private resolvePendingElicitation(params: {
    store: Map<string, PendingElicitationRequest[]>;
    requestId: string;
    subagentSessionId: string | undefined;
    result: unknown;
  }): boolean {
    const { store, requestId, subagentSessionId, result } = params;
    const entries = store.get(requestId);
    if (!entries || entries.length === 0) {
      return false;
    }

    const matchedIndex =
      subagentSessionId !== undefined
        ? entries.findIndex(
            (entry) => entry.subagentSessionId === subagentSessionId
          )
        : -1;
    // Fall back to the sole entry when the session id does not disambiguate
    // (a non-relayed request only ever has a single in-flight entry).
    const index =
      matchedIndex >= 0 ? matchedIndex : entries.length === 1 ? 0 : -1;
    if (index < 0) {
      return false;
    }

    const [entry] = entries.splice(index, 1);
    if (entries.length === 0) {
      store.delete(requestId);
    }
    entry.resolve(result);
    return true;
  }

  private rejectPendingElicitation(params: {
    store: Map<string, PendingElicitationRequest[]>;
    requestId: string;
    error: Error;
  }): boolean {
    const { store, requestId, error } = params;
    const entries = store.get(requestId);
    if (!entries || entries.length === 0) {
      return false;
    }
    store.delete(requestId);
    for (const entry of entries) {
      entry.reject(error);
    }
    return true;
  }

  private rejectPendingElicitationForSession(params: {
    store: Map<string, PendingElicitationRequest[]>;
    subagentSessionId: string;
  }): void {
    const { store, subagentSessionId } = params;
    for (const [requestId, entries] of store) {
      const remaining = entries.filter((entry) => {
        if (entry.subagentSessionId === subagentSessionId) {
          entry.reject(
            new MetaError(
              'Pending interactive request rejected on session cleanup',
              {
                sessionId: subagentSessionId,
                requestId,
              }
            )
          );
          return false;
        }
        return true;
      });
      if (remaining.length === 0) {
        store.delete(requestId);
      } else {
        store.set(requestId, remaining);
      }
    }
  }

  private countPendingElicitation(
    store: Map<string, PendingElicitationRequest[]>
  ): number {
    let count = 0;
    for (const entries of store.values()) {
      count += entries.length;
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  destroy(): void {
    void this.destroyAllSessions();
    this.pendingPermissions.forEach((entries) =>
      entries.forEach(({ reject }) =>
        reject(new MetaError('Pending permission rejected: client destroyed'))
      )
    );
    this.pendingPermissions.clear();
    this.pendingAskUsers.forEach((entries) =>
      entries.forEach(({ reject }) =>
        reject(new MetaError('Pending ask-user rejected: client destroyed'))
      )
    );
    this.pendingAskUsers.clear();
    this.connected = false;
  }

  getPendingCount(): number {
    return (
      this.countPendingElicitation(this.pendingPermissions) +
      this.countPendingElicitation(this.pendingAskUsers)
    );
  }

  // ---------------------------------------------------------------------------
  // Methods not needed for TUI — throw if called
  // ---------------------------------------------------------------------------

  async listOpenedSessions(
    _params?: Parameters<DaemonClient['listOpenedSessions']>[0]
  ): ReturnType<DaemonClient['listOpenedSessions']> {
    return { sessions: [] } as Awaited<
      ReturnType<DaemonClient['listOpenedSessions']>
    >;
  }

  async listAvailableSessions(
    _params: Parameters<DaemonClient['listAvailableSessions']>[0]
  ): ReturnType<DaemonClient['listAvailableSessions']> {
    throw new MetaError(
      'listAvailableSessions not supported in in-process mode'
    );
  }

  async getSessionMessages(
    _params: Parameters<DaemonClient['getSessionMessages']>[0]
  ): ReturnType<DaemonClient['getSessionMessages']> {
    throw new MetaError('getSessionMessages not supported in in-process mode');
  }

  installSshKey(): ReturnType<DaemonClient['installSshKey']> {
    throw new MetaError('installSshKey not supported in in-process mode');
  }

  async getDefaultSettings(): ReturnType<DaemonClient['getDefaultSettings']> {
    const { getDefaultSettings } = await import(
      '@industry/daemon-core/settings'
    );
    return getDefaultSettings();
  }

  async updateSessionDefaults(
    _params: Parameters<DaemonClient['updateSessionDefaults']>[0]
  ): ReturnType<DaemonClient['updateSessionDefaults']> {
    throw new MetaError(
      'updateSessionDefaults not supported in in-process mode'
    );
  }

  async triggerUpdate(): ReturnType<DaemonClient['triggerUpdate']> {
    throw new MetaError('triggerUpdate not supported in in-process mode');
  }

  async startRelay(): ReturnType<DaemonClient['startRelay']> {
    throw new MetaError('startRelay not supported in in-process mode');
  }

  async stopRelay(): ReturnType<DaemonClient['stopRelay']> {
    throw new MetaError('stopRelay not supported in in-process mode');
  }

  async getRelayStatus(): ReturnType<DaemonClient['getRelayStatus']> {
    throw new MetaError('getRelayStatus not supported in in-process mode');
  }

  async validateWorkingDirectory(
    _params: Parameters<DaemonClient['validateWorkingDirectory']>[0]
  ): ReturnType<DaemonClient['validateWorkingDirectory']> {
    throw new MetaError(
      'validateWorkingDirectory not supported in in-process mode'
    );
  }

  async getMcpConfig(): ReturnType<DaemonClient['getMcpConfig']> {
    throw new MetaError('getMcpConfig not supported in in-process mode');
  }

  async updateMcpConfig(
    _params: Parameters<DaemonClient['updateMcpConfig']>[0]
  ): ReturnType<DaemonClient['updateMcpConfig']> {
    throw new MetaError('updateMcpConfig not supported in in-process mode');
  }

  async createTerminal(
    _params: Parameters<DaemonClient['createTerminal']>[0]
  ): ReturnType<DaemonClient['createTerminal']> {
    throw new MetaError('createTerminal not supported in in-process mode');
  }

  async writeTerminalData(
    _params: Parameters<DaemonClient['writeTerminalData']>[0]
  ): ReturnType<DaemonClient['writeTerminalData']> {
    throw new MetaError('writeTerminalData not supported in in-process mode');
  }

  async resizeTerminal(
    _params: Parameters<DaemonClient['resizeTerminal']>[0]
  ): ReturnType<DaemonClient['resizeTerminal']> {
    throw new MetaError('resizeTerminal not supported in in-process mode');
  }

  async closeTerminal(
    _params: Parameters<DaemonClient['closeTerminal']>[0]
  ): ReturnType<DaemonClient['closeTerminal']> {
    throw new MetaError('closeTerminal not supported in in-process mode');
  }

  async listTerminals(
    _params: Parameters<DaemonClient['listTerminals']>[0]
  ): ReturnType<DaemonClient['listTerminals']> {
    // In-process sessions don't have persistent terminals.
    // Return empty so DaemonSessionController.loadSession (which calls
    // loadTerminals internally) doesn't throw.
    return { terminals: [] };
  }

  async listFiles(
    _params: Parameters<DaemonClient['listFiles']>[0]
  ): ReturnType<DaemonClient['listFiles']> {
    throw new MetaError('listFiles not supported in in-process mode');
  }

  async searchFiles(
    _params: Parameters<DaemonClient['searchFiles']>[0]
  ): ReturnType<DaemonClient['searchFiles']> {
    throw new MetaError('searchFiles not supported in in-process mode');
  }

  async searchSessions(
    _params: Parameters<DaemonClient['searchSessions']>[0]
  ): ReturnType<DaemonClient['searchSessions']> {
    throw new MetaError('searchSessions not supported in in-process mode');
  }

  async archiveSession(
    _params: Parameters<DaemonClient['archiveSession']>[0]
  ): ReturnType<DaemonClient['archiveSession']> {
    throw new MetaError('archiveSession not supported in in-process mode');
  }

  async unarchiveSession(
    _params: Parameters<DaemonClient['unarchiveSession']>[0]
  ): ReturnType<DaemonClient['unarchiveSession']> {
    throw new MetaError('unarchiveSession not supported in in-process mode');
  }

  async listAutomations(
    params: Parameters<DaemonClient['listAutomations']>[0]
  ): ReturnType<DaemonClient['listAutomations']> {
    const result = await listAutomations(params.basePath ?? process.cwd());
    return {
      automations: [
        ...result.automations.map((automation) => ({
          id: automation.id,
          uuid: automation.config.id,
          name: automation.config.name,
          description: automation.config.description,
          status: automation.status,
          schedule: automation.config.schedule.cadence,
          model: automation.config.model,
          tags: automation.config.tags,
          nextRunAt: automation.nextRunAt,
          lastRunAt: automation.lastRunAt,
          isValid: true,
          path: automation.path,
          privacyLevel: automation.config.privacyLevel,
          createdBy: automation.config.createdBy,
          forkedFrom: automation.config.forkedFrom,
        })),
        ...(result.invalidAutomations ?? []).map((automation) => ({
          id: automation.id,
          name: automation.id,
          status: 'invalid',
          isValid: false,
          path: automation.path,
        })),
      ],
    };
  }

  async runAutomation(
    _params: Parameters<DaemonClient['runAutomation']>[0]
  ): ReturnType<DaemonClient['runAutomation']> {
    throw new MetaError('runAutomation not supported in in-process mode');
  }

  async pauseAutomation(
    params: Parameters<DaemonClient['pauseAutomation']>[0]
  ): ReturnType<DaemonClient['pauseAutomation']> {
    const automationId = params.automationDirName ?? params.automationId;
    const result = await pauseAutomation(
      { id: automationId },
      params.basePath ?? process.cwd()
    );
    return result.success
      ? {
          success: true,
          automationId,
          status: result.automation?.status ?? 'paused',
        }
      : {
          success: false,
          automationId,
          status: '',
          error: result.error?.message ?? 'Failed to pause automation',
        };
  }

  async resumeAutomation(
    params: Parameters<DaemonClient['resumeAutomation']>[0]
  ): ReturnType<DaemonClient['resumeAutomation']> {
    const automationId = params.automationDirName ?? params.automationId;
    const result = await resumeAutomation(
      { id: automationId },
      params.basePath ?? process.cwd()
    );
    return result.success
      ? {
          success: true,
          automationId,
          status: result.automation?.status ?? 'active',
        }
      : {
          success: false,
          automationId,
          status: '',
          error: result.error?.message ?? 'Failed to resume automation',
        };
  }

  async getAutomationHistory(
    params: Parameters<DaemonClient['getAutomationHistory']>[0]
  ): ReturnType<DaemonClient['getAutomationHistory']> {
    const automationId = params.automationDirName ?? params.automationId;
    const persistedHistory = await getPersistedLocalAutomationHistory({
      automationId,
      basePath: params.basePath ?? process.cwd(),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
    });
    if (persistedHistory.totalCount > 0) {
      return { automationId, ...persistedHistory };
    }
    const result = await getHistory(
      {
        id: automationId,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.offset !== undefined ? { offset: params.offset } : {}),
      },
      params.basePath ?? process.cwd()
    );
    return {
      automationId,
      runs: result.runs,
      totalCount: result.totalCount,
    };
  }

  async getAutomationVisual(
    _params: Parameters<DaemonClient['getAutomationVisual']>[0]
  ): ReturnType<DaemonClient['getAutomationVisual']> {
    throw new MetaError('getAutomationVisual not supported in in-process mode');
  }

  async createAutomation(
    params: Parameters<DaemonClient['createAutomation']>[0]
  ): ReturnType<DaemonClient['createAutomation']> {
    const usesUserAutomationDirectory = params.basePath === undefined;
    const result = await createAutomation(
      {
        id: params.id,
        name: params.name,
        description: params.description,
        instructions: params.instructions,
        schedule: params.schedule,
        visualDescription: params.visualDescription,
        memoryStrategy: params.memoryStrategy,
      },
      params.basePath ?? getIndustryHome(),
      usesUserAutomationDirectory ? getIndustryDirName() : undefined
    );
    return result.success
      ? { success: true, automationId: params.id }
      : {
          success: false,
          error: result.error?.message ?? 'Failed to create automation',
        };
  }

  async updateAutomationModel(
    _params: Parameters<DaemonClient['updateAutomationModel']>[0]
  ): ReturnType<DaemonClient['updateAutomationModel']> {
    throw new MetaError(
      'updateAutomationModel not supported in in-process mode'
    );
  }

  async renameAutomation(
    _params: Parameters<DaemonClient['renameAutomation']>[0]
  ): ReturnType<DaemonClient['renameAutomation']> {
    throw new MetaError('renameAutomation not supported in in-process mode');
  }

  async deleteAutomation(
    _params: Parameters<DaemonClient['deleteAutomation']>[0]
  ): ReturnType<DaemonClient['deleteAutomation']> {
    throw new MetaError('deleteAutomation not supported in in-process mode');
  }

  async updateAutomationPrivacy(
    _params: Parameters<DaemonClient['updateAutomationPrivacy']>[0]
  ): ReturnType<DaemonClient['updateAutomationPrivacy']> {
    throw new MetaError(
      'updateAutomationPrivacy not supported in in-process mode'
    );
  }

  async forkAutomation(
    _params: Parameters<DaemonClient['forkAutomation']>[0]
  ): ReturnType<DaemonClient['forkAutomation']> {
    throw new MetaError('forkAutomation not supported in in-process mode');
  }

  async listCrons(
    params: Parameters<DaemonClient['listCrons']>[0]
  ): ReturnType<DaemonClient['listCrons']> {
    return { crons: this.cronRegistry.listCrons(params) };
  }

  async createCron(
    params: Parameters<DaemonClient['createCron']>[0]
  ): ReturnType<DaemonClient['createCron']> {
    const cron = this.cronRegistry.createCron(params);
    this.cronRuntime.sync();
    const created = this.cronRegistry.getCron(cron.id) ?? cron;
    if (params.runImmediately) {
      void this.cronRuntime.fireNow(cron.id).catch((error) => {
        logException(
          error,
          '[InProcessDaemonRuntime] Failed to fire cron immediately',
          { externalId: cron.id }
        );
      });
    }
    return { cron: created };
  }

  async updateCron(
    params: Parameters<DaemonClient['updateCron']>[0]
  ): ReturnType<DaemonClient['updateCron']> {
    const existing = this.cronRegistry.getCron(params.cronId);
    const payloadPatch =
      params.payload && existing
        ? {
            payload: {
              ...existing.payload,
              ...(params.payload.prompt
                ? { prompt: params.payload.prompt }
                : {}),
            },
          }
        : {};
    const cron = this.cronRegistry.updateCron(params.cronId, {
      ...(params.status ? { status: params.status } : {}),
      ...(params.schedule
        ? { schedule: { ...params.schedule, timezone: 'UTC' as const } }
        : {}),
      ...payloadPatch,
    });
    this.cronRuntime.sync();
    return {
      cron: cron ? (this.cronRegistry.getCron(cron.id) ?? cron) : null,
    };
  }

  async deleteCron(
    params: Parameters<DaemonClient['deleteCron']>[0]
  ): ReturnType<DaemonClient['deleteCron']> {
    const deleted = this.cronRegistry.deleteCron(
      params.cronId,
      params.sessionId
    );
    this.cronRuntime.sync();
    return { deleted };
  }

  async holdSessionCrons(
    params: Parameters<DaemonClient['holdSessionCrons']>[0]
  ): ReturnType<DaemonClient['holdSessionCrons']> {
    const heldCount = this.cronRegistry.holdSessionCrons(
      params.sessionId,
      params.reason
    );
    this.cronRuntime.sync();
    return { heldCount };
  }

  async resumeSessionCrons(
    params: Parameters<DaemonClient['resumeSessionCrons']>[0]
  ): ReturnType<DaemonClient['resumeSessionCrons']> {
    const resumedCount = this.cronRegistry.resumeSessionCrons(params.sessionId);
    this.cronRuntime.sync();
    return { resumedCount };
  }

  async getGitDiff(
    _params: Parameters<DaemonClient['getGitDiff']>[0]
  ): ReturnType<DaemonClient['getGitDiff']> {
    throw new MetaError('getGitDiff not supported in in-process mode');
  }

  async inspectMissionReadiness(
    _params: Parameters<DaemonClient['inspectMissionReadiness']>[0]
  ): ReturnType<DaemonClient['inspectMissionReadiness']> {
    throw new MetaError(
      'inspectMissionReadiness not supported in in-process mode'
    );
  }

  async gitPush(
    _params: Parameters<DaemonClient['gitPush']>[0]
  ): ReturnType<DaemonClient['gitPush']> {
    throw new MetaError('gitPush not supported in in-process mode');
  }

  async gitCommit(
    _params: Parameters<DaemonClient['gitCommit']>[0]
  ): ReturnType<DaemonClient['gitCommit']> {
    throw new MetaError('gitCommit not supported in in-process mode');
  }

  async createPR(
    _params: Parameters<DaemonClient['createPR']>[0]
  ): ReturnType<DaemonClient['createPR']> {
    throw new MetaError('createPR not supported in in-process mode');
  }

  async getSemanticDiffCache(
    _params: Parameters<DaemonClient['getSemanticDiffCache']>[0]
  ): ReturnType<DaemonClient['getSemanticDiffCache']> {
    throw new MetaError(
      'getSemanticDiffCache not supported in in-process mode'
    );
  }

  async saveSemanticDiffCache(
    _params: Parameters<DaemonClient['saveSemanticDiffCache']>[0]
  ): ReturnType<DaemonClient['saveSemanticDiffCache']> {
    throw new MetaError(
      'saveSemanticDiffCache not supported in in-process mode'
    );
  }

  async generateSemanticDiff(
    _params: Parameters<DaemonClient['generateSemanticDiff']>[0]
  ): ReturnType<DaemonClient['generateSemanticDiff']> {
    throw new MetaError(
      'generateSemanticDiff not supported in in-process mode'
    );
  }

  async getProxyToken(): ReturnType<DaemonClient['getProxyToken']> {
    throw new MetaError('getProxyToken not supported in in-process mode');
  }

  async getWorkspaceFileContent(
    _params: Parameters<IDaemonClient['getWorkspaceFileContent']>[0]
  ): ReturnType<IDaemonClient['getWorkspaceFileContent']> {
    throw new MetaError(
      'getWorkspaceFileContent not supported in in-process mode'
    );
  }

  // ---------------------------------------------------------------------------
  // Plugin / marketplace methods
  // ---------------------------------------------------------------------------

  private async getPluginMarketplaceManager() {
    const settingsModule = await import('@industry/runtime/settings');
    return settingsModule.PluginMarketplaceManager.getInstance();
  }

  private parseSettingsLevelOrThrow(scope: string): SettingsLevel {
    const values = Object.values(SettingsLevel);
    const match = values.find((v) => v === scope);
    if (!match) {
      throw new MetaError('Invalid settings level', { value: scope });
    }
    return match;
  }

  private redactMarketplaceSource(source: MarketplaceSource) {
    const redactUrl = (url: string): string => {
      try {
        const parsed = new URL(url);
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
      } catch {
        return url.replace(/\/\/[^@/]+:[^@/]+@/, '//');
      }
    };
    switch (source.source) {
      case 'github':
        return { source: 'github' as const, repo: source.repo };
      case 'url':
        return { source: 'url' as const, url: redactUrl(source.url) };
      case 'local':
        return { source: 'local' as const };
      case 'git-subdir':
        return {
          source: 'git-subdir' as const,
          url: redactUrl(source.url),
          path: source.path,
        };
      default:
        return { source: 'local' as const };
    }
  }

  async listAvailablePlugins(
    _params: Parameters<DaemonClient['listAvailablePlugins']>[0]
  ): ReturnType<DaemonClient['listAvailablePlugins']> {
    const manager = await this.getPluginMarketplaceManager();
    const plugins = await manager.listAvailablePlugins();
    return { plugins };
  }

  async listInstalledPlugins(
    params: Parameters<DaemonClient['listInstalledPlugins']>[0]
  ): ReturnType<DaemonClient['listInstalledPlugins']> {
    const manager = await this.getPluginMarketplaceManager();
    const scope = params.scope
      ? this.parseSettingsLevelOrThrow(params.scope)
      : undefined;
    const results = await manager.listInstalledPluginStatuses(scope);
    return {
      plugins: results.map(({ id, entry, active, reason }) => ({
        id,
        scope: entry.scope,
        version: entry.version,
        installPath: entry.installPath,
        installedAt: entry.installedAt,
        lastUpdated: entry.lastUpdated,
        source: entry.source,
        active,
        reason,
      })),
    };
  }

  async installPlugin(
    params: Parameters<DaemonClient['installPlugin']>[0]
  ): ReturnType<DaemonClient['installPlugin']> {
    const manager = await this.getPluginMarketplaceManager();
    const result = await manager.installPlugin(
      params.marketplace,
      params.pluginName,
      this.parseSettingsLevelOrThrow(params.scope)
    );
    return {
      success: result.success,
      ...(result.pluginId && { pluginId: result.pluginId }),
      ...(result.error && { error: result.error }),
    };
  }

  async uninstallPlugin(
    params: Parameters<DaemonClient['uninstallPlugin']>[0]
  ): ReturnType<DaemonClient['uninstallPlugin']> {
    const manager = await this.getPluginMarketplaceManager();
    const success = await manager.uninstallPlugin(
      params.pluginId,
      this.parseSettingsLevelOrThrow(params.scope)
    );
    return {
      success,
      ...(!success && { error: 'Plugin not found or uninstall failed' }),
    };
  }

  async setPluginEnabled(
    params: Parameters<DaemonClient['setPluginEnabled']>[0]
  ): ReturnType<DaemonClient['setPluginEnabled']> {
    const manager = await this.getPluginMarketplaceManager();
    const result = await manager.setPluginEnabled(
      params.pluginId,
      this.parseSettingsLevelOrThrow(params.scope),
      params.enabled
    );
    return {
      success: result.success,
      ...(result.error && { error: result.error }),
    };
  }

  async updatePlugin(
    params: Parameters<DaemonClient['updatePlugin']>[0]
  ): ReturnType<DaemonClient['updatePlugin']> {
    const manager = await this.getPluginMarketplaceManager();
    const scope = params.scope
      ? this.parseSettingsLevelOrThrow(params.scope)
      : undefined;
    const results = await manager.updatePlugin(params.pluginId, scope);
    return {
      results: results.map((r) => ({
        pluginId: r.pluginId ?? params.pluginId ?? '',
        success: r.success,
        ...(r.error && { error: r.error }),
      })),
    };
  }

  async listMarketplaces(
    _params: Parameters<DaemonClient['listMarketplaces']>[0]
  ): ReturnType<DaemonClient['listMarketplaces']> {
    const manager = await this.getPluginMarketplaceManager();
    const marketplaces = await manager.listMarketplaces();
    return {
      marketplaces: marketplaces.map((m) => ({
        name: m.name,
        source: this.redactMarketplaceSource(m.entry.source),
        pluginCount: m.pluginCount,
        autoUpdate: m.entry.autoUpdate ?? false,
      })),
    };
  }

  async addMarketplace(
    params: Parameters<DaemonClient['addMarketplace']>[0]
  ): ReturnType<DaemonClient['addMarketplace']> {
    const manager = await this.getPluginMarketplaceManager();
    const result = await manager.addMarketplace(params.source);
    return {
      success: result.success,
      ...(result.name && { name: result.name }),
      ...(result.error && { error: result.error }),
    };
  }

  async removeMarketplace(
    params: Parameters<DaemonClient['removeMarketplace']>[0]
  ): ReturnType<DaemonClient['removeMarketplace']> {
    const manager = await this.getPluginMarketplaceManager();
    const result = await manager.removeMarketplace(params.name);
    return {
      success: result.success,
      ...(result.error && { error: result.error }),
    };
  }

  async updateMarketplace(
    params: Parameters<DaemonClient['updateMarketplace']>[0]
  ): ReturnType<DaemonClient['updateMarketplace']> {
    const manager = await this.getPluginMarketplaceManager();
    const results = await manager.updateMarketplace(params.name);
    return {
      results: results.map((r) => ({
        name: r.name ?? params.name ?? '',
        success: r.success,
        ...(r.error && { error: r.error }),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async handleChildIpcMessage(
    connection: IpcConnection,
    message: string
  ): Promise<void> {
    const parsed = parseEnvelope(message);

    if (parsed.kind === 'parse_error') {
      connection.sendMessage(
        JSON.stringify(this.withEnvelope(parsed.response))
      );
      return;
    }

    if (parsed.kind === 'response') {
      this.handleIpcResponse(parsed.response.id, parsed.response);
      return;
    }

    if (parsed.kind === 'notification') {
      return;
    }

    const { request } = parsed;

    try {
      switch (request.method) {
        case DaemonConnectionMethod.AUTHENTICATE: {
          DaemonAuthenticateRequestSchema.parse(request);
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result: {
                  userId: connection.user.userId,
                  orgId: connection.user.orgId,
                },
              })
            )
          );
          return;
        }
        case DaemonDroolMethod.INITIALIZE_SESSION: {
          const validated = DaemonInitializeSessionRequestSchema.parse(request);
          const result = await this.initializeSessionFromConnection(
            validated.params,
            connection
          );
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result,
              })
            )
          );
          return;
        }
        case DaemonDroolMethod.LOAD_SESSION: {
          const validated = DaemonLoadSessionRequestSchema.parse(request);
          const result = await this.loadSessionFromConnection(
            validated.params,
            connection
          );
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result,
              })
            )
          );
          return;
        }
        case DaemonDroolMethod.ADD_USER_MESSAGE: {
          const validated = DaemonAddUserMessageRequestSchema.parse(request);
          const result = await this.addUserMessage(
            validated.params,
            validated.id
          );
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result,
              })
            )
          );
          return;
        }
        case DaemonDroolMethod.RESOLVE_QUEUED_USER_MESSAGE: {
          const validated =
            DaemonResolveQueuedUserMessageRequestSchema.parse(request);
          const result = await this.resolveQueuedUserMessage(validated.params);
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result,
              })
            )
          );
          return;
        }
        case DaemonDroolMethod.INTERRUPT_SESSION: {
          const validated = DaemonInterruptSessionRequestSchema.parse(request);
          const result = await this.interruptSession(validated.params);
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result,
              })
            )
          );
          return;
        }
        case DaemonDroolMethod.CLOSE_SESSION: {
          const validated = DaemonCloseSessionRequestSchema.parse(request);
          const result = await this.closeSession(validated.params);
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result,
              })
            )
          );
          return;
        }
        case DaemonDroolMethod.KILL_WORKER_SESSION: {
          const validated = DaemonKillWorkerSessionRequestSchema.parse(request);
          const result = await this.killWorkerSession(validated.params);
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result,
              })
            )
          );
          return;
        }
        case DaemonDroolMethod.LIST_CRONS: {
          const validated = DaemonListCronsRequestSchema.parse(request);
          const result = await this.listCrons(validated.params);
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result,
              })
            )
          );
          return;
        }
        case DaemonDroolMethod.CREATE_CRON: {
          const validated = DaemonCreateCronRequestSchema.parse(request);
          const result = await this.createCron(validated.params);
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result,
              })
            )
          );
          return;
        }
        case DaemonDroolMethod.UPDATE_CRON: {
          const validated = DaemonUpdateCronRequestSchema.parse(request);
          const result = await this.updateCron(validated.params);
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result,
              })
            )
          );
          return;
        }
        case DaemonDroolMethod.DELETE_CRON: {
          const validated = DaemonDeleteCronRequestSchema.parse(request);
          const result = await this.deleteCron(validated.params);
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result,
              })
            )
          );
          return;
        }
        case DaemonDroolMethod.HOLD_SESSION_CRONS: {
          const validated = DaemonHoldSessionCronsRequestSchema.parse(request);
          const result = await this.holdSessionCrons(validated.params);
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result,
              })
            )
          );
          return;
        }
        case DaemonDroolMethod.RESUME_SESSION_CRONS: {
          const validated =
            DaemonResumeSessionCronsRequestSchema.parse(request);
          const result = await this.resumeSessionCrons(validated.params);
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope({
                type: 'response',
                id: request.id,
                result,
              })
            )
          );
          return;
        }
        default:
          connection.sendMessage(
            JSON.stringify(
              this.withEnvelope(
                createMethodNotFoundResponse(request.id, request.method)
              )
            )
          );
      }
    } catch (error) {
      if (error instanceof MetaError) {
        connection.sendMessage(
          JSON.stringify(
            this.withEnvelope({
              type: 'response',
              id: request.id,
              error: {
                code: JsonRpcErrorCode.INTERNAL_ERROR,
                message: error.message,
              },
            })
          )
        );
        return;
      }

      connection.sendMessage(
        JSON.stringify(
          this.withEnvelope(createInternalErrorResponse(request.id))
        )
      );
    }
  }

  private withEnvelope<T extends object>(message: T) {
    return {
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      ...message,
    };
  }

  private static getJsonRpcError(error: unknown): JsonRpcError {
    return {
      code: InProcessDaemonRuntime.getErrorCode(error),
      message: InProcessDaemonRuntime.getErrorMessage(error),
    };
  }

  private static getErrorMessage(error: unknown): string {
    if (
      error instanceof MetaError &&
      typeof error.metadata?.message === 'string'
    ) {
      return error.metadata.message;
    }

    return error instanceof Error ? error.message : String(error);
  }

  private static getErrorCode(error: unknown): JsonRpcErrorCode {
    if (error instanceof InProcessDaemonMethodNotFoundError) {
      return JsonRpcErrorCode.METHOD_NOT_FOUND;
    }

    if (
      error instanceof MetaError &&
      typeof error.metadata?.code === 'number'
    ) {
      return error.metadata.code;
    }

    return JsonRpcErrorCode.INTERNAL_ERROR;
  }

  private attachManagedProcessIpc(
    transport: ProcessTransport,
    sourceSessionId: string
  ): void {
    const managedProcess = transport.getManagedProcess();
    if (!managedProcess) {
      return;
    }

    this.attachChildIpc(managedProcess.childProcess, { sourceSessionId });
  }

  attachChildIpc(
    childProcess: ChildProcess,
    params: { sourceSessionId?: string }
  ): IpcConnection | null {
    if (typeof childProcess.send !== 'function') {
      return null;
    }

    const { user, caller, tracingMetadata } = this.getTuiConnectionOrThrow();
    const connection = new IpcConnection({
      user,
      connectionId: `in-process-ipc-${uuidv4()}`,
      caller,
      sourceSessionId: params.sourceSessionId,
      interactive: true,
      isChildIpc: true,
      tracingMetadata,
      sendMessage: (message) => {
        try {
          childProcess.send?.(
            message,
            undefined,
            undefined,
            (error: Error | null) => {
              if (error) {
                logWarn(
                  '[InProcessDaemonRuntime] Failed to send IPC message via callback',
                  {
                    cause: error,
                    sessionId: params.sourceSessionId,
                  }
                );
              }
            }
          );
        } catch (error) {
          logWarn(
            '[InProcessDaemonRuntime] Failed to send IPC message via throw',
            {
              cause: error,
              sessionId: params.sourceSessionId,
            }
          );
        }
      },
      isOpen: () =>
        typeof childProcess.send === 'function' &&
        childProcess.connected !== false,
    });

    const onMessage: IpcMessageListener = (message) => {
      if (typeof message !== 'string') {
        return;
      }

      void this.handleChildIpcMessage(connection, message).catch((error) => {
        logException(
          error,
          '[InProcessDaemonRuntime] Failed to handle IPC message',
          {
            sessionId: connection.sourceSessionId,
          }
        );
      });
    };

    let disconnected = false;
    const onDisconnect: IpcDisconnectListener = () => {
      if (disconnected) {
        return;
      }
      disconnected = true;
      removeChildProcessListener(
        childProcess,
        ChildProcessIpcEvent.Message,
        onMessage
      );
      removeChildProcessListener(
        childProcess,
        ChildProcessIpcEvent.Disconnect,
        onDisconnect
      );
      removeChildProcessListener(
        childProcess,
        ChildProcessIpcEvent.Exit,
        onDisconnect
      );
      this.handleConnectionClosed(connection);
    };

    childProcess.on(ChildProcessIpcEvent.Message, onMessage);
    childProcess.on(ChildProcessIpcEvent.Disconnect, onDisconnect);
    childProcess.on(ChildProcessIpcEvent.Exit, onDisconnect);

    return connection;
  }

  private handleConnectionClosed(ownerConnection: IpcConnection): void {
    const ownedSessionIds =
      this.droolRegistry.scheduleCleanupForConnection(ownerConnection);

    for (const sessionId of ownedSessionIds) {
      void this.droolRegistry
        .unregisterDroolClient(sessionId)
        .catch((error) => {
          logException(
            error,
            '[InProcessDaemonRuntime] Failed to clean up IPC-owned session',
            { sessionId }
          );
        });
    }
  }

  private getTuiConnectionOrThrow(): IpcConnection {
    if (!this.tuiConnection) {
      throw new MetaError('In-process daemon client not authenticated');
    }

    return this.tuiConnection;
  }

  private getSourceSessionId(ownerConnection: IpcConnection): string | null {
    if (!('sourceSessionId' in ownerConnection)) {
      return null;
    }

    return typeof ownerConnection.sourceSessionId === 'string' &&
      ownerConnection.sourceSessionId.length > 0
      ? ownerConnection.sourceSessionId
      : null;
  }

  private static getChildSessionToolUseId(result: unknown): string | undefined {
    if (!result || typeof result !== 'object') {
      return undefined;
    }
    if (
      'callingToolUseId' in result &&
      typeof result.callingToolUseId === 'string' &&
      result.callingToolUseId.length > 0
    ) {
      return result.callingToolUseId;
    }
    if (
      !('settings' in result) ||
      !result.settings ||
      typeof result.settings !== 'object' ||
      !('tags' in result.settings) ||
      !isSessionTagArray(result.settings.tags)
    ) {
      return undefined;
    }
    return getCompleteSubagentCallingMetadata(result.settings.tags)
      ?.callingToolUseId;
  }

  private emitChildSessionAvailableIfApplicable(
    childSessionId: string,
    ownerConnection: IpcConnection,
    toolUseId: string | undefined
  ): void {
    const sourceSessionId = this.getSourceSessionId(ownerConnection);
    if (!sourceSessionId || sourceSessionId === childSessionId || !toolUseId) {
      return;
    }

    const message: DaemonSessionNotification = {
      type: 'notification',
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      jsonrpc: JSONRPC_VERSION,
      method: DaemonDroolEvent.SESSION_NOTIFICATION,
      params: {
        sessionId: sourceSessionId,
        notification: {
          type: SessionNotificationType.CHILD_SESSION_AVAILABLE,
          childSessionId,
          toolUseId,
          timestamp: Date.now(),
        },
      },
    };

    this.droolRegistry.broadcastForSession(sourceSessionId, message);
  }

  private async createAndRegisterClient<TResult>({
    ownerConnection,
    transportConfig,
    invoke,
    parseResult,
    getSessionId,
    getHostId,
    isExpectedProcessExit,
    getClientRegistrationState,
    errorMessage,
    inactivityTimeoutMs,
    disableInactivityTimeout,
    runtimeSettingsPath,
  }: {
    ownerConnection: IpcConnection;
    transportConfig: ConstructorParameters<typeof ProcessTransport>[0];
    invoke: (client: DroolClient) => Promise<{
      error?: {
        code: number;
        message: string;
      };
      result?: unknown;
    }>;
    parseResult: (result: unknown) => TResult;
    getSessionId: (result: TResult) => string;
    getHostId?: (result: TResult) => string | undefined;
    isExpectedProcessExit?: (result: TResult) => boolean;
    getClientRegistrationState?: (result: TResult) => {
      cwd?: string;
      tags?: SessionTag[];
      callingSessionId?: string;
      callingToolUseId?: string;
    };
    errorMessage: string;
    inactivityTimeoutMs?: number;
    disableInactivityTimeout?: boolean;
    runtimeSettingsPath?: string;
  }): Promise<TResult> {
    const transport = new ProcessTransport(transportConfig);
    const client = new DroolClient({ transport });

    try {
      await transport.connect();

      const response = await invoke(client);
      if (response.error) {
        throw new MetaError(errorMessage, {
          code: response.error.code,
          message: response.error.message,
        });
      }

      const result = parseResult(response.result);
      const sessionId = getSessionId(result);
      const hostId = getHostId?.(result);
      const registrationState = getClientRegistrationState?.(result) ?? {};

      this.attachManagedProcessIpc(transport, sessionId);

      const cleanup = this.setupEventForwarding(
        client,
        sessionId,
        ownerConnection,
        {
          suppressExpectedProcessExit: isExpectedProcessExit?.(result) ?? false,
        }
      );
      await this.droolRegistry.registerClient({
        sessionId,
        droolClient: client,
        connection: ownerConnection,
        cleanupFn: cleanup,
        hostId,
        cwd: registrationState.cwd,
        tags: registrationState.tags,
        callingSessionId: registrationState.callingSessionId,
        callingToolUseId: registrationState.callingToolUseId,
        inactivityTimeoutMs,
        runtimeSettingsPath,
        disableInactivityTimeout,
      });
      this.cronRegistry.resumeSessionCrons(sessionId);
      this.cronRuntime.sync();
      this.emitChildSessionAvailableIfApplicable(
        sessionId,
        ownerConnection,
        InProcessDaemonRuntime.getChildSessionToolUseId(result)
      );
      return result;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  private async destroyAllSessions(): Promise<void> {
    this.tuiConnection = null;
    this.cronRuntime.sync();
    try {
      for (const sessionId of this.droolRegistry.getAllSessionIds()) {
        this.holdPendingCronPromptsForSession(sessionId, 'client-disconnect');
        this.cronRegistry.holdSessionCrons(sessionId, 'client-disconnect');
      }
      this.cronRuntime.sync();
      await this.droolRegistry.unregisterAllDroolClients();
    } catch (error) {
      logException(
        error,
        '[InProcessDaemonRuntime] Failed to destroy sessions'
      );
    } finally {
      this.pendingInitializeResults.clear();
      this.pendingLoadResults.clear();
      this.pendingSessionReady.clear();
    }
  }

  /**
   * Register a promise that `getClientOrThrow` will await when the given
   * sessionId is not yet in the registry. Keyed by sessionId so
   * concurrent sessions don't block each other.
   */
  setPendingSessionReady(sessionId: string, promise: Promise<unknown>): void {
    this.pendingSessionReady.set(sessionId, promise);

    void promise
      .catch(() => {})
      .finally(() => {
        if (this.pendingSessionReady.get(sessionId) === promise) {
          this.pendingSessionReady.delete(sessionId);
        }
      });
  }

  private async getClientOrThrow(sessionId: string): Promise<DroolClient> {
    await this.beforeRequest?.(sessionId, 'getClient');

    const client = this.droolRegistry.getDroolClient(sessionId);
    if (client) return client;

    const pending = this.pendingSessionReady.get(sessionId);
    if (pending) {
      try {
        await pending;
      } catch (error) {
        logWarn('[InProcessDaemonRuntime] Pending session readiness failed', {
          sessionId,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      } finally {
        if (this.pendingSessionReady.get(sessionId) === pending) {
          this.pendingSessionReady.delete(sessionId);
        }
      }
      const retry = this.droolRegistry.getDroolClient(sessionId);
      if (retry) return retry;
    }

    throw new MetaError('Session not found', { sessionId });
  }

  /**
   * Wire up DroolClient events to synthesized JSON-RPC messages
   * that DaemonSessionController's MessageRouter can parse.
   */
  private setupEventForwarding(
    client: DroolClient,
    sessionId: string,
    ownerConnection: IpcConnection,
    options?: { suppressExpectedProcessExit?: boolean }
  ): () => void {
    // Forward session notifications
    const notificationHandler = (event: SessionNotificationEvent) => {
      const { params } = event;

      const parseResult = CliRequestOrNotificationSchema.safeParse({
        type: 'notification' as const,
        industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
        industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
        jsonrpc: JSONRPC_VERSION,
        method: DroolClientMethod.SESSION_NOTIFICATION,
        params,
      });

      if (!parseResult.success) {
        const isUnsupportedType = parseResult.error.issues.some(
          (issue) =>
            issue.code === 'invalid_union_discriminator' &&
            issue.path.length === 3 &&
            issue.path[0] === 'params' &&
            issue.path[1] === 'notification' &&
            issue.path[2] === 'type'
        );

        if (!isUnsupportedType) {
          // We will regularly have new notifications that are created, so we ignore these
          // errors to avoid polluting the log store
          logException(
            new MetaError('Invalid session notification format', {
              sessionId,
              cause: parseResult.error,
            }),
            '[InProcessDaemonRuntime] Session notification validation failed'
          );
        }
        return;
      }
      if (parseResult.data.type !== 'notification') {
        return;
      }
      const validatedNotification = parseResult.data.params.notification;
      this.handleCronPromptNotification(sessionId, validatedNotification);

      if (
        options?.suppressExpectedProcessExit &&
        isProcessExitNotification(validatedNotification)
      ) {
        logInfo(
          '[InProcessDaemonClient] Suppressing expected delegated process exit',
          {
            sessionId,
            reason: 'expected_process_exit',
          }
        );
        this.holdPendingCronPromptsForSession(
          sessionId,
          'session-process-exit'
        );
        void this.droolRegistry.unregisterDroolClient(sessionId).catch(() => {
          // Best-effort expected-exit cleanup
        });
        this.emitNotification(sessionId, {
          type: SessionNotificationType.DROOL_WORKING_STATE_CHANGED,
          newState: DroolWorkingState.Idle,
        });
        // Also surface the raw process exit to local subscribers (not just the
        // IPC owner below): a subagent that exits without first emitting
        // AGENT_TURN_COMPLETED would otherwise leave a foreground Task waiting
        // forever. On a clean turn AGENT_TURN_COMPLETED arrives first, so the
        // foreground latches on that and ignores this trailing exit, and the
        // background completion wakeup is deduped.
        this.emitNotification(sessionId, validatedNotification);
        this.forwardNotificationToIpcOwnerIfNeeded(
          sessionId,
          validatedNotification,
          ownerConnection
        );
        return;
      }

      // Check for process crash and clean up
      if (
        validatedNotification.type === SessionNotificationType.ERROR &&
        validatedNotification.errorType === DroolErrorType.PROCESS_EXIT_ERROR
      ) {
        logWarn('[InProcessDaemonRuntime] Drool process crashed, cleaning up', {
          sessionId,
          message: validatedNotification.message,
        });
        this.holdPendingCronPromptsForSession(
          sessionId,
          'session-process-exit'
        );
        void this.droolRegistry.unregisterDroolClient(sessionId).catch(() => {
          // Best-effort crash cleanup
        });

        this.emitNotification(sessionId, {
          type: DaemonSpecificNotificationType.SESSION_PROCESS_EXITED,
          message: validatedNotification.message,
          timestamp: Date.now(),
        });
      }

      this.forwardNotificationToIpcOwnerIfNeeded(
        sessionId,
        validatedNotification,
        ownerConnection
      );
      this.emitNotification(sessionId, validatedNotification);
    };

    client.on(DroolClientEvent.SESSION_NOTIFICATION, notificationHandler);

    // Set up permission handler
    client.setPermissionHandler(async (event) => {
      const requestId = event.id;

      const pendingResponsePromise = new Promise<unknown>((resolve, reject) => {
        this.addPendingElicitation({
          store: this.pendingPermissions,
          requestId,
          request: {
            subagentSessionId: sessionId,
            resolve,
            reject,
          },
        });
      });

      const permissionRequestMessage = {
        type: 'request' as const,
        industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
        industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
        jsonrpc: JSONRPC_VERSION,
        id: requestId,
        method: DaemonDroolEvent.REQUEST_PERMISSION as const,
        params: {
          sessionId,
          ...event.params,
        },
      };

      if (ownerConnection.isChildIpc) {
        // Forward permission request to the parent process via IPC.
        // The parent is responsible for rejecting or approving.
        ownerConnection.sendMessage(JSON.stringify(permissionRequestMessage));
      } else {
        this.traceReceive(
          SpanName.CLI_RECEIVE_PERMISSION_REQUEST,
          sessionId,
          { [SpanAttribute.RPC_REQUEST_ID]: requestId },
          () => {
            this.pushMessage(JSON.stringify(permissionRequestMessage));
          }
        );
      }

      const result = await pendingResponsePromise;
      return result as ReturnType<
        NonNullable<Parameters<DroolClient['setPermissionHandler']>[0]>
      >;
    });

    // Set up ask-user handler
    client.setAskUserHandler(async (event) => {
      const requestId = event.id;

      const pendingResponsePromise = new Promise<unknown>((resolve, reject) => {
        this.addPendingElicitation({
          store: this.pendingAskUsers,
          requestId,
          request: {
            subagentSessionId: sessionId,
            resolve,
            reject,
          },
        });
      });

      this.traceReceive(
        SpanName.CLI_RECEIVE_ASK_USER_REQUEST,
        sessionId,
        { [SpanAttribute.RPC_REQUEST_ID]: requestId },
        () => {
          const askUserRequest = {
            type: 'request' as const,
            industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
            industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
            jsonrpc: JSONRPC_VERSION,
            id: requestId,
            method: DaemonDroolEvent.ASK_USER as const,
            params: {
              sessionId,
              toolCallId: event.params.toolCallId,
              questions: event.params.questions,
            },
          };
          this.pushMessage(JSON.stringify(askUserRequest));
        }
      );

      return pendingResponsePromise as ReturnType<
        NonNullable<Parameters<DroolClient['setAskUserHandler']>[0]>
      >;
    });

    return () => {
      client.off(DroolClientEvent.SESSION_NOTIFICATION, notificationHandler);
      client.clearPermissionHandler();
      client.clearAskUserHandler();

      // Reject only pending elicitation requests belonging to this session
      this.rejectPendingElicitationForSession({
        store: this.pendingPermissions,
        subagentSessionId: sessionId,
      });
      this.rejectPendingElicitationForSession({
        store: this.pendingAskUsers,
        subagentSessionId: sessionId,
      });
    };
  }

  private emitNotification(
    sessionId: string,
    notification: Record<string, unknown>
  ): void {
    const notificationAttrs: Attributes =
      typeof notification.type === 'string'
        ? { [SpanAttribute.NOTIFICATION_TYPE]: notification.type }
        : {};
    this.traceReceive(
      SpanName.CLI_RECEIVE_NOTIFICATION,
      sessionId,
      notificationAttrs,
      () => {
        const message = {
          type: 'notification' as const,
          industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
          industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
          jsonrpc: JSONRPC_VERSION,
          method: DaemonDroolEvent.SESSION_NOTIFICATION as const,
          params: { sessionId, notification },
        };
        this.pushMessage(JSON.stringify(message));
      }
    );
  }

  private forwardNotificationToIpcOwnerIfNeeded(
    sessionId: string,
    notification: DaemonSessionNotification['params']['notification'],
    ownerConnection: IpcConnection
  ): void {
    if (
      !ownerConnection.isChildIpc ||
      !shouldForwardNotificationToFilteredListener(notification) ||
      !ownerConnection.isOpen()
    ) {
      return;
    }

    const message: DaemonSessionNotification = {
      type: 'notification',
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      jsonrpc: JSONRPC_VERSION,
      method: DaemonDroolEvent.SESSION_NOTIFICATION,
      params: { sessionId, notification },
    };

    try {
      ownerConnection.sendMessage(JSON.stringify(message));
    } catch (error) {
      logWarn(
        '[InProcessDaemonRuntime] Failed to forward selected notification to IPC owner',
        {
          sessionId,
          notificationType: notification.type,
          cause: error,
        }
      );
    }
  }

  private pushMessage(data: string): void {
    if (this.messageHandler) {
      this.messageHandler(data);
    }
  }

  private pushCronStateChanged(
    params: DaemonCronStateChangedNotification['params']
  ): void {
    const message: DaemonCronStateChangedNotification = {
      type: 'notification',
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      jsonrpc: JSONRPC_VERSION,
      method: DaemonCronEvent.STATE_CHANGED,
      params,
    };
    this.pushMessage(JSON.stringify(message));
  }
}
