// eslint-disable-next-line max-classes-per-file -- PLT-76: migrated from file-level disable
import { EventEmitter } from 'events';

import {
  AgentTurnCompletionReason,
  DecompSessionType,
  DroolWorkingState,
  ToolConfirmationOutcome,
  type AskUserQuestion,
  type AskUserResult,
  type McpAuthCompletedNotification,
  type McpAuthRequiredNotification,
  type McpStatusChangedNotification,
  type SessionNotificationParams,
  type ToolConfirmationInfo,
  type ToolConfirmationListItem,
  type ToolStreamingUpdate as ToolStreamingUpdatePayload,
} from '@industry/drool-sdk-ext/protocol/drool';
import { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';

import type { SessionSettings } from '@/controllers/SessionController';
import type { ToolRoundtripFailure } from '@/utils/toolRoundtripFailure/types';

import type { TokenUsage } from '@industry/common/session/settings';

/**
 * Enum of all agent event names.
 */
// eslint-disable-next-line industry/enum-file-organization -- PLT-76: migrated from file-level disable
export enum AgentEvent {
  // Text streaming
  AssistantTextDelta = 'assistant-text-delta',
  ThinkingTextDelta = 'thinking-text-delta',
  TextBlockComplete = 'text-block-complete',
  ThinkingBlockComplete = 'thinking-block-complete',

  // Tool execution
  ToolCallStart = 'tool-call-start',
  ToolCallProgress = 'tool-call-progress',
  ToolInputComplete = 'tool-input-complete',
  ToolCallComplete = 'tool-call-complete',
  ToolResult = 'tool-result',
  ToolStreamingUpdate = 'tool-streaming-update',
  ToolExecutionHeartbeat = 'tool-execution-heartbeat',

  // Messages
  MessageCreated = 'message-created',
  UserMessage = 'user-message',
  AssistantMessage = 'assistant-message',
  ToolMessage = 'tool-message',

  // State changes
  WorkingStateChanged = 'working-state-changed',
  AgentTurnCompleted = 'agent-turn-completed',
  SettingsUpdated = 'settings-updated',
  SessionCompacted = 'session-compacted',

  // Session lifecycle
  SessionTitleUpdated = 'session-title-updated',
  SessionCreated = 'session-created',
  SessionLoaded = 'session-loaded',
  ChildSessionAvailable = 'child-session-available',

  // Streaming lifecycle
  StreamingStart = 'streaming-start',
  StreamingComplete = 'streaming-complete',

  // MCP
  McpStatusChanged = 'mcp-status-changed',
  McpAuthRequired = 'mcp-auth-required',
  McpAuthCompleted = 'mcp-auth-completed',

  // Project (decomposition mode)
  ProjectNotification = 'project-notification',

  // Errors
  AgentError = 'agent-error',

  // Permission requests
  PermissionRequest = 'permission-request',
  PermissionResponse = 'permission-response',

  // Ask-user requests
  AskUserRequest = 'ask-user-request',
  AskUserResponse = 'ask-user-response',

  // Queue management
  QueuedMessagesDiscarded = 'queued-messages-discarded',
}

// eslint-disable-next-line industry/enum-file-organization -- PLT-76: migrated from file-level disable
export enum SessionTitleUpdateType {
  LlmGenerated = 'llm_generated',
  FirstUserMessage = 'first_user_message',
  ManualRename = 'manual_rename',
}

/**
 * Agent event types with their payload signatures.
 *
 * All modes (TUI, StreamingJSONRPC, ACP) emit these events through the shared
 * event bus. Protocol adapters subscribe and translate to their specific formats.
 */
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export interface AgentEventPayloads {
  // Text streaming
  [AgentEvent.AssistantTextDelta]: {
    messageId: string;
    blockIndex: number;
    textDelta: string;
    sessionId: string;
  };
  [AgentEvent.ThinkingTextDelta]: {
    messageId: string;
    blockIndex: number;
    textDelta: string;
    sessionId: string;
  };
  [AgentEvent.TextBlockComplete]: {
    messageId: string;
    blockIndex: number;
    sessionId: string;
  };
  [AgentEvent.ThinkingBlockComplete]: {
    messageId: string;
    blockIndex: number;
    sessionId: string;
    durationMs?: number;
  };

  // Tool execution
  [AgentEvent.ToolCallStart]: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    sessionId: string;
  };
  [AgentEvent.ToolCallProgress]: {
    id: string;
    partialInput: Record<string, unknown>;
    sessionId: string;
  };
  [AgentEvent.ToolInputComplete]: {
    sessionId: string;
  };
  [AgentEvent.ToolCallComplete]: {
    id: string;
    result: string;
    isError: boolean;
    sessionId: string;
  };
  [AgentEvent.ToolResult]: {
    toolUseId: string;
    messageId: string;
    content: string;
    isError: boolean;
    sessionId: string;
  };
  [AgentEvent.ToolStreamingUpdate]: {
    id: string;
    name: string;
    update: ToolStreamingUpdatePayload;
    sessionId: string;
  };
  /**
   * Keep-alive signal emitted while a long-running tool (e.g. Execute) is
   * actively executing but not producing new streaming output. The
   * JsonRpcProtocolAdapter translates this to a TOOL_EXECUTION_HEARTBEAT
   * session notification, which the daemon consumes to refresh session
   * inactivity timers. Not surfaced to UI consumers.
   */
  [AgentEvent.ToolExecutionHeartbeat]: {
    toolUseId: string;
    toolName: string;
    sessionId: string;
  };

  // Messages
  [AgentEvent.MessageCreated]: {
    message: IndustryDroolMessage;
    sessionId: string;
    /** Request ID for queued message tracking - passed through to CREATE_MESSAGE notification */
    requestId?: string;
  };
  [AgentEvent.UserMessage]: {
    message: IndustryDroolMessage;
    sessionId: string;
    /** Request ID for queued message tracking */
    requestId?: string;
  };
  [AgentEvent.AssistantMessage]: {
    message: IndustryDroolMessage;
    sessionId: string;
  };
  [AgentEvent.ToolMessage]: {
    message: IndustryDroolMessage;
    sessionId: string;
  };

  // State changes
  [AgentEvent.WorkingStateChanged]: {
    state: DroolWorkingState;
    sessionId: string;
  };
  [AgentEvent.AgentTurnCompleted]: {
    sessionId: string;
    reason: AgentTurnCompletionReason;
    tokenUsage: TokenUsage;
    cumulativeTokenUsage: TokenUsage;
  };
  [AgentEvent.SettingsUpdated]: {
    settings: Partial<SessionSettings>;
    sessionId: string;
    requestId?: string;
  };
  [AgentEvent.SessionCompacted]: {
    sessionId: string;
    summaryId: string;
    removedCount: number;
    visibleBoundaryMessageId: string | null;
  };

  // Session lifecycle
  [AgentEvent.SessionTitleUpdated]: {
    sessionId: string;
    title: string;
    updateType: SessionTitleUpdateType;
    requestId?: string;
  };
  [AgentEvent.SessionCreated]: {
    sessionId: string;
  };
  [AgentEvent.SessionLoaded]: {
    sessionId: string;
    cwd?: string;
    settings: SessionSettings;
    messages: IndustryDroolMessage[];
    decompSessionType?: DecompSessionType;
  };
  [AgentEvent.ChildSessionAvailable]: {
    parentSessionId: string;
    childSessionId: string;
    toolUseId: string;
  };

  // Streaming lifecycle
  [AgentEvent.StreamingStart]: {
    sessionId: string;
  };
  [AgentEvent.StreamingComplete]: {
    sessionId: string;
  };

  // MCP
  [AgentEvent.McpStatusChanged]: {
    notification: McpStatusChangedNotification;
  };

  [AgentEvent.McpAuthRequired]: {
    notification: McpAuthRequiredNotification;
  };

  [AgentEvent.McpAuthCompleted]: {
    notification: McpAuthCompletedNotification;
  };

  // Project (decomposition mode)
  [AgentEvent.ProjectNotification]: {
    notification: SessionNotificationParams['notification'];
  };

  // Errors
  [AgentEvent.AgentError]: {
    error: unknown;
    sessionId: string;
  };

  // Permission requests
  [AgentEvent.PermissionRequest]: {
    requestId: string;
    toolUses: ToolConfirmationInfo[];
    options: ToolConfirmationListItem[];
    sessionId: string;
  };
  [AgentEvent.PermissionResponse]: {
    requestId: string;
    approvedToolIds: string[];
    outcome?: ToolConfirmationOutcome;
    comment?: string;
    editedSpecContent?: string;
    sessionId: string;
    failure?: ToolRoundtripFailure;
  };

  [AgentEvent.AskUserRequest]: {
    requestId: string;
    toolCallId: string;
    questions: AskUserQuestion[];
    sessionId: string;
  };

  [AgentEvent.AskUserResponse]: {
    requestId: string;
    result: AskUserResult;
    sessionId: string;
    failure?: ToolRoundtripFailure;
  };

  // Queue management
  [AgentEvent.QueuedMessagesDiscarded]: {
    text: string;
    requestId?: string;
  };
}

// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type AgentEventName = keyof AgentEventPayloads;

/**
 * TypedEventEmitter provides type-safe event emission and subscription.
 */
class TypedEventEmitter<Events> extends EventEmitter {
  emit<K extends keyof Events & string>(event: K, payload: Events[K]): boolean {
    return super.emit(event, payload);
  }

  on<K extends keyof Events & string>(
    event: K,
    listener: (payload: Events[K]) => void
  ): this {
    return super.on(event, listener);
  }

  once<K extends keyof Events & string>(
    event: K,
    listener: (payload: Events[K]) => void
  ): this {
    return super.once(event, listener);
  }

  off<K extends keyof Events & string>(
    event: K,
    listener: (payload: Events[K]) => void
  ): this {
    return super.off(event, listener);
  }

  addListener<K extends keyof Events & string>(
    event: K,
    listener: (payload: Events[K]) => void
  ): this {
    return super.addListener(event, listener);
  }

  removeListener<K extends keyof Events & string>(
    event: K,
    listener: (payload: Events[K]) => void
  ): this {
    return super.removeListener(event, listener);
  }
}

/**
 * AgentEventBus is a typed event emitter for agent events.
 *
 * Usage:
 * ```typescript
 * // Emit an event (from useAgent or similar)
 * agentEventBus.emit('assistant-text-delta', {
 *   messageId: 'msg-123',
 *   blockIndex: 0,
 *   textDelta: 'Hello',
 * });
 *
 * // Subscribe to events (from protocol adapters)
 * agentEventBus.on('assistant-text-delta', (payload) => {
 *   // Translate to JSON-RPC or ACP format
 * });
 * ```
 */
