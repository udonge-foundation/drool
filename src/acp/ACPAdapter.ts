/**
 * ACPAdapter
 *
 * Uses shared infrastructure:
 * - SessionController for settings management
 * - AcpProtocolAdapter for notification emission
 * - AgentEventBus for event forwarding
 * - PermissionRequestHandler for tool confirmations
 */
import fs from 'fs';

import { RequestError } from '@agentclientprotocol/sdk';

import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import { AutonomyMode } from '@industry/drool-sdk-ext/protocol/shared';
import { logInfo, logWarn } from '@industry/logging';
import {
  getAuthToken,
  loginWithDeviceCode,
  requestDeviceAuthorization,
  type DeviceAuthorizationResponse,
} from '@industry/runtime/auth';
import {
  fetchFeatureFlags,
  resetFeatureFlagCache,
} from '@industry/runtime/feature-flags';
import { isAvailableInCLI } from '@industry/utils/llm';
import { findCustomModel } from '@industry/utils/models';

import packageJson from '../../package.json';
import {
  formatPromptForExec,
  extractImagesFromPrompt,
  generateToolTitle,
  buildToolInputContent,
  buildToolLocations,
  parseTodoParams,
  mapTodoPriority,
  mapTodoStatus,
} from '@/acp/protocol/translator';
import {
  resolveAcpSkillSlashPromptForAgent,
  sendAcpAvailableCommandsUpdate,
} from '@/acp/session/availableCommands';
import {
  isValidAutonomyMode,
  isValidReasoningEffort,
} from '@/acp/session/configOptions';
import {
  CONFIG_OPTION_AUTONOMY_LEVEL,
  CONFIG_OPTION_MODEL,
  CONFIG_OPTION_REASONING_EFFORT,
} from '@/acp/session/constants';
import { mergeAcpMcpConfigs } from '@/acp/session/mcpConfigMerge';
import { buildModelState } from '@/acp/session/models';
import { isAcpAutonomyModeAllowed } from '@/acp/session/modes';
import { buildAcpSessionConfigState } from '@/acp/session/state';
import type { ConfigOptionsState } from '@/acp/session/types';
import {
  buildPermissionRequestPayload,
  permissionResponseToOutcome,
} from '@/acp/tools/permissions';
import { inferToolKind } from '@/acp/tools/utils';
import { AcpProtocolAdapter } from '@/adapters/AcpProtocolAdapter';
import { PermissionRequestHandler } from '@/agent/PermissionRequestHandler';
import type { PermissionResponse, ToolConfirmationBatch } from '@/agent/types';
import {
  SessionController,
  getSessionController,
  resetSessionController,
} from '@/controllers/SessionController';
import { getRuntimeAuthConfig } from '@/environment';
import { AgentEvent, subscribeToAgentEvents } from '@/events/AgentEventBus';
import { runAgentWithSession } from '@/exec/sharedAgentRunner';
import { getMcpService } from '@/services/mcp/McpService';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import {
  getTerminalService,
  initializeTerminalService,
} from '@/services/TerminalService';
import { TerminalServiceMode } from '@/services/TerminalService/enums';
import type { DroolMessageEvent } from '@/services/types';
import { cleanMessage } from '@/utils/cleanMessage';
import { SessionNotFoundError } from '@/utils/errors';
import { openBrowser } from '@/utils/openBrowser';

import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  SessionModeState,
  SessionModelState,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type { CustomModel } from '@industry/common/settings';
import type { ToolConfirmationOutcome } from '@industry/drool-sdk-ext/protocol/drool';

// UNSTABLE: session/resume types not yet in SDK
interface ResumeSessionRequest {
  sessionId: string;
  cwd: string;
  mcpServers?: McpServer[];
  _meta?: Record<string, unknown> | null;
}

interface ResumeSessionResponse {
  models?: SessionModelState | null;
  modes?: SessionModeState | null;
  configOptions?: ConfigOptionsState | null;
  _meta?: Record<string, unknown> | null;
}

// UNSTABLE: session/set_config_option not yet in SDK
interface SetSessionConfigOptionRequest {
  sessionId: string;
  configId: string;
  value: string;
}

interface SetSessionConfigOptionResponse {
  _meta?: Record<string, unknown> | null;
}

// UNSTABLE: session/list types not yet in SDK
interface ListSessionsRequest {
  cwd?: string;
  cursor?: string;
}

interface SessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  _meta?: Record<string, unknown> | null;
}

