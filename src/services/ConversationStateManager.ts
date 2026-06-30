import {
  TOOL_EXECUTION_INTERRUPTED_RESULT_TEXT,
  TOOL_RESULT_PENDING_MARKER,
} from '@industry/common/sessionV2';
import { StreamingContentBlockType } from '@industry/drool-core/llms/client/enums';
import {
  ChatCompletionReasoningField,
  ModelProvider,
  OpenAIPhase,
} from '@industry/drool-sdk-ext/protocol/llm';
import {
  ContentBlock,
  IndustryDroolMessage,
  MessageContentBlockType,
  MessageVisibility,
  RedactedThinkingBlock,
  RuntimeContentBlock,
  StreamingTextBlock,
  StreamingThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logInfo, logWarn } from '@industry/logging';
import {
  hasUsableTextContent,
  isNonEmptyTextBlock,
  shouldBeVisibleToLLM,
  shouldBeVisibleToUI,
} from '@industry/utils/messages';

import { ERROR_PREFIX, TOOL_CANCELLED_PREFIX } from '@/constants/constants';
import {
  HookEventName,
  HookExecutionStatus,
  MessageRole,
  MessageType,
  ToolCallStatus,
} from '@/hooks/enums';
import {
  HistoryMessage,
  StateAction,
  ToolExecution,
  ToolResultContent,
} from '@/hooks/types';
import { getI18n } from '@/i18n';
import { convertStreamingBlocksToContentBlocks } from '@/services/message-converters';
import { getSessionService } from '@/services/SessionService';
import { deriveVisibleTextHistoryMessages } from '@/utils/deriveVisibleTextHistoryMessages';
import { getTextContent } from '@/utils/tool-result-helpers';
import { truncateToolResultStringPreview } from '@/utils/truncateToolResultPreview';
import { generateUUID } from '@/utils/uuid';

import type { StreamingContentBlock } from '@industry/drool-core/llms/client/types';
import type { TodoWriteToolParams } from '@industry/drool-core/tools/definitions/todo';

const MAX_TOOL_PROGRESS_UPDATES = 20;

// Memory management constants for toolExecutions Map
// Keep enough for UI display but prevent unbounded growth
const MAX_TOOL_EXECUTIONS = 50;
// Truncate tool results stored in toolExecutions (full result is in conversationHistory for LLM)
// UI already truncates to 2-4 lines via truncateForUIDisplay(), so this is just a safety cap
const MAX_TOOL_RESULT_PREVIEW_LENGTH = 4000;

export class ConversationStateManager {
  // Private in-memory variables (not React state)
  private conversationHistory: IndustryDroolMessage[] = [];

  private toolExecutions: Map<string, ToolExecution> = new Map();

  private debounceTimer: NodeJS.Timeout | null = null;

  // First schedule timestamp in the current burst; 0 when idle.
  private burstStartTime: number = 0;

  private uiUpdatesSuspended: boolean = false;

  private hasPendingUiUpdate: boolean = false;

  // UI update callback (can be changed at runtime)
  private uiMessageCallback: (messages: HistoryMessage[]) => void;

  // TODO state tracking
  private currentTodos: TodoWriteToolParams | null = null;

  private todoUpdateMessageIndex: number = 0;

  // TodoWrite tool_use ID that created/updated the current plan
  private currentTodoWriteId: string | null = null;

