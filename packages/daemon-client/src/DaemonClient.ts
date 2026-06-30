import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import {
  DaemonConnectionMethod,
  DaemonDroolMethod,
  DaemonManagementMethod,
  DaemonSettingsMethod,
  DaemonTerminalMethod,
  DaemonCommandAckResultSchema,
  DaemonAuthenticateRequestSchema,
  DaemonAuthenticateResultSchema,
  DaemonLogoutRequestSchema,
  DaemonLogoutResultSchema,
  DaemonInitializeSessionRequestSchema,
  DaemonInitializeSessionResultSchema,
  DaemonLoadSessionRequestSchema,
  DaemonLoadSessionResultSchema,
  DaemonAddUserMessageRequestSchema,
  DaemonAddUserMessageResultSchema,
  DaemonResolveQueuedUserMessageRequestSchema,
  DaemonResolveQueuedUserMessageResultSchema,
  DaemonInterruptSessionRequestSchema,
  DaemonInterruptSessionResultSchema,
  DaemonCloseSessionRequestSchema,
  DaemonCloseSessionResultSchema,
  DaemonKillWorkerSessionRequestSchema,
  DaemonKillWorkerSessionResultSchema,
  DaemonListOpenedSessionsRequestSchema,
  DaemonListOpenedSessionsResultSchema,
  DaemonListAvailableSessionsRequestSchema,
  DaemonListAvailableSessionsResultSchema,
  DaemonGetSessionMessagesRequestSchema,
  DaemonGetSessionMessagesResultSchema,
  DaemonUpdateSessionSettingsRequestSchema,
  DaemonUpdateSessionSettingsResultSchema,
  DaemonGetDefaultSettingsRequestSchema,
  DaemonGetDefaultSettingsResultSchema,
  DaemonUpdateSessionDefaultsRequestSchema,
  DaemonUpdateSessionDefaultsResultSchema,
  DaemonListCustomModelsRequestSchema,
  DaemonListCustomModelsResultSchema,
  DaemonUpsertCustomModelRequestSchema,
  DaemonUpsertCustomModelResultSchema,
  DaemonDeleteCustomModelRequestSchema,
  DaemonDeleteCustomModelResultSchema,
  DaemonValidateWorkingDirectoryRequestSchema,
  DaemonValidateWorkingDirectoryResultSchema,
  DaemonGetMcpConfigRequestSchema,
  DaemonGetMcpConfigResultSchema,
  DaemonUpdateMcpConfigRequestSchema,
  DaemonUpdateMcpConfigResultSchema,
  DaemonToggleMcpServerRequestSchema,
  DaemonAuthenticateMcpServerRequestSchema,
  DaemonClearMcpAuthRequestSchema,
  DaemonCancelMcpAuthRequestSchema,
  DaemonAddMcpServerRequestSchema,
  DaemonRemoveMcpServerRequestSchema,
  DaemonListMcpRegistryRequestSchema,
  DaemonListMcpRegistryResultSchema,
  DaemonListMcpToolsRequestSchema,
  DaemonListMcpToolsResultSchema,
  DaemonListMcpServersRequestSchema,
  DaemonListMcpServersResultSchema,
  DaemonToggleMcpToolRequestSchema,
  DaemonSubmitMcpAuthCodeRequestSchema,
  DaemonSubmitMcpAuthErrorRequestSchema,
  McpSuccessResultSchema,
  DaemonCreateTerminalRequestSchema,
  CreateTerminalResultSchema,
  DaemonWriteDataRequestSchema,
  WriteDataResultSchema,
  DaemonResizeRequestSchema,
  ResizeResultSchema,
  DaemonCloseTerminalRequestSchema,
  CloseTerminalResultSchema,
  DaemonListTerminalsRequestSchema,
  ListTerminalsResultSchema,
  DaemonListFilesRequestSchema,
  DaemonListFilesResultSchema,
  DaemonSearchFilesRequestSchema,
  DaemonSearchFilesResultSchema,
  DaemonSearchSessionsRequestSchema,
  DaemonSearchSessionsResultSchema,
  DaemonArchiveSessionRequestSchema,
  DaemonArchiveSessionResultSchema,
  DaemonUnarchiveSessionRequestSchema,
  DaemonUnarchiveSessionResultSchema,
  DaemonRenameSessionRequestSchema,
  DaemonRenameSessionResultSchema,
  DaemonListSkillsRequestSchema,
  DaemonListSkillsResultSchema,
  DaemonListCommandsRequestSchema,
  DaemonListCommandsResultSchema,
  DaemonListAvailablePluginsRequestSchema,
  DaemonListAvailablePluginsResultSchema,
  DaemonListInstalledPluginsRequestSchema,
  DaemonListInstalledPluginsResultSchema,
  DaemonInstallPluginRequestSchema,
  DaemonInstallPluginResultSchema,
  DaemonUninstallPluginRequestSchema,
  DaemonUninstallPluginResultSchema,
  DaemonSetPluginEnabledRequestSchema,
  DaemonSetPluginEnabledResultSchema,
  DaemonUpdatePluginRequestSchema,
  DaemonUpdatePluginResultSchema,
  DaemonListMarketplacesRequestSchema,
  DaemonListMarketplacesResultSchema,
  DaemonAddMarketplaceRequestSchema,
  DaemonAddMarketplaceResultSchema,
  DaemonRemoveMarketplaceRequestSchema,
  DaemonRemoveMarketplaceResultSchema,
  DaemonUpdateMarketplaceRequestSchema,
  DaemonUpdateMarketplaceResultSchema,
  DaemonSubmitBugReportRequestSchema,
  DaemonSubmitBugReportResultSchema,
  DaemonGetRewindInfoRequestSchema,
  DaemonGetRewindInfoResultSchema,
  DaemonExecuteRewindRequestSchema,
  DaemonExecuteRewindResultSchema,
  DaemonCompactSessionRequestSchema,
  DaemonCompactSessionResultSchema,
  DaemonForkSessionRequestSchema,
  DaemonForkSessionResultSchema,
  DaemonGetContextBreakdownRequestSchema,
  DaemonGetContextBreakdownResultSchema,
  DaemonWarmupCacheRequestSchema,
  DaemonListAutomationsRequestSchema,
  DaemonListAutomationsResultSchema,
  DaemonRunAutomationRequestSchema,
  DaemonRunAutomationResultSchema,
  DaemonPauseAutomationRequestSchema,
  DaemonPauseAutomationResultSchema,
  DaemonResumeAutomationRequestSchema,
  DaemonResumeAutomationResultSchema,
  DaemonGetAutomationHistoryRequestSchema,
  DaemonGetAutomationHistoryResultSchema,
  DaemonGetAutomationVisualRequestSchema,
  DaemonGetAutomationVisualResultSchema,
  DaemonCreateAutomationRequestSchema,
  DaemonCreateAutomationResultSchema,
  DaemonUpdateAutomationModelRequestSchema,
  DaemonUpdateAutomationModelResultSchema,
  DaemonUpdateAutomationPrivacyRequestSchema,
  DaemonUpdateAutomationPrivacyResultSchema,
  DaemonUpdateAutomationPromptRequestSchema,
  DaemonUpdateAutomationPromptResultSchema,
  DaemonUpdateAutomationScheduleRequestSchema,
  DaemonUpdateAutomationScheduleResultSchema,
  DaemonRenameAutomationRequestSchema,
  DaemonRenameAutomationResultSchema,
  DaemonDeleteAutomationRequestSchema,
  DaemonDeleteAutomationResultSchema,
  DaemonForkAutomationRequestSchema,
  DaemonForkAutomationResultSchema,
  DaemonApplyAutomationConfigRequestSchema,
  DaemonApplyAutomationConfigResultSchema,
  DaemonListCronsRequestSchema,
  DaemonListCronsResultSchema,
  DaemonCreateCronRequestSchema,
  DaemonCreateCronResultSchema,
  DaemonUpdateCronRequestSchema,
  DaemonUpdateCronResultSchema,
  DaemonDeleteCronRequestSchema,
  DaemonDeleteCronResultSchema,
  DaemonHoldSessionCronsRequestSchema,
  DaemonHoldSessionCronsResultSchema,
  DaemonResumeSessionCronsRequestSchema,
  DaemonResumeSessionCronsResultSchema,
  DaemonTriggerUpdateRequestSchema,
  DaemonTriggerUpdateResultSchema,
  DaemonInstallSshKeyRequestSchema,
  DaemonInstallSshKeyResultSchema,
  DaemonGetGitDiffRequestSchema,
  DaemonGetGitDiffResultSchema,
  DaemonInspectMissionReadinessRequestSchema,
  DaemonInspectMissionReadinessResultSchema,
  DaemonGitPushRequestSchema,
  DaemonGitPushResultSchema,
  DaemonGitCommitRequestSchema,
  DaemonGitCommitResultSchema,
  DaemonCreatePRRequestSchema,
  DaemonCreatePRResultSchema,
  DaemonGetSemanticDiffCacheRequestSchema,
  DaemonGetSemanticDiffCacheResultSchema,
  DaemonSaveSemanticDiffCacheRequestSchema,
  DaemonSaveSemanticDiffCacheResultSchema,
  DaemonGenerateSemanticDiffRequestSchema,
  DaemonGenerateSemanticDiffResultSchema,
  DaemonSessionNotificationSchema,
  DaemonGetProxyTokenRequestSchema,
  DaemonGetProxyTokenResultSchema,
  type DaemonGetWorkspaceFileContentRequestParams,
  DaemonGetWorkspaceFileContentRequestSchema,
  DaemonGetWorkspaceFileContentResultSchema,
  DaemonRelayMethod,
  DaemonRelayStartRequestSchema,
  DaemonRelayStartResultSchema,
  DaemonRelayStopRequestSchema,
  DaemonRelayStopResultSchema,
  DaemonRelayGetStatusRequestSchema,
  DaemonRelayGetStatusResultSchema,
  type DaemonRequestPermissionResult,
  type DaemonAskUserResult,
  type DaemonSessionNotificationParams,
  MachineType,
} from '@industry/common/daemon';
import {
  INDUSTRY_PROTOCOL_VERSION,
  LEGACY_INDUSTRY_API_VERSION,
  JSONRPC_VERSION,
  SessionNotificationType,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  type CommandAck,
  type TraceContextMeta,
  JsonRpcBaseRequestSchema,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  type Attributes,
  IndustryDaemonTransport,
  ClientUiSurface,
  OtelTracing,
  SpanName,
  SpanAttribute,
} from '@industry/logging/tracing';