class AgentEventBus extends TypedEventEmitter<AgentEventPayloads> {
  constructor() {
    super();
    // Increase max listeners since multiple adapters may subscribe
    this.setMaxListeners(50);
  }

  /**
   * Remove all listeners - useful for cleanup between tests
   */
  reset(): void {
    this.removeAllListeners();
  }
}

// Singleton instance
export const agentEventBus = new AgentEventBus();

/**
 * Helper to create a scoped subscriber that auto-cleans up.
 * Returns an unsubscribe function.
 */
export function subscribeToAgentEvents<K extends AgentEventName>(
  event: K,
  handler: (payload: AgentEventPayloads[K]) => void
): () => void {
  agentEventBus.on(event, handler);
  return () => agentEventBus.off(event, handler);
}

// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export type AgentEventHandlers = {
  [K in AgentEventName]?: (payload: AgentEventPayloads[K]) => void;
};

/**
 * Helper to subscribe to multiple events at once.
 * Returns an unsubscribe function that removes all handlers.
 *
 * Note: The cast below is required because TypeScript cannot narrow the handler
 * type when iterating over Object.keys(). The AgentEventHandlers type guarantees
 * that handlers[event] has the correct payload type for that event.
 */
export function subscribeToMultipleAgentEvents(
  handlers: AgentEventHandlers
): () => void {
  const unsubscribers: Array<() => void> = [];

  for (const event of Object.keys(handlers) as AgentEventName[]) {
    const handler = handlers[event] as
      | ((payload: AgentEventPayloads[typeof event]) => void)
      | undefined;
    if (handler) {
      unsubscribers.push(subscribeToAgentEvents(event, handler));
    }
  }

  return () => unsubscribers.forEach((fn) => fn());
}
