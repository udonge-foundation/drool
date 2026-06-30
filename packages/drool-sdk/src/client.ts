import EventEmitter from 'events';

import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import {
  AddMcpServerResponseSchema,
  AddUserMessageResponseSchema,
  AuthenticateMcpServerResponseSchema,
  CancelMcpAuthResponseSchema,
  ClearMcpAuthResponseSchema,
  CliRequestOrNotificationSchema,
  CloseSessionResponseSchema,
  CompactSessionResponseSchema,
  DroolClientMethod,
  DroolErrorType,
  DroolServerMethod,
  ExecuteRewindResponseSchema,
  INDUSTRY_PROTOCOL_VERSION,
  ForkSessionRequestParamsSchema,
  ForkSessionResponseSchema,
  GetContextBreakdownResponseSchema,
  GetContextStatsResponseSchema,
  GetRewindInfoResponseSchema,
  InitializeSessionResponseSchema,
  InitializeSessionResultSchema,
  InterruptSessionResponseSchema,
  JSONRPC_VERSION,
  KillWorkerSessionResponseSchema,
  LEGACY_INDUSTRY_API_VERSION,
  ListCommandsResponseSchema,
  ListMcpRegistryResponseSchema,
  ListMcpServersResponseSchema,
  ListMcpToolsResponseSchema,
  ListSkillsResponseSchema,
  ListToolsResponseSchema,
  LoadSessionResponseSchema,
  QueuePlacement,
  RemoveMcpServerResponseSchema,
  RenameSessionResponseSchema,
  RequestPermissionResultSchema,
  ResolveQueuedUserMessageResponseSchema,
  SessionNotificationType,
  SubmitBugReportResponseSchema,
  SubmitMcpAuthCodeRequestParamsSchema,
  SubmitMcpAuthCodeResponseSchema,
  SubmitMcpAuthErrorRequestParamsSchema,
  SubmitMcpAuthErrorResponseSchema,
  ToggleMcpServerResponseSchema,
  ToggleMcpToolResponseSchema,
  ToolConfirmationOutcome,
  UpdateSessionSettingsResponseSchema,
  WarmupCacheResponseSchema,
  type KillWorkerSessionRequest,
  type KillWorkerSessionParams,
  type KillWorkerSessionResponse,
  type RequestPermissionResponse,
  type RequestPermissionResult,
  type GetContextStatsRequest,
  type GetContextBreakdownRequest,
  type ToggleMcpServerRequest,
  type AuthenticateMcpServerRequest,
  type CancelMcpAuthRequest,
  type ClearMcpAuthRequest,
  type SessionNotificationEvent,
  type SessionNotification,
  type AddMcpServerRequest,
  type RemoveMcpServerRequest,
  type ListMcpRegistryRequest,
  type ListMcpToolsRequest,
  type ListToolsRequest,
  type ListToolsParams,
  type ListMcpServersRequest,
  type ToggleMcpToolRequest,
  type SubmitMcpAuthCodeRequest,
  type SubmitMcpAuthErrorRequest,
  type ListSkillsRequest,
  type ListCommandsRequest,
  type SubmitBugReportRequest,
  type RenameSessionRequestParams,
  type AddUserMessageParams,
  type AddUserMessageRequest,
  type AddUserMessageResponse,
  type ResolveQueuedUserMessageParams,
  type ResolveQueuedUserMessageRequest,
  type ResolveQueuedUserMessageResponse,
  type AskUserEvent,
  type AskUserResponse,
  type AskUserResult,
  type ClientRequest,
  type DroolClientOptions,
  type DroolClientTransport,
  type InitializeSessionParams,
  type InitializeSessionRequest,
  type InitializeSessionResponse,
  type InterruptSessionParams,
  type InterruptSessionRequest,
  type InterruptSessionResponse,
  type LoadSessionParams,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type RequestPermissionEvent,
  type UpdateSessionSettingsParams,
  type UpdateSessionSettingsRequest,
  type UpdateSessionSettingsResponse,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  JsonRpcBaseRequest,
  JsonRpcBaseResponse,
  JsonRpcBaseResponseSchema,
  JsonRpcErrorCode,
  type JsonRpcBaseResponseFailure,
  type TraceContextMeta,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logException, logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { OtelTracing } from '@industry/logging/tracing';
import { inspectJsonRpcEnvelope } from '@industry/utils/protocol';

import {
  COMPACTION_TIMEOUT,
  DEFAULT_REQUEST_TIMEOUT,
  MCP_AUTH_TIMEOUT,
  SESSION_INIT_TIMEOUT,
} from './constants';
import { DroolClientEvent } from './enums';
import {
  ConnectionError,
  DroolClientError,
  ProcessExitError,
  ProtocolError,
  SessionError,
  SessionNotFoundError,
  TimeoutError,
} from './errors';
import { DroolEventMap } from './types';

import type { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';

type McpSettingsLevel = SettingsLevel.User;

function getResponseId(response: unknown): string | null | undefined {
  const parsed = JsonRpcBaseResponseSchema.safeParse(response);
  return parsed.success ? parsed.data.id : undefined;
}

/**
 * Derive the JSON-RPC error code for an outgoing failure response. An error can
 * opt into a specific code by setting `metadata.code` on a {@link MetaError}
 * (e.g. {@link JsonRpcErrorCode.CONFLICT} for a duplicate request); anything
 * else falls back to INTERNAL_ERROR.
 */
function resolveJsonRpcErrorCode(error: unknown): JsonRpcErrorCode {
  if (error instanceof MetaError && typeof error.metadata?.code === 'number') {
    return error.metadata.code;
  }
  return JsonRpcErrorCode.INTERNAL_ERROR;
}

export class DroolClient extends EventEmitter<DroolEventMap> {
  private transport: DroolClientTransport;

  private requestTimeout: number;

  private pendingRequests: Map<
    string,
    {
      method: DroolServerMethod;
      resolve: (value: JsonRpcBaseResponse) => void;
      reject: (error: Error) => void;
      timeoutId: NodeJS.Timeout | undefined;
    }
  > = new Map();

  private permissionHandlers: Map<
    string,
    (
      event: RequestPermissionEvent
    ) => Promise<ToolConfirmationOutcome | RequestPermissionResult>
  > = new Map();

  private askUserHandlers: Map<
    string,
    (event: AskUserEvent) => Promise<AskUserResult>
  > = new Map();

  private pendingPermissionRequests: Map<
    string,
    {
      reject: (error: Error) => void;
    }
  > = new Map();

  private pendingAskUserRequests: Map<
    string,
    {
      reject: (error: Error) => void;
    }
  > = new Map();

  private currentSessionId: string | null = null;

  private peerProtocolVersion: string | undefined;

  /**
   * Sticky error from a transport failure. Once set, all subsequent
   * `sendRequest()` calls throw this error immediately, preventing
   * requests from hanging on a dead transport.
   */
  private transportError: Error | null = null;

  constructor(options: DroolClientOptions) {
    super();

    this.transport = options.transport;
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;

    this.transport.onMessage((message: string) => {
      void this.handleMessage(message).catch((error) => {
        // Fallback error handler in case event emitter fails
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit(
          DroolClientEvent.SESSION_NOTIFICATION,
          DroolClient.createNotificationEvent(
            DroolClient.createErrorNotification(err)
          )
        );
      });
    });
    this.transport.onError((error: Error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      logException(err, 'Transport error');
      this.transportError = err;
      this.rejectAllPending(err);
      this.emit(
        DroolClientEvent.SESSION_NOTIFICATION,
        DroolClient.createNotificationEvent(
          DroolClient.createErrorNotification(err)
        )
      );
    });
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  get isConnected(): boolean {
    return this.transport.isConnected;
  }

  private requireMcpOAuthOptOutSupport(): void {
    if (this.peerProtocolVersion === INDUSTRY_PROTOCOL_VERSION) {
      return;
    }

    throw new ProtocolError(
      'MCP OAuth opt-out requires a confirmed matching Drool protocol version. The connected Drool reported an incompatible protocol version and cannot disable OAuth for MCP servers.',
      {
        value: {
          localIndustryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
          peerIndustryProtocolVersion: this.peerProtocolVersion,
        },
      }
    );
  }

  private validateMcpServersProtocolSupport(
    mcpServers: InitializeSessionParams['mcpServers']
  ): void {
    if (
      mcpServers?.some((server) => 'oauth' in server && server.oauth === false)
    ) {
      this.requireMcpOAuthOptOutSupport();
    }
  }

  async initializeSession(
    params: InitializeSessionParams
  ): Promise<InitializeSessionResponse> {
    const request: InitializeSessionRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.INITIALIZE_SESSION,
      params,
    };

    // Use extended timeout for session initialization since it involves
    // spawning CLI process, loading modules, and setting up services
    const rawResponse = await this.sendRequest(request, SESSION_INIT_TIMEOUT);
    const response = InitializeSessionResponseSchema.parse(rawResponse);
    this.peerProtocolVersion = response.industryProtocolVersion;
    if (response.error) {
      throw new ProtocolError('Initialize session request failed', {
        requestId: request.id,
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }
    this.validateMcpServersProtocolSupport(params.mcpServers);
    // This is needed to satisfy type checker
    const result = InitializeSessionResultSchema.parse(response.result);
    this.currentSessionId = result.sessionId;
    return response;
  }

  async loadSession(params: LoadSessionParams): Promise<LoadSessionResponse> {
    const request: LoadSessionRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.LOAD_SESSION,
      params: {
        sessionId: params.sessionId,
        mcpServers: params.mcpServers,
        loadAllMessages: params.loadAllMessages,
        mcpOAuthCallbackUri: params.mcpOAuthCallbackUri,
      },
    };

    // Use extended timeout for session load since it may involve CLI startup
    const rawResponse = await this.sendRequest(request, SESSION_INIT_TIMEOUT);
    // handleResponse already validates with method-specific schema
    const response = LoadSessionResponseSchema.parse(rawResponse);
    this.peerProtocolVersion = response.industryProtocolVersion;
    if (response.error) {
      // Check if this is a session not found error
      const isSessionNotFound =
        response.error.code === JsonRpcErrorCode.ENTITY_NOT_FOUND;

      if (isSessionNotFound) {
        throw new SessionNotFoundError(params.sessionId, {
          requestId: request.id,
          code: response.error.code,
          message: response.error.message,
          data: response.error.data,
        });
      }

      throw new ProtocolError('Load session request failed', {
        requestId: request.id,
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }
    this.validateMcpServersProtocolSupport(params.mcpServers);
    this.currentSessionId = params.sessionId;
    return response;
  }

  async addUserMessage(
    params: AddUserMessageParams,
    requestId?: string
  ): Promise<AddUserMessageResponse> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: AddUserMessageRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: requestId ?? uuidv4(),
      method: DroolServerMethod.ADD_USER_MESSAGE,
      params: {
        text: params.text,
        images: params.images,
        files: params.files,
        ...(params.skipAgentLoop && { skipAgentLoop: params.skipAgentLoop }),
        queuePlacement: params.queuePlacement ?? QueuePlacement.EndOfTurn,
        ...(params.role && { role: params.role }),
        ...(params.visibility && { visibility: params.visibility }),
      },
    };

    const rawResponse = await this.sendRequest(request);
    // handleResponse already validates with method-specific schema
    const response = AddUserMessageResponseSchema.parse(rawResponse);
    if (response.error) {
      throw new ProtocolError('Add user message request failed', {
        requestId: request.id,
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }
    return response;
  }

  async resolveQueuedUserMessage(
    params: ResolveQueuedUserMessageParams
  ): Promise<ResolveQueuedUserMessageResponse> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: ResolveQueuedUserMessageRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.RESOLVE_QUEUED_USER_MESSAGE,
      params,
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = ResolveQueuedUserMessageResponseSchema.parse(rawResponse);
    if (response.error) {
      throw new ProtocolError('Resolve queued user message request failed', {
        requestId: request.id,
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }
    return response;
  }

  async interruptSession(
    params: InterruptSessionParams
  ): Promise<InterruptSessionResponse> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: InterruptSessionRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.INTERRUPT_SESSION,
      params,
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    // handleResponse already validates with method-specific schema
    const response = InterruptSessionResponseSchema.parse(rawResponse);
    if (response.error) {
      throw new ProtocolError('Interrupt session request failed', {
        requestId: request.id,
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }
    return response;
  }

  async killWorkerSession(
    params: KillWorkerSessionParams
  ): Promise<KillWorkerSessionResponse> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: KillWorkerSessionRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.KILL_WORKER_SESSION,
      params,
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    // handleResponse already validates with method-specific schema
    const response = KillWorkerSessionResponseSchema.parse(rawResponse);
    if (response.error) {
      throw new ProtocolError('Kill worker session request failed', {
        requestId: request.id,
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }
    return response;
  }

  async updateSessionSettings(
    params: UpdateSessionSettingsParams,
    requestId?: string
  ): Promise<UpdateSessionSettingsResponse> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: UpdateSessionSettingsRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: requestId ?? uuidv4(),
      method: DroolServerMethod.UPDATE_SESSION_SETTINGS,
      params: {
        modelId: params.modelId,
        reasoningEffort: params.reasoningEffort,
        autonomyMode: params.autonomyMode,
        interactionMode: params.interactionMode,
        autonomyLevel: params.autonomyLevel,
        specModeModelId: params.specModeModelId,
        specModeReasoningEffort: params.specModeReasoningEffort,
        missionSettings: params.missionSettings,
        tags: params.tags,
        compactionTokenLimit: params.compactionTokenLimit,
        compactionThresholdCheckEnabled: params.compactionThresholdCheckEnabled,
        enabledToolIds: params.enabledToolIds,
        disabledToolIds: params.disabledToolIds,
      },
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const responseParsed =
      UpdateSessionSettingsResponseSchema.safeParse(rawResponse);
    if (!responseParsed.success) {
      throw new ProtocolError(
        'Invalid update session settings response format',
        {
          requestId: request.id,
          code: JsonRpcErrorCode.PARSE_ERROR,
          message: responseParsed.error.message,
          data: rawResponse,
        }
      );
    }
    const response = responseParsed.data;
    if (response.error) {
      throw new ProtocolError('Update session settings request failed', {
        requestId: request.id,
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      });
    }
    return response;
  }

  async toggleMcpServer(params: {
    serverName: string;
    enabled: boolean;
    settingsLevel: McpSettingsLevel;
  }): Promise<z.infer<typeof ToggleMcpServerResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: ToggleMcpServerRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.TOGGLE_MCP_SERVER,
      params: {
        serverName: params.serverName,
        enabled: params.enabled,
        settingsLevel: params.settingsLevel,
      },
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = ToggleMcpServerResponseSchema.parse(rawResponse);
    return response;
  }

  async authenticateMcpServer(params: {
    serverName: string;
  }): Promise<z.infer<typeof AuthenticateMcpServerResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: AuthenticateMcpServerRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.AUTHENTICATE_MCP_SERVER,
      params: {
        serverName: params.serverName,
      },
    };

    // Use extended timeout: OAuth requires user interaction (browser login)
    const rawResponse = await this.sendRequest(request, MCP_AUTH_TIMEOUT);
    const response = AuthenticateMcpServerResponseSchema.parse(rawResponse);
    return response;
  }

  async cancelMcpAuth(params: {
    serverName: string;
  }): Promise<z.infer<typeof CancelMcpAuthResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: CancelMcpAuthRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.CANCEL_MCP_AUTH,
      params: {
        serverName: params.serverName,
      },
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = CancelMcpAuthResponseSchema.parse(rawResponse);
    return response;
  }

  async clearMcpAuth(params: {
    serverName: string;
  }): Promise<z.infer<typeof ClearMcpAuthResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: ClearMcpAuthRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.CLEAR_MCP_AUTH,
      params: {
        serverName: params.serverName,
      },
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = ClearMcpAuthResponseSchema.parse(rawResponse);
    return response;
  }

  async addMcpServer(
    params: AddMcpServerRequest['params']
  ): Promise<z.infer<typeof AddMcpServerResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }
    if (params.oauth === false) {
      this.requireMcpOAuthOptOutSupport();
    }

    const request: AddMcpServerRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.ADD_MCP_SERVER,
      params,
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = AddMcpServerResponseSchema.parse(rawResponse);
    return response;
  }

  async removeMcpServer(params: {
    serverName: string;
    settingsLevel: McpSettingsLevel;
  }): Promise<z.infer<typeof RemoveMcpServerResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: RemoveMcpServerRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.REMOVE_MCP_SERVER,
      params,
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = RemoveMcpServerResponseSchema.parse(rawResponse);
    return response;
  }

  async listMcpRegistry(): Promise<
    z.infer<typeof ListMcpRegistryResponseSchema>
  > {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: ListMcpRegistryRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.LIST_MCP_REGISTRY,
      params: {},
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = ListMcpRegistryResponseSchema.parse(rawResponse);
    return response;
  }

  async listMcpTools(): Promise<z.infer<typeof ListMcpToolsResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: ListMcpToolsRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.LIST_MCP_TOOLS,
      params: {},
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = ListMcpToolsResponseSchema.parse(rawResponse);
    return response;
  }

  async listTools(
    params: ListToolsParams = {}
  ): Promise<z.infer<typeof ListToolsResponseSchema>> {
    const request: ListToolsRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.LIST_TOOLS,
      params,
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = ListToolsResponseSchema.parse(rawResponse);
    return response;
  }

  async listMcpServers(): Promise<
    z.infer<typeof ListMcpServersResponseSchema>
  > {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: ListMcpServersRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.LIST_MCP_SERVERS,
      params: {},
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = ListMcpServersResponseSchema.parse(rawResponse);
    return response;
  }

  async toggleMcpTool(
    serverName: string,
    toolName: string,
    enabled: boolean
  ): Promise<z.infer<typeof ToggleMcpToolResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: ToggleMcpToolRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.TOGGLE_MCP_TOOL,
      params: { serverName, toolName, enabled },
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = ToggleMcpToolResponseSchema.parse(rawResponse);
    return response;
  }

  async submitMcpAuthCode(
    params: z.infer<typeof SubmitMcpAuthCodeRequestParamsSchema>
  ): Promise<z.infer<typeof SubmitMcpAuthCodeResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: SubmitMcpAuthCodeRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.SUBMIT_MCP_AUTH_CODE,
      params,
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = SubmitMcpAuthCodeResponseSchema.parse(rawResponse);
    return response;
  }

  async submitMcpAuthError(
    params: z.infer<typeof SubmitMcpAuthErrorRequestParamsSchema>
  ): Promise<z.infer<typeof SubmitMcpAuthErrorResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: SubmitMcpAuthErrorRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.SUBMIT_MCP_AUTH_ERROR,
      params,
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = SubmitMcpAuthErrorResponseSchema.parse(rawResponse);
    return response;
  }

  async listSkills(): Promise<z.infer<typeof ListSkillsResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: ListSkillsRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.LIST_SKILLS,
      params: {},
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = ListSkillsResponseSchema.parse(rawResponse);
    return response;
  }

  async listCommands(): Promise<z.infer<typeof ListCommandsResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: ListCommandsRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.LIST_COMMANDS,
      params: {},
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = ListCommandsResponseSchema.parse(rawResponse);
    return response;
  }

  async getContextStats(): Promise<
    z.infer<typeof GetContextStatsResponseSchema>
  > {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: GetContextStatsRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.GET_CONTEXT_STATS,
      params: {},
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = GetContextStatsResponseSchema.parse(rawResponse);
    return response;
  }

  async getContextBreakdown(): Promise<
    z.infer<typeof GetContextBreakdownResponseSchema>
  > {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: GetContextBreakdownRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.GET_CONTEXT_BREAKDOWN,
      params: {},
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = GetContextBreakdownResponseSchema.parse(rawResponse);
    return response;
  }

  async submitBugReport(
    userComment: string,
    clientLogs?: string
  ): Promise<z.infer<typeof SubmitBugReportResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request: SubmitBugReportRequest = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.SUBMIT_BUG_REPORT,
      params: { userComment, clientLogs },
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    const response = SubmitBugReportResponseSchema.parse(rawResponse);
    return response;
  }

  async getRewindInfo(params: {
    messageId: string;
  }): Promise<z.infer<typeof GetRewindInfoResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.GET_REWIND_INFO as const,
      params: {
        sessionId: this.currentSessionId,
        messageId: params.messageId,
      },
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    return GetRewindInfoResponseSchema.parse(rawResponse);
  }

  async executeRewind(params: {
    messageId: string;
    filesToRestore: Array<{
      filePath: string;
      contentHash: string;
      size: number;
    }>;
    filesToDelete: Array<{ filePath: string }>;
    forkTitle: string;
  }): Promise<z.infer<typeof ExecuteRewindResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.EXECUTE_REWIND as const,
      params: {
        sessionId: this.currentSessionId,
        messageId: params.messageId,
        filesToRestore: params.filesToRestore,
        filesToDelete: params.filesToDelete,
        forkTitle: params.forkTitle,
      },
    };

    const rawResponse = await this.sendRequest(
      request,
      this.requestTimeout * 2
    );
    return ExecuteRewindResponseSchema.parse(rawResponse);
  }

  async compactSession(params: {
    customInstructions?: string;
  }): Promise<z.infer<typeof CompactSessionResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.COMPACT_SESSION as const,
      params: {
        customInstructions: params.customInstructions,
      },
    };

    const rawResponse = await this.sendRequest(request, COMPACTION_TIMEOUT);
    return CompactSessionResponseSchema.parse(rawResponse);
  }

  async forkSession(
    params?: z.infer<typeof ForkSessionRequestParamsSchema>
  ): Promise<z.infer<typeof ForkSessionResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      method: DroolServerMethod.FORK_SESSION as const,
      params: params ?? {},
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    return ForkSessionResponseSchema.parse(rawResponse);
  }

  async renameSession(
    params: RenameSessionRequestParams,
    requestId?: string
  ): Promise<z.infer<typeof RenameSessionResponseSchema>> {
    if (!this.currentSessionId) {
      throw new SessionError(
        'No active session. Call initializeSession or loadSession first.'
      );
    }

    const request = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'request' as const,
      jsonrpc: JSONRPC_VERSION,
      id: requestId ?? uuidv4(),
      method: DroolServerMethod.RENAME_SESSION as const,
      params: {
        title: params.title,
      },
    };

    const rawResponse = await this.sendRequest(request, this.requestTimeout);
    return RenameSessionResponseSchema.parse(rawResponse);
  }

  async warmupCache(): Promise<z.infer<typeof WarmupCacheResponseSchema>> {
    const response = {
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      type: 'response' as const,
      jsonrpc: JSONRPC_VERSION,
      id: uuidv4(),
      result: {},
    };

    return WarmupCacheResponseSchema.parse(response);
  }

  setPermissionHandler(
    handler: (
      event: RequestPermissionEvent
    ) =>
      | Promise<ToolConfirmationOutcome | RequestPermissionResult>
      | ToolConfirmationOutcome
      | RequestPermissionResult
  ): void {
    this.permissionHandlers.set(
      'default',
      async (event) => await handler(event)
    );
  }

  clearPermissionHandler(): void {
    this.permissionHandlers.delete('default');
  }

  setAskUserHandler(
    handler: (event: AskUserEvent) => Promise<AskUserResult> | AskUserResult
  ): void {
    this.askUserHandlers.set('default', async (event) => await handler(event));
  }

  clearAskUserHandler(): void {
    this.askUserHandlers.delete('default');
  }

  async close(): Promise<void> {
    const closeError = new Error(
      'Drool client closed: pending requests cancelled'
    );
    this.rejectAllPending(closeError);
    this.permissionHandlers.clear();
    this.askUserHandlers.clear();
    this.removeAllListeners();
    await this.transport.close();
  }

  private rejectAllPending(error: Error): void {
    this.pendingRequests.forEach(({ timeoutId, reject }) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      reject(error);
    });
    this.pendingRequests.clear();

    this.pendingPermissionRequests.forEach(({ reject }) => {
      reject(error);
    });
    this.pendingPermissionRequests.clear();

    this.pendingAskUserRequests.forEach(({ reject }) => {
      reject(error);
    });
    this.pendingAskUserRequests.clear();
  }

  private async sendRequest(
    request: ClientRequest,
    timeout?: number
  ): Promise<JsonRpcBaseResponse> {
    if (this.transportError) {
      throw this.transportError;
    }
    // Set up a promise that will be resolved when the response arrives
    const responsePromise: Promise<JsonRpcBaseResponse> = new Promise(
      (resolve, reject) => {
        // Set up timeout for the request (if specified)
        const timeoutId = timeout
          ? setTimeout(() => {
              this.pendingRequests.delete(request.id);
              reject(
                new TimeoutError('Send request timed out', {
                  requestId: request.id,
                  method: request.method,
                  timeout,
                })
              );
            }, timeout)
          : undefined;

        // Store promise handlers for when response arrives via handleMessage()
        this.pendingRequests.set(request.id, {
          method: request.method,
          resolve,
          reject,
          timeoutId,
        });
      }
    );

    // Inject trace context from active context (daemon's span if called within trace())
    const _meta: TraceContextMeta = {};
    OtelTracing.injectContext(_meta, OtelTracing.getCurrentContext());
    const requestWithMeta: JsonRpcBaseRequest = _meta.traceparent
      ? { ...request, _meta }
      : request;

    // Send the request to the transport
    try {
      logInfo('[DroolClient] [daemon -> drool] sending request', {
        requestId: request.id,
        method: request.method,
      });
      await this.transport.send(JSON.stringify(requestWithMeta));
    } catch (error) {
      // Send failed: clean up and propagate error
      const pending = this.pendingRequests.get(request.id);
      if (pending) {
        if (pending.timeoutId) {
          clearTimeout(pending.timeoutId);
        }
        this.pendingRequests.delete(request.id);
      }
      throw new ProtocolError('[daemon -> drool] Failed to send request', {
        requestId: request.id,
        cause: error,
      });
    }

    // Wait for response to arrive via handleMessage() → handleResponse()
    return responsePromise;
  }

  private async handleMessage(message: string): Promise<void> {
    try {
      const parsed = JSON.parse(message);

      if ('result' in parsed || 'error' in parsed) {
        this.handleResponse(parsed);
      } else if ('method' in parsed) {
        await this.handleEvent(parsed);
      } else {
        throw new ProtocolError('Invalid message format', {
          message,
        });
      }
    } catch (error) {
      // JSON parse failure or downstream throw. Log and drop; never
      // synthesize a user-visible ERROR notification here.
      logWarn('[DroolClient] Failed to handle message', {
        cause: error,
        preview: message.slice(0, 256),
      });
    }
  }

  private handleResponse(response: unknown): void {
    try {
      // Extract the ID first to look up the request method
      const responseId = getResponseId(response);

      // Only process if we have an ID (error responses may have null ID)
      if (responseId !== null && responseId !== undefined) {
        const pending = this.pendingRequests.get(responseId);

        if (pending) {
          // Use method-specific schema for faster, more accurate validation
          let validatedResponse: JsonRpcBaseResponse;

          switch (pending.method) {
            case DroolServerMethod.INITIALIZE_SESSION:
              validatedResponse =
                InitializeSessionResponseSchema.parse(response);
              break;
            case DroolServerMethod.LOAD_SESSION:
              validatedResponse = LoadSessionResponseSchema.parse(response);
              break;
            case DroolServerMethod.ADD_USER_MESSAGE:
              validatedResponse = AddUserMessageResponseSchema.parse(response);
              break;
            case DroolServerMethod.RESOLVE_QUEUED_USER_MESSAGE:
              validatedResponse =
                ResolveQueuedUserMessageResponseSchema.parse(response);
              break;
            case DroolServerMethod.INTERRUPT_SESSION:
              validatedResponse =
                InterruptSessionResponseSchema.parse(response);
              break;
            case DroolServerMethod.CLOSE_SESSION:
              validatedResponse = CloseSessionResponseSchema.parse(response);
              break;
            case DroolServerMethod.UPDATE_SESSION_SETTINGS:
              validatedResponse =
                UpdateSessionSettingsResponseSchema.parse(response);
              break;
            case DroolServerMethod.TOGGLE_MCP_SERVER:
              validatedResponse = ToggleMcpServerResponseSchema.parse(response);
              break;
            case DroolServerMethod.AUTHENTICATE_MCP_SERVER:
              validatedResponse =
                AuthenticateMcpServerResponseSchema.parse(response);
              break;
            case DroolServerMethod.CANCEL_MCP_AUTH:
              validatedResponse = CancelMcpAuthResponseSchema.parse(response);
              break;
            case DroolServerMethod.CLEAR_MCP_AUTH:
              validatedResponse = ClearMcpAuthResponseSchema.parse(response);
              break;
            case DroolServerMethod.ADD_MCP_SERVER:
              validatedResponse = AddMcpServerResponseSchema.parse(response);
              break;
            case DroolServerMethod.REMOVE_MCP_SERVER:
              validatedResponse = RemoveMcpServerResponseSchema.parse(response);
              break;
            case DroolServerMethod.LIST_MCP_REGISTRY:
              validatedResponse = ListMcpRegistryResponseSchema.parse(response);
              break;
            case DroolServerMethod.LIST_MCP_TOOLS:
              validatedResponse = ListMcpToolsResponseSchema.parse(response);
              break;
            case DroolServerMethod.LIST_TOOLS:
              validatedResponse = ListToolsResponseSchema.parse(response);
              break;
            case DroolServerMethod.TOGGLE_MCP_TOOL:
              validatedResponse = ToggleMcpToolResponseSchema.parse(response);
              break;
            case DroolServerMethod.SUBMIT_MCP_AUTH_CODE:
              validatedResponse =
                SubmitMcpAuthCodeResponseSchema.parse(response);
              break;
            case DroolServerMethod.SUBMIT_MCP_AUTH_ERROR:
              validatedResponse =
                SubmitMcpAuthErrorResponseSchema.parse(response);
              break;
            case DroolServerMethod.KILL_WORKER_SESSION:
              validatedResponse =
                KillWorkerSessionResponseSchema.parse(response);
              break;
            case DroolServerMethod.LIST_SKILLS:
              validatedResponse = ListSkillsResponseSchema.parse(response);
              break;
            case DroolServerMethod.LIST_COMMANDS:
              validatedResponse = ListCommandsResponseSchema.parse(response);
              break;
            case DroolServerMethod.SUBMIT_BUG_REPORT:
              validatedResponse = SubmitBugReportResponseSchema.parse(response);
              break;
            case DroolServerMethod.LIST_MCP_SERVERS:
              validatedResponse = ListMcpServersResponseSchema.parse(response);
              break;
            case DroolServerMethod.GET_REWIND_INFO:
              validatedResponse = GetRewindInfoResponseSchema.parse(response);
              break;
            case DroolServerMethod.EXECUTE_REWIND:
              validatedResponse = ExecuteRewindResponseSchema.parse(response);
              break;
            case DroolServerMethod.COMPACT_SESSION:
              validatedResponse = CompactSessionResponseSchema.parse(response);
              break;
            case DroolServerMethod.FORK_SESSION:
              validatedResponse = ForkSessionResponseSchema.parse(response);
              break;
            case DroolServerMethod.RENAME_SESSION:
              validatedResponse = RenameSessionResponseSchema.parse(response);
              break;
            case DroolServerMethod.GET_CONTEXT_STATS:
              validatedResponse = GetContextStatsResponseSchema.parse(response);
              break;
            case DroolServerMethod.GET_CONTEXT_BREAKDOWN:
              validatedResponse =
                GetContextBreakdownResponseSchema.parse(response);
              break;
            case DroolServerMethod.WARMUP_CACHE:
              validatedResponse = WarmupCacheResponseSchema.parse(response);
              break;
            default: {
              // Exhaustiveness check - TypeScript will error if we missed a method
              const exhaustiveCheck: never = pending.method;
              throw new MetaError('Unsupported method in response handler', {
                method: exhaustiveCheck,
              });
            }
          }

          if (pending.timeoutId) {
            clearTimeout(pending.timeoutId);
          }
          this.pendingRequests.delete(responseId);
          pending.resolve(validatedResponse);
        } else {
          // Response for a request that isn't pending (could be timed out or never sent)
          // Use generic schema as we don't know the method
          const validatedResponse = JsonRpcBaseResponseSchema.parse(response);
          logInfo(
            '[DroolClient] Received response for request not in pending map',
            {
              requestId: validatedResponse.id ?? undefined,
            }
          );
        }
      }
    } catch (error) {
      // A response failed validation or handling. Rather than crashing
      // the pending request with an out-of-band ProtocolError or
      // surfacing a user-visible ERROR notification, synthesize a
      // structurally valid JsonRpcBaseResponseFailure and route it
      // through the normal resolve path so callers see a well-formed
      // failure response (their `if (response.error)` branch will fire).
      //
      // Distinguish failure classes:
      //   - ZodError      → PARSE_ERROR  (schema/shape violation)
      //   - anything else → INTERNAL_ERROR (coding bug, unexpected throw)
      const responseId = getResponseId(response);
      const pending =
        responseId !== null && responseId !== undefined
          ? this.pendingRequests.get(responseId)
          : undefined;
      const zodIssues =
        error instanceof z.ZodError
          ? error.issues.map((issue) => ({
              path: issue.path,
              code: issue.code,
              message: issue.message,
            }))
          : undefined;
      logException(error, 'Invalid response format', {
        method: pending?.method,
        requestId: responseId ?? undefined,
        zodIssues,
      });
      const err = error instanceof Error ? error : new Error(String(error));
      const code =
        error instanceof z.ZodError
          ? JsonRpcErrorCode.PARSE_ERROR
          : JsonRpcErrorCode.INTERNAL_ERROR;
      const message =
        code === JsonRpcErrorCode.PARSE_ERROR
          ? 'Invalid response format'
          : 'Internal error while handling response';

      if (responseId === null || responseId === undefined) {
        // Nothing we can correlate this to; log and drop.
        return;
      }

      if (!pending) {
        // Response for a request that isn't pending (timed out, etc.);
        // log and drop, no user-visible error.
        logInfo(
          '[DroolClient] Dropping unhandleable response with no pending request',
          {
            requestId: responseId,
            code,
            message: err.message,
          }
        );
        return;
      }

      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      this.pendingRequests.delete(responseId);

      const syntheticFailure: JsonRpcBaseResponseFailure = {
        jsonrpc: JSONRPC_VERSION,
        type: 'response',
        industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
        industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
        id: responseId,
        error: {
          code,
          message,
          data: err.message,
        },
      };
      pending.resolve(syntheticFailure);
    }
  }

  private async handleEvent(event: unknown): Promise<void> {
    try {
      const validatedEvent = CliRequestOrNotificationSchema.parse(event);

      if (validatedEvent.method === DroolClientMethod.SESSION_NOTIFICATION) {
        this.emit(DroolClientEvent.SESSION_NOTIFICATION, validatedEvent);
      } else if (
        validatedEvent.method === DroolClientMethod.REQUEST_PERMISSION
      ) {
        await this.handlePermissionRequest(validatedEvent);
      } else if (validatedEvent.method === DroolClientMethod.ASK_USER) {
        await this.handleAskUserRequest(validatedEvent);
      }
    } catch (error) {
      this.logDroppedEventParseError(error, event);

      // If the malformed event was a request (CLI waiting on a reply),
      // respond with a well-formed JSON-RPC failure so the peer's pending
      // promise resolves instead of hanging until timeout.
      await this.replyWithParseFailureIfRequest(error, event);
    }
  }

  /**
   * When an incoming CLI->client request fails to parse, send back a
   * structurally valid JsonRpcBaseResponseFailure so the peer's pending
   * request doesn't hang. No-ops for notifications (no id to reply on)
   * or events we can't correlate.
   */
  private async replyWithParseFailureIfRequest(
    error: unknown,
    event: unknown
  ): Promise<void> {
    const type = DroolClient.getNestedString(event, ['type']);
    const id = DroolClient.getNestedString(event, ['id']);
    if (type !== 'request' || !id) {
      return;
    }

    const err = error instanceof Error ? error : new Error(String(error));
    const code =
      error instanceof z.ZodError
        ? JsonRpcErrorCode.INVALID_REQUEST
        : JsonRpcErrorCode.INTERNAL_ERROR;
    const message =
      code === JsonRpcErrorCode.INVALID_REQUEST
        ? 'Invalid request format'
        : 'Internal error while handling request';

    const errorResponse: JsonRpcBaseResponseFailure = {
      jsonrpc: JSONRPC_VERSION,
      type: 'response',
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id,
      error: {
        code,
        message,
        data: err.message,
      },
    };

    try {
      await this.transport.send(JSON.stringify(errorResponse));
    } catch (sendError) {
      // Best-effort: if the transport itself is broken we can't tell the
      // peer anyway. Log and continue — do not surface a user-visible
      // ERROR notification.
      logException(
        sendError,
        'Failed to send parse-failure response back to peer'
      );
    }
  }

  /**
   * Invariant: parsing failures for incoming events (notifications or
   * server-initiated requests) must NEVER surface as user-visible ERROR
   * notifications. Version skew, unknown inner enum values, missing
   * fields, or malformed shapes all degrade to a log-and-drop so the
   * session continues quietly instead of flashing a synthetic error on
   * every
   */
  private logDroppedEventParseError(error: unknown, event: unknown): void {
    const { protocolVersionMismatch } = inspectJsonRpcEnvelope(event);
    const method = DroolClient.getNestedString(event, ['method']);
    const notificationType = DroolClient.getNestedString(event, [
      'params',
      'notification',
      'type',
    ]);
    const sessionId =
      this.currentSessionId ??
      DroolClient.getNestedString(event, ['params', 'sessionId']);

    const meta = {
      value: {
        method: method ?? undefined,
        notificationType: notificationType ?? undefined,
        protocolVersionMismatch: protocolVersionMismatch ?? undefined,
        sessionId: sessionId ?? undefined,
      },
    };

    // Version skew (the peer advertises a newer protocol) is expected;
    // log at info level. Everything else is a real schema violation and
    // is still logged but at a higher severity for observability.
    if (protocolVersionMismatch) {
      logInfo('[DroolClient] Dropping unsupported event from newer peer', meta);
    } else {
      logWarn('[DroolClient] Dropping malformed event', {
        ...meta,
        cause: error,
      });
    }
  }

  private async handlePermissionRequest(
    event: RequestPermissionEvent
  ): Promise<void> {
    if (this.pendingPermissionRequests.has(event.id)) {
      logInfo('[DroolClient] Ignoring duplicate pending permission request', {
        requestId: event.id,
      });
      return;
    }

    logInfo('[DroolClient] Handling permission request', {
      requestId: event.id,
      toolCount: event.params.toolUses.length,
    });

    this.emit(DroolClientEvent.REQUEST_PERMISSION, event);

    let selectedOption = ToolConfirmationOutcome.Cancel;
    let comment: string | undefined;
    let editedSpecContent: string | undefined;
    const handler = this.permissionHandlers.get('default');
    if (handler) {
      try {
        logInfo('[DroolClient] Waiting for permission handler to resolve', {
          requestId: event.id,
        });

        type HandlerResult = ToolConfirmationOutcome | RequestPermissionResult;

        // Wrap handler call to track and allow cancellation on close
        const handlerPromise = new Promise<HandlerResult>((resolve, reject) => {
          this.pendingPermissionRequests.set(event.id, { reject });
          handler(event)
            .then(resolve)
            .catch(reject)
            .finally(() => {
              this.pendingPermissionRequests.delete(event.id);
            });
        });

        const handlerResult = await handlerPromise;

        const parsedHandlerResult =
          RequestPermissionResultSchema.safeParse(handlerResult);

        if (parsedHandlerResult.success) {
          selectedOption = parsedHandlerResult.data.selectedOption;
          comment = parsedHandlerResult.data.comment;
          editedSpecContent = parsedHandlerResult.data.editedSpecContent;
        } else if (typeof handlerResult === 'string') {
          if (handlerResult === ToolConfirmationOutcome.ProceedEdit) {
            throw new MetaError(
              'Permission handler returned proceed_edit without editedSpecContent'
            );
          }
          selectedOption = handlerResult;
        } else {
          throw new MetaError('Permission handler returned invalid result', {
            cause: parsedHandlerResult.error,
          });
        }

        logInfo('[DroolClient] Permission handler resolved', {
          requestId: event.id,
          result: selectedOption,
        });
      } catch (error) {
        logException(error, 'Failed to handle permission request (processing)');
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit(
          DroolClientEvent.SESSION_NOTIFICATION,
          DroolClient.createNotificationEvent(
            DroolClient.createErrorNotification(err)
          )
        );

        // Delete in case the top level promise was rejected before the finally bloc runs
        this.pendingPermissionRequests.delete(event.id);

        // Send error response to server to prevent hanging promises
        const errorResponse: JsonRpcBaseResponseFailure = {
          jsonrpc: JSONRPC_VERSION,
          industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
          industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
          type: 'response',
          id: event.id,
          error: {
            code: resolveJsonRpcErrorCode(error),
            message: 'Failed to handle permission request',
            data: error instanceof Error ? error.message : String(error),
          },
        };

        try {
          await this.transport.send(JSON.stringify(errorResponse));
        } catch (sendError) {
          logException(
            sendError,
            'Failed to handle permission request (send error response)'
          );
          const sendErr =
            sendError instanceof Error
              ? sendError
              : new Error(String(sendError));
          this.emit(
            DroolClientEvent.SESSION_NOTIFICATION,
            DroolClient.createNotificationEvent(
              DroolClient.createErrorNotification(sendErr)
            )
          );
        }
        return;
      }
    }

    const response: RequestPermissionResponse = {
      type: 'response' as const,
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: event.id,
      result: {
        selectedOption,
        ...(comment !== undefined && { comment }),
        ...(editedSpecContent !== undefined && { editedSpecContent }),
      },
    };

    logInfo('[DroolClient] Sending permission response back to CLI', {
      requestId: event.id,
      result: String(selectedOption),
    });
    await this.transport.send(JSON.stringify(response));
  }

  private async handleAskUserRequest(event: AskUserEvent): Promise<void> {
    logInfo('[DroolClient] Handling ask-user request', {
      requestId: event.id,
      toolCallId: event.params.toolCallId,
      questionCount: event.params.questions.length,
    });

    this.emit(DroolClientEvent.ASK_USER, event);
    let result: AskUserResult = { cancelled: true, answers: [] };
    const handler = this.askUserHandlers.get('default');
    if (handler) {
      try {
        logInfo('[DroolClient] Waiting for ask-user handler to resolve', {
          requestId: event.id,
        });

        const handlerPromise = new Promise<AskUserResult>((resolve, reject) => {
          this.pendingAskUserRequests.set(event.id, { reject });
          handler(event)
            .then(resolve)
            .catch(reject)
            .finally(() => {
              this.pendingAskUserRequests.delete(event.id);
            });
        });

        result = await handlerPromise;

        logInfo('[DroolClient] Ask-user handler resolved', {
          requestId: event.id,
          cancelled: result.cancelled ?? false,
          answerCount: result.answers.length,
        });
      } catch (error) {
        logException(error, 'Failed to handle ask-user request');
        const err = error instanceof Error ? error : new Error(String(error));

        // Delete in case the top level promise was rejected before the finally block runs
        this.pendingAskUserRequests.delete(event.id);

        const errorResponse: JsonRpcBaseResponseFailure = {
          jsonrpc: JSONRPC_VERSION,
          industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
          industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
          type: 'response',
          id: event.id,
          error: {
            code: resolveJsonRpcErrorCode(error),
            message: 'Failed to handle ask-user request',
            data: err.message,
          },
        };

        try {
          await this.transport.send(JSON.stringify(errorResponse));
        } catch (sendError) {
          logException(sendError, 'Failed to send ask-user error response');
        }
        return;
      }
    }

    const response: AskUserResponse = {
      type: 'response' as const,
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: event.id,
      result,
    };

    logInfo('[DroolClient] Sending ask-user response back to CLI', {
      requestId: event.id,
      cancelled: result.cancelled ?? false,
    });

    await this.transport.send(JSON.stringify(response));
  }

  private static getErrorType(error: Error): DroolErrorType {
    switch (error.constructor) {
      case ConnectionError:
        return DroolErrorType.CONNECTION_ERROR;
      case ProtocolError:
        return DroolErrorType.PROTOCOL_ERROR;
      case SessionError:
        return DroolErrorType.SESSION_ERROR;
      case TimeoutError:
        return DroolErrorType.TIMEOUT_ERROR;
      case ProcessExitError:
        return DroolErrorType.PROCESS_EXIT_ERROR;
      case DroolClientError:
        return DroolErrorType.DROOL_CLIENT_ERROR;
      default:
        return DroolErrorType.ERROR;
    }
  }

  private static createErrorNotification(error: Error): SessionNotification {
    return {
      type: SessionNotificationType.ERROR,
      message: error.message,
      errorType: DroolClient.getErrorType(error),
      timestamp: new Date().toISOString(),
      error: {
        name: error.name,
        message: error.message,
      },
    };
  }

  private static getNestedString(
    value: unknown,
    path: string[]
  ): string | null {
    let current: unknown = value;

    for (const key of path) {
      if (!DroolClient.isRecord(current)) {
        return null;
      }

      current = current[key];
    }

    return typeof current === 'string' ? current : null;
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  /**
   * Create a full SessionNotificationEvent for locally-generated notifications.
   * Used when the SDK needs to emit error notifications that weren't received from the CLI.
   */
  private static createNotificationEvent(
    notification: SessionNotification
  ): SessionNotificationEvent {
    return {
      jsonrpc: JSONRPC_VERSION,
      type: 'notification' as const,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      method: DroolClientMethod.SESSION_NOTIFICATION,
      params: { notification },
    };
  }
}