interface ListSessionsResponse {
  sessions: SessionInfo[];
  nextCursor?: string;
}

const SESSION_LIST_PAGE_SIZE = 50;

function isValidModelOption(
  modelId: string,
  customModels: CustomModel[]
): boolean {
  if (isAvailableInCLI(modelId)) return true;
  return findCustomModel(modelId, customModels) !== null;
}

function requireAllowedModelOption(params: {
  modelId: string;
  customModels: CustomModel[];
  errorParams: Record<string, unknown>;
  unrecognizedMessage: string;
}): void {
  const { modelId, customModels, errorParams, unrecognizedMessage } = params;
  if (!isValidModelOption(modelId, customModels)) {
    throw RequestError.invalidParams(errorParams, unrecognizedMessage);
  }

  const validation = getSettingsService().validateModelAccess(modelId);
  if (!validation.allowed) {
    throw RequestError.invalidParams(
      errorParams,
      validation.reason ?? 'Model not allowed by organization policy'
    );
  }
}

function requireAllowedAutonomyMode(params: {
  modeId: string;
  errorParams: Record<string, unknown>;
  invalidMessage: string;
  policyMessage: string;
}): AutonomyMode {
  const { modeId, errorParams, invalidMessage, policyMessage } = params;
  if (!isValidAutonomyMode(modeId)) {
    throw RequestError.invalidParams(errorParams, invalidMessage);
  }
  if (!isAcpAutonomyModeAllowed(modeId)) {
    throw RequestError.invalidParams(errorParams, policyMessage);
  }
  return modeId;
}

/**
 * Session state for ACPAdapter
 */
interface SessionState {
  sessionId: string;
  isCancelling: boolean;
  interruptHandler: (() => Promise<void>) | null;
}

/**
 * ACPAdapter - uses shared infrastructure for unified behavior
 *
 * This is the base class for ACP adapters. ACPDaemonAdapter extends this
 * to add child process orchestration while inheriting common functionality
 * like authentication, session listing, etc.
 */
export class ACPAdapter implements Agent {
  protected readonly connection: AgentSideConnection;

  private sessionController: SessionController;

  private protocolAdapters = new Map<string, AcpProtocolAdapter>();

  protected protocolVersion = 1;

  protected clientCapabilities: ClientCapabilities | null = null;

  private sessions = new Map<string, SessionState>();

  /** Auth token captured during authentication (used by daemon to pass to children) */
  protected authToken: string | null = null;

  private hasReloadedOrgSettingsForAuth = false;

  protected pendingDeviceAuth: DeviceAuthorizationResponse | null = null;

  protected pendingDeviceAuthTimestamp: number | null = null;

  protected isPendingDeviceAuthValid(): boolean {
    if (!this.pendingDeviceAuth || !this.pendingDeviceAuthTimestamp)
      return false;

    // Buffer to avoid handing out an almost-expired code.
    const expirationSeconds = Math.max(
      0,
      this.pendingDeviceAuth.expires_in - 30
    );
    const elapsedSeconds =
      (Date.now() - this.pendingDeviceAuthTimestamp) / 1000;
    return elapsedSeconds <= expirationSeconds;
  }

  protected async applyAuthenticatedToken(token: string): Promise<void> {
    const shouldReloadOrgSettings =
      this.authToken !== token || !this.hasReloadedOrgSettingsForAuth;
    this.authToken = token;

    if (!shouldReloadOrgSettings) return;

    await getSettingsService().reloadOrgSettings();
    resetFeatureFlagCache();
    await fetchFeatureFlags().catch((error) => {
      logWarn('[ACP] Failed to refresh feature flags after authentication', {
        cause: error,
      });
    });
    this.hasReloadedOrgSettingsForAuth = true;
  }

  protected async ensureAuthenticated(): Promise<void> {
    // Use getAuthToken which handles API key and stored credentials
    const token = await getAuthToken(getRuntimeAuthConfig());
    if (token) {
      await this.applyAuthenticatedToken(token);
      return;
    }

    // Best-effort: include a device pairing code in the authRequired message.
    // Cache the device code to avoid issuing new codes on every request.
    if (!this.isPendingDeviceAuthValid()) {
      try {
        this.pendingDeviceAuth = await requestDeviceAuthorization(
          getRuntimeAuthConfig()
        );
        this.pendingDeviceAuthTimestamp = Date.now();
      } catch (error) {
        // If WorkOS is unreachable, fall back to a generic message.
        logWarn('[ACP] Failed to request device authorization', {
          cause: error,
        });
        this.pendingDeviceAuth = null;
        this.pendingDeviceAuthTimestamp = null;
      }
    }

    // No need to say "Authentication Required" - the client labels this for us
    if (this.pendingDeviceAuth) {
      throw RequestError.authRequired(
        undefined,
        `\n\nYour code: ${this.pendingDeviceAuth.user_code}\n\nClick the "Login" button to authenticate, or set a INDUSTRY_API_KEY environment variable.`
      );
    }

    throw RequestError.authRequired(
      undefined,
      'Click the "Login" button to authenticate, or set a INDUSTRY_API_KEY environment variable.'
    );
  }

