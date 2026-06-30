import React from 'react';

import {
  ChatCompletionReasoningField,
  ReasoningEffort,
  OpenAIPhase,
} from '@industry/drool-sdk-ext/protocol/llm';
import {
  IndustryDroolMessage,
  IndustryDroolMessageWithCaching,
  TextBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo } from '@industry/logging';

import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { AgentStatusState } from '@/hooks/enums';
import { AgentState } from '@/hooks/types';
import { generateUUID } from '@/utils/uuid';

import type {
  StreamingContentBlock,
  StreamingResult,
} from '@industry/drool-core/llms/client/types';
import type { OutputFormat } from '@industry/drool-sdk-ext/protocol/drool';

interface DoSendParams {
  conversationHistory: IndustryDroolMessageWithCaching[];
  systemMessage: TextBlock[];
  sessionId: string;
  sendMessage: (params: {
    conversationHistory: IndustryDroolMessage[];
    systemMessage: TextBlock[];
    allowContextLimitS3Logging?: boolean;
    callbacks: {
      onRequestStream: () => void;
      onStreamingComplete: (
        result: StreamingResult,
        wasAborted?: boolean
      ) => void;
      onStreamingError: (error: Error) => void;
      onToolUseDetected?: (toolUse: {
        id: string;
        name: string;
        input: Record<string, unknown>;
        thoughtSignature?: string;
      }) => void;
      onMessageStart?: () => void;
      onReasoningEffortChange?: (
        from: ReasoningEffort,
        to: ReasoningEffort
      ) => void;
      onTextDelta?: (blockIndex: number, textChunk: string) => void;
      onToolInputDelta?: (
        id: string,
        partialInput: Record<string, unknown>
      ) => void;
      onMessageComplete?: () => void;
      onThinking?: () => void;
      onThinkingDelta?: (blockIndex: number, delta: string) => void;
      onContentBlockComplete?: (
        blockIndex: number,
        block: StreamingContentBlock
      ) => void;
      onEncryptedThinking?: (
        encryptedContent: string,
        openaiReasoningId: string
      ) => void;
      onProviderRotate?: (from: string, to: string) => void;
    };
    sessionId: string;
    assistantMessageId: string;
    modelId?: string;
    isSpecMode?: boolean;
    reasoningEffort?: ReasoningEffort;
    outputFormat?: OutputFormat;
  }) => Promise<StreamingResult>;
  setState: React.Dispatch<React.SetStateAction<AgentState>>;
  startAssistantMessage: (id?: string) => void;
  appendAssistantText: (blockIndex: number, textChunk: string) => void;
  updateToolCallInput: (
    id: string,
    partialInput: Record<string, unknown>
  ) => void;
  updateThinkingBlock: (
    thinkingContent: string,
    thinkingSignature?: string
  ) => void;
  appendThinkingDelta: (blockIndex: number, delta: string) => void;
  markThinkingComplete: (
    blockIndex: number,
    durationMs?: number
  ) => number | undefined;
  markTextComplete: (blockIndex: number) => void;
  finalizeAssistantMessage: (
    openaiMessageId?: string,
    openaiPhase?: OpenAIPhase | null
  ) => void;
  addToolCall: (
    id: string,
    name: string,
    input: Record<string, unknown>,
    thoughtSignature?: string
  ) => void;
  addReasoningBlock?: (
    encryptedContent?: string,
    openaiReasoningId?: string,
    openaiReasoningSummary?: string
  ) => void;
  addChatCompletionReasoning: (
    reasoningField: ChatCompletionReasoningField,
    reasoningContent: string
  ) => void;
  finalizeContentBlocks?: (contentBlocks: StreamingContentBlock[]) => void;
  // Controls whether context-limit errors should be logged to S3 at this stage
  // We disable logging before compaction and enable it for post-compaction retries
  allowContextLimitS3Logging?: boolean;
  clearUnfinishedToolCallInvocations: () => void;
  onReasoningEffortChange?: (
    from: ReasoningEffort,
    to: ReasoningEffort
  ) => void;
  // Locked model context for the entire agent turn
  modelId?: string;
  isSpecMode?: boolean;
  reasoningEffort?: ReasoningEffort;
  outputFormat?: OutputFormat;
}

