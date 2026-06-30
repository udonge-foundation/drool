import { isIndustryDisplayable402 } from '@industry/drool-core/llms/errors';
import {
  AskUserResultSchema,
  DroolClientMethod,
  DroolWorkingState,
  SessionNotificationType,
  ToolConfirmationOutcome,
  INDUSTRY_PROTOCOL_VERSION,
  LEGACY_INDUSTRY_API_VERSION,
  JSONRPC_VERSION,
  DroolErrorType,
  RequestPermissionResultSchema,
  SYSTEM_REMINDER_START,
  type ToolConfirmationInfo,
  type ToolConfirmationDetailsData,
  type ToolConfirmationListItem,
  type SessionNotificationParams,
  type SessionNotificationEvent,
  type SettingsUpdatedNotification,
  type CreateMessageNotification,
  type ToolResultNotification,
  type ErrorNotification,
  type RequestPermissionRequest,
  type AskUserRequest,
  type AskUserResult,
  type SandboxStatus,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  MessageContentBlockType,
  IndustryDroolMessage,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import {
  JsonRpcBaseResponseFailure,
  JsonRpcBaseResponseSuccess,
  JsonRpcErrorCode,
  type TraceContextMeta,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logInfo, logWarn } from '@industry/logging';
import {
  OtelTracing,
  SpanName,
  SpanEvent,
  SpanAttribute,
} from '@industry/logging/tracing';
import { isErrnoException } from '@industry/utils/errors';

import type { PermissionResponse, ToolConfirmationBatch } from '@/agent/types';
import {
  SessionController,
  type SessionSettings,
} from '@/controllers/SessionController';
import {
  AgentEvent,
  agentEventBus,
  SessionTitleUpdateType,
  subscribeToMultipleAgentEvents,
} from '@/events/AgentEventBus';
import { MAX_FIRST_USER_MESSAGE_TITLE_LENGTH } from '@/events/constants';
import { formatToolRoundtripFailure } from '@/utils/toolRoundtripFailure';
import { ToolRoundtripFailureSource } from '@/utils/toolRoundtripFailure/enums';
import type { ToolRoundtripFailure } from '@/utils/toolRoundtripFailure/types';
import { generateUUID } from '@/utils/uuid';

/**
 * Write to stdout, gracefully handling EPIPE when the parent process disconnects.
 */
type ParentDisconnectCallback = () => void;

/**
 * Pending permission request tracking
 */
interface PendingPermissionRequest {
  sessionId: string;
  request: RequestPermissionRequest;
  timestamp: number;
}

interface PendingAskUserRequest {
  sessionId: string;
  request: AskUserRequest;
  timestamp: number;
}

/**
 * JsonRpcProtocolAdapter translates AgentEventBus events to JSON-RPC protocol.
 *
 * This adapter subscribes to the shared event bus and emits JSON-RPC notifications
 * to stdout. It handles all protocol-specific formatting while delegating business
 * logic to SessionController and other shared components.
 *
 * Usage:
 * ```typescript
 * const adapter = new JsonRpcProtocolAdapter(sessionController);
 * // Events from agentEventBus are automatically translated to JSON-RPC
 *
 * // Handle permission requests
 * adapter.handlePermissionResponse(requestId, outcome);
 *
 * // Clean up when done
 * adapter.dispose();
 * ```
 */
export class JsonRpcProtocolAdapter {
  private unsubscribe: (() => void) | null = null;

  private parentDisconnected = false;

  private parentDisconnectCallbacks = new Set<ParentDisconnectCallback>();

  private stdoutErrorHandler: ((err: NodeJS.ErrnoException) => void) | null =
    null;

  private pendingToolCalls = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >();

  private pendingPermissionRequests = new Map<
    string,
    PendingPermissionRequest
  >();

  private pendingAskUserRequests = new Map<string, PendingAskUserRequest>();

  constructor(private sessionController: SessionController) {
    this.setupEventSubscriptions();
    this.setupStdoutErrorHandler();
  }

  // A broken parent pipe surfaces synchronously as an EPIPE thrown by
  // process.stdout.write() (handled in safeStdoutWrite), but it can also be
  // reported asynchronously via the stream's 'error' event. Latch on both so
  // disconnect detection does not depend on a write happening to be in flight.
  private setupStdoutErrorHandler(): void {
    this.stdoutErrorHandler = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'EBADF') {
        this.latchParentDisconnect();
      }
    };
    process.stdout.on('error', this.stdoutErrorHandler);
  }

  onParentDisconnect(cb: ParentDisconnectCallback): () => void {
    this.parentDisconnectCallbacks.add(cb);
    return () => {
      this.parentDisconnectCallbacks.delete(cb);
    };
  }

  private latchParentDisconnect(): void {
    if (this.parentDisconnected) return;
    this.parentDisconnected = true;

    logWarn('[JsonRpcAdapter] stdout pipe broken, parent likely disconnected');

    for (const cb of this.parentDisconnectCallbacks) {
      try {
        cb();
      } catch (err) {
        logWarn('[JsonRpcAdapter] parent-disconnect callback failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.parentDisconnectCallbacks.clear();
  }

  private safeStdoutWrite(data: string): void {
    if (this.parentDisconnected) return;
    try {
      process.stdout.write(data);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'EPIPE') {
        this.latchParentDisconnect();
        return;
      }
      throw err;
    }
  }

  /**
   * Set up subscriptions to AgentEventBus events
   */
  private setupEventSubscriptions(): void {
    this.unsubscribe = subscribeToMultipleAgentEvents({
      [AgentEvent.AssistantTextDelta]: (params) => {
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          sessionId: params.sessionId,
          notification: {
            type: SessionNotificationType.ASSISTANT_TEXT_DELTA,
            messageId: params.messageId,
            blockIndex: params.blockIndex,
            textDelta: params.textDelta,
          },
        });
      },

      [AgentEvent.ThinkingTextDelta]: (params) => {
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          sessionId: params.sessionId,
          notification: {
            type: SessionNotificationType.THINKING_TEXT_DELTA,
            messageId: params.messageId,
            blockIndex: params.blockIndex,
            textDelta: params.textDelta,
          },
        });
      },

      [AgentEvent.TextBlockComplete]: (params) => {
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          sessionId: params.sessionId,
          notification: {
            type: SessionNotificationType.ASSISTANT_TEXT_COMPLETE,
            messageId: params.messageId,
            blockIndex: params.blockIndex,
          },
        });
      },

      [AgentEvent.ThinkingBlockComplete]: (params) => {
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          sessionId: params.sessionId,
          notification: {
            type: SessionNotificationType.THINKING_TEXT_COMPLETE,
            messageId: params.messageId,
            blockIndex: params.blockIndex,
            durationMs: params.durationMs,
          },
        });
      },

      [AgentEvent.WorkingStateChanged]: (params) => {
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          sessionId: params.sessionId,
          notification: {
            type: SessionNotificationType.DROOL_WORKING_STATE_CHANGED,
            newState: params.state,
          },
        });
      },

      [AgentEvent.AgentTurnCompleted]: (params) => {
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          sessionId: params.sessionId,
          notification: {
            type: SessionNotificationType.AGENT_TURN_COMPLETED,
            reason: params.reason,
            tokenUsage: params.tokenUsage,
            cumulativeTokenUsage: params.cumulativeTokenUsage,
          },
        });
      },

      [AgentEvent.SessionCompacted]: (params) => {
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          sessionId: params.sessionId,
          notification: {
            type: SessionNotificationType.SESSION_COMPACTED,
            summaryId: params.summaryId,
            removedCount: params.removedCount,
            visibleBoundaryMessageId: params.visibleBoundaryMessageId,
          },
        });
      },

      [AgentEvent.ChildSessionAvailable]: (params) => {
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          sessionId: params.parentSessionId,
          notification: {
            type: SessionNotificationType.CHILD_SESSION_AVAILABLE,
            childSessionId: params.childSessionId,
            toolUseId: params.toolUseId,
            timestamp: Date.now(),
          },
        });
      },

      [AgentEvent.ToolCallStart]: (params) => {
        this.pendingToolCalls.set(params.id, {
          name: params.name,
          input: params.input,
        });

        this.emitToolCallNotification(params.id, params.name, params.input);
      },

      [AgentEvent.ToolCallProgress]: (params) => {
        const pending = this.pendingToolCalls.get(params.id);
        if (pending) {
          pending.input = { ...pending.input, ...params.partialInput };
          this.emitToolCallNotification(params.id, pending.name, pending.input);
        }
      },

      [AgentEvent.ToolCallComplete]: (params) => {
        this.pendingToolCalls.delete(params.id);

        logInfo('[JsonRpcAdapter] Tool call complete', {
          toolId: params.id,
          isError: params.isError,
        });
      },

      [AgentEvent.ToolResult]: (params) => {
        const toolResultNotification: ToolResultNotification = {
          type: SessionNotificationType.TOOL_RESULT,
          toolUseId: params.toolUseId,
          messageId: params.messageId,
          content: params.content,
          isError: params.isError,
        };
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          sessionId: params.sessionId,
          notification: toolResultNotification,
        });
      },

      [AgentEvent.ToolStreamingUpdate]: (params) => {
        const {
          type,
          toolName,
          status,
          details,
          text,
          error,
          timestamp,
          parameters,
          valueSnippet,
          terminalId,
          fullOutput,
          subagentSessionId,
        } = params.update;

        // Emit tool progress updates for streaming tools (Task, Execute)
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          sessionId: params.sessionId,
          notification: {
            type: SessionNotificationType.TOOL_PROGRESS_UPDATE,
            toolUseId: params.id,
            toolName: params.name,
            update: {
              type,
              toolName,
              status,
              details,
              text,
              error,
              timestamp,
              parameters,
              valueSnippet,
              terminalId,
              fullOutput,
              subagentSessionId,
            },
          },
        });
      },

      [AgentEvent.ToolExecutionHeartbeat]: (params) => {
        // Keep-alive notification for the daemon's inactivity timer while a
        // long-running tool (e.g. Execute) is producing no new output.
        // The daemon refreshes the session timeout on any incoming session
        // notification and is expected to suppress this type before
        // forwarding to clients.
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          sessionId: params.sessionId,
          notification: {
            type: SessionNotificationType.TOOL_EXECUTION_HEARTBEAT,
            toolUseId: params.toolUseId,
            toolName: params.toolName,
          },
        });
      },

      [AgentEvent.AgentError]: (params) => {
        const err = params.error as {
          message?: string;
          status?: number;
          error?: unknown;
          cause?: unknown;
        };
        const errorMessage = err?.message ?? String(params.error);
        const errorName =
          params.error instanceof Error ? params.error.name : 'Error';

        // Suppress the raw error notification only when the backend
        // explicitly opted into rendering this 402 to the user via the
        // `displayToUser: true` flag — in that case AgentLoop has
        // already persisted a formatted user-only system message and we
        // don't want clients to render a duplicate copy. Non-displayable
        // 402s (legacy backends, unexpected shapes, etc.) still surface
        // as a normal error notification so the client sees something.
        if (isIndustryDisplayable402(params.error)) {
          return;
        }

        const notification: ErrorNotification = {
          type: SessionNotificationType.ERROR,
          message: errorMessage,
          errorType: DroolErrorType.ERROR,
          timestamp: new Date().toISOString(),
          error: { name: errorName, message: errorMessage },
        };

        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          sessionId: params.sessionId,
          notification,
        });
      },

      [AgentEvent.SessionTitleUpdated]: (params) => {
        const titleLength = params.title.trim().length;
        const shouldForward =
          params.updateType === SessionTitleUpdateType.LlmGenerated ||
          params.updateType === SessionTitleUpdateType.ManualRename ||
          (params.updateType === SessionTitleUpdateType.FirstUserMessage &&
            titleLength > 0 &&
            titleLength <= MAX_FIRST_USER_MESSAGE_TITLE_LENGTH);

        if (!shouldForward) {
          return;
        }

        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          sessionId: params.sessionId,
          notification: {
            type: SessionNotificationType.SESSION_TITLE_UPDATED,
            ...(params.requestId !== undefined && {
              requestId: params.requestId,
            }),
            title: params.title,
          },
        });
      },

      [AgentEvent.MessageCreated]: (params) => {
        this.handleMessageCreated(
          params.message,
          params.sessionId,
          params.requestId
        );
      },

      [AgentEvent.McpStatusChanged]: (params) => {
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          notification: params.notification,
        });
      },

      [AgentEvent.McpAuthRequired]: (params) => {
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          notification: params.notification,
        });
      },

      [AgentEvent.McpAuthCompleted]: (params) => {
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          notification: params.notification,
        });
      },

      [AgentEvent.PermissionRequest]: (params) => {
        this.handlePermissionRequestEvent(params);
      },

      [AgentEvent.AskUserRequest]: (params) => {
        this.handleAskUserRequestEvent(params);
      },

      [AgentEvent.AskUserResponse]: (params) => {
        // On abort/cancel, AskUserAnswerStore emits this event before the
        // adapter's handleAskUserResponse runs, so this is the only path
        // that cleans up the Map entry and prevents zombie entries in
        // loadSession results.
        this.pendingAskUserRequests.delete(params.requestId);
      },

      [AgentEvent.SettingsUpdated]: (params) => {
        this.emitSettingsUpdatedNotification(params.settings, params.requestId);
      },

      [AgentEvent.ProjectNotification]: (params) => {
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          notification: params.notification,
        });
      },

      [AgentEvent.QueuedMessagesDiscarded]: (params) => {
        this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
          notification: {
            type: SessionNotificationType.QUEUED_MESSAGES_DISCARDED,
            text: params.text,
            ...(params.requestId && { requestId: params.requestId }),
          },
        });
      },
    });
  }

  private handleAskUserRequestEvent(params: {
    requestId: string;
    toolCallId: string;
    questions: Array<{
      index: number;
      topic: string;
      question: string;
      options: string[];
    }>;
    sessionId: string;
  }): void {
    // Emit state change to waiting for confirmation
    this.sessionController.setWorkingState(
      DroolWorkingState.WaitingForToolConfirmation
    );

    const request = OtelTracing.trace(
      SpanName.CLI_REQUEST_ASK_USER,
      (span) => {
        span.addEvent(SpanEvent.SENDING);

        const _meta: TraceContextMeta = {};
        OtelTracing.injectContext(_meta, OtelTracing.getCurrentContext());

        const req: AskUserRequest = {
          type: 'request',
          jsonrpc: JSONRPC_VERSION,
          industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
          industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
          method: DroolClientMethod.ASK_USER,
          id: params.requestId,
          params: {
            toolCallId: params.toolCallId,
            questions: params.questions,
          },
          ...(_meta.traceparent ? { _meta } : {}),
        };

        this.safeStdoutWrite(`${JSON.stringify(req)}\n`);

        return req;
      },
      {
        attributes: {
          [SpanAttribute.RPC_METHOD]: DroolClientMethod.ASK_USER,
        },
      }
    );

    this.pendingAskUserRequests.set(params.requestId, {
      sessionId: params.sessionId,
      request,
      timestamp: Date.now(),
    });

    logInfo('[JsonRpcAdapter] Ask-user request forwarded', {
      requestId: params.requestId,
      toolCallId: params.toolCallId,
      questionCount: params.questions.length,
    });
  }

  handleAskUserResponse(requestId: string, result: AskUserResult): boolean {
    const pending = this.pendingAskUserRequests.get(requestId);
    if (!pending) {
      logWarn(
        '[JsonRpcAdapter] No pending ask-user request for ID (response)',
        {
          requestId,
        }
      );
      return false;
    }

    this.pendingAskUserRequests.delete(requestId);

    // Return to streaming state
    this.sessionController.setWorkingState(
      DroolWorkingState.StreamingAssistantMessage
    );

    agentEventBus.emit(AgentEvent.AskUserResponse, {
      requestId,
      result,
      sessionId: pending.sessionId,
    });

    return true;
  }

  handleAskUserFailure(
    requestId: string,
    failure: ToolRoundtripFailure
  ): boolean {
    const pending = this.pendingAskUserRequests.get(requestId);
    if (!pending) {
      logWarn('[JsonRpcAdapter] No pending ask-user request for ID (failure)', {
        requestId,
      });
      return false;
    }

    this.pendingAskUserRequests.delete(requestId);

    this.sessionController.setWorkingState(
      DroolWorkingState.StreamingAssistantMessage
    );

    agentEventBus.emit(AgentEvent.AskUserResponse, {
      requestId,
      result: { cancelled: true, answers: [] },
      sessionId: pending.sessionId,
      failure,
    });

    logWarn('[JsonRpcAdapter] Ask-user request failed', {
      requestId,
      failureReason: formatToolRoundtripFailure(failure),
    });

    return true;
  }

  handlePermissionFailure(
    requestId: string,
    failure: ToolRoundtripFailure
  ): boolean {
    const pending = this.pendingPermissionRequests.get(requestId);
    if (!pending) {
      logWarn(
        '[JsonRpcAdapter] No pending permission request for ID (failure)',
        {
          requestId,
        }
      );
      return false;
    }

    this.pendingPermissionRequests.delete(requestId);
    // A CONFLICT means the daemon still has this permission registered and
    // pending (the request was a duplicate, e.g. fanned out across the child
    // and parent sessions). Emitting PERMISSION_RESOLVED here would tear the
    // still-live permission out of the queue, so suppress it for conflicts.
    const isConflictFailure = failure.code === JsonRpcErrorCode.CONFLICT;

    this.sessionController.setWorkingState(
      DroolWorkingState.StreamingAssistantMessage
    );

    agentEventBus.emit(AgentEvent.PermissionResponse, {
      requestId,
      approvedToolIds: [],
      outcome: ToolConfirmationOutcome.Cancel,
      sessionId: pending.sessionId,
      failure,
    });

    if (!isConflictFailure) {
      this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
        notification: {
          type: SessionNotificationType.PERMISSION_RESOLVED,
          requestId,
          toolUseIds: [],
          selectedOption: ToolConfirmationOutcome.Cancel,
        },
      });
    }

    logWarn('[JsonRpcAdapter] Permission request failed', {
      requestId,
      failureReason: formatToolRoundtripFailure(failure),
    });

    return true;
  }

  tryHandleToolingResponse(
    response: JsonRpcBaseResponseSuccess | JsonRpcBaseResponseFailure
  ): boolean {
    if (response.id === null) {
      return false;
    }

    const requestId = String(response.id);
    const hasPendingPermission = this.pendingPermissionRequests.has(requestId);
    const hasPendingAskUser = this.pendingAskUserRequests.has(requestId);

    if (!hasPendingPermission && !hasPendingAskUser) {
      return false;
    }

    if ('error' in response && response.error) {
      const failure: ToolRoundtripFailure = {
        source: ToolRoundtripFailureSource.Daemon,
        code: response.error.code,
        message: response.error.message,
        data: response.error.data,
      };

      if (hasPendingPermission) {
        return this.handlePermissionFailure(requestId, failure);
      }

      if (hasPendingAskUser) {
        return this.handleAskUserFailure(requestId, failure);
      }

      return true;
    }

    if ('result' in response && response.result) {
      if (hasPendingPermission) {
        const parseResult = RequestPermissionResultSchema.safeParse(
          response.result
        );

        if (parseResult.success) {
          logInfo('[JsonRpcAdapter] Permission response parsed', {
            requestId,
            selectedOptionLabel: parseResult.data.selectedOption,
            hasInput: !!parseResult.data.comment,
          });
          return this.handlePermissionResponse(
            requestId,
            undefined,
            parseResult.data.selectedOption,
            parseResult.data.comment,
            parseResult.data.editedSpecContent
          );
        }

        return this.handlePermissionFailure(requestId, {
          source: ToolRoundtripFailureSource.Protocol,
          message: 'Invalid permission response format',
          data: parseResult.error.message,
        });
      }

      const parseResult = AskUserResultSchema.safeParse(response.result);
      if (parseResult.success) {
        return this.handleAskUserResponse(requestId, parseResult.data);
      }

      if (hasPendingAskUser) {
        return this.handleAskUserFailure(requestId, {
          source: ToolRoundtripFailureSource.Protocol,
          message: 'Invalid ask-user response format',
          data: parseResult.error.message,
        });
      }
      return true;
    }

    const fallbackFailure: ToolRoundtripFailure = {
      source: ToolRoundtripFailureSource.Protocol,
      message: 'Missing response payload for pending tool request',
    };

    if (hasPendingPermission) {
      return this.handlePermissionFailure(requestId, fallbackFailure);
    }

    if (hasPendingAskUser) {
      return this.handleAskUserFailure(requestId, fallbackFailure);
    }
    return true;
  }

  /**
   * Handle message created event - emit appropriate notification
   */
  private handleMessageCreated(
    message: IndustryDroolMessage,
    sessionId: string,
    requestId?: string
  ): void {
    // Tool-role messages are already handled via AgentEvent.ToolResult
    // notifications. Letting them fall through here would duplicate output.
    if (message.role === 'tool') {
      return;
    }

    // Handle user/assistant/system messages - emit CREATE_MESSAGE notification
    // Filter out system reminders
    const visibleContent = message.content.filter((block) => {
      if (block.type === MessageContentBlockType.Text) {
        return !block.text.trim().startsWith(SYSTEM_REMINDER_START);
      }
      return true;
    });

    if (visibleContent.length === 0 && !requestId) {
      return;
    }

    const notification: CreateMessageNotification = {
      type: SessionNotificationType.CREATE_MESSAGE,
      message: {
        id: message.id,
        role: message.role,
        content: visibleContent,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        ...(message.parentId && { parentId: message.parentId }),
        ...(message.visibility && { visibility: message.visibility }),
      },
      // Include requestId for user messages so frontend can clear the queued message
      ...(requestId && { requestId }),
    };

    logInfo('[JsonRpcAdapter] Emitting CREATE_MESSAGE notification', {
      messageId: message.id,
      role: message.role,
      sessionId,
      requestId,
    });

    this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
      notification,
    });
  }

  /**
   * Handle PermissionRequest event from AgentEventBus.
   * Forwards the request to the client via JSON-RPC and tracks for response.
   */
  private handlePermissionRequestEvent(params: {
    requestId: string;
    toolUses: ToolConfirmationInfo[];
    options: ToolConfirmationListItem[];
    sessionId: string;
  }): void {
    // Emit state change to waiting for confirmation
    this.sessionController.setWorkingState(
      DroolWorkingState.WaitingForToolConfirmation
    );

    // Trace the permission request send operation
    const request = OtelTracing.trace(
      SpanName.CLI_REQUEST_PERMISSION,
      (span) => {
        span.addEvent(SpanEvent.SENDING);

        // Inject trace context from the span's context (now active)
        const _meta: TraceContextMeta = {};
        OtelTracing.injectContext(_meta, OtelTracing.getCurrentContext());

        const req: RequestPermissionRequest = {
          type: 'request',
          jsonrpc: JSONRPC_VERSION,
          industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
          industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
          method: DroolClientMethod.REQUEST_PERMISSION,
          id: params.requestId,
          params: {
            toolUses: params.toolUses.map((info) => ({
              toolUse: {
                type: MessageContentBlockType.ToolUse,
                id: info.toolUseId,
                name: info.toolName,
                input: info.toolInput,
              },
              confirmationType: info.confirmationType,
              // Cast details to the serialization type (same structure, just without onConfirm)
              details: info.details as ToolConfirmationDetailsData,
            })),
            options: params.options,
          },
          ...(_meta.traceparent ? { _meta } : {}),
        };

        // Emit request to stdout
        this.safeStdoutWrite(`${JSON.stringify(req)}\n`);

        return req;
      },
      {
        attributes: {
          [SpanAttribute.RPC_METHOD]: DroolClientMethod.REQUEST_PERMISSION,
        },
      }
    );

    // Track the request so we can emit PermissionResponse when client responds
    this.pendingPermissionRequests.set(params.requestId, {
      sessionId: params.sessionId,
      request,
      timestamp: Date.now(),
    });

    logInfo('[JsonRpcAdapter] Permission request forwarded', {
      requestId: params.requestId,
      toolCount: params.toolUses.length,
    });
  }

  /**
   * Request permission for a batch of tools.
   * Returns a promise that resolves when the user responds.
   *
   * Note: This method is for direct calls. It listens to PermissionResponse
   * events to get the result, which are emitted by handlePermissionResponse.
   */
  async requestPermission(
    batch: ToolConfirmationBatch,
    options?: {
      requestId?: string;
      sessionId?: string;
      associatedSessionIds?: string[];
    }
  ): Promise<PermissionResponse> {
    const requestId = options?.requestId ?? generateUUID();
    const sessionId =
      options?.sessionId ?? this.sessionController.getSessionId() ?? 'unknown';

    // Emit state change to waiting for confirmation
    this.sessionController.setWorkingState(
      DroolWorkingState.WaitingForToolConfirmation
    );

    // Trace the permission request send operation
    const request = OtelTracing.trace(
      SpanName.CLI_REQUEST_PERMISSION,
      (span) => {
        span.addEvent(SpanEvent.SENDING);

        // Inject trace context from the span's context (now active)
        const _meta: TraceContextMeta = {};
        OtelTracing.injectContext(_meta, OtelTracing.getCurrentContext());

        const req: RequestPermissionRequest = {
          type: 'request',
          jsonrpc: JSONRPC_VERSION,
          industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
          industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
          method: DroolClientMethod.REQUEST_PERMISSION,
          id: requestId,
          params: {
            toolUses: batch.toolUses.map((info) => ({
              toolUse: {
                type: MessageContentBlockType.ToolUse,
                id: info.toolUseId,
                name: info.toolName,
                input: info.toolInput,
              },
              confirmationType: info.confirmationType,
              // Cast details to the serialization type (same structure, just without onConfirm)
              details: info.details as ToolConfirmationDetailsData,
            })),
            options: batch.options,
            ...(options?.associatedSessionIds
              ? { associatedSessionIds: options.associatedSessionIds }
              : {}),
          },
          ...(_meta.traceparent ? { _meta } : {}),
        };

        // Emit request to stdout
        this.safeStdoutWrite(`${JSON.stringify(req)}\n`);

        return req;
      },
      {
        attributes: {
          [SpanAttribute.RPC_METHOD]: DroolClientMethod.REQUEST_PERMISSION,
        },
      }
    );

    // Track the request
    this.pendingPermissionRequests.set(requestId, {
      sessionId,
      request,
      timestamp: Date.now(),
    });

    // Listen for the response via event bus
    return new Promise<PermissionResponse>((resolve, reject) => {
      const handleResponse = (payload: {
        requestId: string;
        approvedToolIds: string[];
        outcome?: ToolConfirmationOutcome;
        comment?: string;
        editedSpecContent?: string;
        failure?: ToolRoundtripFailure;
      }) => {
        if (payload.requestId === requestId) {
          agentEventBus.off(AgentEvent.PermissionResponse, handleResponse);

          if (payload.failure) {
            reject(new Error(formatToolRoundtripFailure(payload.failure)));
            return;
          }

          const permissionResponse: PermissionResponse = {
            outcome:
              payload.outcome ??
              (payload.approvedToolIds.length > 0
                ? ToolConfirmationOutcome.ProceedOnce
                : ToolConfirmationOutcome.Cancel),
            approvedToolIds: payload.approvedToolIds,
            comment: payload.comment,
          };
          if (payload.editedSpecContent !== undefined) {
            permissionResponse.editedSpecContent = payload.editedSpecContent;
          }

          resolve(permissionResponse);
        }
      };
      agentEventBus.on(AgentEvent.PermissionResponse, handleResponse);
    });
  }

  /**
   * Handle a permission response from the client.
   * Call this when a response is received via stdin.
   */
  handlePermissionResponse(
    requestId: string,
    approvedToolIds: string[] | undefined,
    outcome: ToolConfirmationOutcome,
    comment?: string,
    editedSpecContent?: string
  ): boolean {
    const pending = this.pendingPermissionRequests.get(requestId);
    if (!pending) {
      logWarn(
        '[JsonRpcAdapter] No pending permission request for ID (response)',
        {
          requestId,
        }
      );
      return false;
    }

    this.pendingPermissionRequests.delete(requestId);

    const isCancelled = outcome === ToolConfirmationOutcome.Cancel;
    const pendingToolIds = pending.request.params.toolUses.map(
      (toolUse) => toolUse.toolUse.id
    );
    const resolvedApprovedToolIds = isCancelled
      ? []
      : (approvedToolIds ?? pendingToolIds);

    // Approval resumes tool execution; cancel hands control back to the agent loop.
    this.sessionController.setWorkingState(
      isCancelled
        ? DroolWorkingState.StreamingAssistantMessage
        : DroolWorkingState.ExecutingTool
    );

    const permissionResponse: PermissionResponse = {
      outcome,
      approvedToolIds: resolvedApprovedToolIds,
      comment,
    };
    if (editedSpecContent !== undefined) {
      permissionResponse.editedSpecContent = editedSpecContent;
    }

    const permissionResponsePayload = {
      requestId,
      ...permissionResponse,
      approvedToolIds: resolvedApprovedToolIds,
      sessionId: pending.sessionId,
    };

    // Emit PermissionResponse to AgentEventBus
    agentEventBus.emit(
      AgentEvent.PermissionResponse,
      permissionResponsePayload
    );

    // Emit PERMISSION_RESOLVED notification to frontend client
    this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
      notification: {
        type: SessionNotificationType.PERMISSION_RESOLVED,
        requestId,
        toolUseIds: resolvedApprovedToolIds,
        selectedOption: outcome,
      },
    });

    return true;
  }

  /**
   * Reject all pending permission requests
   */
  rejectAllPendingPermissions(): void {
    const hadPendingPermissionRequests =
      this.pendingPermissionRequests.size > 0;

    for (const [
      requestId,
      pending,
    ] of this.pendingPermissionRequests.entries()) {
      logInfo('[JsonRpcAdapter] Rejecting pending permission request', {
        requestId,
      });

      // Emit empty response on rejection
      agentEventBus.emit(AgentEvent.PermissionResponse, {
        requestId,
        approvedToolIds: [],
        outcome: ToolConfirmationOutcome.Cancel,
        sessionId: pending.sessionId,
      });

      // Emit PERMISSION_RESOLVED notification to frontend client
      this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
        notification: {
          type: SessionNotificationType.PERMISSION_RESOLVED,
          requestId,
          toolUseIds: [],
          selectedOption: ToolConfirmationOutcome.Cancel,
        },
      });
    }
    this.pendingPermissionRequests.clear();

    if (hadPendingPermissionRequests) {
      this.sessionController.setWorkingState(DroolWorkingState.Idle);
    }
  }

  rejectAllPendingAskUserRequests(): void {
    for (const [requestId, pending] of this.pendingAskUserRequests.entries()) {
      logInfo('[JsonRpcAdapter] Rejecting pending ask-user request', {
        requestId,
      });

      agentEventBus.emit(AgentEvent.AskUserResponse, {
        requestId,
        result: { cancelled: true, answers: [] },
        sessionId: pending.sessionId,
      });

      this.pendingAskUserRequests.delete(requestId);
    }
  }

  /**
   * Get count of pending permission requests
   */
  getPendingPermissionCount(): number {
    return this.pendingPermissionRequests.size;
  }

  /**
   * Get pending permission requests for session restore (load_session)
   * Returns the full request params extended with requestId, matching LoadSessionResult type
   */
  getPendingPermissions(): Array<
    RequestPermissionRequest['params'] & { requestId: string }
  > {
    return Array.from(this.pendingPermissionRequests.entries()).map(
      ([requestId, entry]) => ({
        requestId,
        ...entry.request.params, // Include full params (toolUses, options)
      })
    );
  }

  /**
   * Get pending ask-user requests for session restore (load_session)
   * Returns the full request params extended with requestId, matching LoadSessionResult type
   */
  getPendingAskUserRequests(): Array<
    AskUserRequest['params'] & { requestId: string }
  > {
    return Array.from(this.pendingAskUserRequests.entries()).map(
      ([requestId, entry]) => ({
        requestId,
        ...entry.request.params,
      })
    );
  }

  private emitToolCallNotification(
    id: string,
    name: string,
    input: Record<string, unknown>
  ): void {
    this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
      notification: {
        type: SessionNotificationType.TOOL_CALL,
        toolUse: {
          type: MessageContentBlockType.ToolUse,
          id,
          name,
          input,
        },
      },
    });
  }

  /**
   * Emit a JSON-RPC success response
   */
  emitResponse(
    requestId: string,
    result: JsonRpcBaseResponseSuccess['result']
  ): void {
    // Inject trace context from active span context
    const _meta: TraceContextMeta = {};
    OtelTracing.injectContext(_meta, OtelTracing.getCurrentContext());

    const response: JsonRpcBaseResponseSuccess = {
      jsonrpc: JSONRPC_VERSION,
      type: 'response',
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: requestId,
      result,
      ...(_meta.traceparent ? { _meta } : {}),
    };
    this.safeStdoutWrite(`${JSON.stringify(response)}\n`);
  }

  /**
   * Emit a JSON-RPC notification
   */
  private emitNotification(
    method: DroolClientMethod.SESSION_NOTIFICATION,
    params: SessionNotificationParams
  ): void {
    // Trace the notification send operation
    OtelTracing.trace(
      SpanName.CLI_SEND_NOTIFICATION,
      (span) => {
        span.addEvent(SpanEvent.SENDING);

        // Inject trace context from active span context
        const _meta: TraceContextMeta = {};
        OtelTracing.injectContext(_meta, OtelTracing.getCurrentContext());

        const notification: SessionNotificationEvent = {
          jsonrpc: JSONRPC_VERSION,
          type: 'notification',
          industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
          industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
          method,
          params,
          ...(_meta.traceparent ? { _meta } : {}),
        };
        this.safeStdoutWrite(`${JSON.stringify(notification)}\n`);

        span.addEvent(SpanEvent.SENT);
      },
      {
        attributes: {
          [SpanAttribute.RPC_METHOD]: method,
          [SpanAttribute.NOTIFICATION_TYPE]: params.notification.type,
        },
      }
    );
  }

  /**
   * Emit settings updated notification
   */
  private emitSettingsUpdatedNotification(
    updates: Partial<SessionSettings> & {
      sandbox?: SandboxStatus;
    },
    requestId?: string
  ): void {
    // Always include spec mode fields from the current settings state.
    // Presence of specModeModelId means spec mode is active; absence means it's not.
    const currentSettings = this.sessionController.getSettings();
    const missionSettings = currentSettings.missionSettings;

    const notification: SettingsUpdatedNotification = {
      type: SessionNotificationType.SETTINGS_UPDATED,
      ...(requestId !== undefined && { requestId }),
      settings: {
        ...(updates.modelId !== undefined && { modelId: updates.modelId }),
        ...(updates.reasoningEffort !== undefined && {
          reasoningEffort: updates.reasoningEffort,
        }),
        ...(updates.autonomyMode !== undefined && {
          autonomyMode: updates.autonomyMode,
        }),
        ...(updates.interactionMode !== undefined && {
          interactionMode: updates.interactionMode,
        }),
        ...(updates.autonomyLevel !== undefined && {
          autonomyLevel: updates.autonomyLevel,
        }),
        ...(currentSettings.specModeModelId !== undefined &&
          currentSettings.specModeModelId !== null && {
            specModeModelId: currentSettings.specModeModelId,
          }),
        ...(currentSettings.specModeReasoningEffort !== undefined &&
          currentSettings.specModeReasoningEffort !== null && {
            specModeReasoningEffort: currentSettings.specModeReasoningEffort,
          }),
        ...(updates.enabledToolIds !== undefined && {
          enabledToolIds: currentSettings.enabledToolIds,
        }),
        ...(updates.disabledToolIds !== undefined && {
          disabledToolIds: currentSettings.disabledToolIds,
        }),
        ...(missionSettings !== undefined && {
          missionSettings,
        }),
        ...(updates.compactionThresholdCheckEnabled !== undefined && {
          compactionThresholdCheckEnabled:
            currentSettings.compactionThresholdCheckEnabled,
        }),
        ...(updates.sandbox !== undefined && { sandbox: updates.sandbox }),
      },
    };

    logInfo('[JsonRpcAdapter] Emitting settings updated notification', {
      value: JSON.stringify(notification.settings),
    });

    this.emitNotification(DroolClientMethod.SESSION_NOTIFICATION, {
      notification,
    });
  }

  emitSettingsUpdatedAck(requestId: string): void {
    this.emitSettingsUpdatedNotification(
      { ...this.sessionController.getSettings() },
      requestId
    );
  }

  /**
   * Clean up subscriptions
   */
  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.stdoutErrorHandler) {
      process.stdout.removeListener('error', this.stdoutErrorHandler);
      this.stdoutErrorHandler = null;
    }
    this.pendingPermissionRequests.clear();
    this.pendingAskUserRequests.clear();
    this.parentDisconnectCallbacks.clear();
  }
}