  constructor(connection: AgentSideConnection) {
    this.connection = connection;
    // Reset the global SessionController to ensure ACP mode starts with fresh state.
    // This is intentional for ACP isolation - each adapter instance owns its session lifecycle.
    resetSessionController();
    this.sessionController = getSessionController();
  }

  hasTerminalCapability(): boolean {
    return this.clientCapabilities?.terminal === true;
  }

  private initializeTerminalService(sessionId: string): void {
    if (this.hasTerminalCapability()) {
      initializeTerminalService({
        mode: TerminalServiceMode.Host,
        connection: this.connection,
        sessionId,
      });
    } else {
      initializeTerminalService({ mode: TerminalServiceMode.Local });
    }
  }

  private startMcpServerMerge(mcpServers: McpServer[]): void {
    void (async () => {
      const mcpService = getMcpService();
      await mcpService.start();
      const filesystemConfigs = mcpService.getUserMcpConfigs();
      const mergedConfigs = mergeAcpMcpConfigs(mcpServers, filesystemConfigs);

      await mcpService.setMergedMcpConfigs(mergedConfigs);
      await mcpService.stopWatching();
    })().catch((error) => {
      logWarn('[ACP] Background MCP server merge failed', { cause: error });
    });
  }

  private async sendAvailableCommandsUpdate(sessionId: string): Promise<void> {
    try {
      await sendAcpAvailableCommandsUpdate(this.connection, sessionId);
    } catch (error) {
      logWarn('[ACP] Failed to send available commands update', {
        cause: error,
      });
    }
  }