interface DoSendCallbacks {
  onToolUseDetected?: (toolUse: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    thoughtSignature?: string;
  }) => void;
}

/**
 * Creates a doSend function for agent message streaming with all necessary callbacks.
 * This function handles the complex streaming state management and UI updates.
 */
export function createDoSendFunction({
  conversationHistory,
  systemMessage,
  sessionId,
  sendMessage,
  setState,
  startAssistantMessage,
  appendAssistantText,
  updateToolCallInput,
  updateThinkingBlock: _updateThinkingBlock,
  appendThinkingDelta,
  markThinkingComplete,
  markTextComplete,
  finalizeAssistantMessage,
  addToolCall,
  addChatCompletionReasoning,
  addReasoningBlock,
  finalizeContentBlocks,
  allowContextLimitS3Logging,
  clearUnfinishedToolCallInvocations,
  onReasoningEffortChange,
  modelId,
  isSpecMode,
  reasoningEffort,
  outputFormat,
}: DoSendParams) {
  const assistantMessageId = generateUUID();

  const doSend = async (
    additionalCallbacks?: DoSendCallbacks
  ): Promise<StreamingResult> =>
    await sendMessage({
      conversationHistory,
      systemMessage,
      allowContextLimitS3Logging,
      callbacks: {
        onRequestStream: () => {
          setState((prev) => ({
            ...prev,
            status: {
              ...prev.status,
              state: AgentStatusState.Thinking,
              toolUseCount: 0,
              invokingTools: false,
              retrying: false,
            },
          }));
          agentEventBus.emit(AgentEvent.StreamingStart, { sessionId });
        },
        onStreamingComplete: (result: StreamingResult) => {
          // NOTE: Don't call updateThinkingBlock here - thinking content is already
          // accumulated via appendThinkingDelta during streaming. The signature will be
          // added by finalizeContentBlocks below.

          // Update OpenAI reasoning summary if available
          // The encrypted content and ID were already stored via onEncryptedThinking during streaming
          // Now we need to add the summary which becomes available at the end
          if (result.openaiReasoningSummary && addReasoningBlock) {
            // Call addReasoningBlock with undefined for content/id (won't overwrite existing)
            // and the summary to update the existing reasoning block
            addReasoningBlock(
              undefined,
              undefined,
              result.openaiReasoningSummary
            );
          }
          if (
            result.chatCompletionReasoningContent &&
            result.chatCompletionReasoningField &&
            addChatCompletionReasoning
          ) {
            addChatCompletionReasoning(
              result.chatCompletionReasoningField,
              result.chatCompletionReasoningContent
            );
          }

          // Finalize content blocks for interleaved thinking support
          if (result.contentBlocks && finalizeContentBlocks) {
            finalizeContentBlocks(result.contentBlocks);
          }

          // Finalize the assistant message with OpenAI message ID and phase if available
          finalizeAssistantMessage(result.openaiMessageId, result.openaiPhase);
          // Note: Tool cancellation errors are handled by stopAgent() to avoid duplication

          agentEventBus.emit(AgentEvent.StreamingComplete, { sessionId });
        },
        onStreamingError: (error: Error) => {
          throw error;
        },
        // New streaming state callbacks
        onMessageStart: () => {
          startAssistantMessage(assistantMessageId);
          // Note: onStreamingStart was already called in onRequestStream
        },
        onTextDelta: (blockIndex: number, textChunk: string) => {
          setState((prev) => {
            if (prev.status.state !== AgentStatusState.Streaming) {
              return {
                ...prev,
                status: {
                  ...prev.status,
                  state: AgentStatusState.Streaming,
                  retrying: false,
                },
              };
            }
            // Clear retrying flag once we get any text delta from the new attempt
            if (prev.status.retrying) {
              return {
                ...prev,
                status: {
                  ...prev.status,
                  retrying: false,
                },
              };
            }
            return prev;
          });
          appendAssistantText(blockIndex, textChunk);
          agentEventBus.emit(AgentEvent.AssistantTextDelta, {
            messageId: assistantMessageId,
            blockIndex,
            textDelta: textChunk,
            sessionId,
          });
        },
        onToolInputDelta: (
          id: string,
          partialInput: Record<string, unknown>
        ) => {
          updateToolCallInput(id, partialInput);
          // Mark that the model is actively constructing tool invocations
          setState((prev) => ({
            ...prev,
            status: {
              ...prev.status,
              state: AgentStatusState.Streaming,
              retrying: false,
              invokingTools: true,
            },
          }));
          agentEventBus.emit(AgentEvent.ToolCallProgress, {
            id,
            partialInput,
            sessionId,
          });
        },
        onMessageComplete: () => {
          agentEventBus.emit(AgentEvent.ToolInputComplete, { sessionId });

          // Message finalization is now handled in onStreamingComplete
        },
        onThinking: () => {
          setState((prev) => {
            if (prev.status.state !== AgentStatusState.Thinking) {
              return {
                ...prev,
                status: {
                  ...prev.status,
                  state: AgentStatusState.Thinking,
                  retrying: false,
                },
              };
            }
            if (prev.status.retrying) {
              return {
                ...prev,
                status: {
                  ...prev.status,
                  retrying: false,
                },
              };
            }
            return prev;
          });
        },
        onThinkingDelta: (blockIndex: number, delta: string) => {
          // Append thinking delta progressively during streaming
          // This ensures thinking appears in UI before text/tools
          appendThinkingDelta(blockIndex, delta);
          agentEventBus.emit(AgentEvent.ThinkingTextDelta, {
            messageId: assistantMessageId,
            blockIndex,
            textDelta: delta,
            sessionId,
          });
        },
        onContentBlockComplete: (blockIndex: number, block) => {
          // When a content block completes streaming, mark it so it renders
          if (block.type === 'thinking') {
            const durationMs = markThinkingComplete(
              blockIndex,
              block.durationMs
            );
            agentEventBus.emit(AgentEvent.ThinkingBlockComplete, {
              messageId: assistantMessageId,
              blockIndex,
              sessionId,
              durationMs,
            });
          } else if (block.type === 'text') {
            markTextComplete(blockIndex);
            agentEventBus.emit(AgentEvent.TextBlockComplete, {
              messageId: assistantMessageId,
              blockIndex,
              sessionId,
            });
          }
        },
        onEncryptedThinking: (
          encryptedContent: string,
          openaiReasoningId: string
        ) => {
          // Store encrypted reasoning content with the assistant message
          if (addReasoningBlock) {
            addReasoningBlock(encryptedContent, openaiReasoningId);
          } else {
            logInfo('[createDoSendFunction] addReasoningBlock not provided!');
          }
        },

        // Invoked when Anthropic provider rotation happens between retries
        onProviderRotate: (_from: string, _to: string) => {
          // TODO: we don't clear thinking / text, so the UI state may be inconsistent. doesn't affect LLM outputs.
          clearUnfinishedToolCallInvocations();
          setState((prev) => ({
            ...prev,
            status: {
              ...prev.status,
              invokingTools: false,
              toolUseCount: 0,
              retrying: true,
            },
          }));
        },
        onReasoningEffortChange,

        onToolUseDetected: (toolUse: {
          id: string;
          name: string;
          input: Record<string, unknown>;
          thoughtSignature?: string;
        }) => {
          // Add to UI immediately for streaming state management
          addToolCall(
            toolUse.id,
            toolUse.name,
            toolUse.input,
            toolUse.thoughtSignature
          );
          // Increment tool use count during streaming
          setState((prev) => ({
            ...prev,
            status: {
              ...prev.status,
              state: AgentStatusState.Streaming,
              invokingTools: true,
              toolUseCount: (prev.status.toolUseCount ?? 0) + 1,
            },
          }));

          agentEventBus.emit(AgentEvent.ToolCallStart, {
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
            sessionId,
          });

          // Call additional callback if provided
          if (additionalCallbacks?.onToolUseDetected) {
            additionalCallbacks.onToolUseDetected(toolUse);
          }
        },
      },
      sessionId,
      assistantMessageId,
      modelId,
      isSpecMode,
      reasoningEffort,
      outputFormat,
    });

  return { doSend, assistantMessageId };
}
