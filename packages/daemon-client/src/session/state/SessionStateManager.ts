import {
  DaemonSpecificNotificationType,
  DaemonTerminalEvent,
  SessionLoadState,
  type DaemonSessionNotificationParams,
} from '@industry/common/daemon';
import { TerminalStatus } from '@industry/common/terminal';
import {
  McpStatus,
  SessionNotificationType,
  DroolWorkingState,
  type AvailableModelConfig,
  type McpServerStatusInfo,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  MessageContentBlockType,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import {
  AutonomyLevel,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logError, logInfo, logWarn } from '@industry/logging';
import { filterMessagesForUI } from '@industry/utils/messages';

import { QueuedUserMessageKind } from './enums';
import { isDaemonQueuedMessageKind } from './queuedUserMessageHelpers';
import { SessionStore } from './SessionStore';
import {
  getLatestTodoWriteToolUse,
  getTodoListFromToolUse,
  isTodoWriteToolUse,
} from './todoState';
import { resolveInteractionSettings } from '../utils/resolveInteractionSettings';

import type { TerminalMetadata } from '../types';
import type { QueuedUserMessageState, SessionTodoList } from './types';
import type {
  ToolResultBlock,
  ToolUseBlock,
  ContentBlock,
  IndustryDroolMessage,
  StreamingTextBlock,
  StreamingThinkingBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

const PROCESSED_REQUEST_ID_CACHE_LIMIT = 500;

// Helper to detect abort errors from user interruption
const isAbortError = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    lower.includes('aborted') ||
    lower.includes('request was aborted') ||
    lower.includes('aborterror') ||
    lower.includes('apiuseraborterror')
  );
};

/**
 * SessionStateManager handles complex business logic and mutations
 * for session state, working on top of the primitive SessionStore.
 *
 * This layer is responsible for:
 * - Processing notifications and updating messages accordingly
 * - Managing relationships between tool calls and tool results
 * - Handling streaming updates
 * - Coordinating complex message mutations
 */
export class SessionStateManager {
  private store: SessionStore;

  private streamingMessageIds: Set<string> = new Set();

  // SSM is the source of truth for all queued prompts in this session.
  // Queue entries explicitly distinguish local post-Esc deferrals from
  // daemon-accepted discardable queue entries while preserving FIFO order.
  private queuedMessages: Map<string, QueuedUserMessageState> = new Map();

  private processedMessageRequestIds: Set<string> = new Set();

  // Track tool messages that arrived before their parent assistant message
  // Key: toolUseId, Value: tool result message
  private orphanedToolMessages: Map<string, IndustryDroolMessage> = new Map();

  // Track the pending assistant message created from TOOL_CALL notifications.
  // TOOL_CALL notifications arrive individually before the authoritative
  // CREATE_MESSAGE (assistant). We buffer them into a single pending message
  // and replace it when CREATE_MESSAGE arrives.
  private pendingAssistantMessageId: string | null = null;

  private droolWorkingState: DroolWorkingState = DroolWorkingState.Idle;

  // Track whether the last notification was a streaming text/thinking delta
  // so we can flush pending throttled notifications when transitioning to
  // a discrete event type.
  private lastNotificationWasStreamingDelta = false;

  private thinkingBlockStartTimes: Map<string, number> = new Map();

  private thinkingBlockContentIndices: Map<string, number> = new Map();

  private getThinkingBlockKey(messageId: string, blockIndex: number): string {
    return `${messageId}:${blockIndex}`;
  }

  private rememberThinkingBlockContentIndex(
    messageId: string,
    blockIndex: number,
    contentIndex: number
  ): void {
    this.thinkingBlockContentIndices.set(
      this.getThinkingBlockKey(messageId, blockIndex),
      contentIndex
    );
  }

  private getMappedThinkingBlockContentIndex(
    messageId: string,
    blockIndex: number,
    content: ContentBlock[]
  ): number | undefined {
    const key = this.getThinkingBlockKey(messageId, blockIndex);
    const contentIndex = this.thinkingBlockContentIndices.get(key);
    if (
      contentIndex !== undefined &&
      content[contentIndex]?.type === MessageContentBlockType.Thinking
    ) {
      return contentIndex;
    }

    if (contentIndex !== undefined) {
      this.thinkingBlockContentIndices.delete(key);
    }

    return undefined;
  }

  private findThinkingBlockContentIndexByOrdinal(
    content: ContentBlock[],
    blockIndex: number
  ): number {
    let thinkingBlockCount = 0;
    for (let i = 0; i < content.length; i++) {
      if (content[i].type === MessageContentBlockType.Thinking) {
        if (thinkingBlockCount === blockIndex) {
          return i;
        }
        thinkingBlockCount++;
      }
    }

    return -1;
  }

  private clearThinkingBlockTracking(): void {
    this.thinkingBlockStartTimes.clear();
    this.thinkingBlockContentIndices.clear();
  }

  private getTrackedThinkingBlockIndexForContentIndex(
    messageId: string,
    contentIndex: number
  ): number | undefined {
    const keyPrefix = `${messageId}:`;
    for (const [key, trackedContentIndex] of this.thinkingBlockContentIndices) {
      if (!key.startsWith(keyPrefix) || trackedContentIndex !== contentIndex) {
        continue;
      }

      const blockIndex = Number(key.slice(keyPrefix.length));
      return Number.isNaN(blockIndex) ? undefined : blockIndex;
    }

    return undefined;
  }

  private completeStreamingContentBlocks(): void {
    for (const message of this.store.getMessages()) {
      let didUpdateMessage = false;
      let thinkingBlockOrdinal = 0;
      const content = message.content.map((block, contentIndex) => {
        if (
          block.type === MessageContentBlockType.Text &&
          'isStreaming' in block &&
          block.isStreaming === true
        ) {
          didUpdateMessage = true;
          return {
            ...block,
            isStreaming: false,
          } satisfies StreamingTextBlock;
        }

        if (block.type === MessageContentBlockType.Thinking) {
          const blockIndex =
            this.getTrackedThinkingBlockIndexForContentIndex(
              message.id,
              contentIndex
            ) ?? thinkingBlockOrdinal;
          thinkingBlockOrdinal++;

          if ('isStreaming' in block && block.isStreaming === true) {
            didUpdateMessage = true;
            const trackedDurationMs = this.resolveThinkingDurationMs(
              message.id,
              blockIndex
            );
            return {
              ...block,
              isStreaming: false,
              ...(trackedDurationMs === undefined
                ? {}
                : { durationMs: trackedDurationMs }),
            } satisfies StreamingThinkingBlock;
          }
        }

        return block;
      });

      if (didUpdateMessage) {
        this.store.updateMessage(message.id, {
          content,
          updatedAt: Date.now(),
        });
      }
    }

    this.streamingMessageIds.clear();
    this.clearThinkingBlockTracking();
  }

  private markThinkingBlockStarted(
    messageId: string,
    blockIndex: number
  ): void {
    const key = this.getThinkingBlockKey(messageId, blockIndex);
    if (!this.thinkingBlockStartTimes.has(key)) {
      this.thinkingBlockStartTimes.set(key, Date.now());
    }
  }

  private resolveThinkingDurationMs(
    messageId: string,
    blockIndex: number
  ): number | undefined {
    const key = this.getThinkingBlockKey(messageId, blockIndex);
    const startedAtMs = this.thinkingBlockStartTimes.get(key);
    this.thinkingBlockStartTimes.delete(key);
    return startedAtMs === undefined
      ? undefined
      : Math.max(0, Date.now() - startedAtMs);
  }

  private loadState: SessionLoadState = SessionLoadState.NotLoaded;

  // Terminal registry: maps terminalId → write handler
  // When a terminal is mounted, it registers a handler
  // When unmounted, it unregisters and data gets buffered instead
  private terminalWriteHandlers: Map<string, (data: string) => void> =
    new Map();

  // Optimistic messages that are shown immediately before server confirmation
  // Key: requestId, Value: the optimistic message
  private optimisticMessages: Map<string, IndustryDroolMessage> = new Map();

  // Streaming-assistant placeholder bubble id rendered while the user's
  // submitted turn is in flight. Set synchronously by
  // MultiSessionStateManager.registerOptimisticSubmit alongside the user
  // bubble (which lives in optimisticMessages). Cleared on
  // confirm/cancel via the same path. The user bubble itself is
  // rendered via getDisplayMessages → optimisticMessages, so this field
  // is just for the (empty) assistant streaming placeholder slot.
  private optimisticAssistantBubbleId: string | null = null;

  // Progressive UI rendering (on by default, used by the Ink CLI): when
  // enabled, initializeSession bounds the initially rendered tail of large
  // transcripts and the consumer expands via expandUiMessages(). Web/desktop
  // opt out and render the full transcript, relying on settled-row
  // memoization instead.
  private readonly progressiveUiRender: boolean;

  // When non-null, limits how many messages are rendered (from the tail).
  // null means "show all" (fully expanded).
  private renderLimit: number | null = null;

  private static readonly INITIAL_UI_RENDER_LIMIT = 30;

  private currentTodos: SessionTodoList | null = null;

  // Index of TodoWrite tool-use blocks by tool-use id so todo state updates
  // on tool results are O(1) instead of rescanning the whole transcript.
  private todoToolUsesById: Map<string, ToolUseBlock> = new Map();