  private scheduleAvailableCommandsUpdate(sessionId: string): void {
    setTimeout(() => {
      void this.sendAvailableCommandsUpdate(sessionId);
    }, 0);
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.protocolVersion = request.protocolVersion ?? 1;
    this.clientCapabilities = request.clientCapabilities ?? null;

    return {
      protocolVersion: this.protocolVersion,
      agentCapabilities: {
        loadSession: true,
        // @ts-expect-error UNSTABLE: session/resume and sessionCapabilities not yet in SDK types
        sessionCapabilities: {
          list: {},
          resume: {},
        },
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        // UNSTABLE: _meta extension for terminal-auth (Zed only)
        _meta: {
          terminal_output: true,
          'terminal-auth': true,
        },
      },
      agentInfo: {
        name: packageJson.name,
        title: 'Industry Drool',
        version: packageJson.version,
      },
      authMethods: [
        {
          id: 'device-pairing',
          name: 'Login',
          description:
            'Authenticate with Industry using a device pairing code in your browser.',
        },
        {
          id: 'industry-api-key',
          name: 'Industry API Key',
          description:
            'Authenticate using a Industry API key set in the INDUSTRY_API_KEY environment variable.',
        },
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    await this.ensureAuthenticated();

    // Create session via SessionController
    // If daemon passed a sessionId (ACP child mode via _meta), use it; otherwise generate one
    const providedSessionId = (params._meta as { sessionId?: string } | null)
      ?.sessionId;

    // Run session creation and model fetching in parallel — they are independent.
    // Attach .catch() so a rejection is always observed even if we throw before awaiting.
    const modelStatePromise = buildModelState().catch((err) => {
      logWarn(
        '[ACP] Failed to fetch available models on session create, using defaults',
        {
          cause: err,
        }
      );
      return [] as SessionModelState['availableModels'];
    });
    const sessionId = await this.sessionController.createSession({
      cwd: params.cwd,
      sessionId: providedSessionId,
      skipRemoteCreation: !!providedSessionId, // Skip remote creation for daemon-managed sessions
    });

    // Initialize terminal service based on client capabilities
    this.initializeTerminalService(sessionId);

    // Create protocol adapter for this session
    this.protocolAdapters.set(
      sessionId,
      new AcpProtocolAdapter(this.sessionController, this.connection, sessionId)
    );

    // Handle MCP server merging
    if (params.mcpServers && params.mcpServers.length > 0) {
      this.startMcpServerMerge(params.mcpServers);
    }

    const settings = this.sessionController.getSettings();
    this.sessions.set(sessionId, {
      sessionId,
      isCancelling: false,
      interruptHandler: null,
    });

    const { models, modes, configOptions } = buildAcpSessionConfigState({
      settings,
      availableModels: await modelStatePromise,
    });

    logInfo('[ACP] Created new session', {
      sessionId,
      count: params.mcpServers?.length ?? 0,
    });

    this.scheduleAvailableCommandsUpdate(sessionId);

    // UNSTABLE: configOptions is part of the stable ACP spec
    // (https://agentclientprotocol.com/protocol/session-config-options) but is
    // not yet present in @agentclientprotocol/sdk types. Cast through unknown
    // until the SDK adds it. Clients that don't understand the field will
    // simply ignore it.
    return {
      sessionId,
      models,
      modes,
      configOptions,
    } as unknown as NewSessionResponse;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    logInfo('[ACP] loadSession called', {
      sessionId: params.sessionId,
      cwd: params.cwd,
    });

    await this.ensureAuthenticated();

    // Kick off model fetching in parallel — independent of session load. Used
    // for the `model` entry in configOptions on the response.
    const modelStatePromise = buildModelState().catch((err) => {
      logWarn(
        '[ACP] Failed to fetch available models on session load, using defaults',
        { cause: err }
      );
      return [] as SessionModelState['availableModels'];
    });

    // Load session via SessionController (handles chdir + settings refresh)
    let loadedSession;
    try {
      loadedSession = await this.sessionController.loadSession({
        sessionId: params.sessionId,
      });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        throw RequestError.invalidParams(
          { sessionId: params.sessionId },
          'Unknown session identifier'
        );
      }
      throw error;
    }

    // Apply client cwd override if provided
    if (params.cwd && params.cwd !== loadedSession.cwd) {
      if (!fs.existsSync(params.cwd)) {
        throw RequestError.invalidParams(
          { cwd: params.cwd },
          `Working directory does not exist: ${params.cwd}`
        );
      }
      process.chdir(params.cwd);
    }

    // Track the session locally
    this.sessions.set(params.sessionId, {
      sessionId: params.sessionId,
      isCancelling: false,
      interruptHandler: null,
    });

    // Initialize terminal service based on client capabilities
    this.initializeTerminalService(params.sessionId);

    // Create protocol adapter for this session
    if (!this.protocolAdapters.has(params.sessionId)) {
      this.protocolAdapters.set(
        params.sessionId,
        new AcpProtocolAdapter(
          this.sessionController,
          this.connection,
          params.sessionId
        )
      );
    }

    // Handle MCP server merging on load
    if (params.mcpServers && params.mcpServers.length > 0) {
      this.startMcpServerMerge(params.mcpServers);
    }

    // Load and replay all message events as session/update notifications
    const messageEvents = await getSessionService().getAllMessageEvents(
      params.sessionId
    );

    logInfo('[ACP] Replaying session messages', {
      sessionId: params.sessionId,
      messageCount: messageEvents.length,
    });

    // Replay each message in chronological order
    // Sequential replay is intentional - messages must be sent in order
    // (no-await-in-loop disabled in replayMessageEvent)
    for (const event of messageEvents) {
      await this.replayMessageEvent(params.sessionId, event);
    }

    logInfo('[ACP] Session loaded and replayed', {
      sessionId: params.sessionId,
      count: params.mcpServers?.length ?? 0,
      messageCount: messageEvents.length,
    });

    const settings = this.sessionController.getSettings();
    const { configOptions } = buildAcpSessionConfigState({
      settings,
      availableModels: await modelStatePromise,
    });

    this.scheduleAvailableCommandsUpdate(params.sessionId);

    // UNSTABLE: configOptions is in the stable ACP spec but not yet typed in
    // the SDK. See newSession() for details.
    return { configOptions } as unknown as LoadSessionResponse;
  }

  /**
   * Replay a single message event as ACP session/update notifications.
   * Transforms stored message format to ACP protocol format.
   *
   * Note: Sequential await in loops is intentional - content blocks must be
   * sent in order to preserve conversation structure.
   */
  private async replayMessageEvent(
    sessionId: string,
    event: DroolMessageEvent
  ): Promise<void> {
    const { message } = event;

    // Skip LLM-only messages (system reminders, etc.) - they shouldn't be shown in UI
    if (message.visibility === 'llm_only') {
      return;
    }

    const content = Array.isArray(message.content)
      ? message.content
      : [{ type: 'text' as const, text: String(message.content) }];

    if (message.role === 'user') {
      // Check if this is a tool result message (contains tool_result blocks)
      const hasToolResults = content.some(
        (block) => block.type === 'tool_result'
      );

      if (hasToolResults) {
        // Send tool results as tool_call_update notifications
        for (const block of content) {
          if (block.type === 'tool_result') {
            const resultBlock = block as {
              tool_use_id: string;
              content?: string | Array<{ type: string; text?: string }>;
              is_error?: boolean;
            };

            // Extract text content from tool result
            let resultText = '';
            if (typeof resultBlock.content === 'string') {
              resultText = resultBlock.content;
            } else if (Array.isArray(resultBlock.content)) {
              resultText = resultBlock.content
                .filter((c) => c.type === 'text' && c.text)
                .map((c) => c.text)
                .join('\n');
            }

            try {
              await this.connection.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: resultBlock.tool_use_id,
                  status: resultBlock.is_error ? 'failed' : 'completed',
                  rawOutput: resultText ? { text: resultText } : undefined,
                },
              });
            } catch (error) {
              logWarn('[ACP] Failed to replay tool result', { cause: error });
            }
          }
        }
      } else {
        // Regular user message - send as user_message_chunk
        for (const block of content) {
          if (block.type === 'text') {
            // Clean system reminders from user messages before sending to UI
            const cleanedText = cleanMessage((block as { text: string }).text);
            if (!cleanedText) {
              // Skip empty messages (e.g., messages that were only system reminders)
              continue;
            }
            try {
              await this.connection.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: 'user_message_chunk',
                  content: { type: 'text', text: cleanedText },
                },
              });
            } catch (error) {
              logWarn('[ACP] Failed to replay user message', { cause: error });
            }
          }
        }
      }
    } else if (message.role === 'assistant') {
      // Process assistant message content blocks
      for (const block of content) {
        try {
          if (block.type === 'text') {
            // Agent text response
            await this.connection.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: (block as { text: string }).text,
                },
              },
            });
          } else if (block.type === 'thinking') {
            // Agent thinking/reasoning
            const thinkingBlock = block as { thinking: string };
            await this.connection.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: thinkingBlock.thinking },
              },
            });
          } else if (block.type === 'tool_use') {
            // Tool call from agent
            const toolBlock = block as {
              id: string;
              name: string;
              input: Record<string, unknown>;
            };

            // Handle TodoWrite specially as plan update
            if (toolBlock.name === 'TodoWrite') {
              const todos = parseTodoParams(toolBlock.input);
              if (todos) {
                await this.connection.sessionUpdate({
                  sessionId,
                  update: {
                    sessionUpdate: 'plan',
                    entries: todos.map((todo) => ({
                      content: todo.content,
                      priority: mapTodoPriority(todo.priority),
                      status: mapTodoStatus(todo.status),
                    })),
                  },
                });
              }
            } else {
              // Regular tool call
              await this.connection.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: toolBlock.id,
                  title: generateToolTitle(toolBlock.name, toolBlock.input),
                  kind: inferToolKind(toolBlock.name),
                  status: 'completed', // Historical tool calls are completed
                  rawInput: toolBlock.input,
                  content: buildToolInputContent(
                    toolBlock.name,
                    toolBlock.input
                  ),
                  locations: buildToolLocations(
                    toolBlock.name,
                    toolBlock.input
                  ),
                },
              });
            }
          }
        } catch (error) {
          logWarn('[ACP] Failed to replay assistant content block', {
            cause: error,
            type: block.type,
          });
        }
      }
    }
  }

  async resumeSession(
    params: ResumeSessionRequest
  ): Promise<ResumeSessionResponse> {
    await this.ensureAuthenticated();

    // Start model fetching early — independent of session load below.
    // Attach .catch() so a rejection is always observed even if we throw before awaiting.
    const modelStatePromise = buildModelState().catch((err) => {
      logWarn(
        '[ACP] Failed to fetch available models on session resume, using defaults',
        {
          cause: err,
        }
      );
      return [] as SessionModelState['availableModels'];
    });

    // Check if session is already tracked in memory
    let session = this.sessions.get(params.sessionId);

    if (!session) {
      // Session not in memory (e.g. CLI restarted) - load via SessionController
      try {
        await this.sessionController.loadSession({
          sessionId: params.sessionId,
        });
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          throw RequestError.invalidParams(
            { sessionId: params.sessionId },
            'Unknown session identifier'
          );
        }
        throw error;
      }

      // Apply client cwd override if provided
      if (params.cwd) {
        if (!fs.existsSync(params.cwd)) {
          throw RequestError.invalidParams(
            { cwd: params.cwd },
            `Working directory does not exist: ${params.cwd}`
          );
        }
        process.chdir(params.cwd);
      }

      session = {
        sessionId: params.sessionId,
        isCancelling: false,
        interruptHandler: null,
      };
      this.sessions.set(params.sessionId, session);

      if (!this.protocolAdapters.has(params.sessionId)) {
        this.protocolAdapters.set(
          params.sessionId,
          new AcpProtocolAdapter(
            this.sessionController,
            this.connection,
            params.sessionId
          )
        );
      }

      logInfo('[ACP] Loaded session from disk for resume', {
        sessionId: params.sessionId,
      });
    } else if (params.cwd) {
      if (!fs.existsSync(params.cwd)) {
        throw RequestError.invalidParams(
          { cwd: params.cwd },
          `Working directory does not exist: ${params.cwd}`
        );
      }
      process.chdir(params.cwd);
    }

    // Initialize terminal service based on client capabilities
    this.initializeTerminalService(params.sessionId);

    // Merge ACP MCP servers with filesystem config on session resume
    if (params.mcpServers && params.mcpServers.length > 0) {
      this.startMcpServerMerge(params.mcpServers);
    }

    const settings = this.sessionController.getSettings();
    const { models, modes, configOptions } = buildAcpSessionConfigState({
      settings,
      availableModels: await modelStatePromise,
    });

    logInfo('[ACP] Resuming session (without message replay)', {
      sessionId: params.sessionId,
      count: params.mcpServers?.length ?? 0,
    });

    this.scheduleAvailableCommandsUpdate(params.sessionId);

    return {
      models,
      modes,
      configOptions,
    };
  }

  async listSessions(
    params: ListSessionsRequest
  ): Promise<ListSessionsResponse> {
    const sessionService = getSessionService();
    const { sessions: paginatedSessions, nextCursor } =
      await sessionService.getSessionListPage({
        currentCwd: params.cwd,
        cursor: params.cursor,
        pageSize: SESSION_LIST_PAGE_SIZE,
      });

    const sessions: SessionInfo[] = paginatedSessions.map((s) => ({
      sessionId: s.id,
      cwd: s.cwd ?? '',
      title: s.sessionTitle ?? s.title,
      updatedAt: s.modifiedTime.toISOString(),
      _meta: {
        messageCount: s.messageCount,
      },
    }));

    logInfo('[ACP] listSessions called', {
      cwd: params.cwd,
      batchSize: SESSION_LIST_PAGE_SIZE,
      count: sessions.length,
      found: !!nextCursor,
    });

    return { sessions, nextCursor };
  }

  async readTextFile(
    params: ReadTextFileRequest
  ): Promise<ReadTextFileResponse> {
    this.requireSession(params.sessionId);
    return this.connection.readTextFile({
      sessionId: params.sessionId,
      path: params.path,
      line: params.line,
      limit: params.limit,
    });
  }

  async writeTextFile(
    params: WriteTextFileRequest
  ): Promise<WriteTextFileResponse> {
    this.requireSession(params.sessionId);
    await this.connection.writeTextFile({
      sessionId: params.sessionId,
      path: params.path,
      content: params.content,
    });
    return {};
  }

  async authenticate(params: AuthenticateRequest): Promise<void> {
    logInfo('[ACP] authenticate called', {
      method: params.methodId,
    });

    // Handle API key authentication
    if (
      params.methodId === 'industry-api-key' ||
      params.methodId === 'api-key'
    ) {
      // For API key auth method, get current token (which may be an API key)
      const token = await getAuthToken(getRuntimeAuthConfig());
      if (!token) {
        throw RequestError.internalError(
          'No authentication available. Set INDUSTRY_API_KEY or login.',
          'API key authentication failed'
        );
      }
      await this.applyAuthenticatedToken(token);
      return;
    }

    // Handle device pairing authentication
    if (params.methodId === 'device-pairing') {
      // Check if already authenticated
      const existingToken = await getAuthToken(getRuntimeAuthConfig());
      if (existingToken) {
        await this.applyAuthenticatedToken(existingToken);
        return;
      }

      try {
        // Reuse the device code from ensureAuthenticated() so the code
        // shown to the user matches the one opened in the browser.
        const cachedAuth = this.isPendingDeviceAuthValid()
          ? this.pendingDeviceAuth!
          : undefined;
        this.pendingDeviceAuth = null;
        this.pendingDeviceAuthTimestamp = null;

        const authConfig = getRuntimeAuthConfig();
        const flow = loginWithDeviceCode(authConfig, cachedAuth);
        let browserOpened = false;

        for await (const status of flow) {
          if (status.type === 'pending' && !browserOpened) {
            browserOpened = true;
            await openBrowser(status.verificationUriComplete);
          }
        }

        const token = await getAuthToken(getRuntimeAuthConfig());
        if (token) {
          await this.applyAuthenticatedToken(token);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Authentication failed';
        throw RequestError.internalError(
          message,
          'Device authentication failed'
        );
      }
      return;
    }

    // Unknown method
    throw RequestError.invalidParams(
      { method: params.methodId },
      `Unknown authentication method: ${params.methodId}`
    );
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);

    session.isCancelling = false;

    const promptText = formatPromptForExec(params) || 'Process request';
    const promptImages = extractImagesFromPrompt(params);

    // Subscribe to AgentError events for the duration of this prompt
    // This captures errors from the agent execution to return as proper JSON-RPC errors
    let capturedError: Error | null = null;
    const unsubscribeEventsFn = subscribeToAgentEvents(
      AgentEvent.AgentError,
      (errorParams) => {
        capturedError =
          errorParams.error instanceof Error
            ? errorParams.error
            : new Error(String(errorParams.error));
      }
    );

    // Create permission handler for this prompt
    const permissionHandler = new PermissionRequestHandler(
      async (batch: ToolConfirmationBatch): Promise<PermissionResponse> => {
        if (batch.toolUses.length === 0) {
          return { outcome: 'cancel' as ToolConfirmationOutcome };
        }

        const lastTool = batch.toolUses[batch.toolUses.length - 1];
        const payload = buildPermissionRequestPayload(
          lastTool,
          batch.toolUses.length,
          batch.toolUses
        );

        const response = await this.connection.requestPermission({
          sessionId: params.sessionId,
          options: payload.options,
          toolCall: payload.toolCall,
        });

        const outcome = permissionResponseToOutcome(response);
        return { outcome };
      }
    );

    try {
      // Defensive: ensure session is loaded in SessionService without re-chdir.
      // By the ACP protocol flow the session is already loaded via
      // newSession/loadSession/resumeSession, but if it somehow isn't we
      // reload it here. We skip the reload when the session is already current
      // to avoid reverting a client-provided cwd override.
      const sessionService = getSessionService();
      if (sessionService.getCurrentSessionId() !== session.sessionId) {
        await this.sessionController.ensureSessionLoaded(session.sessionId);
      }

      // Clear spec mode model for ACP
      this.sessionController.clearSpecModeModel();

      const resolvedPromptText =
        await resolveAcpSkillSlashPromptForAgent(promptText);

      const result = await runAgentWithSession(
        {
          prompt: resolvedPromptText,
          images: promptImages,
          permissionHandler,
        },
        {
          onInterruptReady: (interruptFn) => {
            session.interruptHandler = interruptFn;
          },
        }
      );

      // Check if an error was captured during execution
      // Note: TypeScript doesn't track that the callback may have set capturedError
      if (capturedError !== null) {
        // Throw a proper JSON-RPC error instead of returning stopReason: 'refusal'
        throw RequestError.internalError(
          (capturedError as Error).message,
          'Agent error'
        );
      }

      if (result.isError) {
        return { stopReason: 'refusal' };
      }

      if (session.isCancelling) {
        return { stopReason: 'cancelled' };
      }

      return { stopReason: 'end_turn' };
    } catch (error) {
      // Check if this is already a RequestError (from our error handling above)
      if (error instanceof RequestError) {
        throw error;
      }

      // For cancellation, return cancelled stop reason (not an error)
      if (session.isCancelling) {
        return { stopReason: 'cancelled' };
      }

      // For other errors, throw a proper JSON-RPC error
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw RequestError.internalError(errorMessage, 'Prompt failed');
    } finally {
      // Always unsubscribe from error events
      unsubscribeEventsFn();
      session.isCancelling = false;
      session.interruptHandler = null;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return;

    session.isCancelling = true;

    // Kill and release all active terminals
    try {
      const terminalService = getTerminalService();
      await terminalService.releaseAll();
    } catch (error) {
      logWarn('[ACP] Failed to release terminals on cancel', {
        cause: error,
      });
    }

    // Call the interrupt handler to abort the LLM request
    if (session.interruptHandler) {
      try {
        await session.interruptHandler();
      } catch (error) {
        logWarn('[ACP] Failed to cancel session', { cause: error });
      }
    }
  }

  async setSessionModel(
    params: SetSessionModelRequest
  ): Promise<SetSessionModelResponse> {
    this.requireSession(params.sessionId);
    const customModels = this.sessionController.getCustomModels();
    requireAllowedModelOption({
      modelId: params.modelId,
      customModels,
      errorParams: { modelId: params.modelId },
      unrecognizedMessage: 'Model not recognized',
    });

    this.sessionController.setModel(params.modelId);
    return {};
  }

  async setSessionMode(
    params: SetSessionModeRequest
  ): Promise<SetSessionModeResponse> {
    this.requireSession(params.sessionId);
    const modeId = requireAllowedAutonomyMode({
      modeId: params.modeId,
      errorParams: { modeId: params.modeId },
      invalidMessage: `Invalid autonomy mode: ${params.modeId}`,
      policyMessage: 'Autonomy mode not allowed by organization policy',
    });

    this.sessionController.setAutonomyMode(modeId);

    return {};
  }

  /**
   * Apply a value for one of the advertised ACP config options.
   *
   * Per the ACP spec
   * (https://agentclientprotocol.com/protocol/session-config-options),
   * `session/set_config_option` is the write side of the same machinery that
   * `session/new`/`session/load` advertise via `configOptions`. We delegate
   * to SessionController so the existing `SettingsUpdated` event flow runs
   * and `config_option_update` is emitted by `AcpProtocolAdapter`.
   */
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse> {
    this.requireSession(params.sessionId);

    switch (params.configId) {
      case CONFIG_OPTION_REASONING_EFFORT: {
        if (!isValidReasoningEffort(params.value)) {
          throw RequestError.invalidParams(
            { configId: params.configId, value: params.value },
            `Invalid reasoning effort value: ${params.value}`
          );
        }
        this.sessionController.setReasoningEffort(
          params.value as ReasoningEffort
        );
        return {};
      }

      case CONFIG_OPTION_AUTONOMY_LEVEL: {
        const modeId = requireAllowedAutonomyMode({
          modeId: params.value,
          errorParams: { configId: params.configId, value: params.value },
          invalidMessage: `Invalid autonomy level value: ${params.value}`,
          policyMessage: 'Autonomy level not allowed by organization policy',
        });
        this.sessionController.setAutonomyMode(modeId);
        return {};
      }

      case CONFIG_OPTION_MODEL: {
        const customModels = this.sessionController.getCustomModels();
        requireAllowedModelOption({
          modelId: params.value,
          customModels,
          errorParams: { configId: params.configId, value: params.value },
          unrecognizedMessage: `Invalid model: ${params.value}`,
        });
        // Changing the model can shrink/expand the reasoning_effort option
        // list. SessionService re-clamps reasoning effort to the new
        // model's `defaultReasoningEffort` when the current effort is not
        // in its supported set, and the resulting `SettingsUpdated` event
        // triggers a `config_option_update` reflecting both fields.
        this.sessionController.setModel(params.value);
        return {};
      }

      default:
        throw RequestError.invalidParams(
          { configId: params.configId },
          `Unknown config option: ${params.configId}`
        );
    }
  }

  // Handle extension methods - routes unstable/new methods not yet in SDK
  async extMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case 'session/list':
        return this.listSessions(
          params as ListSessionsRequest
        ) as unknown as Record<string, unknown>;
      case 'session/resume':
        return this.resumeSession(
          params as unknown as ResumeSessionRequest
        ) as unknown as Record<string, unknown>;
      case 'session/set_config_option':
        return this.setSessionConfigOption(
          params as unknown as SetSessionConfigOptionRequest
        ) as unknown as Record<string, unknown>;
      default:
        throw RequestError.methodNotFound(method);
    }
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        { sessionId },
        'Unknown session identifier'
      );
    }
    return session;
  }
}