import {
  ClientDestroyedError,
  ConnectionClosedError,
  DaemonClientError,
  JsonRpcRequestError,
  RequestTimeoutError,
} from './errors';
import {
  DaemonClientTransportKind,
  type DaemonClientTransport,
} from './transports';

import type {
  BuildDaemonRequestOptions,
  DaemonClientConfig,
  PendingRequest,
} from './types';

const DEFAULT_REQUEST_TIMEOUT = 30000;
const COMPACTION_REQUEST_TIMEOUT = 240000;

type DaemonClientRequest = z.infer<typeof JsonRpcBaseRequestSchema>;

type AckNotificationWaiter = {
  resultSchema: z.ZodTypeAny;
  mapNotification: (
    notification: DaemonSessionNotificationParams['notification']
  ) => unknown | undefined;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
};

export class DaemonClient {
  private transport: DaemonClientTransport;

  private pendingRequests = new Map<string, PendingRequest>();

  private ackNotificationWaiters = new Map<string, AckNotificationWaiter>();

  private config: {
    requestTimeout: number;
  };

  /** industry.* attributes describing the daemon this client talks to. */
  private readonly machineTraceAttributes: Attributes;

  private messageInterceptor: ((data: string) => void) | null = null;

  private readonly transportMessageHandler = (data: string) => {
    this.handleMessage(data);
  };

  private readonly transportCloseHandler = (code: number, reason: string) => {
    this.rejectPendingRequests(code, reason);
  };

  // Auth queue: non-auth requests wait for this to resolve
  private authPromise: Promise<void> | null = null;

  private authResolve: (() => void) | null = null;

  /** Client surface from config, used in auth metadata (not span attributes). */
  private readonly clientSurface: ClientUiSurface | undefined;

  /**
   * Async hook invoked from sendRequest before any JSON-RPC request whose
   * params include a sessionId. Awaited before the request is sent; if it
   * throws or rejects, the originating request rejects with the same error.
   */
  private beforeRequest:
    | ((sessionId: string, method: string) => Promise<void>)
    | null = null;

  constructor(config: DaemonClientConfig) {
    this.transport = config.transport;
    this.config = {
      requestTimeout: config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
    };
    this.clientSurface = config.clientSurface;
    this.machineTraceAttributes = DaemonClient.buildMachineTraceAttributes(
      config,
      this.transport
    );

    this.transport.on('message', this.transportMessageHandler);
    this.transport.on('close', this.transportCloseHandler);
  }

