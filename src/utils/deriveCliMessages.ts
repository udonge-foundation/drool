import {
  MessageContentBlockType,
  MessageVisibility,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo } from '@industry/logging';
import {
  getToolResultBlocks,
  getToolResultToolUseId,
  isPendingToolResult,
  isPendingToolResultMarker,
  isToolResultError,
  shouldBeVisibleToUI,
} from '@industry/utils/messages';

import { ERROR_PREFIX } from '@/constants/constants';
import { MessageRole, MessageType, ToolCallStatus } from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';
import { deriveVisibleTextHistoryMessages } from '@/utils/deriveVisibleTextHistoryMessages';
import { getTextContent } from '@/utils/tool-result-helpers';
import type { DeriveCliMessagesOptions } from '@/utils/types';

import type {
  IndustryDroolMessage,
  RuntimeContentBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

/**
 * Pure function that converts an array of `IndustryDroolMessage[]` into
 * `HistoryMessage[]` suitable for CLI rendering.
 *
 * This is extracted from `ConversationStateManager.deriveUIMessages()` with
 * the following simplifications:
 * - No `this` / singletons / ConversationStateManager state
 * - No `toolExecutions` map (tool status comes from SSM separately)
 * - No `initialRenderMode` (progressive loading handled by the hook)
 * - Handles `uiRenderCutoffMessageId` for compaction
 */
export function deriveCliMessages(
  messages: IndustryDroolMessage[],
  options?: DeriveCliMessagesOptions
): HistoryMessage[] {
  let result: HistoryMessage[] = [];

  // Pre-scan: collect tool results so we can set the correct status on
  // tool_use blocks. Without this, tool_use blocks always get Pending and
  // once Ink's <Static> freezes them, they shimmer forever.
  const completedToolResults = new Set<string>();
  const errorToolResults = new Set<string>();
  for (const msg of messages) {
    for (const tr of getToolResultBlocks(msg)) {
      const toolUseId = getToolResultToolUseId(tr);
      if (!toolUseId) {
        continue;
      }
      // Skip pending placeholders — they mean the tool hasn't executed yet
      if (isPendingToolResult(tr)) {
        continue;
      }
      const isError =
        isToolResultError(tr) ||
        (typeof tr.content === 'string' && tr.content.startsWith(ERROR_PREFIX));
      if (isError) {
        errorToolResults.add(toolUseId);
      } else {
        completedToolResults.add(toolUseId);
      }
    }
  }

  // Convert conversation history to UI messages, filtering by visibility
  messages
    .filter((msg) => shouldBeVisibleToUI(msg))
    .forEach((msg) => {
      const visibility = msg.visibility || MessageVisibility.Both;
      for (const toolResult of getToolResultBlocks(msg)) {
        const toolUseId = getToolResultToolUseId(toolResult);
        if (!toolUseId) {
          continue;
        }
        if (isPendingToolResultMarker(toolResult)) {
          continue;
        }
        result.push({
          id: msg.id,
          role: MessageRole.Tool,
          content: getTextContent(toolResult.content),
          messageType: MessageType.ToolResult,
          visibility,
          toolCallId: toolUseId,
          toolCallStatus: errorToolResults.has(toolUseId)
            ? ToolCallStatus.Error
            : undefined,
        });
      }

      if (msg.role === 'user' || msg.role === 'system') {
        result.push(...deriveVisibleTextHistoryMessages(msg));
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          result.push({
            id: msg.id,
            role: MessageRole.Assistant,
            content: msg.content,
            messageType: MessageType.Markdown,
            visibility: msg.visibility || MessageVisibility.Both,
          });
        } else if (Array.isArray(msg.content)) {
          // Handle legacy thinking content (older sessions before interleaved thinking)
          const hasThinkingInContent = msg.content.some(
            (b) =>
              b.type === MessageContentBlockType.Thinking ||
              b.type === MessageContentBlockType.RedactedThinking
          );
          if (!hasThinkingInContent) {
            if (msg.openaiReasoningSummary) {
              result.push({
                id: `${msg.id}-reasoning-legacy`,
                role: MessageRole.Assistant,
                content: msg.openaiReasoningSummary,
                messageType: MessageType.Thinking,
                visibility: msg.visibility || MessageVisibility.Both,
                thinkingBlock: {
                  type: 'thinking',
                  thinking: msg.openaiReasoningSummary,
                  signature: msg.openaiEncryptedContent
                    ? JSON.stringify({
                        reasoning_id: msg.openaiReasoningId,
                      })
                    : undefined,
                  index: 0,
                },
              });
            } else if (msg.chatCompletionReasoningContent) {
              result.push({
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
          let thinkingCounter = 0;
          let textCounter = 0;

          (msg.content as RuntimeContentBlock[]).forEach((block) => {
            if (block.type === MessageContentBlockType.Thinking) {
              // Skip thinking blocks that are still streaming.
              // They will render once the THINKING_TEXT_COMPLETE
              // notification marks isStreaming=false.
              if (block.isStreaming) {
                logInfo(
                  '[deriveCliMessages] Skipping streaming thinking block',
                  {
                    messageId: msg.id,
                    length: block.thinking?.length ?? 0,
                  }
                );
                return;
              }

              const thinkingIndex = thinkingCounter++;

              result.push({
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
            } else if (
              block.type === MessageContentBlockType.RedactedThinking
            ) {
              const thinkingIndex = thinkingCounter++;

              result.push({
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
            } else if (block.type === MessageContentBlockType.Text) {
              // Skip text blocks that are still streaming.
              // They will render once the ASSISTANT_TEXT_COMPLETE
              // notification marks isStreaming=false.
              if (block.isStreaming) {
                logInfo('[deriveCliMessages] Skipping streaming text block', {
                  messageId: msg.id,
                  length: block.text?.length ?? 0,
                });
                return;
              }

              // Skip empty text blocks
              if (!block.text || block.text.trim() === '') {
                return;
              }

              const textIndex = textCounter++;
              result.push({
                id: `${msg.id}-text-${textIndex}`,
                role: MessageRole.Assistant,
                content: block.text,
                messageType: MessageType.Markdown,
                visibility: msg.visibility || MessageVisibility.Both,
              });
            } else if (block.type === MessageContentBlockType.ToolUse) {
              let toolMessage = `Executing ${block.name}...`;

              if (block.name === 'Create') {
                const input = block.input as { file_path?: string };
                toolMessage = `Creating ${input.file_path || 'file'}...`;
              } else if (block.name === 'Read') {
                const input = block.input as { file_path?: string };
                toolMessage = `Reading ${input.file_path || 'file'}...`;
              } else if (block.name === 'Execute') {
                const input = block.input as { command?: string };
                toolMessage = `Executing: ${input.command || 'command'}...`;
              } else if (block.name === 'LS') {
                const input = block.input as { directory_path?: string };
                toolMessage = `Listing ${input.directory_path || 'directory'}...`;
              }

              const toolStatus = errorToolResults.has(block.id)
                ? ToolCallStatus.Error
                : completedToolResults.has(block.id)
                  ? ToolCallStatus.Completed
                  : ToolCallStatus.Pending;

              result.push({
                id: block.id,
                role: MessageRole.Tool,
                content: toolMessage,
                messageType: MessageType.ToolCall,
                visibility: msg.visibility || MessageVisibility.Both,
                toolCallStatus: toolStatus,
                toolCallId: block.id,
                toolName: block.name,
                toolInput: block.input,
              });
            }
          });
        }
      }
    });

  // Apply UI render cutoff if set (from compaction)
  const cutoffId = options?.uiRenderCutoffMessageId;
  if (cutoffId) {
    const cutoffIndex = result.findIndex((msg) => msg.id === cutoffId);
    if (cutoffIndex > 0) {
      const hiddenIndicator: HistoryMessage = {
        id: 'ui-render-cutoff-indicator',
        role: MessageRole.System,
        content: `Previous ${cutoffIndex} messages hidden`,
        messageType: MessageType.Text,
        visibility: MessageVisibility.UserOnly,
      };
      result = [hiddenIndicator, ...result.slice(cutoffIndex)];
    }
  }

  return result;
}