  // Streaming state tracking
  private currentAssistantMessage: {
    id: string;
    content: string;
    toolUses: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
      thoughtSignature?: string;
    }>;
    isComplete: boolean;
  } | null = null;

  private pendingToolResults: Map<
    string,
    { id: string; content: ToolResultContent; isComplete: boolean }
  > = new Map();

  // Track the most recently created tool message id to align with persistence
  private lastToolMessageId: string | null = null;

  // Indexed content blocks during streaming - single source of truth for block order
  private streamingContentBlocks: Map<number, StreamingContentBlock> =
    new Map();

  // UI render cutoff - messages before this ID are hidden from Static rendering
  // Set during compaction to limit rendered messages to ~500
  private uiRenderCutoffMessageId: string | null = null;

  // Track last logged cutoff index to avoid spamming logs
  private lastLoggedCutoffIndex: number | null = null;

  // When non-null, limits how many UI messages are rendered (from the tail).
  // null means "show all" (fully expanded).
  private renderLimit: number | null = null;

  // Cached count of visible messages, set once at load time to avoid
  // re-filtering the full array on each expansion step.
  private cachedVisibleCount: number | null = null;

  private static readonly INITIAL_UI_RENDER_LIMIT = 30;

  constructor(uiMessageCallback: (messages: HistoryMessage[]) => void) {
    this.uiMessageCallback = uiMessageCallback;
  }

  /**
   * Set or update the UI message callback.
   * This allows React components to register their setState callback.
   */
  setUiMessageCallback(callback: (messages: HistoryMessage[]) => void): void {
    this.uiMessageCallback = callback;
  }

  /**
   * Temporarily suspend UI updates (deriveUIMessages + setState callback).
   * In-memory state continues to update for correctness.
   */
  setUiUpdatesSuspended(suspended: boolean): void {
    if (this.uiUpdatesSuspended === suspended) {
      return;
    }

    this.uiUpdatesSuspended = suspended;

    if (suspended) {
      // Prevent any pending debounced callback from firing while suspended.
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      return;
    }

    // Flush a single update if anything changed while suspended.
    if (this.hasPendingUiUpdate) {
      this.hasPendingUiUpdate = false;
      this.scheduleReactUpdate('flushAfterResume');
    }
  }

  // Update actions for batch updates
  updateAction(actions: StateAction | StateAction[]): void {
    const actionsArray = Array.isArray(actions) ? actions : [actions];

    // 1. Update in-memory immediately for all actions
    actionsArray.forEach((action) => this.updateInMemoryState(action));

    // 2. Debounce React state update
    this.scheduleReactUpdate();
  }

  private updateInMemoryState(action: StateAction): void {
    switch (action.type) {
      case 'ADD_USER_MESSAGE': {
        const messageId = action.id || generateUUID();
        this.conversationHistory.push({
          id: messageId,
          role: action.role ?? MessageRole.User,
          content: action.content,
          visibility: action.visibility ?? MessageVisibility.Both,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        break;
      }

      case 'ADD_SYSTEM_NOTIFICATION': {
        const now = Date.now();
        const id = action.id || generateUUID();
        const msg: IndustryDroolMessage = {
          id,
          role: MessageRole.User,
          content: [
            {
              type: MessageContentBlockType.Text,
              text: action.content,
            },
          ],
          visibility: MessageVisibility.LLMOnly,
          createdAt: now,
          updatedAt: now,
        };
        this.conversationHistory.push(msg);
        break;
      }

      case 'ADD_CONTEXT_MESSAGE': {
        const now = Date.now();
        const id = action.id || generateUUID();
        this.conversationHistory.push({
          id,
          role: MessageRole.User,
          content: action.content,
          visibility: MessageVisibility.LLMOnly,
          createdAt: now,
          updatedAt: now,
        });
        break;
      }

      case 'TOOL_STATUS': {
        const existing = this.toolExecutions.get(action.id);
        if (existing) {
          this.toolExecutions.set(action.id, {
            ...existing,
            status: action.status,
          });
        }
        break;
      }

      case 'TOOL_PARAMETER_STREAM': {
        const existing = this.toolExecutions.get(action.id);
        if (existing) {
          this.toolExecutions.set(action.id, {
            ...existing,
            input: { ...existing.input, ...action.partialInput },
          });
        }
        break;
      }

      case 'UPDATE_TOOL_PROGRESS': {
        const existing = this.toolExecutions.get(action.id);
        if (!existing) {
          break;
        }

        const previousUpdates = existing.progressUpdates || [];
        const lastUpdate = previousUpdates[previousUpdates.length - 1];
        const incoming = action.update;
        const isDuplicate =
          lastUpdate &&
          lastUpdate.type === incoming.type &&
          lastUpdate.toolName === incoming.toolName &&
          lastUpdate.text === incoming.text &&
          lastUpdate.status === incoming.status &&
          lastUpdate.details === incoming.details &&
          lastUpdate.valueSnippet === incoming.valueSnippet;

        if (isDuplicate) {
          break;
        }

        const nextUpdates = [...previousUpdates, incoming].slice(
          -MAX_TOOL_PROGRESS_UPDATES
        );
        const lastUpdateAt = incoming.timestamp || Date.now();
        const nextStatus =
          existing.status === ToolCallStatus.Pending
            ? ToolCallStatus.Executing
            : existing.status;

        this.toolExecutions.set(action.id, {
          ...existing,
          status: nextStatus,
          progressUpdates: nextUpdates,
          lastUpdateAt,
        });

        this.scheduleReactUpdate('updateToolProgress');

        break;
      }

      case 'START_HOOK_EXECUTION': {
        // Add a hook execution message to the conversation history
        const now = Date.now();
        const startTime = action.startTime || now;
        const hookMessage = {
          id: action.id,
          role: MessageRole.System,
          content: [
            {
              type: MessageContentBlockType.Text,
              text: `Hook execution started: ${action.hookEventName}`,
            },
          ],
          visibility: MessageVisibility.UserOnly,
          createdAt: startTime,
          updatedAt: now,
          hookEventName: action.hookEventName,
          hookMatcher: action.hookMatcher,
          hookCommands: action.hookCommands,
          hookStatus: HookExecutionStatus.Executing,
          hookToolCallId: action.hookToolCallId,
          isParallelExecution: action.isParallelExecution,
          parallelGroupId: action.parallelGroupId,
        } as IndustryDroolMessage & {
          hookEventName: HookEventName;
          hookMatcher?: string;
          hookCommands: Array<{ command: string; timeout?: number }>;
          hookStatus: HookExecutionStatus;
          hookToolCallId?: string;
          isParallelExecution?: boolean;
          parallelGroupId?: string;
        };
        this.conversationHistory.push(hookMessage);
        break;
      }

      case 'UPDATE_HOOK_EXECUTION': {
        // Find and update the hook execution message
        const hookMessage = this.conversationHistory.find(
          (msg) => msg.id === action.id
        ) as
          | (IndustryDroolMessage & {
              hookStatus?: HookExecutionStatus;
              hookResults?: Array<{
                exitCode: number;
                stdout: string;
                stderr: string;
                suppressOutput?: boolean;
              }>;
              endTime?: number;
            })
          | undefined;

        if (hookMessage) {
          const now = Date.now();
          hookMessage.updatedAt = now;
          hookMessage.endTime = now;
          hookMessage.hookStatus = action.hookStatus;
          hookMessage.hookResults = action.hookResults;
        }
        this.scheduleReactUpdate('updateHookExecution');
        break;
      }

      case 'CLEAR_HISTORY': {
        this.conversationHistory = [];
        this.toolExecutions.clear();
        this.currentAssistantMessage = null;
        this.pendingToolResults.clear();
        // Reset TODO state
        this.currentTodos = null;
        this.todoUpdateMessageIndex = 0;
        // Reset UI render cutoff
        this.uiRenderCutoffMessageId = null;
        this.lastLoggedCutoffIndex = null;
        // Reset progressive loading
        this.renderLimit = null;
        this.cachedVisibleCount = null;
        break;
      }

      case 'ADD_MESSAGE': {
        // Simplified legacy support - handle user and system messages
        // Assistant messages are handled via streaming API
        if (action.role === MessageRole.User) {
          this.updateAction({
            type: 'ADD_USER_MESSAGE',
            content: [
              { type: MessageContentBlockType.Text, text: action.content },
            ],
          });
        } else if (action.role === MessageRole.System) {
          // System messages are treated as user messages in the conversation history
          // but are displayed differently in the UI
          const visibility =
            action.options?.visibility || MessageVisibility.Both;
          const transient = action.options?.transient || false;
          const now = Date.now();
          const id = action.id || generateUUID();
          const sysMsg: IndustryDroolMessage & {
            transient?: boolean;
            messageType?: MessageType;
          } = {
            id,
            role: MessageRole.User,
            content: [
              {
                type: MessageContentBlockType.Text,
                text: action.content,
              },
            ],
            visibility,
            createdAt: now,
            updatedAt: now,
            transient,
            messageType: action.options?.messageType,
          };
          this.conversationHistory.push(sysMsg);
          // Trigger UI update
          this.scheduleReactUpdate('addSystemMessage');
        }
        // Assistant and tool messages are now handled by streaming methods
        break;
      }

      case 'UPDATE_MESSAGE': {
        // This updates UI state only, as in-memory state should not be mutated after creation
        break;
      }

      case 'APPEND_TO_TOOL_RESULTS': {
        // Find the most recent tool message that contains tool results and append content to it
        const lastToolMessage = this.conversationHistory
          .slice()
          .reverse()
          .find(
            (msg) =>
              msg.role === 'tool' &&
              Array.isArray(msg.content) &&
              msg.content.some((block) => block.type === 'tool_result')
          );

        if (lastToolMessage && Array.isArray(lastToolMessage.content)) {
          // Add the content as a text block to the tool results message
          lastToolMessage.content.push({
            type: MessageContentBlockType.Text,
            text: action.content,
          });
          lastToolMessage.updatedAt = Date.now();
        } else {
          // No-op: if no tool results message exists, callers should emit a persisted system notification themselves
        }
        break;
      }

      default: {
        // Unknown action type - do nothing
        break;
      }
    }
  }

  private scheduleReactUpdate(_caller?: string): void {
    if (this.uiUpdatesSuspended) {
      this.hasPendingUiUpdate = true;
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      return;
    }

    // Debounce with a max-wait cap so rapid streaming deltas can't starve
    // the flush (spec-plan partials would otherwise defer it indefinitely).
    const DEBOUNCE_MS = 20;
    const MAX_WAIT_MS = 60;
    const now = Date.now();

    if (this.burstStartTime === 0) {
      this.burstStartTime = now;
    }

    const sinceBurstStart = now - this.burstStartTime;
    const wait = Math.max(
      0,
      Math.min(DEBOUNCE_MS, MAX_WAIT_MS - sinceBurstStart)
    );

    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.burstStartTime = 0;
      const uiMessages = this.deriveUIMessages();
      this.uiMessageCallback(uiMessages);
    }, wait);
  }

  /**
   * Sync streaming content blocks to the message content array.
   * Maintains order by sorting blocks by their streaming index.
   */
  private syncContentBlocksToMessage(): void {
    const lastMessage =
      this.conversationHistory[this.conversationHistory.length - 1];
    if (
      !lastMessage ||
      lastMessage.role !== 'assistant' ||
      !Array.isArray(lastMessage.content)
    ) {
      return;
    }

    // Sort blocks by index and convert to ContentBlock format
    const sortedBlocks = [...this.streamingContentBlocks.values()].sort(
      (a, b) => a.index - b.index
    );

    // Preserve existing tool_use blocks that were added via addToolCall
    const existingToolUseBlocks = lastMessage.content.filter(
      (b) => b.type === MessageContentBlockType.ToolUse
    );

    const newContent: ContentBlock[] = [];

    for (const block of sortedBlocks) {
      if (block.type === StreamingContentBlockType.Thinking) {
        // Always add thinking blocks - they'll update in place as content streams
        // This ensures the thinking message ID exists from the start for Ink's Static
        const thinkingBlock: StreamingThinkingBlock = {
          type: MessageContentBlockType.Thinking,
          thinking: block.content,
          signature: block.signature || '',
          signatureProvider: block.signatureProvider,
          isStreaming: block.isStreaming,
          ...(block.durationMs !== undefined && {
            durationMs: block.durationMs,
          }),
        };
        newContent.push(thinkingBlock);
      } else if (block.type === StreamingContentBlockType.Text) {
        const textBlock: StreamingTextBlock = {
          type: MessageContentBlockType.Text,
          text: block.content,
          isStreaming: block.isStreaming,
        };
        newContent.push(textBlock);
      } else if (
        block.type === StreamingContentBlockType.RedactedThinking &&
        block.data
      ) {
        newContent.push({
          type: MessageContentBlockType.RedactedThinking,
          data: block.data,
        } as RedactedThinkingBlock);
      }
      // tool_use blocks are handled separately via addToolCall
    }

    // Append existing tool_use blocks (they maintain their own order)
    newContent.push(...existingToolUseBlocks);

    lastMessage.content = newContent;
  }

  /**
   * Clear any unfinished tool call invocations from the current assistant message.
   * Invoked when we rotate Anthropic providers to avoid mixing tool_use IDs across attempts.
   */
  clearUnfinishedToolCallInvocations(): void {
    if (!this.currentAssistantMessage) {
      return;
    }

    const unfinishedToolIds = this.currentAssistantMessage.toolUses.map(
      (t) => t.id
    );

    // Remove tool_use blocks from the last assistant message
    const lastMessage =
      this.conversationHistory[this.conversationHistory.length - 1];
    if (
      lastMessage &&
      lastMessage.role === 'assistant' &&
      Array.isArray(lastMessage.content)
    ) {
      lastMessage.content = lastMessage.content.filter((block) => {
        if (block.type !== MessageContentBlockType.ToolUse) return true;
        const toolBlock = block as ToolUseBlock;
        return !unfinishedToolIds.includes(toolBlock.id);
      });
    }

    // Remove executions and any pending results for these tools
    unfinishedToolIds.forEach((id) => {
      this.toolExecutions.delete(id);
      this.pendingToolResults.delete(id);
    });

    // Reset current assistant tool list
    this.currentAssistantMessage.toolUses = [];

    this.scheduleReactUpdate('clearUnfinishedToolCallInvocations');
  }

  /**
   * Discard the in-flight (unfinalized) assistant message entirely, so a
   * content-moderation-refused partial turn is not resent on later turns.
   */
  discardInFlightAssistantMessage(): void {
    if (!this.currentAssistantMessage) {
      return;
    }

    const { id, toolUses } = this.currentAssistantMessage;

    const messageIndex = this.conversationHistory.findIndex(
      (msg) => msg.id === id && msg.role === MessageRole.Assistant
    );
    if (messageIndex !== -1) {
      this.conversationHistory.splice(messageIndex, 1);
    }

    toolUses.forEach((toolUse) => {
      this.toolExecutions.delete(toolUse.id);
      this.pendingToolResults.delete(toolUse.id);
    });

    this.streamingContentBlocks.clear();
    this.currentAssistantMessage = null;

    this.scheduleReactUpdate('discardInFlightAssistantMessage');
  }

  private deriveUIMessages(): HistoryMessage[] {
    let messages: HistoryMessage[] = [];

    // Type for hook execution messages
    type HookExecutionMessage = IndustryDroolMessage & {
      hookEventName?: string;
      hookMatcher?: string;
      hookCommands?: Array<{ command: string; timeout?: number }>;
      hookStatus?: string;
      hookResults?: Array<{
        exitCode: number;
        stdout: string;
        stderr: string;
        suppressOutput?: boolean;
      }>;
      isParallelExecution?: boolean;
      parallelGroupId?: string;
    };

    // When renderLimit is active, only derive messages from the tail of
    // conversationHistory to avoid O(n) work on the initial render.
    // Over-fetch by 2x to account for messages filtered out by visibility.
    let sourceMessages = this.conversationHistory;
    if (this.renderLimit !== null) {
      const sliceSize = Math.min(
        this.renderLimit * 2,
        this.conversationHistory.length
      );
      sourceMessages = this.conversationHistory.slice(-sliceSize);
    }

    // Convert conversation history to UI messages, filtering by visibility
    sourceMessages
      .filter((msg) => shouldBeVisibleToUI(msg))
      .forEach((msg, _index) => {
        const visibility = msg.visibility || MessageVisibility.Both;

        // Check if this is a hook execution message
        const hookMsg = msg as HookExecutionMessage;
        if (hookMsg.hookEventName && hookMsg.hookCommands) {
          messages.push({
            id: msg.id,
            role: MessageRole.System,
            content: '',
            messageType: MessageType.HookExecution,
            visibility: MessageVisibility.UserOnly,
            hookEventName: hookMsg.hookEventName as HookEventName,
            hookMatcher: hookMsg.hookMatcher,
            hookCommands: hookMsg.hookCommands,
            hookStatus: hookMsg.hookStatus as HookExecutionStatus,
            hookResults: hookMsg.hookResults,
            startTime: msg.createdAt,
            endTime: msg.updatedAt,
            isParallelExecution: hookMsg.isParallelExecution,
            parallelGroupId: hookMsg.parallelGroupId,
          });
          return;
        }

        if (msg.role === 'user') {
          messages.push(...deriveVisibleTextHistoryMessages(msg));
        } else if (msg.role === 'tool') {
          if (Array.isArray(msg.content)) {
            msg.content.forEach((block) => {
              if (block.type === 'tool_result') {
                const toolExecution = this.toolExecutions.get(block.toolUseId);

                messages.push({
                  id: msg.id,
                  role: MessageRole.Tool,
                  content: getTextContent(block.content),
                  messageType: MessageType.ToolResult,
                  visibility,
                  toolCallId: block.toolUseId,
                  toolName: toolExecution?.name,
                  toolCallStatus: toolExecution?.status,
                  startTime: toolExecution?.startTime,
                  endTime: toolExecution?.endTime,
                  progressUpdates: toolExecution?.progressUpdates,
                });
              }
            });
          }
        } else if (msg.role === 'assistant') {
          if (typeof msg.content === 'string') {
            messages.push({
              id: msg.id,
              role: MessageRole.Assistant,
              content: msg.content,
              messageType: MessageType.Markdown,
              visibility: msg.visibility || MessageVisibility.Both,
            });
          } else if (Array.isArray(msg.content)) {
            // Process each content block and create appropriate UI messages
            // Thinking blocks become their own messages (shown in extended view, filtered in normal view)

            // Handle legacy thinking content (older sessions before interleaved thinking)
            // Only create legacy thinking messages if there are no thinking blocks in content array
            const hasThinkingInContent = msg.content.some(
              (b) => b.type === 'thinking' || b.type === 'redacted_thinking'
            );
            if (!hasThinkingInContent) {
              if (msg.openaiReasoningSummary) {
                messages.push({
                  id: `${msg.id}-reasoning-legacy`,
                  role: MessageRole.Assistant,
                  content: msg.openaiReasoningSummary,
                  messageType: MessageType.Thinking,
                  visibility: msg.visibility || MessageVisibility.Both,
                  thinkingBlock: {
                    type: 'thinking',
                    thinking: msg.openaiReasoningSummary,
                    signature: msg.openaiEncryptedContent
                      ? JSON.stringify({ reasoning_id: msg.openaiReasoningId })
                      : undefined,
                    signatureProvider: ModelProvider.OPENAI,
                    index: 0,
                  },
                });
              } else if (msg.chatCompletionReasoningContent) {
                messages.push({
                  id: `${msg.id}-reasoning-legacy`,
                  role: MessageRole.Assistant,
                  content: msg.chatCompletionReasoningContent,
                  messageType: MessageType.Thinking,
                  visibility: msg.visibility || MessageVisibility.Both,
                  thinkingBlock: {
                    type: 'thinking',
                    thinking: msg.chatCompletionReasoningContent,
                    signature: undefined,
                    index: 0,
                  },
                });
              }
            }

            // Use separate counters for each block type to ensure stable IDs
            // Array index changes when content is finalized (thinking blocks are inserted)
            let thinkingCounter = 0;
            let textCounter = 0;

            (msg.content as RuntimeContentBlock[]).forEach((block) => {
              if (block.type === 'thinking') {
                // Skip rendering thinking blocks that are still streaming.
                // They will render once markThinkingComplete is called (on content_block_stop).
                if (block.isStreaming) {
                  return;
                }

                const thinkingIndex = thinkingCounter++;

                // Create a dedicated thinking message
                messages.push({
                  id: `${msg.id}-thinking-${thinkingIndex}`,
                  role: MessageRole.Assistant,
                  content: block.thinking || '',
                  messageType: MessageType.Thinking,
                  visibility: msg.visibility || MessageVisibility.Both,
                  thinkingBlock: {
                    type: 'thinking',
                    thinking: block.thinking,
                    signature: block.signature,
                    durationMs: block.durationMs,
                    index: thinkingIndex,
                  },
                });
              } else if (block.type === 'redacted_thinking') {
                const thinkingIndex = thinkingCounter++;
                // Create a dedicated redacted thinking message
                messages.push({
                  id: `${msg.id}-thinking-${thinkingIndex}`,
                  role: MessageRole.Assistant,
                  content: '[Redacted]',
                  messageType: MessageType.Thinking,
                  visibility: msg.visibility || MessageVisibility.Both,
                  thinkingBlock: {
                    type: 'redacted_thinking',
                    data: block.data,
                    index: thinkingIndex,
                  },
                });
              } else if (block.type === 'text') {
                // Skip empty text blocks
                if (!isNonEmptyTextBlock(block)) {
                  return;
                }

                // Skip text blocks that are still streaming
                // They will render once markTextComplete is called
                if (block.isStreaming) {
                  return;
                }

                const textIndex = textCounter++;
                messages.push({
                  id: `${msg.id}-text-${textIndex}`,
                  role: MessageRole.Assistant,
                  content: block.text,
                  messageType: MessageType.Markdown,
                  visibility: msg.visibility || MessageVisibility.Both,
                });
              } else if (block.type === 'tool_use') {
                const toolExecution = this.toolExecutions.get(block.id);
                const safeInput =
                  (block.input as Record<string, unknown> | undefined) ?? {};
                let toolMessage = `Executing ${block.name}...`;

                if (block.name === 'Create') {
                  const input = safeInput as { file_path?: string };
                  toolMessage = `Creating ${input.file_path || 'file'}...`;
                } else if (block.name === 'Read') {
                  const input = safeInput as { file_path?: string };
                  toolMessage = `Reading ${input.file_path || 'file'}...`;
                } else if (block.name === 'Execute') {
                  const input = safeInput as { command?: string };
                  toolMessage = `Executing: ${input.command || 'command'}...`;
                } else if (block.name === 'LS') {
                  const input = safeInput as { directory_path?: string };
                  toolMessage = `Listing ${input.directory_path || 'directory'}...`;
                }

                messages.push({
                  id: block.id, // Use tool_use_id as unique identifier
                  role: MessageRole.Tool,
                  content: toolMessage,
                  messageType: MessageType.ToolCall,
                  visibility: msg.visibility || MessageVisibility.Both,
                  toolCallStatus:
                    toolExecution?.status || ToolCallStatus.Pending,
                  toolCallId: block.id,
                  toolName: block.name,
                  toolInput: safeInput,
                  startTime: toolExecution?.startTime,
                  endTime: toolExecution?.endTime,
                  progressUpdates: toolExecution?.progressUpdates,
                });
              }
            });
          }
        }
      });

    // Apply UI render cutoff if set (from compaction)
    if (this.uiRenderCutoffMessageId) {
      // Find the index of the cutoff message
      const cutoffIndex = messages.findIndex(
        (msg) => msg.id === this.uiRenderCutoffMessageId
      );

      if (cutoffIndex > 0) {
        // Insert a "previous messages hidden" indicator before the cutoff message
        const hiddenIndicator: HistoryMessage = {
          id: 'ui-render-cutoff-indicator',
          role: MessageRole.System,
          content: getI18n().t('common:conversation.previousMessagesHidden'),
          messageType: MessageType.Text,
          visibility: MessageVisibility.UserOnly,
        };

        // Slice to keep only messages from cutoff onwards, with indicator
        messages = [hiddenIndicator, ...messages.slice(cutoffIndex)];

        // Only log when the cutoff index changes to avoid spamming logs
        if (cutoffIndex !== this.lastLoggedCutoffIndex) {
          this.lastLoggedCutoffIndex = cutoffIndex;
          logInfo('[ConversationStateManager] Applied UI render cutoff', {
            cutoffMessageId: this.uiRenderCutoffMessageId,
            index: cutoffIndex,
            count: cutoffIndex,
            messageCount: messages.length,
          });
        }
      } else if (cutoffIndex === -1) {
        // Cutoff message ID not found - log warning but continue without cutoff
        logWarn(
          '[ConversationStateManager] UI render cutoff message not found',
          {
            cutoffMessageId: this.uiRenderCutoffMessageId,
            totalMessages: messages.length,
          }
        );
      }
    }

    // Progressive loading: show only last N messages for fast display
    if (this.renderLimit !== null && messages.length > this.renderLimit) {
      const hiddenCount = messages.length - this.renderLimit;
      const loadingIndicator: HistoryMessage = {
        id: '__internal__ui-initial-render-loading',
        role: MessageRole.System,
        content: getI18n().t('common:conversation.loadingOlderMessages', {
          count: hiddenCount,
        }),
        messageType: MessageType.Text,
        visibility: MessageVisibility.UserOnly,
      };

      messages = [loadingIndicator, ...messages.slice(-this.renderLimit)];
    }

    return messages;
  }

  // Getters for external use
  getConversationHistory(): IndustryDroolMessage[] {
    // Include all messages for LLM (including system reminder) - only filter from UI
    const filteredMessages = this.conversationHistory.filter((msg) => {
      // Filter out messages that should not be visible to the LLM
      if (!shouldBeVisibleToLLM(msg)) {
        return false;
      }

      // Filter out empty assistant messages to prevent API validation errors
      if (msg.role === 'assistant') {
        // Check if array has any meaningful content
        const hasTextContent = hasUsableTextContent(msg.content);
        const hasToolUse = msg.content.some(
          (block) => block.type === 'tool_use'
        );

        // Filter out if no meaningful content
        if (msg.content.length === 0 || (!hasTextContent && !hasToolUse)) {
          return false;
        }
      }

      // Filter out user messages that only contain pending tool_results (never executed)
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const hasOnlyPendingToolResults =
          msg.content.length > 0 &&
          msg.content.every(
            (block) =>
              block.type === 'tool_result' &&
              (block as ToolResultBlock).content === TOOL_RESULT_PENDING_MARKER
          );

        if (hasOnlyPendingToolResults) {
          return false;
        }
      }

      return true;
    });

    // Validate tool_use / tool_result pairing
    const validatedMessages =
      ConversationStateManager.validateToolUsePairing(filteredMessages);

    return validatedMessages.map(({ visibility: _visibility, ...msg }) => msg);
  }

  isConversationEmpty(): boolean {
    return (
      this.conversationHistory.filter((msg) => shouldBeVisibleToLLM(msg))
        .length === 0
    );
  }

  /**
   * Validates tool_use / tool_result pairing and inserts synthetic results
   * for any tool_use blocks that lack completed tool_results.
   *
   * IMPORTANT: This method never mutates the input messages. When a tool
   * message has incomplete results, a new message object is created instead
   * of overwriting the original (which would corrupt in-flight tool execution).
   */
  private static validateToolUsePairing(
    messages: IndustryDroolMessage[]
  ): IndustryDroolMessage[] {
    const result: IndustryDroolMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        result.push(msg);

        const toolUseIds = msg.content
          .filter((block) => block.type === 'tool_use')
          .map((block) => (block as ToolUseBlock).id);

        if (toolUseIds.length > 0) {
          const nextMessage = i + 1 < messages.length ? messages[i + 1] : null;

          // Build a map of tool_use id → existing real tool_result so we can
          // preserve siblings that have already resolved (e.g. an AskUser
          // that replayed successfully) when other siblings in the same
          // assistant message are still pending.
          const realResultByToolUseId = new Map<string, ToolResultBlock>();
          if (
            nextMessage &&
            nextMessage.role === 'tool' &&
            Array.isArray(nextMessage.content)
          ) {
            for (const block of nextMessage.content) {
              if (block.type !== 'tool_result') continue;
              const tr = block as ToolResultBlock;
              const isReal =
                typeof tr.content !== 'undefined' &&
                tr.content !== null &&
                tr.content !== TOOL_RESULT_PENDING_MARKER;
              if (isReal) {
                realResultByToolUseId.set(tr.toolUseId, tr);
              }
            }
          }

          const hasCorrespondingToolResults = toolUseIds.every((id) =>
            realResultByToolUseId.has(id)
          );

          if (!hasCorrespondingToolResults) {
            // Only synthesize cancellation placeholders for the tool_uses
            // that don't already have a real result. Real results from
            // siblings (e.g. resolved AskUser) are preserved verbatim so the
            // LLM still sees them.
            const mergedToolResults: ToolResultBlock[] = toolUseIds.map(
              (id) =>
                realResultByToolUseId.get(id) ?? {
                  type: MessageContentBlockType.ToolResult,
                  toolUseId: id,
                  content: 'Error: Tool execution was cancelled',
                }
            );

            if (nextMessage && nextMessage.role === 'tool') {
              // Create a replacement message instead of mutating the original.
              // The original message in conversationHistory retains its pending
              // markers so updateToolResult() can still fill them in.
              result.push({
                ...nextMessage,
                content: mergedToolResults,
              });
              // Skip the original nextMessage so it isn't pushed again
              i++;
            } else {
              const syntheticToolMsg: IndustryDroolMessage = {
                id: `synthetic-tool-result:${msg.id}`,
                role: MessageRole.Tool,
                content: mergedToolResults,
                visibility: MessageVisibility.LLMOnly,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
              result.push(syntheticToolMsg);
            }
          }
        }
      } else if (msg.role === 'user') {
        result.push(msg);
      } else {
        result.push(msg);
      }
    }

    return result;
  }

  // Get all messages including internal ones
  getAllMessages(): IndustryDroolMessage[] {
    return [...this.conversationHistory];
  }

  getLastMessage(): IndustryDroolMessage | undefined {
    return this.conversationHistory.at(-1);
  }

  getToolExecutions(): Map<string, ToolExecution> {
    return new Map(this.toolExecutions);
  }

  clearHistory(): void {
    this.updateAction({ type: 'CLEAR_HISTORY' });
  }

  // Load full conversation history (used when loading sessions)
  loadConversationHistory(messages: IndustryDroolMessage[]): void {
    // Clear current state
    this.clearHistory();

    // Load the conversation history directly
    this.conversationHistory = [...messages];

    // Cache visible count once so expandUiMessages doesn't re-filter every step
    this.cachedVisibleCount = messages.filter((msg) =>
      shouldBeVisibleToUI(msg)
    ).length;

    // Enable progressive loading for fast UI display
    // Only show last N messages initially, then double on each expansion step
    this.renderLimit =
      this.cachedVisibleCount > ConversationStateManager.INITIAL_UI_RENDER_LIMIT
        ? ConversationStateManager.INITIAL_UI_RENDER_LIMIT
        : null;

    // Rebuild toolExecutions map from historical messages
    this.rebuildToolExecutionsFromHistory();

    // Load TODO state from session after conversation is loaded
    this.loadTodoStateFromSession();

    // Trigger UI update to reflect the loaded history
    this.scheduleReactUpdate('loadConversationHistory');
  }

  /**
   * Double the render limit (or expand fully if doubling exceeds total count).
   * Returns true if there are still more messages to expand, false if fully expanded.
   */
  expandUiMessages(): boolean {
    if (this.renderLimit === null) {
      return false;
    }
    // Use cached count (computed once at load time) to avoid O(n) filter per step
    const displayCount =
      this.cachedVisibleCount ??
      this.conversationHistory.filter((msg) => shouldBeVisibleToUI(msg)).length;
    const nextLimit = this.renderLimit * 2;
    if (nextLimit >= displayCount) {
      this.renderLimit = null;
      this.cachedVisibleCount = null;
    } else {
      this.renderLimit = nextLimit;
    }
    this.scheduleReactUpdate('expandUiMessages');
    return this.renderLimit !== null;
  }

  // Rebuild toolExecutions map from loaded conversation history
  private rebuildToolExecutionsFromHistory(): void {
    // Single pass: collect tool_use blocks (pending) and resolve them with
    // tool_result blocks that follow. In conversation order, assistant
    // tool_use always precedes its corresponding tool_result.
    const pendingToolUses = new Map<
      string,
      { id: string; name: string; input: unknown }
    >();

    for (const msg of this.conversationHistory) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            const toolUse = block as ToolUseBlock;
            pendingToolUses.set(toolUse.id, {
              id: toolUse.id,
              name: toolUse.name,
              input: toolUse.input,
            });
            // Create execution entry immediately (result will be filled in below)
            this.toolExecutions.set(toolUse.id, {
              id: toolUse.id,
              name: toolUse.name,
              status: ToolCallStatus.Completed,
              input: toolUse.input,
              result: undefined,
              startTime: undefined,
              endTime: undefined,
              progressUpdates: [],
            });
          }
        }
      } else if (
        (msg.role === 'user' || msg.role === 'tool') &&
        Array.isArray(msg.content)
      ) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const toolResult = block as ToolResultBlock;
            const execution = this.toolExecutions.get(toolResult.toolUseId);
            if (!execution) continue;

            const result = getTextContent(toolResult.content);

            if (result === TOOL_RESULT_PENDING_MARKER) {
              // Keep interrupted tools pending so resume can retry them.
              execution.status = ToolCallStatus.Pending;
              if (msg.role === 'tool') {
                this.lastToolMessageId = msg.id;
              }
            } else {
              const isError =
                result.startsWith(ERROR_PREFIX) ||
                result.startsWith(TOOL_CANCELLED_PREFIX);

              execution.status = isError
                ? ToolCallStatus.Error
                : ToolCallStatus.Completed;
              execution.result = truncateToolResultStringPreview(
                result,
                MAX_TOOL_RESULT_PREVIEW_LENGTH
              );
              pendingToolUses.delete(toolResult.toolUseId);
            }
          }
        }
      }
    }

    // Seed pending results so re-executed tools can fill them in.
    for (const [toolId] of pendingToolUses) {
      this.pendingToolResults.set(toolId, {
        id: toolId,
        content: TOOL_RESULT_PENDING_MARKER,
        isComplete: false,
      });
    }

    // Add missing pending tool_result blocks for orphan tool_use messages.
    if (pendingToolUses.size > 0) {
      const lastMsg =
        this.conversationHistory[this.conversationHistory.length - 1];
      const lastMsgHasTailingToolMsg =
        lastMsg && lastMsg.role === MessageRole.Tool;
      if (!lastMsgHasTailingToolMsg) {
        const syntheticToolBlocks: ToolResultBlock[] = Array.from(
          pendingToolUses.keys()
        ).map((id) => ({
          type: MessageContentBlockType.ToolResult,
          toolUseId: id,
          content: TOOL_RESULT_PENDING_MARKER,
        }));
        const toolMsgId = generateUUID();
        this.conversationHistory.push({
          id: toolMsgId,
          role: MessageRole.Tool,
          content: syntheticToolBlocks,
          visibility: MessageVisibility.Both,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        this.lastToolMessageId = toolMsgId;
      }

      // Keep orphan executions pending after adding the marker results.
      for (const id of pendingToolUses.keys()) {
        const execution = this.toolExecutions.get(id);
        if (execution) {
          execution.status = ToolCallStatus.Pending;
        }
      }
    }

    // Prune to keep only the most recent tool executions
    this.pruneOldToolExecutions();
  }

  // Streaming methods for immediate in-memory updates
  startAssistantMessage(id?: string): void {
    // Force-complete any stuck pending/executing tools from previous turn
    // This prevents tools from getting permanently stuck in Pending state
    // when streaming errors or BYOK model issues cause executeTools() to be skipped
    for (const [toolId, execution] of this.toolExecutions) {
      if (
        execution.status === ToolCallStatus.Pending ||
        execution.status === ToolCallStatus.Executing
      ) {
        this.toolExecutions.set(toolId, {
          ...execution,
          status: ToolCallStatus.Completed,
          result: TOOL_EXECUTION_INTERRUPTED_RESULT_TEXT,
          endTime: Date.now(),
        });

        // Also update the tool result in conversation history
        // so LLM context stays consistent
        for (const msg of this.conversationHistory) {
          if (msg.role === 'tool' && Array.isArray(msg.content)) {
            const toolBlock = msg.content.find(
              (block) =>
                block.type === 'tool_result' &&
                (block as ToolResultBlock).toolUseId === toolId
            ) as ToolResultBlock | undefined;
            if (
              toolBlock &&
              (!toolBlock.content ||
                toolBlock.content === TOOL_RESULT_PENDING_MARKER)
            ) {
              toolBlock.content = TOOL_EXECUTION_INTERRUPTED_RESULT_TEXT;
            }
          }
        }

        logWarn('[ConversationStateManager] Force-completed stuck tool', {
          toolId,
          toolName: execution.name,
          previousState: execution.status,
        });
      }
    }

    const messageId = id || generateUUID();
    this.currentAssistantMessage = {
      id: messageId,
      content: '',
      toolUses: [],
      isComplete: false,
    };

    // Clear streaming content blocks for new message
    this.streamingContentBlocks.clear();

    // Update conversation history immediately
    const assistantMessage: IndustryDroolMessage = {
      id: messageId,
      role: MessageRole.Assistant,
      content: [],
      visibility: MessageVisibility.Both,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Don't add placeholder thinking blocks - let them be created on-demand
    // when thinking content actually arrives from the API

    this.conversationHistory.push(assistantMessage);
  }

  appendAssistantText(blockIndex: number, textChunk: string): void {
    if (!this.currentAssistantMessage) {
      this.startAssistantMessage();
    }

    this.currentAssistantMessage!.content += textChunk;

    // Track in indexed content blocks (single source of truth)
    let block = this.streamingContentBlocks.get(blockIndex);
    if (!block) {
      block = {
        type: StreamingContentBlockType.Text,
        index: blockIndex,
        content: '',
        isComplete: false,
        isStreaming: true,
      };
      this.streamingContentBlocks.set(blockIndex, block);
    }
    block.content += textChunk;

    // Sync to message content array
    this.syncContentBlocksToMessage();
  }

  addToolCall(
    id: string,
    name: string,
    input: Record<string, unknown>,
    thoughtSignature?: string
  ): void {
    if (!this.currentAssistantMessage) {
      this.startAssistantMessage();
    }

    const toolUse = {
      id,
      name,
      input,
      ...(thoughtSignature && { thoughtSignature }),
    };
    this.currentAssistantMessage!.toolUses.push(toolUse);

    // Add tool use to the content array
    const lastMessage =
      this.conversationHistory[this.conversationHistory.length - 1];
    if (
      lastMessage &&
      lastMessage.role === 'assistant' &&
      Array.isArray(lastMessage.content)
    ) {
      lastMessage.content.push({
        type: MessageContentBlockType.ToolUse,
        id,
        name,
        input,
        ...(thoughtSignature && { thoughtSignature }),
      });
    }

    // Add to tool executions map
    this.toolExecutions.set(id, {
      id,
      name,
      status: ToolCallStatus.Pending,
      input,
      startTime: Date.now(),
      progressUpdates: [],
    });

    // Trigger UI update for tool call detection
    this.scheduleReactUpdate('addToolCall');
  }

  updateToolCallInput(id: string, partialInput: Record<string, unknown>): void {
    if (!this.currentAssistantMessage) return;

    // Update tool use in current message
    const toolUse = this.currentAssistantMessage.toolUses.find(
      (t) => t.id === id
    );
    if (toolUse) {
      toolUse.input = { ...toolUse.input, ...partialInput };

      // Update conversation history
      const lastMessage =
        this.conversationHistory[this.conversationHistory.length - 1];
      if (
        lastMessage &&
        lastMessage.role === 'assistant' &&
        Array.isArray(lastMessage.content)
      ) {
        const toolBlock = lastMessage.content.find(
          (block) =>
            block.type === 'tool_use' && (block as ToolUseBlock).id === id
        ) as ToolUseBlock | undefined;
        if (toolBlock) {
          toolBlock.input = toolUse.input;
        }
      }

      // Update tool executions
      const execution = this.toolExecutions.get(id);
      if (execution) {
        this.toolExecutions.set(id, {
          ...execution,
          input: toolUse.input,
        });
      }

      // Trigger UI update for parameter completion
      this.scheduleReactUpdate('updateToolCallInput');
    }
  }

  /**
   * Append a thinking content delta during streaming.
   * Uses indexed content blocks to preserve order and enable immediate UI updates.
   */
  appendThinkingDelta(blockIndex: number, delta: string): void {
    if (!this.currentAssistantMessage) {
      this.startAssistantMessage();
    }

    // Track in indexed content blocks (single source of truth)
    let block = this.streamingContentBlocks.get(blockIndex);
    if (!block) {
      block = {
        type: StreamingContentBlockType.Thinking,
        index: blockIndex,
        content: '',
        signature: '',
        isComplete: false,
        isStreaming: true, // Don't render until streaming completes
        startedAtMs: Date.now(),
      };
      this.streamingContentBlocks.set(blockIndex, block);
    } else if (block.startedAtMs === undefined) {
      block.startedAtMs = Date.now();
    }
    block.content += delta;

    // Sync to message content array
    this.syncContentBlocksToMessage();

    // Trigger UI update to show thinking progressively
    this.scheduleReactUpdate('appendThinkingDelta');
  }

  /**
   * Mark a thinking block as complete (no longer streaming).
   * Called when content_block_stop is received for a thinking block.
   * This allows the thinking to render immediately without waiting for finalizeContentBlocks.
   */
  markThinkingComplete(
    blockIndex: number,
    durationMs?: number
  ): number | undefined {
    const block = this.streamingContentBlocks.get(blockIndex);
    if (block && block.type === StreamingContentBlockType.Thinking) {
      const completedAtMs = Date.now();
      block.isStreaming = false;
      block.isComplete = true;
      block.durationMs =
        durationMs ??
        block.durationMs ??
        Math.max(0, completedAtMs - (block.startedAtMs ?? completedAtMs));

      // Sync to message content array so isStreaming: false propagates
      this.syncContentBlocksToMessage();

      // NOTE: Don't trigger scheduleReactUpdate here!
      // If we do, it can cause the message to be rendered in <Static> while
      // text is still streaming. The thinking will be rendered on the next
      // natural UI update (e.g., when text delta arrives or message finalizes).
      return block.durationMs;
    }
    return undefined;
  }

  /**
   * Mark a text block as complete (no longer streaming).
   * Called when content_block_stop is received for a text block.
   */
  markTextComplete(blockIndex: number): void {
    const block = this.streamingContentBlocks.get(blockIndex);
    if (block && block.type === StreamingContentBlockType.Text) {
      block.isStreaming = false;
      block.isComplete = true;

      // Sync to message content array so isStreaming: false propagates
      this.syncContentBlocksToMessage();

      // Trigger UI update now that text is complete
      this.scheduleReactUpdate('markTextComplete');
    }
  }

  updateThinkingBlock(
    thinkingContent: string,
    thinkingSignature?: string
  ): void {
    // Update the streaming content blocks (single source of truth)
    // Find existing thinking block or use index 0 for legacy single-block support
    let thinkingBlockIndex = -1;
    for (const [index, block] of this.streamingContentBlocks.entries()) {
      if (block.type === StreamingContentBlockType.Thinking) {
        thinkingBlockIndex = index;
        break;
      }
    }

    // If no thinking block exists in streaming blocks, create one at index 0
    // This maintains compatibility with legacy code that calls updateThinkingBlock directly
    if (thinkingBlockIndex === -1) {
      thinkingBlockIndex = 0;
      this.streamingContentBlocks.set(thinkingBlockIndex, {
        type: StreamingContentBlockType.Thinking,
        index: thinkingBlockIndex,
        content: thinkingContent,
        signature: thinkingSignature || '',
        isComplete: false,
        startedAtMs: Date.now(),
      });
    } else {
      // Update existing thinking block
      const block = this.streamingContentBlocks.get(thinkingBlockIndex)!;
      if (block.startedAtMs === undefined) {
        block.startedAtMs = Date.now();
      }
      block.content = thinkingContent;
      if (thinkingSignature) {
        block.signature = thinkingSignature;
      }
    }

    // Sync to message content array
    this.syncContentBlocksToMessage();
  }

  /**
   * Finalize all content blocks from streaming into the assistant message.
   * Called when streaming completes to update signatures and handle edge cases.
   * Uses the passed-in contentBlocks (from StreamingResult) which has correct
   * interleaved ordering including tool_use blocks.
   */
  finalizeContentBlocks(contentBlocks: StreamingContentBlock[]): void {
    const finalizedContentBlocks = contentBlocks.filter(
      (block): block is StreamingContentBlock => block != null
    );

    // Update signatures in our streaming blocks from the finalized blocks
    // and mark all thinking blocks as no longer streaming
    for (const block of finalizedContentBlocks) {
      if (block.type === StreamingContentBlockType.Thinking) {
        const existingBlock = this.streamingContentBlocks.get(block.index);
        if (
          existingBlock &&
          existingBlock.type === StreamingContentBlockType.Thinking
        ) {
          if (block.signature) {
            existingBlock.signature = block.signature;
          }
          if (block.signatureProvider) {
            existingBlock.signatureProvider = block.signatureProvider;
          }
          if (block.durationMs !== undefined) {
            existingBlock.durationMs = block.durationMs;
          } else if (existingBlock.durationMs === undefined) {
            const completedAtMs = Date.now();
            existingBlock.durationMs = Math.max(
              0,
              completedAtMs - (existingBlock.startedAtMs ?? completedAtMs)
            );
          }
          // Mark as no longer streaming - this will allow it to render
          existingBlock.isStreaming = false;
        }
      }
    }

    const lastMessage =
      this.conversationHistory[this.conversationHistory.length - 1];
    if (
      !lastMessage ||
      lastMessage.role !== 'assistant' ||
      !Array.isArray(lastMessage.content)
    ) {
      return;
    }

    // Extract tool uses from the existing in-memory message content
    // (addToolCall() puts them there with full input + thoughtSignature)
    const existingToolUses = lastMessage.content
      .filter((b) => b.type === MessageContentBlockType.ToolUse)
      .map((b) => {
        const tu = b as ToolUseBlock;
        return {
          id: tu.id,
          name: tu.name,
          input: tu.input as Record<string, unknown>,
          ...(tu.thoughtSignature && {
            thoughtSignature: tu.thoughtSignature,
          }),
        };
      });

    const newContent = convertStreamingBlocksToContentBlocks(
      finalizedContentBlocks,
      existingToolUses
    );

    if (newContent.length > 0) {
      lastMessage.content = newContent;
    }
  }

  finalizeAssistantMessage(
    openaiMessageId?: string,
    openaiPhase?: OpenAIPhase | null
  ): void {
    if (!this.currentAssistantMessage) return;

    this.currentAssistantMessage.isComplete = true;

    // Mark all streaming content blocks as complete
    // This ensures any blocks that didn't get an explicit content_block_stop
    // (e.g., in tests or edge cases) are still rendered
    for (const block of this.streamingContentBlocks.values()) {
      if (block.isStreaming) {
        block.isStreaming = false;
        block.isComplete = true;
        if (
          block.type === StreamingContentBlockType.Thinking &&
          block.durationMs === undefined
        ) {
          const completedAtMs = Date.now();
          block.durationMs = Math.max(
            0,
            completedAtMs - (block.startedAtMs ?? completedAtMs)
          );
        }
      }
    }
    this.syncContentBlocksToMessage();

    // Store OpenAI message ID and phase if provided
    if (openaiMessageId || openaiPhase !== undefined) {
      const lastMessage =
        this.conversationHistory[this.conversationHistory.length - 1];
      if (lastMessage && lastMessage.role === 'assistant') {
        if (openaiMessageId) {
          lastMessage.openaiMessageId = openaiMessageId;
        }
        if (openaiPhase !== undefined) {
          lastMessage.openaiPhase = openaiPhase;
        }
        logInfo(
          '[ConversationStateManager] Stored OpenAI message ID in assistant message'
        );
      }
    }

    // Create a single message with all tool results at once
    if (this.currentAssistantMessage.toolUses.length > 0) {
      const toolResults: ToolResultBlock[] =
        this.currentAssistantMessage.toolUses.map((toolUse) => ({
          type: MessageContentBlockType.ToolResult,
          toolUseId: toolUse.id,
          content: TOOL_RESULT_PENDING_MARKER,
        }));

      // Add single message with all tool results
      const toolMsgId = generateUUID();
      this.lastToolMessageId = toolMsgId;
      this.conversationHistory.push({
        id: toolMsgId,
        role: MessageRole.Tool,
        content: toolResults,
        visibility: MessageVisibility.Both,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Track pending results
      this.currentAssistantMessage.toolUses.forEach((toolUse) => {
        this.pendingToolResults.set(toolUse.id, {
          id: toolUse.id,
          content: TOOL_RESULT_PENDING_MARKER,
          isComplete: false,
        });
      });
    }

    // Trigger UI update for completed assistant message
    this.scheduleReactUpdate('finalizeAssistantMessage');

    this.currentAssistantMessage = null;
  }

  getLastToolMessageId(): string | null {
    return this.lastToolMessageId;
  }

  /**
   * Get the ID of the message currently being streamed.
   * Returns null if no message is being streamed.
   */
  getStreamingMessageId(): string | null {
    return this.currentAssistantMessage?.id ?? null;
  }

  addReasoningBlock(
    encryptedContent?: string,
    openaiReasoningId?: string,
    openaiReasoningSummary?: string
  ): void {
    if (!this.currentAssistantMessage) {
      this.startAssistantMessage();
      logInfo(
        '[ConversationStateManager] Creating new assistant message from reasoning block'
      );
    }

    // Find the last assistant message in conversation history
    const lastMessage =
      this.conversationHistory[this.conversationHistory.length - 1];

    if (lastMessage && lastMessage.role === 'assistant') {
      // Store the encrypted content in the assistant message
      // Only update fields that are provided (non-empty)
      if (encryptedContent) {
        lastMessage.openaiEncryptedContent = encryptedContent;
      }
      if (openaiReasoningId) {
        lastMessage.openaiReasoningId = openaiReasoningId;
      }

      // Store the reasoning summary if provided
      if (openaiReasoningSummary) {
        lastMessage.openaiReasoningSummary = openaiReasoningSummary;
      }
    }
  }

  addChatCompletionReasoning(
    reasoningField: ChatCompletionReasoningField,
    reasoningContent: string
  ): void {
    // Find the last assistant message in conversation history
    const lastMessage =
      this.conversationHistory[this.conversationHistory.length - 1];

    if (lastMessage && lastMessage.role === 'assistant') {
      // Store the reasoning field name and content in the assistant message
      lastMessage.chatCompletionReasoningField = reasoningField;
      lastMessage.chatCompletionReasoningContent = reasoningContent;
    }
  }

  updateToolResult(toolId: string, content: ToolResultContent): void {
    const pending = this.pendingToolResults.get(toolId);
    if (!pending) {
      return;
    }

    // Determine if this result represents an error
    const executionBeforeUpdate = this.toolExecutions.get(toolId);
    const isErrorResult =
      executionBeforeUpdate?.status === ToolCallStatus.Error;

    pending.content = content;
    pending.isComplete = true;

    // Update tool execution status
    const execution = this.toolExecutions.get(toolId);
    if (execution) {
      const newStatus = isErrorResult
        ? ToolCallStatus.Error
        : ToolCallStatus.Completed;

      this.toolExecutions.set(toolId, {
        ...execution,
        status: newStatus,
        result:
          typeof content === 'string'
            ? truncateToolResultStringPreview(
                content,
                MAX_TOOL_RESULT_PREVIEW_LENGTH
              )
            : content,
        endTime: Date.now(),
      });
    }

    // Find the message containing this specific tool result
    // Note: Full untruncated result is stored in conversationHistory
    for (const msg of this.conversationHistory) {
      if (msg.role === 'tool' && Array.isArray(msg.content)) {
        const toolBlock = msg.content.find(
          (block) =>
            block.type === 'tool_result' &&
            (block as ToolResultBlock).toolUseId === toolId
        ) as ToolResultBlock | undefined;

        if (toolBlock) {
          toolBlock.content = content;
          // Set isError flag so web app can display errors correctly
          if (isErrorResult) {
            toolBlock.isError = true;
          }
          break; // Found and updated, stop searching
        }
      }
    }

    this.pendingToolResults.delete(toolId);

    // Persist TODO state if this was a successful TodoWrite execution
    const updatedExecution = this.toolExecutions.get(toolId);
    if (!isErrorResult && updatedExecution?.name === 'TodoWrite') {
      try {
        const input = updatedExecution.input as TodoWriteToolParams;
        // Pass the tool_use ID so we can track which TodoWrite created the plan
        this.updateTodoState(input, toolId);
      } catch {
        // Ignore invalid TODO payloads – do not block normal flow
      }
    }

    // Prune old completed tool executions to prevent memory bloat
    this.pruneOldToolExecutions();

    // Trigger UI update for tool result
    this.scheduleReactUpdate('updateToolResult');
  }

  setToolError(toolId: string, error: string): void {
    const execution = this.toolExecutions.get(toolId);
    if (execution) {
      this.toolExecutions.set(toolId, {
        ...execution,
        status: ToolCallStatus.Error,
        error,
        endTime: Date.now(),
      });
    }

    // Update tool result with error
    this.updateToolResult(toolId, `${ERROR_PREFIX} ${error}`);
  }

  updateToolStatus(toolId: string, status: ToolCallStatus): void {
    const execution = this.toolExecutions.get(toolId);
    if (execution) {
      // Update startTime when marking as Executing
      const updatedExecution = {
        ...execution,
        status,
        ...(status === ToolCallStatus.Executing && { startTime: Date.now() }),
      };
      this.toolExecutions.set(toolId, updatedExecution);
    }

    // Trigger UI update
    this.scheduleReactUpdate('setToolError');
  }

  /**
   * Prune old completed tool executions to prevent memory bloat.
   * Keeps the most recent MAX_TOOL_EXECUTIONS entries, prioritizing
   * pending/executing tools over completed ones.
   */
  private pruneOldToolExecutions(): void {
    if (this.toolExecutions.size <= MAX_TOOL_EXECUTIONS) {
      return;
    }

    // Separate active (pending/executing) from completed tools
    const activeTools: Array<[string, ToolExecution]> = [];
    const completedTools: Array<[string, ToolExecution]> = [];

    for (const [id, exec] of this.toolExecutions) {
      if (
        exec.status === ToolCallStatus.Pending ||
        exec.status === ToolCallStatus.Executing
      ) {
        activeTools.push([id, exec]);
      } else {
        completedTools.push([id, exec]);
      }
    }

    // Sort completed tools by endTime (oldest first)
    completedTools.sort((a, b) => (a[1].endTime || 0) - (b[1].endTime || 0));

    // Calculate how many completed tools to remove
    const totalToKeep = MAX_TOOL_EXECUTIONS;
    const completedToKeep = Math.max(0, totalToKeep - activeTools.length);
    const toRemove = completedTools.slice(
      0,
      completedTools.length - completedToKeep
    );

    if (toRemove.length > 0) {
      logInfo('[ConversationStateManager] Pruning old tool executions', {
        count: this.toolExecutions.size,
        deletedCount: toRemove.length,
        // eslint-disable-next-line industry/no-nested-log-metadata -- active/completed tool counts consumed as a unit
        value: {
          active: activeTools.length,
          completed: completedTools.length,
        },
      });

      for (const [id] of toRemove) {
        this.toolExecutions.delete(id);
      }
    }
  }

  // Get all pending tool IDs that need results populated
  getPendingToolIds(): string[] {
    const pendingIds: string[] = [];

    // Check pendingToolResults for incomplete results
    for (const [toolId, result] of this.pendingToolResults) {
      if (!result.isComplete) {
        pendingIds.push(toolId);
      }
    }

    // Also check toolExecutions for tools that are pending or executing
    for (const [toolId, execution] of this.toolExecutions) {
      if (
        execution.status === ToolCallStatus.Pending ||
        execution.status === ToolCallStatus.Executing
      ) {
        // Only add if not already in the list
        if (!pendingIds.includes(toolId)) {
          pendingIds.push(toolId);
        }
      }
    }

    return pendingIds;
  }

  getCurrentTodos(): TodoWriteToolParams | null {
    return this.currentTodos;
  }

  /**
   * Get the tool_use ID of the current TodoWrite (identifies the plan).
   * Returns null if no plan exists.
   */
  getCurrentTodoWriteId(): string | null {
    return this.currentTodoWriteId;
  }

  /**
   * Get the ID of the current assistant message being processed.
   * Returns null if no assistant message is currently active.
   */
  getCurrentMessageId(): string | null {
    return this.currentAssistantMessage?.id || null;
  }

  getTodoStaleMessageCount(): number {
    const currentMessageCount = this.conversationHistory.filter(
      (msg) => msg.role === 'user' && shouldBeVisibleToUI(msg)
    ).length;
    return currentMessageCount - this.todoUpdateMessageIndex;
  }

  /**
   * Central handler for persisting TODO list updates.
   * @param todos The todo list parameters
   * @param toolUseId The tool_use ID of the TodoWrite call (used to identify the plan)
   */
  public updateTodoState(todos: TodoWriteToolParams, toolUseId?: string): void {
    this.currentTodos = todos;
    if (toolUseId) {
      this.currentTodoWriteId = toolUseId;
    }
    this.todoUpdateMessageIndex = this.conversationHistory.filter(
      (msg) => msg.role === 'user' && shouldBeVisibleToUI(msg)
    ).length;

    try {
      const sessionService = getSessionService();
      sessionService.appendTodoState(todos, this.todoUpdateMessageIndex);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to persist TODO state:', error);
    }

    this.scheduleReactUpdate('updateTodoState');
  }

  // Load TODO state from session
  loadTodoStateFromSession(): void {
    try {
      const sessionService = getSessionService();
      const todoState = sessionService.getLatestTodoState();
      if (todoState) {
        this.currentTodos = todoState.todos;
        this.todoUpdateMessageIndex = todoState.messageIndex;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load TODO state from session:', error);
      // Continue without TODO state - graceful degradation
    }
  }

  /**
   * Sets the UI render cutoff message ID.
   * Messages before this ID will be hidden from Static rendering.
   * @param messageId The ID of the first user message to render
   */
  setUiRenderCutoff(messageId: string | null): void {
    this.uiRenderCutoffMessageId = messageId;
    if (messageId) {
      logInfo('[ConversationStateManager] UI render cutoff set', {
        cutoffMessageId: messageId,
      });
    }
    this.scheduleReactUpdate('setUiRenderCutoff');
  }

  /**
   * Request a React re-render without changing any state.
   * Used by daemon mode where notification handlers update in-memory state
   * (e.g., appendAssistantText) but need a separate render trigger because
   * the in-process path handles rendering via messaging.ts setState calls.
   */
  requestRender(caller?: string): void {
    this.scheduleReactUpdate(caller ?? 'requestRender');
  }

  /**
   * Gets the current UI render cutoff message ID.
   */
  getUiRenderCutoff(): string | null {
    return this.uiRenderCutoffMessageId;
  }

  /**
   * Loads UI render cutoff from session's latest compaction summary.
   */
  async loadUiRenderCutoffFromSession(): Promise<void> {
    try {
      const sessionService = getSessionService();
      const latestSummary = await sessionService.loadLatestCompactionSummary();
      if (latestSummary?.uiRenderCutoffMessageId) {
        this.uiRenderCutoffMessageId = latestSummary.uiRenderCutoffMessageId;
        logInfo(
          '[ConversationStateManager] Loaded UI render cutoff from session',
          {
            cutoffMessageId: latestSummary.uiRenderCutoffMessageId,
          }
        );
        this.scheduleReactUpdate('loadUiRenderCutoffFromSession');
      }
    } catch (error) {
      logException(error, 'Failed to load UI render cutoff from session');
      // Continue without cutoff - graceful degradation
    }
  }
}

// Singleton instance
let instance: ConversationStateManager | null = null;

/**
 * Get the singleton ConversationStateManager instance.
 * Creates it on first access with a no-op callback.
 */
export function getConversationStateManager(): ConversationStateManager {
  if (!instance) {
    instance = new ConversationStateManager(() => {
      // No-op callback initially - will be set by React components
    });
  }
  return instance;
}