  private static buildMachineTraceAttributes(
    config: DaemonClientConfig,
    transport: DaemonClientTransport
  ): Attributes {
    const daemonTransport: IndustryDaemonTransport =
      transport.isRelayConnection()
        ? IndustryDaemonTransport.WsRelay
        : transport.getTransportKind() === DaemonClientTransportKind.Ipc
          ? IndustryDaemonTransport.Ipc
          : transport.getTransportKind() === DaemonClientTransportKind.InProcess
            ? IndustryDaemonTransport.InProcess
            : config.machineType === MachineType.Local
              ? IndustryDaemonTransport.WsLocalhost
              : IndustryDaemonTransport.WsDirect;
    // industry.client.surface lives on the resource, not per-span.
    const attrs: Attributes = {
      [SpanAttribute.INDUSTRY_MACHINE_TYPE]: config.machineType,
      [SpanAttribute.INDUSTRY_DAEMON_TRANSPORT]: daemonTransport,
    };
    if (config.machineType === MachineType.Computer) {
      attrs[SpanAttribute.INDUSTRY_MACHINE_PROVIDER] = config.providerType;
    }
    return attrs;
  }

  // Connection control
  async connect(url: string): Promise<void> {
    await this.transport.connect(url);
  }

  disconnect(): void {
    this.transport.disconnect();
  }

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  getConnectionId(): string | null {
    return this.transport.getConnectionId();
  }

  // Message interception for notifications
  onMessage(handler: (data: string) => void): void {
    this.messageInterceptor = handler;
  }

  /**
   * Register an async hook that runs before every JSON-RPC request whose
   * params include a sessionId. Receives the sessionId and method name.
   * A second call replaces the previous hook.
   */
  setBeforeRequest(
    hook: (sessionId: string, method: string) => Promise<void>
  ): void {
    this.beforeRequest = hook;
  }

  // Connection event hooks
  onConnectionOpen(handler: () => void): void {
    this.transport.on('open', handler);
  }

  onConnectionClose(handler: (code: number, reason: string) => void): void {
    this.transport.on('close', handler);
  }

  onConnectionError(handler: (error: Error) => void): void {
    this.transport.on('error', handler);
  }

  /** Machine context for the authenticate handshake's metadata.tracing. */
  getTracingMetadata(): {
    machineType?: string;
    machineProvider?: string;
    daemonTransport?: string;
  } {
    const attrs = this.machineTraceAttributes;
    return {
      machineType: attrs[SpanAttribute.INDUSTRY_MACHINE_TYPE] as
        | string
        | undefined,
      machineProvider: attrs[SpanAttribute.INDUSTRY_MACHINE_PROVIDER] as
        | string
        | undefined,
      daemonTransport: attrs[SpanAttribute.INDUSTRY_DAEMON_TRANSPORT] as
        | string
        | undefined,
    };
  }

  getClientSurface(): ClientUiSurface | undefined {
    return this.clientSurface;
  }

  /**
   * In-process-only coordination hook used by DaemonSessionController to
   * de-dupe concurrent session-ready calls. Forwarded to the transport iff
   * the transport supports it (InProcessDaemonClientTransport does); for
   * WS/IPC transports the call is a no-op because dedup happens
   * implicitly through the JSON-RPC request id map.
   *
   * TODO: Remove this when in-process parent mode can rely on daemon
   * capability composition instead of a transport-specific readiness hook.
   */
  setPendingSessionReady(sessionId: string, promise: Promise<unknown>): void {
    const transport = this.transport as DaemonClientTransport & {
      setPendingSessionReady?: (id: string, p: Promise<unknown>) => void;
    };
    transport.setPendingSessionReady?.(sessionId, promise);
  }

  // Authentication
  async authenticate(
    params: z.infer<typeof DaemonAuthenticateRequestSchema>['params']
  ) {
    return OtelTracing.trace(SpanName.WEB_DAEMON_AUTHENTICATE, async () => {
      // Set up auth promise that other requests will await
      this.authPromise = new Promise((resolve) => {
        this.authResolve = resolve;
      });

      const request = DaemonClient.buildDaemonRequest({
        method: DaemonConnectionMethod.AUTHENTICATE,
        id: DaemonClient.generateRequestId(),
        params,
      });
      const validated = DaemonAuthenticateRequestSchema.parse(request);
      try {
        const result = await this.sendRequest(
          validated,
          DaemonAuthenticateResultSchema
        );
        this.authResolve?.();
        return result;
      } finally {
        // Always settle the auth gate so queued non-auth requests fail
        // fast instead of deadlocking when authenticate rejects.
        this.authResolve?.();
        this.authPromise = null;
      }
    });
  }