  // Recency guard: tool-use ids are assigned monotonically increasing
  // sequence numbers on first track, and currentTodos remembers the sequence
  // that produced it, so a re-delivered success result for an older TodoWrite
  // (notification replay, reconnect result overwrites) cannot regress the
  // list to an earlier state.
  private todoToolUseSequenceById: Map<string, number> = new Map();

  private nextTodoToolUseSequence = 0;

  private currentTodosSequence = -1;

  constructor(
    store: SessionStore,
    options?: { progressiveUiRender?: boolean }
  ) {
    this.store = store;
    this.progressiveUiRender = options?.progressiveUiRender ?? true;
  }

  setOptimisticAssistantBubbleId(id: string): void {
    this.optimisticAssistantBubbleId = id;
    this.store.notify();
  }

  clearOptimisticAssistantBubbleId(): void {
    if (this.optimisticAssistantBubbleId === null) return;
    this.optimisticAssistantBubbleId = null;
    this.store.notify();
  }

  getOptimisticAssistantBubbleId(): string | null {
    return this.optimisticAssistantBubbleId;
  }

  getCurrentTodos(): SessionTodoList | null {
    return this.currentTodos;
  }

  /**
   * Handle incoming tool result notification.
   * Creates or updates a tool message with the result.
   *
   * The messageId parameter indicates which tool message this result belongs to.
   * Tool messages are separate from assistant messages and contain the execution results.
   */
  handleToolResultNotification(
    messageId: string,
    toolResult: ToolResultBlock
  ): void {
    this.updateTodoStateForToolResult(toolResult);
    this.droolWorkingState = DroolWorkingState.ExecutingTool;
    this.store.notify();

    const existing = this.store.getMessage(messageId);

    if (existing) {
      // Update existing tool message
      if (existing.role !== MessageRole.Tool) {
        logError('Tool result notification for non-tool message', {
          messageId,
          role: existing.role,
        });
        return;
      }

      // Check if this tool result already exists
      const existingResultIndex = existing.content.findIndex(
        (block) =>
          block.type === MessageContentBlockType.ToolResult &&
          block.toolUseId === toolResult.toolUseId
      );

      let updatedContent: ContentBlock[];
      if (existingResultIndex >= 0) {
        // Update existing result
        updatedContent = [...existing.content];
        updatedContent[existingResultIndex] = toolResult;
      } else {
        // Add new result
        updatedContent = [...existing.content, toolResult];
      }

      this.store.updateMessage(messageId, {
        content: updatedContent,
        updatedAt: Date.now(),
      });
    } else {
      // Create new tool message
      // Find the parent - should be the last assistant message that contains the matching tool use
      let parentId: string | undefined;
      const messages = this.store.getMessages();

      // Search backwards for an assistant message with the matching tool call
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === MessageRole.Assistant) {
          const hasMatchingToolCall = msg.content.some(
            (block) =>
              block.type === MessageContentBlockType.ToolUse &&
              block.id === toolResult.toolUseId
          );
          if (hasMatchingToolCall) {
            parentId = msg.id;
            break;
          }
        }
      }

      // If no matching assistant found, store as orphaned tool message
      // This can happen if tool result arrives before assistant message due to WebSocket timing
      if (!parentId) {
        logWarn(
          'Tool result arrived before matching assistant message - storing as orphaned',
          {
            toolMessageId: messageId,
            toolCallId: toolResult.toolUseId,
          }
        );

        // Store in orphaned map with toolUseId as key
        const orphanedMessage: IndustryDroolMessage = {
          id: messageId,
          role: MessageRole.Tool,
          content: [toolResult],
          parentId: undefined, // Will be set when assistant message arrives
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.orphanedToolMessages.set(toolResult.toolUseId, orphanedMessage);

        // Don't add to store yet - will be added when parent is found
        return;
      }
      logInfo('Tool result matched to assistant message', {
        toolMessageId: messageId,
        toolCallId: toolResult.toolUseId,
        assistantMessageId: parentId,
      });

      const newToolMessage: IndustryDroolMessage = {
        id: messageId,
        role: MessageRole.Tool,
        content: [toolResult],
        parentId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      this.addMessage(newToolMessage);
    }
  }

  private trackTodoToolUse(toolUse: ToolUseBlock): void {
    if (!isTodoWriteToolUse(toolUse)) {
      return;
    }
    this.todoToolUsesById.set(toolUse.id, toolUse);
    if (!this.todoToolUseSequenceById.has(toolUse.id)) {
      this.todoToolUseSequenceById.set(
        toolUse.id,
        this.nextTodoToolUseSequence++
      );
    }
  }

  private trackTodoToolUses(message: IndustryDroolMessage): void {
    for (const block of message.content) {
      if (block.type === MessageContentBlockType.ToolUse) {
        this.trackTodoToolUse(block);
      }
    }
  }

  private updateTodoStateForToolResult(toolResult: ToolResultBlock): void {
    if (toolResult.isError) {
      return;
    }

    const toolUse = this.todoToolUsesById.get(toolResult.toolUseId);
    if (!toolUse) {
      return;
    }

    const sequence = this.todoToolUseSequenceById.get(toolUse.id) ?? -1;
    if (sequence < this.currentTodosSequence) {
      return;
    }

    const todoList = getTodoListFromToolUse(toolUse);
    if (!todoList) {
      return;
    }

    this.currentTodos = todoList;
    this.currentTodosSequence = sequence;
  }

  private applyTodoStateFromMessage(message: IndustryDroolMessage): void {
    this.trackTodoToolUses(message);
    for (const block of message.content) {
      if (block.type === MessageContentBlockType.ToolResult) {
        this.updateTodoStateForToolResult(block);
      }
    }
  }

  rebuildTodoStateFromMessages(messages: IndustryDroolMessage[]): void {
    this.todoToolUsesById.clear();
    this.todoToolUseSequenceById.clear();
    this.nextTodoToolUseSequence = 0;
    for (const message of messages) {
      this.trackTodoToolUses(message);
    }
    const latestTodoToolUse = getLatestTodoWriteToolUse(messages);
    this.currentTodos = latestTodoToolUse
      ? getTodoListFromToolUse(latestTodoToolUse)
      : null;
    this.currentTodosSequence = latestTodoToolUse
      ? (this.todoToolUseSequenceById.get(latestTodoToolUse.id) ?? -1)
      : -1;
  }

  getDroolWorkingState(): DroolWorkingState {
    return this.droolWorkingState;
  }

  /**
   * Get the current load state of this session.
   */
  getLoadState(): SessionLoadState {
    return this.loadState;
  }

  /**
   * Set the load state of this session.
   */
  setLoadState(state: SessionLoadState): void {
    this.loadState = state;
  }

  /**
   * Handle streaming text updates for assistant messages.
   * Creates the message if it doesn't exist, or appends to existing text.
   */
  handleStreamingTextDelta(messageId: string, textDelta: string): void {
    const message = this.store.getMessage(messageId);

    if (!message) {
      // Create new assistant message with initial text
      // Set parentId to the last message in the conversation
      const messages = this.store.getMessages();
      const lastMessage =
        messages.length > 0 ? messages[messages.length - 1] : null;

      const textBlock: StreamingTextBlock = {
        type: MessageContentBlockType.Text,
        text: textDelta,
        isStreaming: true,
      };

      const newMessage: IndustryDroolMessage = {
        id: messageId,
        role: MessageRole.Assistant,
        content: [textBlock],
        parentId: lastMessage?.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.addMessage(newMessage, { silent: true });
    } else {
      // Append to existing message
      const updatedContent = [...message.content];

      // Find the last text block to append to
      let lastTextBlockIndex = -1;
      for (let i = updatedContent.length - 1; i >= 0; i--) {
        if (updatedContent[i].type === MessageContentBlockType.Text) {
          lastTextBlockIndex = i;
          break;
        }
      }

      if (lastTextBlockIndex >= 0) {
        // Append to existing text block
        const existing = updatedContent[lastTextBlockIndex];
        if (existing.type === MessageContentBlockType.Text) {
          updatedContent[lastTextBlockIndex] = {
            ...existing,
            text: existing.text + textDelta,
          };
        }
      } else {
        // No text block found, create a new one
        const newBlock: StreamingTextBlock = {
          type: MessageContentBlockType.Text,
          text: textDelta,
          isStreaming: true,
        };
        updatedContent.push(newBlock);
      }

      this.store.updateMessage(
        messageId,
        { content: updatedContent, updatedAt: Date.now() },
        { silent: true }
      );
    }
  }

  /**
   * Handle streaming thinking updates for assistant messages.
   * Creates the message if it doesn't exist, or appends to existing thinking block.
   */
  handleStreamingThinkingDelta(
    messageId: string,
    blockIndexOrDelta: number | string,
    thinkingDelta?: string
  ): void {
    const blockIndex =
      typeof blockIndexOrDelta === 'number' ? blockIndexOrDelta : 0;
    const resolvedThinkingDelta =
      typeof blockIndexOrDelta === 'string'
        ? blockIndexOrDelta
        : (thinkingDelta ?? '');
    this.markThinkingBlockStarted(messageId, blockIndex);

    const message = this.store.getMessage(messageId);

    if (!message) {
      // Create new assistant message with initial thinking block
      const messages = this.store.getMessages();
      const lastMessage =
        messages.length > 0 ? messages[messages.length - 1] : null;

      const thinkingBlock: StreamingThinkingBlock = {
        type: MessageContentBlockType.Thinking,
        thinking: resolvedThinkingDelta,
        signature: '',
        isStreaming: true,
        supportsThinkingDuration: true,
      };

      const newMessage: IndustryDroolMessage = {
        id: messageId,
        role: MessageRole.Assistant,
        content: [thinkingBlock],
        parentId: lastMessage?.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.rememberThinkingBlockContentIndex(messageId, blockIndex, 0);
      this.addMessage(newMessage, { silent: true });
    } else {
      // Append to existing message
      const updatedContent = [...message.content];

      let lastThinkingBlockIndex = -1;
      if (typeof blockIndexOrDelta === 'number') {
        lastThinkingBlockIndex =
          this.getMappedThinkingBlockContentIndex(
            messageId,
            blockIndex,
            updatedContent
          ) ?? -1;
      } else {
        for (let i = updatedContent.length - 1; i >= 0; i--) {
          if (updatedContent[i].type === MessageContentBlockType.Thinking) {
            lastThinkingBlockIndex = i;
            break;
          }
        }
      }

      if (lastThinkingBlockIndex >= 0) {
        // Append to existing thinking block
        const existing = updatedContent[lastThinkingBlockIndex];
        if (existing.type === MessageContentBlockType.Thinking) {
          const existingStreamingBlock = existing as StreamingThinkingBlock;
          updatedContent[lastThinkingBlockIndex] = {
            ...existing,
            thinking: existing.thinking + resolvedThinkingDelta,
            supportsThinkingDuration:
              existingStreamingBlock.supportsThinkingDuration ?? true,
          } as StreamingThinkingBlock;
        }
      } else {
        // No thinking block found, create a new one
        const newBlock: StreamingThinkingBlock = {
          type: MessageContentBlockType.Thinking,
          thinking: resolvedThinkingDelta,
          signature: '',
          isStreaming: true,
          supportsThinkingDuration: true,
        };
        if (typeof blockIndexOrDelta === 'number') {
          this.rememberThinkingBlockContentIndex(
            messageId,
            blockIndex,
            updatedContent.length
          );
        }
        updatedContent.push(newBlock);
      }

      this.store.updateMessage(
        messageId,
        { content: updatedContent, updatedAt: Date.now() },
        { silent: true }
      );
    }
  }

  /**
   * Mark a streaming text block as complete (no longer streaming).
   * Called when ASSISTANT_TEXT_COMPLETE notification is received.
   */
  handleTextBlockComplete(
    messageId: string,
    blockIndex: number,
    options?: { silent?: boolean }
  ): void {
    const message = this.store.getMessage(messageId);
    if (!message) return;

    const updatedContent = [...message.content];
    const indexedBlock = updatedContent[blockIndex];
    if (indexedBlock?.type === MessageContentBlockType.Text) {
      const streamingBlock: StreamingTextBlock = {
        ...indexedBlock,
        isStreaming: false,
      };
      updatedContent[blockIndex] = streamingBlock;
      this.store.updateMessage(
        messageId,
        {
          content: updatedContent,
          updatedAt: Date.now(),
        },
        options
      );
      return;
    }

    let textBlockCount = 0;
    for (let i = 0; i < updatedContent.length; i++) {
      const block = updatedContent[i];
      if (block.type === MessageContentBlockType.Text) {
        if (textBlockCount === blockIndex) {
          const streamingBlock: StreamingTextBlock = {
            ...block,
            isStreaming: false,
          };
          updatedContent[i] = streamingBlock;
          break;
        }
        textBlockCount++;
      }
    }

    this.store.updateMessage(
      messageId,
      {
        content: updatedContent,
        updatedAt: Date.now(),
      },
      options
    );
  }

  /**
   * Mark a streaming thinking block as complete (no longer streaming).
   * Called when THINKING_TEXT_COMPLETE notification is received.
   */
  handleThinkingBlockComplete(
    messageId: string,
    blockIndex: number,
    durationMs?: number,
    options?: { silent?: boolean }
  ): void {
    const message = this.store.getMessage(messageId);
    if (!message) return;

    const updatedContent = [...message.content];
    let targetContentIndex =
      this.getMappedThinkingBlockContentIndex(
        messageId,
        blockIndex,
        updatedContent
      ) ?? -1;

    if (targetContentIndex === -1) {
      targetContentIndex = this.findThinkingBlockContentIndexByOrdinal(
        updatedContent,
        blockIndex
      );
      if (targetContentIndex !== -1) {
        this.rememberThinkingBlockContentIndex(
          messageId,
          blockIndex,
          targetContentIndex
        );
      }
    }

    if (targetContentIndex !== -1) {
      const block = updatedContent[targetContentIndex];
      if (block.type === MessageContentBlockType.Thinking) {
        const trackedDurationMs = this.resolveThinkingDurationMs(
          messageId,
          blockIndex
        );
        const resolvedDurationMs = durationMs ?? trackedDurationMs;
        const streamingBlock: StreamingThinkingBlock = {
          ...block,
          isStreaming: false,
          ...(resolvedDurationMs === undefined
            ? {}
            : { durationMs: resolvedDurationMs }),
        };
        updatedContent[targetContentIndex] = streamingBlock;
      }
    }

    this.store.updateMessage(
      messageId,
      {
        content: updatedContent,
        updatedAt: Date.now(),
      },
      options
    );
  }

  /**
   * Handle tool use notification - add tool call to message.
   * Tool uses typically appear in assistant messages.
   */
  handleToolUseNotification(messageId: string, toolUse: ToolUseBlock): void {
    this.trackTodoToolUse(toolUse);
    const message = this.store.getMessage(messageId);

    if (!message) {
      // Create new assistant message with tool use
      const newMessage: IndustryDroolMessage = {
        id: messageId,
        role: MessageRole.Assistant,
        content: [toolUse],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.addMessage(newMessage);
    } else {
      // Check if this tool use already exists (by ID)
      const existingIndex = message.content.findIndex(
        (block) =>
          block.type === MessageContentBlockType.ToolUse &&
          block.id === toolUse.id
      );

      let updatedContent: ContentBlock[];
      if (existingIndex >= 0) {
        // Update existing tool use
        updatedContent = [...message.content];
        updatedContent[existingIndex] = toolUse;
      } else {
        // Append new tool use
        updatedContent = [...message.content, toolUse];
      }

      this.store.updateMessage(messageId, {
        content: updatedContent,
        updatedAt: Date.now(),
      });
    }
  }

  /**
   * Handle a complete tool message with potentially multiple results.
   * Tool messages are typically created after assistant messages complete.
   */
  handleToolMessage(toolMessage: IndustryDroolMessage): void {
    if (toolMessage.role !== MessageRole.Tool) {
      logError('handleToolMessage called with non-tool message');
      return;
    }

    this.droolWorkingState = DroolWorkingState.ExecutingTool;
    this.store.notify();
    const existing = this.store.getMessage(toolMessage.id);

    if (existing) {
      // Merge tool results, avoiding duplicates
      const existingResults = existing.content.filter(
        (b) => b.type === MessageContentBlockType.ToolResult
      ) as ToolResultBlock[];
      const newResults = toolMessage.content.filter(
        (b) => b.type === MessageContentBlockType.ToolResult
      ) as ToolResultBlock[];

      // Create a map to deduplicate by toolUseId
      const resultMap = new Map<string, ToolResultBlock>();

      // Add existing results first (they may be partial)
      existingResults.forEach((result) => {
        resultMap.set(result.toolUseId, result);
      });

      // Overwrite with new results (they may be more complete)
      newResults.forEach((result) => {
        resultMap.set(result.toolUseId, result);
        this.updateTodoStateForToolResult(result);
      });

      this.store.updateMessage(toolMessage.id, {
        content: Array.from(resultMap.values()),
        updatedAt: Date.now(),
      });
    } else {
      // Add new tool message
      this.addMessage(toolMessage);
    }
  }

  /**
   * Capture session-level settings (model, reasoning effort, autonomy, cwd, …)
   * so they can be reapplied after a session-state reset.
   */
  private snapshotPreservedSettings(): {
    modelId: string | null;
    reasoningEffort: string | null;
    interactionMode: DroolInteractionMode | null;
    autonomyLevel: AutonomyLevel | null;
    specModeModelId: string | null;
    specModeReasoningEffort: string | null;
    cwd: string | null;
    tags: ReturnType<SessionStore['getTags']>;
  } {
    return {
      modelId: this.store.getModelId(),
      reasoningEffort: this.store.getReasoningEffort(),
      interactionMode: this.store.getInteractionMode(),
      autonomyLevel: this.store.getAutonomyLevel(),
      specModeModelId: this.store.getSpecModeModelId(),
      specModeReasoningEffort: this.store.getSpecModeReasoningEffort(),
      cwd: this.store.getCwd(),
      tags: this.store.getTags(),
    };
  }

  private restorePreservedSettings(
    snapshot: ReturnType<SessionStateManager['snapshotPreservedSettings']>
  ): void {
    if (snapshot.modelId !== null) {
      this.store.setModelId(snapshot.modelId);
    }
    if (snapshot.reasoningEffort !== null) {
      this.store.setReasoningEffort(snapshot.reasoningEffort);
    }
    if (snapshot.interactionMode !== null) {
      this.store.setInteractionMode(snapshot.interactionMode);
    }
    if (snapshot.autonomyLevel !== null) {
      this.store.setAutonomyLevel(snapshot.autonomyLevel);
    }
    if (snapshot.specModeModelId !== null) {
      this.store.setSpecModeModelId(snapshot.specModeModelId);
    }
    if (snapshot.specModeReasoningEffort !== null) {
      this.store.setSpecModeReasoningEffort(snapshot.specModeReasoningEffort);
    }
    if (snapshot.cwd !== null) {
      this.store.setCwd(snapshot.cwd);
    }
    if (snapshot.tags !== null) {
      this.store.setTags(snapshot.tags);
    }
  }

  /**
   * Initialize session from server response.
   * Clears existing state and sets up fresh session.
   * Stores all messages including system reminders - filtering happens at render time.
   * Preserves session settings (modelId, reasoningEffort, autonomy settings) if they exist.
   */
  initializeSession(sessionId: string, messages: IndustryDroolMessage[]): void {
    const preserved = this.snapshotPreservedSettings();

    this.store.clearMessages();
    this.pendingAssistantMessageId = null;
    this.clearThinkingBlockTracking();
    // Rebuild todo state before setSession so its notify already reflects it.
    this.rebuildTodoStateFromMessages(messages);
    this.store.setSession(sessionId, { messages });

    // Enable progressive loading for large sessions
    this.renderLimit =
      this.progressiveUiRender &&
      messages.length > SessionStateManager.INITIAL_UI_RENDER_LIMIT
        ? SessionStateManager.INITIAL_UI_RENDER_LIMIT
        : null;

    this.restorePreservedSettings(preserved);
    this.setLoadState(SessionLoadState.Loaded);
  }

  /**
   * Load an existing session, potentially merging with cached state.
   * Stores all messages including system reminders - filtering happens at render time.
   */
  loadSession(sessionId: string, messages: IndustryDroolMessage[]): void {
    const currentSessionId = this.store.getSessionId();

    if (currentSessionId === sessionId) {
      // Same session - merge messages (server state takes precedence)
      const messageMap = new Map<string, IndustryDroolMessage>();

      // Snapshot pre-merge state for the optimistic-bubble cleanup below.
      const cachedMessagesBeforeMerge = this.store.getMessages();
      const hadNoConfirmedMessagesBeforeMerge =
        cachedMessagesBeforeMerge.length === 0;

      // First add cached messages
      cachedMessagesBeforeMerge.forEach((msg) => {
        messageMap.set(msg.id, msg);
      });

      // Overwrite with server messages (source of truth)
      messages.forEach((msg) => {
        messageMap.set(msg.id, msg);
      });

      const preserved = this.snapshotPreservedSettings();

      // Clear messages and re-add in order (preserves sessionId and machineId)
      this.store.clearMessages();
      this.clearThinkingBlockTracking();
      const mergedMessages = Array.from(messageMap.values()).sort(
        (a, b) => a.createdAt - b.createdAt
      );
      // Rebuild todo state before setSession so its notify already reflects it.
      this.rebuildTodoStateFromMessages(mergedMessages);
      this.store.setSession(sessionId, {
        messages: mergedMessages,
      });

      this.restorePreservedSettings(preserved);
      this.setLoadState(SessionLoadState.Loaded);

      // Drop the stale optimistic assistant placeholder if a fresh
      // session (no cached messages pre-load) now has a real assistant
      // message from the server — we missed CREATE_MESSAGE while
      // disconnected. Scoped to the empty-pre-load case so reconnects
      // mid-conversation don't clear placeholders incorrectly.
      if (
        hadNoConfirmedMessagesBeforeMerge &&
        this.optimisticAssistantBubbleId !== null &&
        messages.some((msg) => msg.role === MessageRole.Assistant)
      ) {
        this.clearOptimisticAssistantBubbleId();
      }
    } else {
      // Different session - replace entirely
      this.initializeSession(sessionId, messages);
    }
  }

  /**
   * Handle message created notification.
   * Intelligently handles both new messages and updates to existing ones.
   */
  upsertMessage(message: IndustryDroolMessage): void {
    const existing = this.store.getMessage(message.id);

    if (existing) {
      // This is an update to an existing message
      // Common with streaming - the final message replaces the partial one
      let newMessage: IndustryDroolMessage = {
        ...message,
        // Preserve parentId from existing message if not in new message
        parentId: message.parentId ?? existing.parentId,
      };

      if (
        existing.role === MessageRole.Assistant &&
        message.role === MessageRole.Assistant
      ) {
        // Preserve any tool results that might have been added during streaming
        const existingToolResults = existing.content.filter(
          (b) => b.type === MessageContentBlockType.ToolResult
        );

        // Check if the new message already has these results
        const newHasAllResults = existingToolResults.every((existingResult) =>
          message.content.some(
            (b) =>
              b.type === MessageContentBlockType.ToolResult &&
              b.toolUseId === (existingResult as ToolResultBlock).toolUseId
          )
        );

        if (!newHasAllResults && existingToolResults.length > 0) {
          logInfo('Merging tool results into assistant message', {
            messageId: message.id,
            count: existingToolResults.length,
            toolCallIds: existingToolResults.map(
              (r) => (r as ToolResultBlock).toolUseId
            ),
          });
          // Merge tool results into the new message
          newMessage = {
            ...newMessage,
            content: [...message.content, ...existingToolResults],
          };
        }
      }

      // Track TodoWrite tool uses before adopting orphaned tool messages so
      // their results can resolve todo state against this message.
      this.applyTodoStateFromMessage(newMessage);
      if (newMessage.role === MessageRole.Assistant) {
        this.adoptOrphanedToolMessages(newMessage);
      }
      this.store.updateMessage(message.id, newMessage);
    } else {
      // New message - ensure parentId is set
      const messageWithParent: IndustryDroolMessage = {
        ...message,
        parentId: message.parentId ?? this.store.getLastMessage()?.id,
      };

      if (messageWithParent.role === MessageRole.Assistant) {
        // Track TodoWrite tool uses before adopting orphaned tool messages so
        // their results can resolve todo state against this message.
        this.trackTodoToolUses(messageWithParent);
        this.adoptOrphanedToolMessages(messageWithParent);
      }

      this.addMessage(messageWithParent);
    }
  }

  /**
   * Adopt tool messages whose results arrived before this assistant message
   * (or before its authoritative update) carried the matching tool use.
   */
  private adoptOrphanedToolMessages(
    assistantMessage: IndustryDroolMessage
  ): void {
    const adoptedOrphans: IndustryDroolMessage[] = [];
    for (const block of assistantMessage.content) {
      if (block.type !== MessageContentBlockType.ToolUse) {
        continue;
      }
      const orphanedMsg = this.orphanedToolMessages.get(block.id);
      if (orphanedMsg) {
        adoptedOrphans.push(orphanedMsg);
        this.orphanedToolMessages.delete(block.id);
      }
    }

    if (adoptedOrphans.length === 0) {
      return;
    }

    logInfo('Adopting orphaned tool messages into assistant message', {
      assistantMessageId: assistantMessage.id,
      toolMessageIds: adoptedOrphans.map((m) => m.id),
    });

    adoptedOrphans.forEach((toolMsg) => {
      this.addMessage({
        ...toolMsg,
        parentId: assistantMessage.id,
      });
    });
  }

  /**
   * Handle streaming start for a new message.
   * Sets up placeholder that will be filled by deltas.
   */
  handleStreamingStart({
    messageId,
    role,
    parentId,
  }: {
    messageId: string;
    role: MessageRole.Assistant | MessageRole.Tool;
    parentId?: string;
  }): void {
    const existing = this.store.getMessage(messageId);

    if (!existing) {
      // If no explicit parentId provided, use the last message as parent
      let finalParentId = parentId;
      if (!finalParentId) {
        const messages = this.store.getMessages();
        const lastMessage =
          messages.length > 0 ? messages[messages.length - 1] : null;
        finalParentId = lastMessage?.id;
      }

      const newMessage: IndustryDroolMessage = {
        id: messageId,
        role,
        content: [],
        parentId: finalParentId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.addMessage(newMessage);
      this.streamingMessageIds.add(messageId);
    }
  }

  /**
   * Handle streaming completion.
   * Marks message as complete and performs any final cleanup.
   */
  handleStreamingEnd(messageId: string): void {
    if (this.streamingMessageIds.has(messageId)) {
      this.streamingMessageIds.delete(messageId);
      this.store.updateMessage(messageId, {
        updatedAt: Date.now(),
      });
    }
  }

  /**
   * Get all messages in the current session.
   * Returns messages ordered by parent-child relationships.
   */
  getMessages(): IndustryDroolMessage[] {
    return this.store.getOrderedMessages();
  }

  /**
   * Get a specific message by ID.
   */
  getMessage(id: string): IndustryDroolMessage | undefined {
    return this.store.getMessage(id);
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | null {
    return this.store.getSessionId();
  }

  /**
   * Get messages filtered by role.
   */
  getMessagesByRole(
    role: MessageRole.User | MessageRole.Assistant | MessageRole.Tool
  ): IndustryDroolMessage[] {
    return this.store.getMessagesByRole(role);
  }

  /**
   * Get the last message in the session.
   */
  getLastMessage(): IndustryDroolMessage | undefined {
    return this.store.getLastMessage();
  }

  /**
   * Check if a message is currently streaming.
   */
  isMessageStreaming(messageId: string): boolean {
    return this.streamingMessageIds.has(messageId);
  }

  /**
   * Get all messages currently streaming.
   */
  getStreamingMessageIds(): string[] {
    return Array.from(this.streamingMessageIds);
  }

  getStore(): SessionStore {
    return this.store;
  }

  /**
   * Get MCP servers from the store
   */
  getMcpServers(): McpServerStatusInfo[] {
    return this.store.getMcpServers();
  }

  /**
   * Get MCP status from the store
   */
  getMcpStatus(): McpStatus {
    return this.store.getMcpStatus();
  }

  /**
   * Handle incoming notifications from the daemon.
   * This is the main entry point for processing all notification types.
   * Manages state updates for the session based on notifications.
   *
   * @param params - The notification parameters including sessionId and notification data
   */
  handleNotification(params: DaemonSessionNotificationParams): void {
    const { notification } = params;
    let skipTrailingNotify = false;

    const isStreamingDelta =
      notification.type === SessionNotificationType.ASSISTANT_TEXT_DELTA ||
      notification.type === SessionNotificationType.THINKING_TEXT_DELTA;

    // Clear the optimistic submit bubble when the daemon's CREATE_MESSAGE
    // echoes the same `clientTurnId` we issued for this turn (passed as
    // `externalRequestId` on `addUserMessage`). Exact id match keeps the
    // multi-submit case safe: a stale notification for an older turn can't
    // dismiss a newer optimistic, and a brand-new turn's CREATE_MESSAGE
    // can't clobber a still-pending one for a different turn.
    const isBlockComplete =
      notification.type === SessionNotificationType.ASSISTANT_TEXT_COMPLETE ||
      notification.type === SessionNotificationType.THINKING_TEXT_COMPLETE;

    // When transitioning from streaming text/thinking deltas to a different
    // event type, flush any pending throttled notification immediately so
    // that the full accumulated content is visible to subscribers before
    // the discrete event is processed (ensures correct Static content).
    // Skip this heuristic flush when the next event is a *_COMPLETE
    // notification — the complete handler will flush with isStreaming: false
    // set, giving subscribers a single atomic update instead of two renders.
    if (
      this.lastNotificationWasStreamingDelta &&
      !isStreamingDelta &&
      !isBlockComplete
    ) {
      logInfo(
        '[SessionStateManager] Heuristic flush: streaming delta → discrete event',
        {
          sessionId: params.sessionId,
          type: notification.type,
        }
      );
      this.store.flushStreamingChanges();
      this.store.flushNotify();
    }

    switch (notification.type) {
      case SessionNotificationType.CREATE_MESSAGE: {
        // If there's a pending assistant message and this CREATE_MESSAGE is
        // the authoritative assistant message, replace the pending one.
        // CREATE_MESSAGE content ordering is always authoritative.
        if (
          this.pendingAssistantMessageId &&
          notification.message.role === MessageRole.Assistant
        ) {
          const pendingId = this.pendingAssistantMessageId;
          this.pendingAssistantMessageId = null;

          // Capture the pending message's parentId before removing it.
          // If the authoritative message omits parentId, we use this as
          // the fallback to avoid a cycle: after re-parenting tool results
          // to the real assistant ID, getLastMessage() could return one of
          // those tool results, making the assistant a child of its own
          // tool result.
          const pendingParentId = this.store.getMessage(pendingId)?.parentId;

          // Re-parent any messages (e.g. tool results) that reference the
          // pending message so they point to the real assistant message ID
          const allMessages = this.store.getMessages();
          for (const msg of allMessages) {
            if (msg.parentId === pendingId) {
              this.store.updateMessage(msg.id, {
                parentId: notification.message.id,
              });
            }
          }

          // Remove the pending message from the store
          this.store.removeMessage(pendingId);

          // Inject the pending's parentId if the authoritative message
          // doesn't specify one, preventing the getLastMessage() fallback
          // in upsertMessage() from picking a re-parented tool message.
          if (!notification.message.parentId && pendingParentId) {
            notification.message = {
              ...notification.message,
              parentId: pendingParentId,
            };
          }
        }

        if (notification.requestId) {
          // Static render consumers must not observe both placeholder and authoritative rows.
          this.rememberProcessedMessageRequestId(notification.requestId);
          this.clearQueuedMessage(notification.requestId);
          this.removeOptimisticMessage(notification.requestId);
        }

        this.upsertMessage(notification.message);
        break;
      }

      case SessionNotificationType.TOOL_RESULT: {
        // Transform the notification to match the expected ToolResultBlock type
        const toolResult: ToolResultBlock = {
          type: MessageContentBlockType.ToolResult,
          toolUseId: notification.toolUseId,
          content: notification.content,
          isError: notification.isError,
        };
        this.handleToolResultNotification(notification.messageId, toolResult);
        this.store.markToolCompleted(notification.toolUseId);
        break;
      }

      case SessionNotificationType.ERROR: {
        // Check if this is an abort error from user interruption
        if (isAbortError(notification.message)) {
          // Log abort errors as info instead of exception
          logInfo('[SessionStateManager] Execution aborted by user', {
            sessionId: params.sessionId,
            message: notification.message,
          });
        } else {
          logError('[SessionStateManager] Session error notification', {
            sessionId: params.sessionId,
            type: notification.errorType,
            errorName: notification.error?.name,
            message: notification.message,
            cause: notification.error,
          });
        }
        this.stopStreaming();
        break;
      }

      case DaemonSpecificNotificationType.SESSION_INACTIVITY: {
        logInfo('[SessionStateManager] Session became inactive', {
          sessionId: params.sessionId,
          message: notification.message,
          timestamp: notification.timestamp,
          timeout: notification.timeoutSeconds,
        });
        this.setLoadState(SessionLoadState.NotLoaded);
        break;
      }

      case DaemonSpecificNotificationType.SESSION_PROCESS_EXITED: {
        logInfo('[SessionStateManager] Session process exited unexpectedly', {
          sessionId: params.sessionId,
          message: notification.message,
          timestamp: notification.timestamp,
        });
        this.setLoadState(SessionLoadState.NotLoaded);
        break;
      }

      case DaemonSpecificNotificationType.SESSION_CLOSED: {
        logInfo('[SessionStateManager] Session closed', {
          sessionId: params.sessionId,
          timestamp: notification.timestamp,
        });
        this.setLoadState(SessionLoadState.NotLoaded);
        break;
      }

      case DaemonSpecificNotificationType.SESSION_UNSUBSCRIBED: {
        logInfo('[SessionStateManager] Session was unsubscribed', {
          sessionId: params.sessionId,
          message: notification.message,
        });
        this.setLoadState(SessionLoadState.NotLoaded);
        break;
      }

      case SessionNotificationType.CHILD_SESSION_AVAILABLE:
        break;

      case DaemonTerminalEvent.DATA: {
        skipTrailingNotify = true;
        // Route DATA to registered handler (mounted terminal) or buffer (unmounted)
        const handler = this.terminalWriteHandlers.get(notification.terminalId);

        if (handler) {
          // Terminal is mounted - write directly to xterm via registered handler
          handler(notification.data);
        } else {
          // Terminal is unmounted - buffer the data
          this.store.appendTerminalBufferedData(
            notification.terminalId,
            notification.data
          );
        }
        break;
      }

      case DaemonTerminalEvent.EXIT: {
        logInfo('Terminal exited:', {
          terminalId: notification.terminalId,
          exitCode: notification.exitCode,
          signal: notification.signal,
        });
        break;
      }

      case SessionNotificationType.DROOL_WORKING_STATE_CHANGED: {
        const newState = notification.newState;
        const previousState = this.droolWorkingState;

        // Update working state based on notification
        if (newState === DroolWorkingState.Idle) {
          this.stopStreaming();
        } else if (newState === DroolWorkingState.StreamingAssistantMessage) {
          this.startStreaming();
        } else if (newState === DroolWorkingState.ExecutingTool) {
          this.setExecutingTool();
        } else if (newState === DroolWorkingState.WaitingForToolConfirmation) {
          this.setWaitingForConfirmation();
        } else if (newState === DroolWorkingState.CompactingConversation) {
          this.setCompacting();
        }

        logInfo('Drool working state changed', {
          sessionId: params.sessionId,
          previousState,
          value: newState,
          state: this.droolWorkingState,
        });
        break;
      }

      case SessionNotificationType.SESSION_COMPACTED: {
        if (notification.visibleBoundaryMessageId) {
          this.store.setUiRenderCutoff(notification.visibleBoundaryMessageId);
        }
        break;
      }

      case SessionNotificationType.PERMISSION_RESOLVED: {
        logInfo('[SessionStateManager] Permission resolved', {
          sessionId: params.sessionId,
          value: notification.selectedOption,
        });
        // Resume streaming after permission is resolved
        if (
          this.droolWorkingState ===
          DroolWorkingState.WaitingForToolConfirmation
        ) {
          this.startStreaming();
        }
        break;
      }

      case SessionNotificationType.SETTINGS_UPDATED: {
        const { settings } = notification;
        // Update all settings that were provided
        if (settings.modelId !== undefined) {
          this.store.setModelId(settings.modelId);
        }
        if (settings.reasoningEffort !== undefined) {
          this.store.setReasoningEffort(settings.reasoningEffort);
        }
        this.applyInteractionSettings(settings);
        // Spec mode fields are always present in the notification:
        // present = spec mode active, absent = spec mode not enabled.
        this.store.setSpecModeModelId(settings.specModeModelId ?? null);
        this.store.setSpecModeReasoningEffort(
          settings.specModeReasoningEffort ?? null
        );
        this.store.setMissionSettings(settings.missionSettings ?? null);
        if (settings.tags !== undefined) {
          this.store.setTags(settings.tags);
        }
        if (settings.compactionThresholdCheckEnabled !== undefined) {
          this.store.setCompactionThresholdCheckEnabled(
            settings.compactionThresholdCheckEnabled
          );
        }

        // Each setter above calls notify(), but the throttle coalesces them.
        // An extra notify() is harmless (just sets pendingNotify) and ensures
        // the trailing-edge flush includes the full batch of settings.
        this.store.notify();

        logInfo('[SessionStateManager] Settings updated', {
          sessionId: params.sessionId,
          value: settings,
        });
        break;
      }

      case SessionNotificationType.SESSION_TITLE_UPDATED: {
        const { title } = notification;

        this.store.setTitle(title);
        logInfo('[SessionStateManager] Session title updated', {
          sessionId: params.sessionId,
        });
        break;
      }

      case SessionNotificationType.MCP_STATUS_CHANGED: {
        // Store MCP servers in session state for quick UI access on session switch
        this.store.setMcpServers(notification.servers);

        // Calculate overall MCP status from summary
        const { total, connected, connecting, failed } = notification.summary;
        let status: McpStatus;
        if (notification.summary.configError) {
          status = McpStatus.Failed;
        } else if (total === 0) {
          status = McpStatus.NoServers;
        } else if (connecting > 0) {
          status = McpStatus.Initializing;
        } else if (failed > 0) {
          status = McpStatus.Failed;
        } else if (connected === total) {
          status = McpStatus.Ready;
        } else {
          status = McpStatus.Ready; // Partial connection (some disabled)
        }
        this.store.setMcpStatus(status);

        logInfo('[SessionStateManager] MCP status changed', {
          count: connected,
          totalCount: total,
          state: status,
        });
        break;
      }

      case SessionNotificationType.ASSISTANT_TEXT_DELTA: {
        skipTrailingNotify = true;
        // Transition from Thinking → Streaming when text starts arriving
        if (this.droolWorkingState === DroolWorkingState.Thinking) {
          logInfo(
            '[SessionStateManager] Working state transition: Thinking → Streaming (text delta arrived)',
            {
              sessionId: params.sessionId,
              messageId: notification.messageId,
              count: this.store.getMessage(notification.messageId)?.content
                .length,
            }
          );
          this.droolWorkingState = DroolWorkingState.StreamingAssistantMessage;
          this.store.flushNotify();
        }
        this.handleStreamingTextDelta(
          notification.messageId,
          notification.textDelta
        );
        this.store.notifyStreamingChange();
        break;
      }

      case SessionNotificationType.THINKING_TEXT_DELTA: {
        skipTrailingNotify = true;
        // Transition to Thinking when thinking deltas arrive
        if (
          this.droolWorkingState === DroolWorkingState.StreamingAssistantMessage
        ) {
          logInfo(
            '[SessionStateManager] Working state transition: Streaming → Thinking (thinking delta arrived)',
            {
              sessionId: params.sessionId,
              messageId: notification.messageId,
              count: this.store.getMessage(notification.messageId)?.content
                .length,
            }
          );
          this.droolWorkingState = DroolWorkingState.Thinking;
          this.store.flushNotify();
        }
        this.handleStreamingThinkingDelta(
          notification.messageId,
          notification.blockIndex,
          notification.textDelta
        );
        this.store.notifyStreamingChange();
        break;
      }

      case SessionNotificationType.ASSISTANT_TEXT_COMPLETE: {
        skipTrailingNotify = true;
        logInfo('[SessionStateManager] Text block complete', {
          sessionId: params.sessionId,
          messageId: notification.messageId,
          index: notification.blockIndex,
        });
        this.handleTextBlockComplete(
          notification.messageId,
          notification.blockIndex,
          { silent: true }
        );
        this.store.flushStreamingChanges();
        this.store.flushNotify();
        break;
      }

      case SessionNotificationType.THINKING_TEXT_COMPLETE: {
        skipTrailingNotify = true;
        logInfo('[SessionStateManager] Thinking block complete', {
          sessionId: params.sessionId,
          messageId: notification.messageId,
          index: notification.blockIndex,
        });
        this.handleThinkingBlockComplete(
          notification.messageId,
          notification.blockIndex,
          notification.durationMs,
          { silent: true }
        );
        this.store.flushStreamingChanges();
        this.store.flushNotify();
        break;
      }

      // Mission notifications - handled by IndustryDaemonClient, not SessionStateManager
      case SessionNotificationType.MISSION_STATE_CHANGED:
      case SessionNotificationType.MISSION_FEATURES_CHANGED:
      case SessionNotificationType.MISSION_PROGRESS_ENTRY:
      case SessionNotificationType.MISSION_HEARTBEAT:
      case SessionNotificationType.MISSION_WORKER_STARTED:
      case SessionNotificationType.MISSION_WORKER_COMPLETED:
      case SessionNotificationType.SESSION_TOKEN_USAGE_CHANGED:
      case SessionNotificationType.AGENT_TURN_COMPLETED:
        // Mission state is managed separately, not in session state
        break;

      case SessionNotificationType.TOOL_PROGRESS_UPDATE:
        skipTrailingNotify = true;
        this.store.addUpdate({
          toolUseId: notification.toolUseId,
          update: notification.update,
        });
        break;

      case SessionNotificationType.TOOL_CALL: {
        const toolUse: ToolUseBlock = {
          type: MessageContentBlockType.ToolUse,
          id: notification.toolUse.id,
          name: notification.toolUse.name,
          input: notification.toolUse.input,
        };

        // Clear stale pending reference (e.g. from a previous turn that errored)
        if (
          this.pendingAssistantMessageId &&
          !this.store.getMessage(this.pendingAssistantMessageId)
        ) {
          this.pendingAssistantMessageId = null;
        }

        if (this.pendingAssistantMessageId) {
          // Append to existing pending assistant message
          this.handleToolUseNotification(
            this.pendingAssistantMessageId,
            toolUse
          );
        } else {
          const lastMessage = this.store.getLastMessage();

          if (lastMessage?.role === MessageRole.Assistant) {
            // Append to existing assistant message (e.g. from text streaming)
            this.handleToolUseNotification(lastMessage.id, toolUse);
          } else {
            // Check if this tool call already exists in a committed message
            // (CREATE_MESSAGE arrived before this TOOL_CALL - out of order)
            const messages = this.store.getMessages();
            const alreadyExists = messages.some(
              (msg) =>
                msg.role === MessageRole.Assistant &&
                msg.content.some(
                  (block) =>
                    block.type === MessageContentBlockType.ToolUse &&
                    block.id === toolUse.id
                )
            );

            if (!alreadyExists) {
              // Create a new pending assistant message
              const pendingId = `pending-assistant-${Date.now()}`;
              this.pendingAssistantMessageId = pendingId;
              const newMessage: IndustryDroolMessage = {
                id: pendingId,
                role: MessageRole.Assistant,
                content: [toolUse],
                parentId: lastMessage?.id,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
              this.addMessage(newMessage);
            }
          }
        }
        break;
      }

      case SessionNotificationType.MCP_AUTH_REQUIRED:
      case SessionNotificationType.MCP_AUTH_COMPLETED:
        // MCP OAuth auth URL notification - handled by IndustryDaemonClient event emission
        // No state changes needed in SessionStateManager
        break;

      case SessionNotificationType.HOOK_EXECUTION_STARTED: {
        this.store.addHookExecution(notification.hookId, {
          hookId: notification.hookId,
          hookEventName: notification.hookEventName,
          hookMatcher: notification.hookMatcher,
          hookCommands: notification.hookCommands,
          hookToolCallId: notification.hookToolCallId,
          isParallelExecution: notification.isParallelExecution,
          parallelGroupId: notification.parallelGroupId,
          hookStatus: 'executing',
        });
        break;
      }

      case SessionNotificationType.HOOK_EXECUTION_COMPLETED: {
        this.store.updateHookExecution(notification.hookId, {
          hookStatus: notification.hookStatus,
          hookResults: notification.hookResults,
        });
        break;
      }

      case SessionNotificationType.QUEUED_MESSAGES_DISCARDED:
        this.pauseDaemonQueuedMessagesAfterEsc(notification.requestId);
        break;

      case SessionNotificationType.STRUCTURED_OUTPUT:
        skipTrailingNotify = true;
        break;

      case SessionNotificationType.TOOL_EXECUTION_HEARTBEAT:
        // Internal daemon keep-alive; suppressed before reaching clients.
        // No state changes required.
        break;
      case SessionNotificationType.LOOP_STATE_CHANGED:
        // Deprecated legacy notification; durable cron events are authoritative.
        break;
      default: {
        // This ensures exhaustive checking of all notification types
        const exhaustiveCheck: never = notification;
        logError('Unknown notification type:', {
          type: exhaustiveCheck,
        });
      }
    }

    this.lastNotificationWasStreamingDelta = isStreamingDelta;

    // For discrete events, fire an additional notify() so the version bump
    // is visible to snapshot hooks. High-frequency events (streaming deltas,
    // terminal DATA, tool progress) already trigger notify() through their
    // store setters; the throttle coalesces rapid-fire calls automatically.
    if (!skipTrailingNotify) {
      this.store.notify();
    }
  }

  // ============ Terminal Management Methods ============

  /**
   * Set the active terminal ID
   */
  setActiveTerminalId(terminalId: string | null): void {
    this.store.setActiveTerminalId(terminalId);
  }

  /**
   * Get the active terminal ID
   */
  getActiveTerminalId(): string | null {
    return this.store.getActiveTerminalId();
  }

  /**
   * Add a new terminal to the session
   */
  addTerminal(terminal: TerminalMetadata): void {
    this.store.addTerminal(terminal);
  }

  /**
   * Update terminal status
   */
  updateTerminalStatus(terminalId: string, status: TerminalStatus): void {
    this.store.updateTerminal(terminalId, { status });
  }

  /**
   * Mark terminal as exited
   */
  updateTerminalExit({
    terminalId,
    exitCode,
    signal,
  }: {
    terminalId: string;
    exitCode: number;
    signal: string;
  }): void {
    this.store.updateTerminal(terminalId, {
      status: TerminalStatus.DISCONNECTED,
      exitCode,
      signal,
    });
  }

  /**
   * Remove a terminal from the session
   */
  removeTerminal(terminalId: string): void {
    this.store.removeTerminal(terminalId);
  }

  /**
   * Get terminal by ID
   */
  getTerminal(terminalId: string): TerminalMetadata | undefined {
    return this.store.getTerminal(terminalId);
  }

  /**
   * Get all terminals
   */
  getTerminals(): Map<string, TerminalMetadata> {
    return this.store.getTerminals();
  }

  startStreaming(): void {
    this.droolWorkingState = DroolWorkingState.StreamingAssistantMessage;
    this.store.flushNotify();
  }

  stopStreaming(): void {
    this.droolWorkingState = DroolWorkingState.Idle;
    this.completeStreamingContentBlocks();
    this.store.flushNotify();
  }

  setWaitingForConfirmation(): void {
    this.droolWorkingState = DroolWorkingState.WaitingForToolConfirmation;
    this.store.flushNotify();
  }

  setExecutingTool(): void {
    this.droolWorkingState = DroolWorkingState.ExecutingTool;
    this.store.flushNotify();
  }

  setCompacting(): void {
    this.droolWorkingState = DroolWorkingState.CompactingConversation;
    this.store.flushNotify();
  }

  /**
   * Queue a user prompt in SSM for shared UI rendering and lifecycle handling.
   * LocalDeferredAfterEsc entries are client-side deferred follow-ups whose
   * FIFO head is restored once Esc cancellation fully settles.
   * LocalPausedAfterEsc entries are post-Esc queue remainders that stay visible
   * until explicit user action.
   * DaemonQueuedDiscardable entries are steering messages that may drain
   * mid-loop; DaemonQueuedEndOfLoop entries are held until the active agent loop
   * completes. Daemon-backed queue entries may be discarded on interrupt.
   */
  queueUserMessage(
    requestId: string,
    content: ContentBlock[],
    kind: QueuedUserMessageKind = QueuedUserMessageKind.DaemonQueuedDiscardable,
    createdAt: number = Date.now()
  ): void {
    this.queueUserMessages([
      {
        requestId,
        content,
        kind,
        createdAt,
      },
    ]);
  }

  queueUserMessages(messages: QueuedUserMessageState[]): void {
    if (messages.length === 0) {
      return;
    }

    let queuedAny = false;
    let removedOptimistic = false;
    for (const message of messages) {
      if (this.processedMessageRequestIds.has(message.requestId)) {
        continue;
      }
      removedOptimistic =
        this.optimisticMessages.delete(message.requestId) || removedOptimistic;
      this.queuedMessages.set(message.requestId, message);
      queuedAny = true;
    }

    if (!queuedAny) {
      return;
    }
    if (removedOptimistic) {
      this.store.notifyMessagesChanged();
      return;
    }
    this.store.notify();
  }

  replaceDaemonQueuedMessages(messages: QueuedUserMessageState[]): void {
    const nextQueuedMessages = new Map<string, QueuedUserMessageState>();
    let changed = false;
    let removedOptimistic = false;

    for (const [requestId, queuedMessage] of this.queuedMessages.entries()) {
      if (isDaemonQueuedMessageKind(queuedMessage.kind)) {
        changed = true;
        continue;
      }
      nextQueuedMessages.set(requestId, queuedMessage);
    }

    for (const message of messages) {
      if (this.processedMessageRequestIds.has(message.requestId)) {
        changed = true;
        continue;
      }
      removedOptimistic =
        this.optimisticMessages.delete(message.requestId) || removedOptimistic;
      nextQueuedMessages.set(message.requestId, message);
      if (this.queuedMessages.get(message.requestId) !== message) {
        changed = true;
      }
    }

    if (!changed && nextQueuedMessages.size === this.queuedMessages.size) {
      return;
    }

    this.queuedMessages = nextQueuedMessages;
    if (removedOptimistic) {
      this.store.notifyMessagesChanged();
      return;
    }
    this.store.notify();
  }

  private rememberProcessedMessageRequestId(requestId: string): void {
    this.processedMessageRequestIds.delete(requestId);
    this.processedMessageRequestIds.add(requestId);

    while (
      this.processedMessageRequestIds.size > PROCESSED_REQUEST_ID_CACHE_LIMIT
    ) {
      const oldestRequestId = this.processedMessageRequestIds
        .values()
        .next().value;
      if (!oldestRequestId) {
        break;
      }
      this.processedMessageRequestIds.delete(oldestRequestId);
    }
  }

  /**
   * Record that a user message requestId has been confirmed/processed so a
   * late queueUserMessage for the same requestId is suppressed by
   * queueUserMessages' guard. Mirrors the bookkeeping the CREATE_MESSAGE path
   * already performs, for confirm paths that don't flow through a
   * notification (e.g. text-based optimistic-submit reconcile on load).
   */
  markRequestIdProcessed(requestId: string): void {
    this.rememberProcessedMessageRequestId(requestId);
  }

  /**
   * Clear a specific queued message by requestId
   */
  clearQueuedMessage(requestId: string): void {
    this.queuedMessages.delete(requestId);
    this.store.notify();
  }

  getQueuedMessages(): QueuedUserMessageState[] {
    return Array.from(this.queuedMessages.values());
  }

  getQueuedMessage(requestId: string): QueuedUserMessageState | null {
    return this.queuedMessages.get(requestId) ?? null;
  }

  dequeueQueuedMessage(
    kind?: QueuedUserMessageKind
  ): QueuedUserMessageState | null {
    for (const [requestId, queuedMessage] of this.queuedMessages.entries()) {
      if (kind && queuedMessage.kind !== kind) {
        continue;
      }

      this.queuedMessages.delete(requestId);
      this.store.notify();
      return queuedMessage;
    }

    return null;
  }

  dequeueQueuedMessages(
    kind?: QueuedUserMessageKind
  ): QueuedUserMessageState[] {
    const queuedMessages: QueuedUserMessageState[] = [];

    for (const [requestId, queuedMessage] of this.queuedMessages.entries()) {
      if (kind && queuedMessage.kind !== kind) {
        continue;
      }

      this.queuedMessages.delete(requestId);
      queuedMessages.push(queuedMessage);
    }

    if (queuedMessages.length > 0) {
      this.store.notify();
    }

    return queuedMessages;
  }

  restoreQueuedMessageToFront(message: QueuedUserMessageState): void {
    this.restoreQueuedMessagesToFront([message]);
  }

  restoreQueuedMessagesToFront(messages: QueuedUserMessageState[]): void {
    if (messages.length === 0) {
      return;
    }

    const restoredMessages = new Map<string, QueuedUserMessageState>();
    for (const message of messages) {
      restoredMessages.set(message.requestId, message);
      this.queuedMessages.delete(message.requestId);
    }

    this.queuedMessages = new Map([
      ...restoredMessages.entries(),
      ...this.queuedMessages.entries(),
    ]);
    this.store.notify();
  }

  clearQueuedMessages(
    kind?: QueuedUserMessageKind | QueuedUserMessageKind[]
  ): void {
    if (!kind) {
      if (this.queuedMessages.size === 0) {
        return;
      }
      this.queuedMessages.clear();
      this.store.notify();
      return;
    }

    const kinds = new Set(Array.isArray(kind) ? kind : [kind]);
    let removedAny = false;
    for (const [requestId, queuedMessage] of this.queuedMessages.entries()) {
      if (!kinds.has(queuedMessage.kind)) {
        continue;
      }
      this.queuedMessages.delete(requestId);
      removedAny = true;
    }

    if (removedAny) {
      this.store.notify();
    }
  }

  pauseDaemonQueuedMessagesAfterEsc(restoredRequestId?: string): void {
    let changed = false;
    const pausedQueue = new Map<string, QueuedUserMessageState>();

    for (const [requestId, queuedMessage] of this.queuedMessages.entries()) {
      const hasRestorableAttachment = queuedMessage.content.some(
        (block) =>
          block.type === MessageContentBlockType.Document ||
          block.type === MessageContentBlockType.Image
      );

      if (requestId === restoredRequestId) {
        changed = true;
        if (hasRestorableAttachment) {
          pausedQueue.set(requestId, {
            ...queuedMessage,
            kind: QueuedUserMessageKind.LocalPausedAfterEsc,
          });
        }
        continue;
      }

      if (!isDaemonQueuedMessageKind(queuedMessage.kind)) {
        pausedQueue.set(requestId, queuedMessage);
        continue;
      }

      changed = true;
      if (
        queuedMessage.kind === QueuedUserMessageKind.DaemonQueuedDiscardable
      ) {
        if (hasRestorableAttachment) {
          pausedQueue.set(requestId, {
            ...queuedMessage,
            kind: QueuedUserMessageKind.LocalPausedAfterEsc,
          });
        }
        continue;
      }

      pausedQueue.set(requestId, {
        ...queuedMessage,
        kind: QueuedUserMessageKind.LocalPausedAfterEsc,
      });
    }

    if (!changed) {
      return;
    }

    this.queuedMessages = pausedQueue;
    this.store.notify();
  }

  clearQueue(): void {
    this.queuedMessages.clear();
    this.store.notify();
  }

  private mergeOptimisticMessages(
    realMessages: IndustryDroolMessage[]
  ): IndustryDroolMessage[] {
    const optimisticMsgs = Array.from(this.optimisticMessages.values());
    return [...realMessages, ...optimisticMsgs].sort(
      (a, b) => a.createdAt - b.createdAt
    );
  }

  /**
   * Get messages filtered for UI display.
   * Uses the canonical filterMessagesForUI utility to ensure consistent filtering.
   * Includes optimistic messages that are pending server confirmation.
   */
  getDisplayMessages(): IndustryDroolMessage[] {
    const sorted = this.mergeOptimisticMessages(
      filterMessagesForUI(this.store.getMessages())
    );

    // Progressive loading: show only the last N messages during initial render
    if (this.renderLimit !== null && sorted.length > this.renderLimit) {
      return sorted.slice(-this.renderLimit);
    }

    return sorted;
  }

  /**
   * Add an optimistic message that will be shown until confirmed by server
   */
  addOptimisticMessage(requestId: string, message: IndustryDroolMessage): void {
    this.optimisticMessages.set(requestId, message);
    this.store.notifyMessagesChanged();
  }

  /**
   * Inspect a single optimistic message by requestId. Used by the
   * post-load reconciliation pass in `MultiSessionStateManager` to
   * match optimistic submits against the daemon-persisted user
   * messages and confirm them when the originating CREATE_MESSAGE
   * notification was lost.
   */
  getOptimisticMessage(requestId: string): IndustryDroolMessage | undefined {
    return this.optimisticMessages.get(requestId);
  }

  /**
   * Remove optimistic message when confirmed or on error
   */
  removeOptimisticMessage(requestId: string): void {
    if (this.optimisticMessages.delete(requestId)) {
      this.store.notifyMessagesChanged();
    }
  }

  /**
   * Update session settings (model ID, reasoning effort, and autonomy level)
   */
  updateSessionSettings(params: {
    modelId?: string;
    reasoningEffort?: string;
    interactionMode?: DroolInteractionMode;
    autonomyLevel?: AutonomyLevel;
    tags?: ReturnType<SessionStore['getTags']>;
  }): void {
    if (params.modelId !== undefined) {
      this.store.setModelId(params.modelId);
    }
    if (params.reasoningEffort !== undefined) {
      this.store.setReasoningEffort(params.reasoningEffort);
    }
    this.applyInteractionSettings(params);
    if (params.tags !== undefined) {
      this.store.setTags(params.tags);
    }
  }

  /**
   * Resolve and apply interaction settings (interactionMode, autonomyLevel)
   * to the session store.
   */
  applyInteractionSettings(settings: {
    interactionMode?: DroolInteractionMode;
    autonomyLevel?: AutonomyLevel;
  }): void {
    if (
      settings.interactionMode === undefined &&
      settings.autonomyLevel === undefined
    ) {
      return;
    }

    const nextInteractionSettings = resolveInteractionSettings({
      interactionMode: settings.interactionMode,
      autonomyLevel: settings.autonomyLevel,
      fallback: {
        interactionMode:
          this.store.getInteractionMode() ?? DroolInteractionMode.Auto,
        autonomyLevel: this.store.getAutonomyLevel() ?? AutonomyLevel.Off,
      },
    });

    this.store.setInteractionMode(nextInteractionSettings.interactionMode);
    this.store.setAutonomyLevel(nextInteractionSettings.autonomyLevel);
  }

  /**
   * Get current interaction mode
   */
  getInteractionMode(): DroolInteractionMode | null {
    return this.store.getInteractionMode();
  }

  /**
   * Get current autonomy level
   */
  getAutonomyLevel(): AutonomyLevel | null {
    return this.store.getAutonomyLevel();
  }

  /**
   * Get current model ID
   */
  getModelId(): string | null {
    return this.store.getModelId();
  }

  /**
   * Get current reasoning effort
   */
  getReasoningEffort(): string | null {
    return this.store.getReasoningEffort();
  }

  /**
   * Get spec mode model ID
   */
  getSpecModeModelId(): string | null {
    return this.store.getSpecModeModelId();
  }

  /**
   * Get spec mode reasoning effort
   */
  getSpecModeReasoningEffort(): string | null {
    return this.store.getSpecModeReasoningEffort();
  }

  /**
   * Get available models
   */
  getAvailableModels(): AvailableModelConfig[] | null {
    return this.store.getAvailableModels();
  }

  // ============ Terminal Registry Methods ============

  /**
   * Register a mounted terminal's write handler.
   * Also flushes any buffered data that arrived while unmounted.
   */
  registerTerminal(
    terminalId: string,
    writeHandler: (data: string) => void
  ): void {
    this.terminalWriteHandlers.set(terminalId, writeHandler);

    // If there's buffered data from previous unmount, flush it now
    const buffered = this.store.getTerminalBufferedData(terminalId);
    if (buffered) {
      logInfo('[SessionStateManager] Flushing buffered terminal data', {
        terminalId,
      });
      writeHandler(buffered);

      // Clear the buffered data after flushing to prevent duplicate flushes
      // if multiple terminal instances register
      this.store.clearTerminalBufferedData(terminalId);
    }
  }

  /**
   * Unregister when terminal unmounts.
   * Future DATA notifications will be buffered.
   */
  unregisterTerminal(terminalId: string): void {
    this.terminalWriteHandlers.delete(terminalId);
    logInfo('[SessionStateManager] Terminal unregistered', { terminalId });
  }

  /**
   * Store serialized terminal state (called on unmount)
   */
  storeTerminalState(
    terminalId: string,
    state: {
      serialized: string;
      cols: number;
      rows: number;
      timestamp: number;
      cursorHidden?: boolean;
    }
  ): void {
    this.store.storeTerminalSerializedState(terminalId, state);
    logInfo('[SessionStateManager] Terminal state serialized', {
      terminalId,
    });
  }

  /**
   * Get serialized state for restoration
   */
  getTerminalSerializedState(terminalId: string):
    | {
        serialized: string;
        cols: number;
        rows: number;
        timestamp: number;
        cursorHidden?: boolean;
      }
    | undefined {
    return this.store.getTerminalSerializedState(terminalId);
  }

  /**
   * Get buffered data for restoration
   */
  getTerminalBufferedData(terminalId: string): string | undefined {
    return this.store.getTerminalBufferedData(terminalId);
  }

  /**
   * Clear only buffered data (called when daemon state is restored)
   */
  clearTerminalBufferedData(terminalId: string): void {
    this.store.clearTerminalBufferedData(terminalId);
  }

  /**
   * Clear restoration state after terminal is restored
   */
  clearTerminalRestorationState(terminalId: string): void {
    this.store.clearTerminalRestorationState(terminalId);
    logInfo('[SessionStateManager] Terminal restoration state cleared', {
      terminalId,
    });
  }

  /**
   * Get the machine ID for this session
   */
  getMachineId(): string {
    return this.store.getMachineId();
  }

  /**
   * Set the machine ID for this session
   */
  setMachineId(machineId: string): void {
    this.store.setMachineId(machineId);
  }

  // ============ UI Render Cutoff ============

  setUiRenderCutoff(messageId: string | null): void {
    this.store.setUiRenderCutoff(messageId);
    if (messageId) {
      logInfo('[SessionStateManager] UI render cutoff set', {
        cutoffMessageId: messageId,
      });
    }
  }

  getUiRenderCutoff(): string | null {
    return this.store.getUiRenderCutoff();
  }

  /**
   * Double the render limit (or expand fully if doubling exceeds total count).
   * Returns true if there are still more messages to expand, false if fully
   * expanded. No-op unless progressive UI rendering is enabled.
   */
  expandUiMessages(): boolean {
    if (this.renderLimit === null) {
      return false;
    }
    const displayCount = filterMessagesForUI(this.store.getMessages()).length;
    const nextLimit = this.renderLimit * 2;
    if (nextLimit >= displayCount) {
      this.renderLimit = null;
    } else {
      this.renderLimit = nextLimit;
    }
    // The set of rendered messages changed, so message snapshots keyed on
    // messagesVersion must invalidate, not just general store subscribers.
    this.store.notifyMessagesChanged();
    return this.renderLimit !== null;
  }

  private addMessage(
    message: IndustryDroolMessage,
    options?: { silent?: boolean }
  ): void {
    this.applyTodoStateFromMessage(message);
    this.store.addMessage(message, options);
  }

  // ============ Conversation State Queries ============

  isConversationEmpty(): boolean {
    return (
      this.store.getMessageCount() === 0 && this.optimisticMessages.size === 0
    );
  }
}