  logout() {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonConnectionMethod.LOGOUT,
      id: DaemonClient.generateRequestId(),
      params: {},
    });
    const validated = DaemonLogoutRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonLogoutResultSchema);
  }

  // Session methods
  initializeSession(
    params: z.infer<typeof DaemonInitializeSessionRequestSchema>['params'],
    options?: { timeout?: number }
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.INITIALIZE_SESSION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonInitializeSessionRequestSchema.parse(request);
    return this.sendRequest(
      validated,
      DaemonInitializeSessionResultSchema,
      options?.timeout
    );
  }

  loadSession(
    params: z.infer<typeof DaemonLoadSessionRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.LOAD_SESSION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonLoadSessionRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonLoadSessionResultSchema);
  }

  addUserMessage(
    params: z.infer<typeof DaemonAddUserMessageRequestSchema>['params'],
    requestId?: string
  ) {
    return this.sendAddUserMessageRequest(params, requestId);
  }

  addUserMessageWithoutSessionLoadGuard(
    params: z.infer<typeof DaemonAddUserMessageRequestSchema>['params'],
    requestId?: string
  ) {
    return this.sendAddUserMessageRequest(params, requestId, {
      skipBeforeRequest: true,
    });
  }

  private sendAddUserMessageRequest(
    params: z.infer<typeof DaemonAddUserMessageRequestSchema>['params'],
    requestId?: string,
    options?: { skipBeforeRequest?: boolean }
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.ADD_USER_MESSAGE,
      id: requestId ?? DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonAddUserMessageRequestSchema.parse(request);
    return this.sendAckCompatibleRequest({
      request: validated,
      responseSchema: DaemonAddUserMessageResultSchema,
      mapNotification: (notification) =>
        notification.type === SessionNotificationType.CREATE_MESSAGE
          ? {}
          : undefined,
      skipBeforeRequest: options?.skipBeforeRequest,
    });
  }

  resolveQueuedUserMessage(
    params: z.infer<
      typeof DaemonResolveQueuedUserMessageRequestSchema
    >['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.RESOLVE_QUEUED_USER_MESSAGE,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated =
      DaemonResolveQueuedUserMessageRequestSchema.parse(request);
    return this.sendAckCompatibleRequest({
      request: validated,
      responseSchema: DaemonResolveQueuedUserMessageResultSchema,
      mapNotification: (notification) =>
        notification.type === SessionNotificationType.CREATE_MESSAGE
          ? {}
          : undefined,
    });
  }

  interruptSession(
    params: z.infer<typeof DaemonInterruptSessionRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.INTERRUPT_SESSION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonInterruptSessionRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonInterruptSessionResultSchema);
  }

  closeSession(
    params: z.infer<typeof DaemonCloseSessionRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.CLOSE_SESSION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonCloseSessionRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonCloseSessionResultSchema);
  }

  killWorkerSession(
    params: z.infer<typeof DaemonKillWorkerSessionRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.KILL_WORKER_SESSION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonKillWorkerSessionRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonKillWorkerSessionResultSchema);
  }

  listOpenedSessions(
    params: z.infer<typeof DaemonListOpenedSessionsRequestSchema>['params'] = {}
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.LIST_OPENED_SESSIONS,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonListOpenedSessionsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListOpenedSessionsResultSchema);
  }

  listAvailableSessions(
    params: z.infer<typeof DaemonListAvailableSessionsRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.LIST_AVAILABLE_SESSIONS,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonListAvailableSessionsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListAvailableSessionsResultSchema);
  }

  getSessionMessages(
    params: z.infer<typeof DaemonGetSessionMessagesRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.GET_SESSION_MESSAGES,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonGetSessionMessagesRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonGetSessionMessagesResultSchema);
  }

  updateSessionSettings(
    params: z.infer<typeof DaemonUpdateSessionSettingsRequestSchema>['params']
  ) {
    logInfo('[DaemonClient] updateSessionSettings called', {
      sessionId: params.sessionId,
      sessionTags: JSON.stringify(params.tags),
      hasInteractionMode: params.interactionMode !== undefined,
    });
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.UPDATE_SESSION_SETTINGS,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonUpdateSessionSettingsRequestSchema.parse(request);
    return this.sendAckCompatibleRequest({
      request: validated,
      responseSchema: DaemonUpdateSessionSettingsResultSchema,
      mapNotification: (notification) =>
        notification.type === SessionNotificationType.SETTINGS_UPDATED
          ? {}
          : undefined,
    });
  }

  validateWorkingDirectory(
    params: z.infer<
      typeof DaemonValidateWorkingDirectoryRequestSchema
    >['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.VALIDATE_WORKING_DIRECTORY,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated =
      DaemonValidateWorkingDirectoryRequestSchema.parse(request);
    return this.sendRequest(
      validated,
      DaemonValidateWorkingDirectoryResultSchema
    );
  }

  // Settings methods
  getDefaultSettings() {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonSettingsMethod.GET_DEFAULT_SETTINGS,
      id: DaemonClient.generateRequestId(),
      params: {},
    });
    const validated = DaemonGetDefaultSettingsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonGetDefaultSettingsResultSchema);
  }

  updateSessionDefaults(
    params: z.infer<typeof DaemonUpdateSessionDefaultsRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonSettingsMethod.UPDATE_SESSION_DEFAULTS,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonUpdateSessionDefaultsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonUpdateSessionDefaultsResultSchema);
  }

  listCustomModels() {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonSettingsMethod.LIST_CUSTOM_MODELS,
      id: DaemonClient.generateRequestId(),
      params: {},
    });
    const validated = DaemonListCustomModelsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListCustomModelsResultSchema);
  }

  upsertCustomModel(
    params: z.infer<typeof DaemonUpsertCustomModelRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonSettingsMethod.UPSERT_CUSTOM_MODEL,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonUpsertCustomModelRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonUpsertCustomModelResultSchema);
  }

  deleteCustomModel(
    params: z.infer<typeof DaemonDeleteCustomModelRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonSettingsMethod.DELETE_CUSTOM_MODEL,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonDeleteCustomModelRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonDeleteCustomModelResultSchema);
  }

  triggerUpdate() {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonManagementMethod.TRIGGER_UPDATE,
      id: DaemonClient.generateRequestId(),
      params: {},
    });
    const validated = DaemonTriggerUpdateRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonTriggerUpdateResultSchema);
  }

  installSshKey(publicKey: string) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonManagementMethod.INSTALL_SSH_KEY,
      id: DaemonClient.generateRequestId(),
      params: { publicKey },
    });
    const validated = DaemonInstallSshKeyRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonInstallSshKeyResultSchema);
  }

  // Relay methods
  startRelay() {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonRelayMethod.START,
      id: DaemonClient.generateRequestId(),
      params: {},
    });
    const validated = DaemonRelayStartRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonRelayStartResultSchema);
  }

  stopRelay() {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonRelayMethod.STOP,
      id: DaemonClient.generateRequestId(),
      params: {},
    });
    const validated = DaemonRelayStopRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonRelayStopResultSchema);
  }

  getRelayStatus() {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonRelayMethod.GET_STATUS,
      id: DaemonClient.generateRequestId(),
      params: {},
    });
    const validated = DaemonRelayGetStatusRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonRelayGetStatusResultSchema);
  }

  // Terminal methods
  createTerminal(
    params: z.infer<typeof DaemonCreateTerminalRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonTerminalMethod.CREATE,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonCreateTerminalRequestSchema.parse(request);
    return this.sendRequest(validated, CreateTerminalResultSchema);
  }

  writeTerminalData(
    params: z.infer<typeof DaemonWriteDataRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonTerminalMethod.WRITE_DATA,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonWriteDataRequestSchema.parse(request);
    return this.sendRequest(validated, WriteDataResultSchema);
  }

  resizeTerminal(params: z.infer<typeof DaemonResizeRequestSchema>['params']) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonTerminalMethod.RESIZE,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonResizeRequestSchema.parse(request);
    return this.sendRequest(validated, ResizeResultSchema);
  }

  closeTerminal(
    params: z.infer<typeof DaemonCloseTerminalRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonTerminalMethod.CLOSE,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonCloseTerminalRequestSchema.parse(request);
    return this.sendRequest(validated, CloseTerminalResultSchema);
  }

  listTerminals(
    params: z.infer<typeof DaemonListTerminalsRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonTerminalMethod.LIST,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonListTerminalsRequestSchema.parse(request);
    return this.sendRequest(validated, ListTerminalsResultSchema);
  }

  // File methods
  listFiles(params: z.infer<typeof DaemonListFilesRequestSchema>['params']) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.LIST_FILES,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonListFilesRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListFilesResultSchema);
  }

  searchFiles(
    params: z.infer<typeof DaemonSearchFilesRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.SEARCH_FILES,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonSearchFilesRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonSearchFilesResultSchema);
  }

  searchSessions(
    params: z.infer<typeof DaemonSearchSessionsRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.SEARCH_SESSIONS,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonSearchSessionsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonSearchSessionsResultSchema);
  }

  // MCP methods
  getMcpConfig() {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.GET_MCP_CONFIG,
      id: DaemonClient.generateRequestId(),
      params: {},
    });
    const validated = DaemonGetMcpConfigRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonGetMcpConfigResultSchema);
  }

  updateMcpConfig(
    params: z.infer<typeof DaemonUpdateMcpConfigRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.UPDATE_MCP_CONFIG,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonUpdateMcpConfigRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonUpdateMcpConfigResultSchema);
  }

  toggleMcpServer(
    params: z.infer<typeof DaemonToggleMcpServerRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.TOGGLE_MCP_SERVER,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonToggleMcpServerRequestSchema.parse(request);
    return this.sendRequest(validated, McpSuccessResultSchema);
  }

  authenticateMcpServer(
    params: z.infer<typeof DaemonAuthenticateMcpServerRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.AUTHENTICATE_MCP_SERVER,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonAuthenticateMcpServerRequestSchema.parse(request);
    // OAuth requires user interaction (browser login, consent) -- use 5 min timeout
    return this.sendRequest(validated, McpSuccessResultSchema, 300000);
  }

  clearMcpAuth(
    params: z.infer<typeof DaemonClearMcpAuthRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.CLEAR_MCP_AUTH,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonClearMcpAuthRequestSchema.parse(request);
    return this.sendRequest(validated, McpSuccessResultSchema);
  }

  cancelMcpAuth(
    params: z.infer<typeof DaemonCancelMcpAuthRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.CANCEL_MCP_AUTH,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonCancelMcpAuthRequestSchema.parse(request);
    return this.sendRequest(validated, McpSuccessResultSchema);
  }

  addMcpServer(
    params: z.infer<typeof DaemonAddMcpServerRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.ADD_MCP_SERVER,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonAddMcpServerRequestSchema.parse(request);
    return this.sendRequest(validated, McpSuccessResultSchema);
  }

  removeMcpServer(
    params: z.infer<typeof DaemonRemoveMcpServerRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.REMOVE_MCP_SERVER,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonRemoveMcpServerRequestSchema.parse(request);
    return this.sendRequest(validated, McpSuccessResultSchema);
  }

  listMcpRegistry(
    params: z.infer<typeof DaemonListMcpRegistryRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.LIST_MCP_REGISTRY,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonListMcpRegistryRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListMcpRegistryResultSchema);
  }

  listMcpTools(
    params: z.infer<typeof DaemonListMcpToolsRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.LIST_MCP_TOOLS,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonListMcpToolsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListMcpToolsResultSchema);
  }

  listMcpServers(
    params: z.infer<typeof DaemonListMcpServersRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.LIST_MCP_SERVERS,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonListMcpServersRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListMcpServersResultSchema);
  }

  toggleMcpTool(
    params: z.infer<typeof DaemonToggleMcpToolRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.TOGGLE_MCP_TOOL,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonToggleMcpToolRequestSchema.parse(request);
    return this.sendRequest(validated, McpSuccessResultSchema);
  }

  submitMcpAuthCode(
    params: z.infer<typeof DaemonSubmitMcpAuthCodeRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.SUBMIT_MCP_AUTH_CODE,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonSubmitMcpAuthCodeRequestSchema.parse(request);
    return this.sendRequest(validated, McpSuccessResultSchema);
  }

  submitMcpAuthError(
    params: z.infer<typeof DaemonSubmitMcpAuthErrorRequestSchema>['params']
  ) {
    const request = {
      type: 'request',
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: DaemonClient.generateRequestId(),
      method: DaemonDroolMethod.SUBMIT_MCP_AUTH_ERROR,
      params,
    };
    const validated = DaemonSubmitMcpAuthErrorRequestSchema.parse(request);
    return this.sendRequest(validated, McpSuccessResultSchema);
  }

  // Session archive/unarchive methods
  archiveSession(
    params: z.infer<typeof DaemonArchiveSessionRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.ARCHIVE_SESSION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonArchiveSessionRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonArchiveSessionResultSchema);
  }

  unarchiveSession(
    params: z.infer<typeof DaemonUnarchiveSessionRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.UNARCHIVE_SESSION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonUnarchiveSessionRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonUnarchiveSessionResultSchema);
  }

  renameSession(
    params: z.infer<typeof DaemonRenameSessionRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.RENAME_SESSION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonRenameSessionRequestSchema.parse(request);
    return this.sendAckCompatibleRequest({
      request: validated,
      responseSchema: DaemonRenameSessionResultSchema,
      mapNotification: (notification) =>
        notification.type === SessionNotificationType.SESSION_TITLE_UPDATED
          ? { success: true }
          : undefined,
    });
  }

  // Skills methods
  listSkills(params: z.infer<typeof DaemonListSkillsRequestSchema>['params']) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.LIST_SKILLS,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonListSkillsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListSkillsResultSchema);
  }

  // Custom command methods
  listCommands(
    params: z.infer<typeof DaemonListCommandsRequestSchema>['params']
  ) {
    const request = {
      type: 'request',
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: DaemonClient.generateRequestId(),
      method: DaemonDroolMethod.LIST_COMMANDS,
      params,
    };
    const validated = DaemonListCommandsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListCommandsResultSchema);
  }

  // Plugin methods
  listAvailablePlugins(
    params: z.infer<typeof DaemonListAvailablePluginsRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.LIST_AVAILABLE_PLUGINS,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonListAvailablePluginsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListAvailablePluginsResultSchema);
  }

  listInstalledPlugins(
    params: z.infer<typeof DaemonListInstalledPluginsRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.LIST_INSTALLED_PLUGINS,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonListInstalledPluginsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListInstalledPluginsResultSchema);
  }

  installPlugin(
    params: z.infer<typeof DaemonInstallPluginRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.INSTALL_PLUGIN,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonInstallPluginRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonInstallPluginResultSchema);
  }

  uninstallPlugin(
    params: z.infer<typeof DaemonUninstallPluginRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.UNINSTALL_PLUGIN,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonUninstallPluginRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonUninstallPluginResultSchema);
  }

  setPluginEnabled(
    params: z.infer<typeof DaemonSetPluginEnabledRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.SET_PLUGIN_ENABLED,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonSetPluginEnabledRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonSetPluginEnabledResultSchema);
  }

  updatePlugin(
    params: z.infer<typeof DaemonUpdatePluginRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.UPDATE_PLUGIN,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonUpdatePluginRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonUpdatePluginResultSchema);
  }

  listMarketplaces(
    params: z.infer<typeof DaemonListMarketplacesRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.LIST_MARKETPLACES,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonListMarketplacesRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListMarketplacesResultSchema);
  }

  addMarketplace(
    params: z.infer<typeof DaemonAddMarketplaceRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.ADD_MARKETPLACE,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonAddMarketplaceRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonAddMarketplaceResultSchema);
  }

  removeMarketplace(
    params: z.infer<typeof DaemonRemoveMarketplaceRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.REMOVE_MARKETPLACE,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonRemoveMarketplaceRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonRemoveMarketplaceResultSchema);
  }

  updateMarketplace(
    params: z.infer<typeof DaemonUpdateMarketplaceRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.UPDATE_MARKETPLACE,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonUpdateMarketplaceRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonUpdateMarketplaceResultSchema);
  }

  // Bug report methods
  submitBugReport(
    params: z.infer<typeof DaemonSubmitBugReportRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.SUBMIT_BUG_REPORT,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonSubmitBugReportRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonSubmitBugReportResultSchema);
  }

  getRewindInfo(
    params: z.infer<typeof DaemonGetRewindInfoRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.GET_REWIND_INFO,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonGetRewindInfoRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonGetRewindInfoResultSchema);
  }

  executeRewind(
    params: z.infer<typeof DaemonExecuteRewindRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.EXECUTE_REWIND,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonExecuteRewindRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonExecuteRewindResultSchema);
  }

  compactSession(
    params: z.infer<typeof DaemonCompactSessionRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.COMPACT_SESSION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonCompactSessionRequestSchema.parse(request);
    return this.sendRequest(
      validated,
      DaemonCompactSessionResultSchema,
      COMPACTION_REQUEST_TIMEOUT
    );
  }

  forkSession(
    params: z.infer<typeof DaemonForkSessionRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.FORK_SESSION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonForkSessionRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonForkSessionResultSchema);
  }

  warmupCache(
    _params: z.infer<typeof DaemonWarmupCacheRequestSchema>['params']
  ) {
    return Promise.resolve({});
  }

  getContextBreakdown(
    params: z.infer<typeof DaemonGetContextBreakdownRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.GET_CONTEXT_BREAKDOWN,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonGetContextBreakdownRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonGetContextBreakdownResultSchema);
  }

  // Automations methods
  listAutomations(
    params: z.infer<typeof DaemonListAutomationsRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.LIST_AUTOMATIONS,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonListAutomationsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListAutomationsResultSchema);
  }

  runAutomation(
    params: z.infer<typeof DaemonRunAutomationRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.RUN_AUTOMATION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonRunAutomationRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonRunAutomationResultSchema);
  }

  pauseAutomation(
    params: z.infer<typeof DaemonPauseAutomationRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.PAUSE_AUTOMATION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonPauseAutomationRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonPauseAutomationResultSchema);
  }

  resumeAutomation(
    params: z.infer<typeof DaemonResumeAutomationRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.RESUME_AUTOMATION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonResumeAutomationRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonResumeAutomationResultSchema);
  }

  getAutomationHistory(
    params: z.infer<typeof DaemonGetAutomationHistoryRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.GET_AUTOMATION_HISTORY,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonGetAutomationHistoryRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonGetAutomationHistoryResultSchema);
  }

  getAutomationVisual(
    params: z.infer<typeof DaemonGetAutomationVisualRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.GET_AUTOMATION_VISUAL,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonGetAutomationVisualRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonGetAutomationVisualResultSchema);
  }

  createAutomation(
    params: z.infer<typeof DaemonCreateAutomationRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.CREATE_AUTOMATION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonCreateAutomationRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonCreateAutomationResultSchema);
  }

  updateAutomationModel(
    params: z.infer<typeof DaemonUpdateAutomationModelRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.UPDATE_AUTOMATION_MODEL,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonUpdateAutomationModelRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonUpdateAutomationModelResultSchema);
  }

  updateAutomationPrivacy(
    params: z.infer<typeof DaemonUpdateAutomationPrivacyRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.UPDATE_AUTOMATION_PRIVACY,
      id: DaemonClient.generateRequestId(),
      params,
      includeProtocolVersion: false,
    });
    const validated = DaemonUpdateAutomationPrivacyRequestSchema.parse(request);
    return this.sendRequest(
      validated,
      DaemonUpdateAutomationPrivacyResultSchema
    );
  }

  updateAutomationPrompt(
    params: z.infer<typeof DaemonUpdateAutomationPromptRequestSchema>['params']
  ) {
    const request = {
      type: 'request',
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: DaemonClient.generateRequestId(),
      method: DaemonDroolMethod.UPDATE_AUTOMATION_PROMPT,
      params,
    };
    const validated = DaemonUpdateAutomationPromptRequestSchema.parse(request);
    return this.sendRequest(
      validated,
      DaemonUpdateAutomationPromptResultSchema
    );
  }

  updateAutomationSchedule(
    params: z.infer<
      typeof DaemonUpdateAutomationScheduleRequestSchema
    >['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.UPDATE_AUTOMATION_SCHEDULE,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated =
      DaemonUpdateAutomationScheduleRequestSchema.parse(request);
    return this.sendRequest(
      validated,
      DaemonUpdateAutomationScheduleResultSchema
    );
  }

  renameAutomation(
    params: z.infer<typeof DaemonRenameAutomationRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.RENAME_AUTOMATION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonRenameAutomationRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonRenameAutomationResultSchema);
  }

  deleteAutomation(
    params: z.infer<typeof DaemonDeleteAutomationRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.DELETE_AUTOMATION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonDeleteAutomationRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonDeleteAutomationResultSchema);
  }

  forkAutomation(
    params: z.infer<typeof DaemonForkAutomationRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.FORK_AUTOMATION,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonForkAutomationRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonForkAutomationResultSchema);
  }

  applyAutomationConfig(
    params: z.infer<typeof DaemonApplyAutomationConfigRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.APPLY_AUTOMATION_CONFIG,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonApplyAutomationConfigRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonApplyAutomationConfigResultSchema);
  }

  listCrons(params: z.infer<typeof DaemonListCronsRequestSchema>['params']) {
    const request = {
      type: 'request',
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: DaemonClient.generateRequestId(),
      method: DaemonDroolMethod.LIST_CRONS,
      params,
    };
    const validated = DaemonListCronsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonListCronsResultSchema);
  }

  createCron(params: z.infer<typeof DaemonCreateCronRequestSchema>['params']) {
    const request = {
      type: 'request',
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: DaemonClient.generateRequestId(),
      method: DaemonDroolMethod.CREATE_CRON,
      params,
    };
    const validated = DaemonCreateCronRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonCreateCronResultSchema);
  }

  updateCron(params: z.infer<typeof DaemonUpdateCronRequestSchema>['params']) {
    const request = {
      type: 'request',
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: DaemonClient.generateRequestId(),
      method: DaemonDroolMethod.UPDATE_CRON,
      params,
    };
    const validated = DaemonUpdateCronRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonUpdateCronResultSchema);
  }

  deleteCron(params: z.infer<typeof DaemonDeleteCronRequestSchema>['params']) {
    const request = {
      type: 'request',
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: DaemonClient.generateRequestId(),
      method: DaemonDroolMethod.DELETE_CRON,
      params,
    };
    const validated = DaemonDeleteCronRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonDeleteCronResultSchema);
  }

  holdSessionCrons(
    params: z.infer<typeof DaemonHoldSessionCronsRequestSchema>['params']
  ) {
    const request = {
      type: 'request',
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: DaemonClient.generateRequestId(),
      method: DaemonDroolMethod.HOLD_SESSION_CRONS,
      params,
    };
    const validated = DaemonHoldSessionCronsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonHoldSessionCronsResultSchema);
  }

  resumeSessionCrons(
    params: z.infer<typeof DaemonResumeSessionCronsRequestSchema>['params']
  ) {
    const request = {
      type: 'request',
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: DaemonClient.generateRequestId(),
      method: DaemonDroolMethod.RESUME_SESSION_CRONS,
      params,
    };
    const validated = DaemonResumeSessionCronsRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonResumeSessionCronsResultSchema);
  }

  getGitDiff(params: z.infer<typeof DaemonGetGitDiffRequestSchema>['params']) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.GET_GIT_DIFF,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonGetGitDiffRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonGetGitDiffResultSchema);
  }

  inspectMissionReadiness(
    params: z.infer<typeof DaemonInspectMissionReadinessRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.INSPECT_MISSION_READINESS,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonInspectMissionReadinessRequestSchema.parse(request);
    return this.sendRequest(
      validated,
      DaemonInspectMissionReadinessResultSchema
    );
  }

  gitPush(params: z.infer<typeof DaemonGitPushRequestSchema>['params']) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.GIT_PUSH,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonGitPushRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonGitPushResultSchema);
  }

  gitCommit(params: z.infer<typeof DaemonGitCommitRequestSchema>['params']) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.GIT_COMMIT,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonGitCommitRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonGitCommitResultSchema);
  }

  createPR(params: z.infer<typeof DaemonCreatePRRequestSchema>['params']) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.CREATE_PR,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonCreatePRRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonCreatePRResultSchema);
  }

  getSemanticDiffCache(
    params: z.infer<typeof DaemonGetSemanticDiffCacheRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.GET_SEMANTIC_DIFF_CACHE,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonGetSemanticDiffCacheRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonGetSemanticDiffCacheResultSchema);
  }

  saveSemanticDiffCache(
    params: z.infer<typeof DaemonSaveSemanticDiffCacheRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.SAVE_SEMANTIC_DIFF_CACHE,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonSaveSemanticDiffCacheRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonSaveSemanticDiffCacheResultSchema);
  }

  generateSemanticDiff(
    params: z.infer<typeof DaemonGenerateSemanticDiffRequestSchema>['params']
  ) {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.GENERATE_SEMANTIC_DIFF,
      id: DaemonClient.generateRequestId(),
      params,
    });
    const validated = DaemonGenerateSemanticDiffRequestSchema.parse(request);
    return this.sendRequest(
      validated,
      DaemonGenerateSemanticDiffResultSchema,
      180000
    );
  }

  getProxyToken() {
    const request = DaemonClient.buildDaemonRequest({
      method: DaemonDroolMethod.GET_PROXY_TOKEN,
      id: DaemonClient.generateRequestId(),
    });
    const validated = DaemonGetProxyTokenRequestSchema.parse(request);
    return this.sendRequest(validated, DaemonGetProxyTokenResultSchema);
  }

  getWorkspaceFileContent(params: DaemonGetWorkspaceFileContentRequestParams) {
    const request = {
      type: 'request',
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: DaemonClient.generateRequestId(),
      method: DaemonDroolMethod.GET_WORKSPACE_FILE_CONTENT,
      params,
    };
    const validated = DaemonGetWorkspaceFileContentRequestSchema.parse(request);
    return this.sendRequest(
      validated,
      DaemonGetWorkspaceFileContentResultSchema
    );
  }

  // Permission response (special case - sends a response, not a request)
  sendPermissionResponse(
    requestId: string,
    result: DaemonRequestPermissionResult
  ): void {
    const response = {
      type: 'response' as const,
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: requestId,
      result,
    };

    this.transport.send(JSON.stringify(response));
  }

  // Ask-user response (special case - sends a response, not a request)
  sendAskUserResponse(requestId: string, result: DaemonAskUserResult): void {
    const response = {
      type: 'response' as const,
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: requestId,
      result,
    };

    this.transport.send(JSON.stringify(response));
  }

  /**
   * Reject all pending requests when the connection closes.
   * Without this, in-flight requests (e.g. daemon.authenticate) would
   * hang until their individual timeouts fire.
   */
  private rejectPendingRequests(code: number, reason: string): void {
    const error = new ConnectionClosedError(code, reason);

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }

    for (const [id, waiter] of this.ackNotificationWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
      this.ackNotificationWaiters.delete(id);
    }
  }

  // Cleanup
  destroy(): void {
    const error = new ClientDestroyedError();
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const [_id, waiter] of this.ackNotificationWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.ackNotificationWaiters.clear();

    this.transport.off('message', this.transportMessageHandler);
    this.transport.off('close', this.transportCloseHandler);
    this.transport.disconnect();
  }

  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  private static generateRequestId(): string {
    return uuidv4();
  }

  private static buildDaemonRequest(
    options: BuildDaemonRequestOptions
  ): Record<string, unknown> {
    const { method, id, params, meta, includeProtocolVersion = true } = options;

    const request: Record<string, unknown> = {
      type: 'request',
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      id,
      method,
    };

    if (includeProtocolVersion) {
      request.industryProtocolVersion = INDUSTRY_PROTOCOL_VERSION;
    }

    // Omit the params key entirely when none supplied, so param-less frames
    // stay param-less on the wire.
    if (params !== undefined) {
      request.params = params;
    }

    if (meta?.traceparent) {
      request._meta = meta;
    }

    return request;
  }

  private static isCommandAckResult(value: unknown): value is CommandAck {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<string, unknown>).accepted === true
    );
  }

  private createAckNotificationWaiter<T extends z.ZodTypeAny>({
    request,
    resultSchema,
    mapNotification,
    timeoutMs,
  }: {
    request: DaemonClientRequest;
    resultSchema: T;
    mapNotification: (
      notification: DaemonSessionNotificationParams['notification']
    ) => z.infer<T> | undefined;
    timeoutMs: number;
  }): {
    promise: Promise<z.infer<T>>;
    cleanup: () => void;
    startTimeout: () => void;
  } {
    const promise = new Promise<z.infer<T>>((resolve, reject) => {
      this.ackNotificationWaiters.set(request.id, {
        resultSchema,
        mapNotification,
        resolve: (result) => resolve(result as z.infer<T>),
        reject,
        timeout: undefined,
      });
    });

    promise.catch(() => {
      // The request may complete with a legacy full response, in which case this
      // speculative waiter is cleaned up without being awaited.
    });

    return {
      promise,
      cleanup: () => {
        const waiter = this.ackNotificationWaiters.get(request.id);
        if (!waiter) return;
        clearTimeout(waiter.timeout);
        this.ackNotificationWaiters.delete(request.id);
      },
      startTimeout: () => {
        const waiter = this.ackNotificationWaiters.get(request.id);
        if (!waiter) return;
        const timeout = setTimeout(() => {
          this.ackNotificationWaiters.delete(request.id);
          waiter.reject(
            new RequestTimeoutError(request.method, request.id, timeoutMs)
          );
        }, timeoutMs);
        timeout.unref?.();
        waiter.timeout = timeout;
      },
    };
  }

  private async sendAckCompatibleRequest<T extends z.ZodTypeAny>({
    request,
    responseSchema,
    mapNotification,
    timeoutOverride,
    skipBeforeRequest,
  }: {
    request: DaemonClientRequest;
    responseSchema: T;
    mapNotification: (
      notification: DaemonSessionNotificationParams['notification']
    ) => z.infer<T> | undefined;
    timeoutOverride?: number;
    skipBeforeRequest?: boolean;
  }): Promise<z.infer<T>> {
    const timeoutMs = timeoutOverride ?? this.config.requestTimeout;
    const waiter = this.createAckNotificationWaiter({
      request,
      resultSchema: responseSchema,
      mapNotification,
      timeoutMs,
    });

    try {
      const result = await this.sendRequest(
        request,
        z.union([DaemonCommandAckResultSchema, responseSchema]),
        timeoutOverride,
        { skipBeforeRequest }
      );

      if (DaemonClient.isCommandAckResult(result)) {
        logInfo('[DaemonClient] Command acknowledged by daemon', {
          method: request.method,
          requestId: request.id,
        });
        waiter.startTimeout();
        return await waiter.promise;
      }

      waiter.cleanup();
      return result;
    } catch (error) {
      waiter.cleanup();
      throw error;
    }
  }

  private async sendRequest<T extends z.ZodTypeAny>(
    request: DaemonClientRequest,
    responseSchema: T,
    timeoutOverride?: number,
    options?: { skipBeforeRequest?: boolean }
  ): Promise<z.infer<T>> {
    const params = request.params as Record<string, unknown> | undefined;
    const sessionId =
      typeof params?.sessionId === 'string' ? params.sessionId : undefined;

    return OtelTracing.trace(
      SpanName.WEB_RPC_REQUEST,
      async (rpcSpan, spanContext) => {
        if (
          sessionId !== undefined &&
          this.beforeRequest &&
          !options?.skipBeforeRequest
        ) {
          await this.beforeRequest(sessionId, request.method);
        }

        // Wait for auth to complete before sending non-auth requests
        if (
          this.authPromise &&
          request.method !== DaemonConnectionMethod.AUTHENTICATE
        ) {
          await this.authPromise;
        }

        if (!this.transport.isConnected()) {
          throw new DaemonClientError('Daemon transport not connected');
        }

        const { id, method } = request;
        const requestTimeout = timeoutOverride ?? this.config.requestTimeout;

        // Inject from the explicit spanContext rather than otelContext.active().
        // Browser (and some runtimes without AsyncHooks) lose the active context
        // across the awaits above, which would drop the traceparent header and
        // cause the daemon to start a fresh trace. Threading spanContext
        // through guarantees the JSON-RPC _meta carries this span's traceparent.
        const _meta: TraceContextMeta = {};
        OtelTracing.injectContext(_meta, spanContext);
        const tracedRequest = _meta.traceparent
          ? { ...request, _meta }
          : request;

        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            rpcSpan.setAttributes({
              [SpanAttribute.INDUSTRY_RPC_TIMED_OUT]: true,
            });
            this.pendingRequests.delete(id);
            reject(new RequestTimeoutError(method, id, requestTimeout));
          }, requestTimeout);

          this.pendingRequests.set(id, {
            resolve,
            reject,
            timeout,
            schema: responseSchema,
          });
          this.transport.send(JSON.stringify(tracedRequest));
        });
      },
      {
        attributes: {
          [SpanAttribute.RPC_METHOD]: request.method,
          [SpanAttribute.RPC_REQUEST_ID]: request.id,
          ...this.machineTraceAttributes,
          ...(sessionId && { [SpanAttribute.SESSION_ID]: sessionId }),
        },
      }
    );
  }

  private handleAckCompatibleNotification(
    message: Record<string, unknown>
  ): void {
    if (
      this.ackNotificationWaiters.size === 0 ||
      message.type !== 'notification' ||
      message.method !== 'daemon.session_notification'
    ) {
      return;
    }

    const parseResult = DaemonSessionNotificationSchema.safeParse(message);
    if (!parseResult.success) {
      return;
    }

    const { notification } = parseResult.data.params;
    if (
      !('requestId' in notification) ||
      typeof notification.requestId !== 'string'
    ) {
      return;
    }

    const waiter = this.ackNotificationWaiters.get(notification.requestId);
    if (!waiter) {
      return;
    }

    const mappedResult = waiter.mapNotification(notification);
    if (mappedResult === undefined) {
      return;
    }

    const validationResult = waiter.resultSchema.safeParse(mappedResult);
    clearTimeout(waiter.timeout);
    this.ackNotificationWaiters.delete(notification.requestId);

    if (!validationResult.success) {
      waiter.reject(
        new MetaError('ACK notification result validation failed', {
          cause: validationResult.error,
        })
      );
      return;
    }

    waiter.resolve(validationResult.data);
  }

  private handleMessage(data: string): void {
    // Let consumers intercept for notifications
    if (this.messageInterceptor) {
      this.messageInterceptor(data);
    }

    try {
      const message = JSON.parse(data);
      if (message && typeof message === 'object') {
        this.handleAckCompatibleNotification(
          message as Record<string, unknown>
        );
      }

      // Only handle responses for our pending requests
      if (message.id && this.pendingRequests.has(message.id)) {
        const pending = this.pendingRequests.get(message.id)!;
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(
            new JsonRpcRequestError(
              `RPC Error: ${message.error.message}`,
              message.error,
              message.id
            )
          );
          return;
        }

        if (message.result === undefined) {
          pending.reject(
            new JsonRpcRequestError(
              'Response missing result field',
              { code: -32600, message: 'Response missing result field' },
              message.id
            )
          );
          return;
        }

        try {
          const validated = pending.schema.parse(message.result);
          pending.resolve(validated);
        } catch (error) {
          logWarn('[DaemonClient] Response validation failed', {
            cause: error,
          });
          pending.reject(
            new MetaError('Response validation failed', { cause: error })
          );
        }
      }
    } catch (error) {
      logWarn('[DaemonClient] Failed to parse message', { data, error });
    }
  }
}
