import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import {
  ChatCompletionReasoningField,
  ModelProvider,
  OpenAIPhase,
} from '@industry/drool-sdk-ext/protocol/llm';
import { logError, logInfo, logWarn } from '@industry/logging';
import { approxTokensFromChars } from '@industry/utils/llm';

import { StreamingContentBlockType } from './enums';
import { parseOptimisticJson } from './optimistic-json-parser';
import { sanitizeToolCallId } from './tool-call-ids';
import { LanguageModelFinishReason } from '../../streaming/enums';
import { LLMEmptyResponseError } from '../errors/errors';
import { mapAnthropicFinishReason } from '../provider/anthropic/stop-reason';
import { mapGeminiFinishReason } from '../provider/google/finish-reason';
import { normalizeApplyPatchToolName } from '../provider/openai/apply-patch-interop';
import { throwMappedOpenAIResponseFailedChunkError } from '../provider/openai/error-handling';
import { mapOpenaiFinishReason } from '../provider/openai/finish-reason';

import type {
  ChunkProcessingOptions,
  EmptyResponseRetryState,
  ExtendedChatCompletionDelta,
  OptimisticParseResult,
  StreamingCallbacks,
  StreamingContentBlock,
  StreamingState,
  ToolCallInfo,
} from './types';
import type { GenerateContentResponse } from '@google/genai';

/** Wire shape of Anthropic `message_delta.delta.stop_details`. */
interface AnthropicStopDetails {
  type: string;
  category?: string | null;
  explanation?: string | null;
}

/**
 * Generate a unique tool call ID for Gemini
 * Gemini reuses tool call IDs (e.g., uses tool name as ID), so we generate our own unique IDs
 */
function generateToolCallId(): string {
  return `tc-${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Responses providers can emit per-turn positional ids (`call_0`, `call_1`);
 * remap only that shape so replay history stays unique while added/done events remain stable.
 */
function resolveResponsesToolCallId(
  state: StreamingState,
  rawCallId: string
): string {
  if (!/^call_\d+$/.test(rawCallId)) {
    return rawCallId;
  }
  state.responsesToolCallIdMap ??= {};
  const existing = state.responsesToolCallIdMap[rawCallId];
  if (existing) {
    return existing;
  }
  const generated = generateToolCallId();
  state.responsesToolCallIdMap[rawCallId] = generated;
  return generated;
}

/**
 * Creates initial streaming state.
 */
export function createInitialStreamingState(
  modelProvider?: ModelProvider
): StreamingState {
  return {
    streamingContent: '',
    toolUses: [],
    toolInputBuffers: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      thinkingTokens: 0,
    },
    openaiMessageId: undefined,
    openaiPhase: undefined,
    openaiReasoningId: undefined,
    openaiEncryptedContent: undefined,
    finalStreamingContent: undefined,
    thinkingContent: undefined,
    thinkingSignature: undefined,
    // Index-based content block tracking for interleaved thinking
    contentBlocks: [],
    modelProvider,
  };
}

export function startThinkingDuration(block: StreamingContentBlock): void {
  if (
    block.type === StreamingContentBlockType.Thinking &&
    block.startedAtMs === undefined
  ) {
    block.startedAtMs = Date.now();
  }
}

function completeThinkingDuration(block: StreamingContentBlock): void {
  if (
    block.type !== StreamingContentBlockType.Thinking ||
    block.durationMs !== undefined
  ) {
    return;
  }

  const nowMs = Date.now();
  block.durationMs = Math.max(0, nowMs - (block.startedAtMs ?? nowMs));
}

export function completeContentBlock(
  block: StreamingContentBlock,
  callbacks: StreamingCallbacks
): void {
  completeThinkingDuration(block);
  block.isComplete = true;
  callbacks.onContentBlockComplete?.(block.index, block);
}

function appendOpenAIReasoningDelta({
  state,
  callbacks,
  outputIndex,
  delta,
}: {
  state: StreamingState;
  callbacks: StreamingCallbacks;
  outputIndex: number;
  delta: string;
}): void {
  const thinkingBlock = state.contentBlocks[outputIndex];
  if (thinkingBlock?.type === StreamingContentBlockType.Thinking) {
    startThinkingDuration(thinkingBlock);
    thinkingBlock.content += delta;
    callbacks.onThinkingDelta?.(outputIndex, delta);
  }

  if (!state.openaiReasoningSummary) {
    state.openaiReasoningSummary = '';
  }
  state.openaiReasoningSummary += delta;

  const deltaTokens = approxTokensFromChars(delta.length);
  state.usage.thinkingTokens = (state.usage.thinkingTokens || 0) + deltaTokens;
  callbacks.onThinking?.();
}

function stampGeminiThoughtSignatureOnThinkingBlocks(
  state: StreamingState,
  thoughtSignature: string
): void {
  for (const block of state.contentBlocks) {
    if (
      block.type === StreamingContentBlockType.Thinking &&
      block.signatureProvider === ModelProvider.GOOGLE &&
      !block.signature?.trim()
    ) {
      block.signature = thoughtSignature;
    }
  }
}

function completeLatestIncompleteContentBlock(
  state: StreamingState,
  callbacks: StreamingCallbacks
): void {
  const block = state.contentBlocks.findLast(
    (contentBlock) => !contentBlock.isComplete
  );
  if (block) {
    completeContentBlock(block, callbacks);
  }
}

function getNonEmptyCustomToolInput(
  input: Record<string, unknown> | undefined
): string | undefined {
  const value = input?.input;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getPreferredCustomToolInput({
  directInput,
  bufferedInput,
  existingInput,
}: {
  directInput?: string;
  bufferedInput?: string;
  existingInput?: string;
}): string | undefined {
  return [directInput, bufferedInput, existingInput].find(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
}

function toCustomToolInput(input: string | undefined): Record<string, unknown> {
  return input ? { input } : {};
}

function extractTextBlocks(
  blocks: unknown,
  type: string,
  { requireNonEmpty = false }: { requireNonEmpty?: boolean } = {}
): string | undefined {
  if (!Array.isArray(blocks)) {
    return undefined;
  }

  const texts: string[] = [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) {
      continue;
    }
    const { type: blockType, text } = block as { type?: string; text?: string };
    if (
      blockType === type &&
      typeof text === 'string' &&
      (!requireNonEmpty || text.length > 0)
    ) {
      texts.push(text);
    }
  }
  return texts.length > 0 ? texts.join('\n') : undefined;
}

// Partial-string value keys per tool. ExitSpecMode excludes `plan` because
// streaming the long body causes flicker on large specs.
const TOOL_PARTIAL_STRING_VALUE_KEYS: Record<string, readonly string[]> = {
  ExitSpecMode: ['title'],
};

// Return the first non-empty line of a partial `"plan":"..."` JSON value so
// the ExitSpecMode header can show a title while `plan` streams in before
// `title`. Handles just enough JSON escape semantics (`\n`/`\r` break the
// line, `\"`/`\\`/`\/`/`\t` are single chars) to avoid pulling in a full
// parser.
function extractPartialPlanTitleHint(buffer: string): string | undefined {
  const match = buffer.match(/"plan"\s*:\s*"/);
  if (!match || match.index === undefined) {
    return undefined;
  }
  let pos = match.index + match[0].length;
  let hint = '';
  let hasStartedHint = false;
  while (pos < buffer.length) {
    const ch = buffer[pos];
    if (ch === '\\' && pos + 1 < buffer.length) {
      const next = buffer[pos + 1];
      if (next === 'n' || next === 'r') {
        if (!hasStartedHint) {
          pos += 2;
          continue;
        }
        break;
      }
      let value: string;
      if (next === '"' || next === '\\' || next === '/') {
        value = next;
      } else if (next === 't') {
        value = '\t';
      } else {
        value = next;
      }
      if (!hasStartedHint && /\s/.test(value)) {
        pos += 2;
        continue;
      }
      hasStartedHint = true;
      hint += value;
      pos += 2;
      continue;
    }
    if (ch === '"') {
      break;
    }
    if (!hasStartedHint && /\s/.test(ch)) {
      pos++;
      continue;
    }
    hasStartedHint = true;
    hint += ch;
    pos++;
  }
  // Strip markdown wrappers to match ExitSpecModeTool.getPlanTitle output.
  const cleaned = hint
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^(?:plan|specification|spec)\s*:\s*/i, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^__(.+)__$/, '$1')
    .replace(/^`(.+)`$/, '$1')
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function parseOptimisticToolInput(
  rawInput: string,
  toolName: string | undefined
): OptimisticParseResult {
  const result = parseOptimisticJson(rawInput, {
    includeIncompleteStringValueKeys: toolName
      ? TOOL_PARTIAL_STRING_VALUE_KEYS[toolName]
      : undefined,
  });

  // Display-only fallback: only applied before either `title` or `plan`
  // surface from the real parse.
  if (
    toolName === 'ExitSpecMode' &&
    !('title' in result.data) &&
    !('plan' in result.data)
  ) {
    const hint = extractPartialPlanTitleHint(rawInput);
    if (hint) {
      result.data = { ...result.data, title: hint };
    }
  }

  return result;
}

/**
 * Call onToolInputDelta only when the parsed data has actually changed
 * since the last emission for this tool index.
 */
export function emitToolInputDeltaIfChanged(params: {
  state: StreamingState;
  index: number;
  toolId: string;
  data: Record<string, unknown>;
  callbacks: StreamingCallbacks;
}): void {
  const { state, index, toolId, data, callbacks } = params;
  const serialized = JSON.stringify(data);
  if (!state.lastEmittedToolInput) {
    state.lastEmittedToolInput = {};
  }
  if (state.lastEmittedToolInput[index] === serialized) {
    return;
  }
  state.lastEmittedToolInput[index] = serialized;
  callbacks.onToolInputDelta?.(toolId, data);
}

export function hasStreamingTextOrToolUse(state: StreamingState): boolean {
  return (
    state.streamingContent.length > 0 || state.toolUses.some((t) => t !== null)
  );
}

export function getStreamingThinkingOrReasoningContent(
  state: StreamingState
): string | undefined {
  return (
    state.thinkingContent ??
    state.openaiReasoningSummary ??
    state.chatCompletionReasoningContent
  );
}

/**
 * Determines whether an empty streaming response should be treated as a retryable error.
 *
 * Returns true when the response contained no text, tool calls, thinking content,
 * or provider-specific reasoning AND was not intentionally ended by the model.
 * When the model sends a stop reason (e.g. end_turn) with no content, it intentionally
 * produced an empty turn — this is valid, not an error.
 *
 * A truly empty response (no stop reason, no content) typically indicates a transient
 * API issue such as rate limiting or a dropped connection.
 */
export function isEmptyResponseError(
  state: StreamingState,
  aborted: boolean
): boolean {
  if (aborted) return false;

  const hasThinkingOrReasoning =
    !!getStreamingThinkingOrReasoningContent(state);

  if (hasStreamingTextOrToolUse(state) || hasThinkingOrReasoning) return false;

  // Model intentionally ended with no content — valid empty turn, not an error
  if (state.stopReason) return false;

  return true;
}

/**
 * Processes an Anthropic streaming chunk and updates state.
 * @param event - The Anthropic message stream event
 * @param state - The streaming state (will be mutated)
 * @param callbacks - Callbacks for streaming events
 */
export function processAnthropicChunk(
  event: Anthropic.MessageStreamEvent,
  state: StreamingState,
  callbacks: StreamingCallbacks,
  options: ChunkProcessingOptions = {}
): void {
  switch (event.type) {
    case 'message_start': {
      // Guard against missing message/usage from custom model proxies
      const messageUsage = event.message?.usage;
      if (!messageUsage) break;
      state.usage.inputTokens = messageUsage.input_tokens ?? 0;
      state.usage.cacheCreationInputTokens =
        messageUsage.cache_creation_input_tokens || 0;
      state.usage.cacheReadInputTokens =
        messageUsage.cache_read_input_tokens || 0;

      // Don't update session totals yet - wait for message_stop to ensure
      // we only count tokens from successful streams (no failed retries)
      break;
    }

    case 'content_block_start': {
      const blockIndex = event.index;

      // Guard against missing content_block from custom model proxies
      if (!event.content_block) break;

      if (event.content_block.type === 'tool_use') {
        // Pad with null so the tool call sits at the correct content-block index.
        while (state.toolUses.length <= blockIndex) {
          state.toolUses.push(null);
        }

        state.toolUses[blockIndex] = {
          id: event.content_block.id,
          name: event.content_block.name,
          input: event.content_block.input as Record<string, unknown>,
        };

        // Track in contentBlocks for interleaved thinking support
        state.contentBlocks[blockIndex] = {
          type: StreamingContentBlockType.ToolUse,
          index: blockIndex,
          content: '',
          toolUseId: event.content_block.id,
          toolName: event.content_block.name,
          isComplete: false,
        };

        // Notify about tool use detection immediately
        if (callbacks.onToolUseDetected) {
          callbacks.onToolUseDetected({
            id: event.content_block.id,
            name: event.content_block.name,
            input: event.content_block.input as Record<string, unknown>,
          });
        }
      } else if (event.content_block.type === 'thinking') {
        // Track thinking block for interleaved thinking support
        state.contentBlocks[blockIndex] = {
          type: StreamingContentBlockType.Thinking,
          index: blockIndex,
          content: '',
          signature: '',
          signatureProvider: ModelProvider.ANTHROPIC,
          isComplete: false,
        };
        callbacks.onThinkingBlockStart?.(blockIndex);
        callbacks.onThinking?.();
      } else if (event.content_block.type === 'redacted_thinking') {
        // Handle redacted thinking (safety system triggered)
        const redactedBlock = event.content_block as { data?: string };
        state.contentBlocks[blockIndex] = {
          type: StreamingContentBlockType.RedactedThinking,
          index: blockIndex,
          content: '',
          data: redactedBlock.data || '',
          isComplete: false,
        };
        callbacks.onRedactedThinkingBlock?.(
          blockIndex,
          redactedBlock.data || ''
        );
      } else if (event.content_block.type === 'text') {
        // Track text block for interleaved thinking support
        state.contentBlocks[blockIndex] = {
          type: StreamingContentBlockType.Text,
          index: blockIndex,
          content: '',
          isComplete: false,
        };
      }
      break;
    }

    case 'content_block_delta': {
      const blockIndex = event.index;
      const block = state.contentBlocks[blockIndex];

      // Guard against missing delta from custom model proxies
      if (!event.delta) break;

      if (event.delta.type === 'text_delta') {
        state.streamingContent += event.delta.text;

        // Update indexed content block
        if (block?.type === StreamingContentBlockType.Text) {
          block.content += event.delta.text;
        }

        // Notify streaming state manager with block index
        if (callbacks.onTextDelta) {
          callbacks.onTextDelta(blockIndex, event.delta.text);
        }
      } else if (event.delta.type === 'thinking_delta') {
        const thinkingDelta = event.delta.thinking ?? '';
        if (thinkingDelta) {
          // Update indexed content block
          if (block?.type === StreamingContentBlockType.Thinking) {
            startThinkingDuration(block);
            block.content += thinkingDelta;
            callbacks.onThinkingDelta?.(blockIndex, thinkingDelta);
          }

          // Keep legacy accumulation for backward compatibility
          if (!state.thinkingContent) {
            state.thinkingContent = '';
          }
          state.thinkingContent += thinkingDelta;

          const deltaTokens = approxTokensFromChars(thinkingDelta.length);
          state.usage.thinkingTokens =
            (state.usage.thinkingTokens || 0) + deltaTokens;
          callbacks.onThinking?.();
        }
      } else if (event.delta.type === 'signature_delta') {
        // Accumulate signature for thinking block
        const signatureDelta =
          (event.delta as { signature?: string }).signature ?? '';
        if (signatureDelta) {
          // Update indexed content block. `signatureProvider` distinguishes
          // real Anthropic (cryptographically verifiable) from Fireworks-
          // Anthropic-compat routes (signature empty / unverifiable, must
          // be downgraded before forwarding to real Anthropic).
          if (block?.type === StreamingContentBlockType.Thinking) {
            block.signature = (block.signature || '') + signatureDelta;
            block.signatureProvider =
              state.modelProvider ?? ModelProvider.ANTHROPIC;
          }

          // Keep legacy accumulation for backward compatibility
          if (!state.thinkingSignature) {
            state.thinkingSignature = '';
          }
          state.thinkingSignature += signatureDelta;
        }
      } else if (
        event.delta.type === 'input_json_delta' &&
        event.index !== undefined
      ) {
        // Accumulate the partial JSON string
        if (!state.toolInputBuffers[event.index]) {
          state.toolInputBuffers[event.index] = '';
        }
        const partialJson = event.delta.partial_json || '';
        state.toolInputBuffers[event.index] += partialJson;

        // Try to parse partial input and notify streaming state manager
        if (callbacks.onToolInputDelta && partialJson) {
          const toolUse = state.toolUses[event.index];
          if (toolUse && toolUse.id) {
            // Parse the accumulated JSON optimistically
            const parseResult = parseOptimisticToolInput(
              state.toolInputBuffers[event.index],
              toolUse.name
            );

            // Only send updates if we have some meaningful data
            if (Object.keys(parseResult.data).length > 0) {
              emitToolInputDeltaIfChanged({
                state,
                index: event.index,
                toolId: toolUse.id,
                data: parseResult.data,
                callbacks,
              });
            }
          }
        }
      }
      break;
    }

    case 'content_block_stop': {
      // Mark content block as complete
      const stopBlockIndex = event.index;
      const stopBlock = state.contentBlocks[stopBlockIndex];
      if (stopBlock) {
        completeContentBlock(stopBlock, callbacks);
      }
      break;
    }

    case 'message_delta': {
      if (event.usage) {
        // Store the token count in state but don't trigger update callback during streaming
        // This prevents excessive re-renders
        if (typeof event.usage.input_tokens === 'number') {
          state.usage.inputTokens = event.usage.input_tokens;
        }
        if (typeof event.usage.cache_creation_input_tokens === 'number') {
          state.usage.cacheCreationInputTokens =
            event.usage.cache_creation_input_tokens;
        }
        if (typeof event.usage.cache_read_input_tokens === 'number') {
          state.usage.cacheReadInputTokens =
            event.usage.cache_read_input_tokens;
        }
        state.usage.outputTokens = event.usage.output_tokens;
        // Note: thinking_tokens are tracked via thinking_delta events, not here
      }
      if (event.delta?.stop_reason) {
        state.stopReason = mapAnthropicFinishReason(event.delta.stop_reason);
      }
      // The installed Anthropic SDK does not type `stop_details` yet; it is
      // surfaced on refusals (Opus 4.7+ / Fable) with a classifier category
      // such as `reasoning_extraction`, `cyber`, or `bio`.
      const stopDetails = (
        event.delta as { stop_details?: AnthropicStopDetails | null }
      )?.stop_details;
      if (stopDetails) {
        state.stopDetails = {
          type: stopDetails.type,
          ...(stopDetails.category ? { category: stopDetails.category } : {}),
          ...(stopDetails.explanation
            ? { explanation: stopDetails.explanation }
            : {}),
        };
      }
      break;
    }

    case 'message_stop': {
      state.finalStreamingContent = state.streamingContent;

      // Send COMPLETE token count update when streaming succeeds
      // This includes input tokens from message_start, ensuring we only
      // count tokens from successful streams (no failed retries)
      options.onTokenUsage?.(
        {
          inputTokens: state.usage.inputTokens,
          outputTokens: state.usage.outputTokens,
          cacheCreationTokens: state.usage.cacheCreationInputTokens,
          cacheReadTokens: state.usage.cacheReadInputTokens,
          ...(state.usage.thinkingTokens !== undefined && {
            thinkingTokens: state.usage.thinkingTokens,
          }),
        },
        false
      );

      // Notify streaming state manager
      if (callbacks.onMessageComplete) {
        callbacks.onMessageComplete();
      }
      break;
    }

    default:
      // Ignore other event types
      break;
  }
}

/**
 * Processes an OpenAI streaming chunk and updates state
 * @param chunk - The OpenAI response chunk
 * @param state - The streaming state (will be mutated)
 * @param toolCalls - Tool call tracking for OpenAI
 * @param callbacks - Callbacks for streaming events
 */

export function processOpenAIChunk(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chunk: any, // OpenAI ResponseStreamEvent type is complex and not exported
  state: StreamingState,
  toolCalls: Record<number, ToolCallInfo | undefined>,
  callbacks: StreamingCallbacks,
  options: ChunkProcessingOptions = {}
): void {
  switch (chunk.type) {
    case 'response.created': {
      // Sometimes the initial response includes output with message IDs
      if (chunk.response && chunk.response.output) {
        const messageOutput = chunk.response.output.find(
          (item: { type?: string; id?: string }) =>
            item.type === 'message' && item.id
        );
        if (messageOutput && !state.openaiMessageId) {
          state.openaiMessageId = messageOutput.id;
        }
      }
      break;
    }

    case 'response.output_item.added': {
      const item = chunk.item;
      // Guard against missing item from custom model proxies
      if (!item) break;
      // Capture message ID if this is a message item
      if (item.type === 'message' && 'id' in item && item.id) {
        state.openaiMessageId = item.id;
        // Track text block in contentBlocks for unified content ordering
        state.contentBlocks[chunk.output_index] = {
          type: StreamingContentBlockType.Text,
          index: chunk.output_index,
          content: '',
          isComplete: false,
        };
      } else if (item.type === ChatCompletionReasoningField.Reasoning) {
        // Create thinking block for reasoning item (OpenAI Responses API)
        // Use output_index for proper interleaved content ordering
        state.contentBlocks[chunk.output_index] = {
          type: StreamingContentBlockType.Thinking,
          index: chunk.output_index,
          content: '',
          signatureProvider: ModelProvider.OPENAI,
          isComplete: false,
        };
        callbacks.onThinkingBlockStart?.(chunk.output_index);
        callbacks.onThinking?.();
      } else if (item.type === 'function_call') {
        // Track tool call for parameter streaming
        const toolUseId = resolveResponsesToolCallId(state, item.call_id);
        toolCalls[chunk.output_index] = {
          id: toolUseId,
          name: item.name,
          arguments: item.arguments,
        };

        // Pad with null so the tool call sits at the correct output index.
        while (state.toolUses.length <= chunk.output_index) {
          state.toolUses.push(null);
        }

        state.toolUses[chunk.output_index] = {
          id: toolUseId,
          name: item.name,
          input: {}, // Will be populated as parameters stream
        };

        // Track in contentBlocks for unified content ordering
        state.contentBlocks[chunk.output_index] = {
          type: StreamingContentBlockType.ToolUse,
          index: chunk.output_index,
          content: '',
          toolUseId,
          toolName: item.name,
          isComplete: false,
        };

        // Notify about tool use detection
        if (callbacks.onToolUseDetected) {
          callbacks.onToolUseDetected({
            id: toolUseId,
            name: item.name,
            input: {}, // Parameters will stream separately
          });
        }
      } else if (item.type === 'custom_tool_call') {
        const normalizedToolName = normalizeApplyPatchToolName(item.name);
        const toolUseId = resolveResponsesToolCallId(state, item.call_id);
        const initialInputValue = getPreferredCustomToolInput({
          directInput: item.input,
          bufferedInput: state.toolInputBuffers[chunk.output_index],
          existingInput: getNonEmptyCustomToolInput(
            state.toolUses[chunk.output_index]?.input
          ),
        });
        const initialInput = toCustomToolInput(initialInputValue);
        if (initialInputValue) {
          state.toolInputBuffers[chunk.output_index] = initialInputValue;
        }

        toolCalls[chunk.output_index] = {
          id: toolUseId,
          name: normalizedToolName,
          arguments: JSON.stringify({
            input: initialInputValue ?? item.input ?? '',
          }),
        };

        while (state.toolUses.length <= chunk.output_index) {
          state.toolUses.push(null);
        }

        state.toolUses[chunk.output_index] = {
          id: toolUseId,
          name: normalizedToolName,
          input: initialInput,
        };

        state.contentBlocks[chunk.output_index] = {
          type: StreamingContentBlockType.ToolUse,
          index: chunk.output_index,
          content: '',
          toolUseId,
          toolName: normalizedToolName,
          isComplete: false,
        };

        callbacks.onToolUseDetected?.({
          id: toolUseId,
          name: normalizedToolName,
          input: initialInput,
        });
      }
      break;
    }

    case 'response.output_item.done': {
      const item = chunk.item;
      // Guard against missing item from custom model proxies
      if (!item) break;

      // Capture message ID and phase if this is a message item
      if (item.type === 'message' && 'id' in item && item.id) {
        // Set message ID if not already set by output_item.added
        if (!state.openaiMessageId) {
          state.openaiMessageId = item.id;
        }
        // Capture phase from gpt-5.3-codex+ (not yet in SDK types).
        // Phase is only available on the done event, not on added.
        const phase = (item as Record<string, unknown>).phase as
          | OpenAIPhase
          | null
          | undefined;
        if (phase !== undefined) {
          state.openaiPhase = phase;
        }
        // Mark text block as complete
        const textBlock = state.contentBlocks[chunk.output_index];
        if (textBlock?.type === StreamingContentBlockType.Text) {
          textBlock.isComplete = true;
          callbacks.onContentBlockComplete?.(chunk.output_index, textBlock);
        }
      } else if (item.type === ChatCompletionReasoningField.Reasoning) {
        // Find the thinking block by output_index and mark as complete
        const thinkingBlock = state.contentBlocks[chunk.output_index];
        if (thinkingBlock?.type === StreamingContentBlockType.Thinking) {
          // Store serialized item as signature for restoration in multi-turn conversations
          thinkingBlock.signature = JSON.stringify(item);
          thinkingBlock.signatureProvider = ModelProvider.OPENAI;
          completeContentBlock(thinkingBlock, callbacks);
        }

        // Store reasoning ID and encrypted content (legacy)
        state.openaiReasoningId = item.id;
        state.openaiEncryptedContent = item.encrypted_content;

        if (!state.openaiReasoningSummary) {
          state.openaiReasoningSummary =
            extractTextBlocks(item.summary, 'summary_text') ||
            extractTextBlocks(item.content, 'reasoning_text', {
              requireNonEmpty: true,
            });
        }

        // Notify about encrypted thinking
        if (callbacks.onEncryptedThinking) {
          callbacks.onEncryptedThinking(item.encrypted_content, item.id);
        }
      } else if (item.type === 'function_call') {
        // Update final tool call state
        const toolCall = toolCalls[chunk.output_index];
        if (toolCall && state.toolUses[chunk.output_index]) {
          const toolUseId = resolveResponsesToolCallId(state, item.call_id);
          toolCalls[chunk.output_index] = {
            id: toolUseId,
            name: item.name,
            arguments: item.arguments,
          };

          // Parse final arguments
          try {
            const parsedArgs = JSON.parse(item.arguments);
            state.toolUses[chunk.output_index] = {
              id: toolUseId,
              name: item.name,
              input: parsedArgs,
            };
          } catch (error) {
            logWarn('Failed to parse tool arguments', { cause: error });
          }
        }

        // Mark tool_use block as complete in contentBlocks
        const toolBlock = state.contentBlocks[chunk.output_index];
        if (toolBlock?.type === StreamingContentBlockType.ToolUse) {
          toolBlock.isComplete = true;
          callbacks.onContentBlockComplete?.(chunk.output_index, toolBlock);
        }
      } else if (item.type === 'custom_tool_call') {
        const normalizedToolName = normalizeApplyPatchToolName(item.name);
        const toolUseId = resolveResponsesToolCallId(state, item.call_id);
        const finalInputValue = getPreferredCustomToolInput({
          directInput: item.input,
          bufferedInput: state.toolInputBuffers[chunk.output_index],
          existingInput: getNonEmptyCustomToolInput(
            state.toolUses[chunk.output_index]?.input
          ),
        });
        if (finalInputValue) {
          state.toolInputBuffers[chunk.output_index] = finalInputValue;
        }

        state.toolUses[chunk.output_index] = {
          id: toolUseId,
          name: normalizedToolName,
          input: toCustomToolInput(finalInputValue),
        };

        const toolBlock = state.contentBlocks[chunk.output_index];
        if (toolBlock?.type === StreamingContentBlockType.ToolUse) {
          toolBlock.isComplete = true;
          callbacks.onContentBlockComplete?.(chunk.output_index, toolBlock);
        }
      }
      break;
    }

    case 'response.output_text.done': {
      // Capture message ID from text done event if available
      if ('item_id' in chunk && chunk.item_id && !state.openaiMessageId) {
        state.openaiMessageId = chunk.item_id;
        logInfo('Captured OpenAI message ID from response.output_text.done:', {
          messageId: state.openaiMessageId,
        });
      }
      break;
    }

    case 'response.output_text.delta': {
      // Handle text streaming
      state.streamingContent += chunk.delta;

      // Update indexed content block for unified content tracking
      // Find the text block and its index
      const textBlockEntry = Object.entries(state.contentBlocks).find(
        ([, b]) => b?.type === StreamingContentBlockType.Text && !b.isComplete
      );
      if (textBlockEntry) {
        const [blockIndex, textBlock] = textBlockEntry;
        textBlock.content += chunk.delta;

        // Notify streaming state manager with block index
        if (callbacks.onTextDelta) {
          callbacks.onTextDelta(parseInt(blockIndex, 10), chunk.delta);
        }
      }
      break;
    }

    /* ----------------------------------------------
     * OpenAI Responses reasoning / thinking streaming
     * ---------------------------------------------- */
    case 'response.reasoning_summary_part.added':
    case 'response.reasoning_part.added': {
      callbacks.onThinking?.();
      break;
    }

    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      const delta = chunk.delta ?? '';
      const outputIndex =
        typeof chunk.output_index === 'number' ? chunk.output_index : 0;
      appendOpenAIReasoningDelta({
        state,
        callbacks,
        outputIndex,
        delta,
      });
      break;
    }

    case 'response.reasoning_summary_text.done':
    case 'response.reasoning_summary_part.done':
    case 'response.reasoning_text.done':
    case 'response.reasoning_part.done': {
      break;
    }

    case 'response.function_call_arguments.delta': {
      // Handle tool parameter streaming
      const toolCall = toolCalls[chunk.output_index];
      if (toolCall) {
        // Accumulate the partial arguments
        if (!state.toolInputBuffers[chunk.output_index]) {
          state.toolInputBuffers[chunk.output_index] = '';
        }
        state.toolInputBuffers[chunk.output_index] += chunk.delta;

        // Try to parse partial input and notify streaming state manager
        if (callbacks.onToolInputDelta && chunk.delta) {
          // Parse the accumulated arguments optimistically
          const parseResult = parseOptimisticToolInput(
            state.toolInputBuffers[chunk.output_index],
            toolCall.name
          );

          // Only send updates if we have some meaningful data
          if (Object.keys(parseResult.data).length > 0) {
            emitToolInputDeltaIfChanged({
              state,
              index: chunk.output_index,
              toolId: toolCall.id,
              data: parseResult.data,
              callbacks,
            });
          }
        }
      }
      break;
    }

    case 'response.function_call_arguments.done': {
      // Handle completion of tool arguments
      const toolCall = toolCalls[chunk.output_index];
      if (toolCall && state.toolUses[chunk.output_index]) {
        try {
          const parsedArgs = JSON.parse(chunk.arguments);
          state.toolUses[chunk.output_index] = {
            id: toolCall.id,
            name: toolCall.name,
            input: parsedArgs,
          };
        } catch (error) {
          logWarn('Failed to parse completed tool arguments', { cause: error });
        }
      }
      break;
    }

    case 'response.custom_tool_call_input.delta': {
      if (!state.toolInputBuffers[chunk.output_index]) {
        state.toolInputBuffers[chunk.output_index] = '';
      }
      state.toolInputBuffers[chunk.output_index] += chunk.delta;

      const toolUseId =
        toolCalls[chunk.output_index]?.id ??
        state.toolUses[chunk.output_index]?.id;
      if (callbacks.onToolInputDelta && chunk.delta && toolUseId) {
        emitToolInputDeltaIfChanged({
          state,
          index: chunk.output_index,
          toolId: toolUseId,
          data: { input: state.toolInputBuffers[chunk.output_index] },
          callbacks,
        });
      }
      break;
    }

    case 'response.custom_tool_call_input.done': {
      const toolCall = toolCalls[chunk.output_index];
      const existingToolUse = state.toolUses[chunk.output_index];
      const finalInputValue = getPreferredCustomToolInput({
        directInput: chunk.input,
        bufferedInput: state.toolInputBuffers[chunk.output_index],
        existingInput: getNonEmptyCustomToolInput(existingToolUse?.input),
      });
      if (finalInputValue) {
        state.toolInputBuffers[chunk.output_index] = finalInputValue;
      }

      if (toolCall || existingToolUse) {
        state.toolUses[chunk.output_index] = {
          id: toolCall?.id ?? existingToolUse?.id ?? '',
          name: toolCall?.name ?? existingToolUse?.name ?? '',
          input: toCustomToolInput(finalInputValue),
        };
      }
      break;
    }

    case 'response.completed':
    case 'response.incomplete': {
      // Handle response completion (both completed and incomplete)
      state.finalStreamingContent = state.streamingContent;
      state.stopReason = mapOpenaiFinishReason(
        chunk.type === 'response.incomplete' ? 'max_output_tokens' : 'stop'
      );

      // Extract and store message ID from the response output if we don't have it yet
      if (!state.openaiMessageId && chunk.response?.output) {
        const messageOutput = chunk.response.output.find(
          (item: { type?: string; id?: string }) => item.type === 'message'
        );
        if (messageOutput && messageOutput.id) {
          state.openaiMessageId = messageOutput.id;
        }
      }

      if (chunk.response && chunk.response.usage) {
        const rawInputTokens = chunk.response.usage.input_tokens || 0;
        state.usage.outputTokens = chunk.response.usage.output_tokens || 0;
        state.usage.cacheCreationInputTokens =
          chunk.response.usage.input_tokens_details
            ?.cache_creation_input_tokens || 0;
        state.usage.cacheReadInputTokens =
          chunk.response.usage.input_tokens_details?.cached_tokens || 0;

        // OpenAI Responses API reports input_tokens as TOTAL (including cached).
        // Normalize to exclude cache so that inputTokens + cacheReadInputTokens
        // gives the true context size (consistent with Chat Completions API path).
        state.usage.inputTokens = Math.max(
          0,
          rawInputTokens - state.usage.cacheReadInputTokens
        );

        const finalThinking =
          chunk.response.usage.output_tokens_details?.reasoning_tokens;
        if (typeof finalThinking === 'number') {
          state.usage.thinkingTokens = finalThinking;
        }
        options.onTokenUsage?.(
          {
            inputTokens: state.usage.inputTokens,
            cacheReadTokens: state.usage.cacheReadInputTokens,
            outputTokens: state.usage.outputTokens,
            ...(state.usage.thinkingTokens !== undefined && {
              thinkingTokens: state.usage.thinkingTokens,
            }),
          },
          false
        );
      }

      if (callbacks.onMessageComplete) {
        callbacks.onMessageComplete();
      }
      break;
    }

    case 'response.failed': {
      throwMappedOpenAIResponseFailedChunkError(chunk);
      break;
    }

    default:
      // Ignore other chunk types
      break;
  }
}

function emitOpenAIChatToolUseDetected(params: {
  state: StreamingState;
  callbacks: StreamingCallbacks;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  thoughtSignature?: string;
}): void {
  const { state, callbacks, toolCallId, toolName, input, thoughtSignature } =
    params;

  if (!toolName) return;

  const existingBlock = state.contentBlocks.find(
    (block) =>
      block.type === StreamingContentBlockType.ToolUse &&
      block.toolUseId === toolCallId
  );
  if (existingBlock) return;

  callbacks.onToolUseDetected?.({
    id: toolCallId,
    name: toolName,
    input,
    ...(thoughtSignature && { thoughtSignature }),
  });

  const toolBlockIndex = state.contentBlocks.length;
  state.contentBlocks.push({
    type: StreamingContentBlockType.ToolUse,
    index: toolBlockIndex,
    content: '',
    toolUseId: toolCallId,
    toolName,
    isComplete: false,
  });
}

/**
 * Processes an OpenAI Chat Completions streaming chunk and updates state
 * @param chunk - The OpenAI chat completion chunk
 * @param state - The streaming state (will be mutated)
 * @param toolCalls - Tool calls accumulator
 * @param callbacks - Callbacks for streaming events
 * @param responseHeaders - Optional response headers (for Fireworks cached token usage)
 */
export function processOpenAIChatChunk(
  chunk: OpenAI.Chat.ChatCompletionChunk,
  state: StreamingState,
  toolCalls: Record<number, ToolCallInfo | undefined>,
  callbacks: StreamingCallbacks,
  responseHeaders?: Headers,
  options: ChunkProcessingOptions = {}
): void {
  const modelProvider = state.modelProvider;
  // Track tool call ID to index mapping for providers without explicit index (e.g., Gemini)
  // This is scoped per chunk processing and rebuilt from existing toolCalls state
  const toolCallIdToIndex: Record<string, number> = {};
  let nextAutoIndex = 0;

  // Rebuild ID-to-index mapping from existing tool calls
  for (const [indexStr, toolCall] of Object.entries(toolCalls)) {
    if (toolCall?.id) {
      const idx = parseInt(indexStr, 10);
      toolCallIdToIndex[toolCall.id] = idx;
      nextAutoIndex = Math.max(nextAutoIndex, idx + 1);
    }
  }

  // Store usage information but don't update session totals yet
  // Wait for completion to ensure we only count successful streams
  if (chunk.usage) {
    state.usage.cacheReadInputTokens =
      chunk.usage.prompt_tokens_details?.cached_tokens || 0;
    // Check for Fireworks cached token header if not in chunk usage
    if (!state.usage.cacheReadInputTokens && responseHeaders) {
      const fireworksCachedTokens = responseHeaders.get(
        'fireworks-cached-prompt-tokens'
      );
      if (fireworksCachedTokens) {
        state.usage.cacheReadInputTokens = Number(fireworksCachedTokens);
      }
    }
    state.usage.inputTokens = Math.max(
      0,
      (chunk.usage.prompt_tokens || 0) - state.usage.cacheReadInputTokens
    );
    state.usage.outputTokens = chunk.usage.completion_tokens || 0;

    options.onTokenUsage?.(
      {
        inputTokens: state.usage.inputTokens,
        cacheReadTokens: state.usage.cacheReadInputTokens,
        outputTokens: state.usage.outputTokens,
      },
      true
    );
  }

  // Process each choice
  // Guard against chunks without choices (e.g., reasoning/thinking-only chunks)
  if (!chunk.choices) {
    return;
  }

  for (const choice of chunk.choices) {
    // Process delta content when present (guard against missing delta from custom model proxies)
    if (choice?.delta) {
      const delta = choice.delta as ExtendedChatCompletionDelta;

      // Handle text content
      if (delta.content) {
        state.streamingContent += delta.content;

        // Track text block in contentBlocks for interleaved support
        // Find or create an open text block
        let textBlockIndex = state.contentBlocks.findIndex(
          (b) => b.type === StreamingContentBlockType.Text && !b.isComplete
        );

        if (textBlockIndex === -1) {
          // Create new text block
          textBlockIndex = state.contentBlocks.length;
          state.contentBlocks.push({
            type: StreamingContentBlockType.Text,
            index: textBlockIndex,
            content: '',
            isComplete: false,
          });
        }

        const textBlock = state.contentBlocks[textBlockIndex];
        textBlock.content += delta.content;

        if (callbacks.onTextDelta) {
          callbacks.onTextDelta(textBlockIndex, delta.content);
        }
      }

      // Handle reasoning content (check all known field names)
      // Some providers use 'reasoning' (e.g., OpenAI), others use 'reasoning_content' (e.g., llama.cpp)
      const reasoningFields = [
        ChatCompletionReasoningField.Reasoning,
        ChatCompletionReasoningField.ReasoningContent,
      ] as const;
      const reasoningEntry = reasoningFields.find((field) => delta[field]);

      if (reasoningEntry && delta[reasoningEntry]) {
        const reasoningText = delta[reasoningEntry];

        // Find or create thinking block in contentBlocks for interleaved support
        let thinkingBlockIndex = state.contentBlocks.findIndex(
          (b) => b.type === StreamingContentBlockType.Thinking && !b.isComplete
        );

        if (thinkingBlockIndex === -1) {
          // Create new thinking block
          thinkingBlockIndex = state.contentBlocks.length;
          // Stamp the actual active model's provider so cross-turn replay
          // doesn't trigger a CrossProvider downgrade in
          // `normalizeThinkingBlocks`, which would wrap the reasoning in
          // literal `<thinking>\n...\n</thinking>` text and pollute the
          // prompt. Kimi K2.6 (INDUSTRY provider) echoes such tags back in
          // its own `content` stream, compounding every turn (FAC-19104).
          // Fall back to OPENAI for tests / legacy callers that don't
          // set `state.modelProvider`.
          state.contentBlocks.push({
            type: StreamingContentBlockType.Thinking,
            index: thinkingBlockIndex,
            content: '',
            signature:
              modelProvider === ModelProvider.GOOGLE ? '' : reasoningEntry,
            signatureProvider: modelProvider ?? ModelProvider.OPENAI,
            isComplete: false,
          });
          callbacks.onThinkingBlockStart?.(thinkingBlockIndex);
        }

        const thinkingBlock = state.contentBlocks[thinkingBlockIndex];
        startThinkingDuration(thinkingBlock);
        thinkingBlock.content += reasoningText;
        callbacks.onThinkingDelta?.(thinkingBlockIndex, reasoningText);

        // Keep legacy accumulation for backward compatibility
        if (!state.chatCompletionReasoningField) {
          state.chatCompletionReasoningField = reasoningEntry;
        }
        if (!state.chatCompletionReasoningContent) {
          state.chatCompletionReasoningContent = '';
        }
        state.chatCompletionReasoningContent += reasoningText;

        // Notify about thinking state
        if (callbacks.onThinking) {
          callbacks.onThinking();
        }
      }

      // Capture Gemini thought signature (for maintaining context across turns)
      if (
        modelProvider === ModelProvider.GOOGLE &&
        delta.extra_content?.google?.thought_signature
      ) {
        stampGeminiThoughtSignatureOnThinkingBlocks(
          state,
          delta.extra_content.google.thought_signature
        );
      }

      // Handle tool calls
      if (delta.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          let index: number;
          let toolCallThoughtSignature: string | undefined;

          // Sanitize the tool call ID early for consistent lookups
          // (some providers like Kimi send IDs with leading whitespace)
          const sanitizedDeltaId = sanitizeToolCallId(toolCallDelta.id);

          // Handle missing index field (some providers like Gemini don't send it)
          if (typeof toolCallDelta.index === 'number') {
            // Standard OpenAI format: use provided index
            index = toolCallDelta.index;
          } else if (
            sanitizedDeltaId &&
            toolCallIdToIndex[sanitizedDeltaId] !== undefined
          ) {
            // Provider without index: reuse existing index for this ID
            index = toolCallIdToIndex[sanitizedDeltaId];
          } else {
            // New tool call without index: auto-assign next available index
            index = nextAutoIndex;
            nextAutoIndex++;

            // Track this ID's index for future chunks
            if (sanitizedDeltaId) {
              toolCallIdToIndex[sanitizedDeltaId] = index;
            }
          }

          // Capture Gemini thought signature from tool call delta (tool-call scoped only)
          if (modelProvider === ModelProvider.GOOGLE) {
            const toolCallDeltaTyped = toolCallDelta as typeof toolCallDelta & {
              extra_content?: { google?: { thought_signature?: string } };
            };

            const signature =
              toolCallDeltaTyped.extra_content?.google?.thought_signature;
            if (signature) {
              if (!state.toolCallSignatures) {
                state.toolCallSignatures = {};
              }
              state.toolCallSignatures[index] = signature;
              toolCallThoughtSignature = signature;
            }
          }

          if (!toolCalls[index]) {
            // Regenerate a unique id for providers whose raw tool_call ids
            // collide across turns:
            //   - Gemini reuses ids like tool names;
            //   - Fireworks/Kimi (vLLM native fn-call format) emits
            //     positional per-assistant-message ids like
            //     `functions.Read:0` that reset each turn and collide on
            //     replay, breaking tool_use ↔ tool_result pairing and
            //     sending the model into a retry loop. Detected by the
            //     unmistakable raw shape `functions.<Name>:<index>` so we
            //     don't need per-model plumbing. Other Fireworks-hosted
            //     Chat-Completions models (GLM `chatcmpl-tool-<hex>`,
            //     MiniMax `call_<hex>`) emit session-unique ids and are
            //     left alone. FAC-18554.
            const rawDeltaId = toolCallDelta.id;
            const isKimiPositionalId =
              typeof rawDeltaId === 'string' &&
              /^functions\.[A-Za-z_][A-Za-z0-9_-]*:\d+$/.test(
                rawDeltaId.trim()
              );
            const uniqueToolCallId =
              modelProvider === ModelProvider.GOOGLE || isKimiPositionalId
                ? generateToolCallId()
                : sanitizedDeltaId;

            // Initialize new tool call
            toolCalls[index] = {
              id: uniqueToolCallId,
              name: toolCallDelta.function?.name || '',
              arguments: '',
            };

            // Pad with null so the tool call sits at the correct index.
            while (state.toolUses.length <= index) {
              state.toolUses.push(null);
            }

            state.toolUses[index] = {
              id: uniqueToolCallId,
              name: toolCallDelta.function?.name || '',
              input: {},
            };

            emitOpenAIChatToolUseDetected({
              state,
              callbacks,
              toolCallId: uniqueToolCallId,
              toolName: toolCallDelta.function?.name || '',
              input: {},
              thoughtSignature: toolCallThoughtSignature,
            });
          } else if (toolCallDelta.function?.name) {
            const toolCall = toolCalls[index]!;
            const name = toolCallDelta.function.name;
            toolCall.name = name;

            const toolUse = state.toolUses[index];
            if (toolUse) {
              toolUse.name = name;
            }

            emitOpenAIChatToolUseDetected({
              state,
              callbacks,
              toolCallId: toolCall.id,
              toolName: name,
              input: toolUse?.input ?? {},
              thoughtSignature: toolCallThoughtSignature,
            });
          }

          // Accumulate function arguments
          if (toolCallDelta.function?.arguments) {
            toolCalls[index]!.arguments += toolCallDelta.function.arguments;

            // Store in buffer for later parsing
            if (!state.toolInputBuffers[index]) {
              state.toolInputBuffers[index] = '';
            }
            state.toolInputBuffers[index] += toolCallDelta.function.arguments;

            // Try optimistic parsing
            const currentArgs = toolCalls[index]!.arguments;
            const parseResult = parseOptimisticToolInput(
              currentArgs,
              toolCalls[index]!.name
            );

            const toolUse = state.toolUses[index];
            if (parseResult.data && callbacks.onToolInputDelta && toolUse) {
              emitToolInputDeltaIfChanged({
                state,
                index,
                toolId: toolUse.id,
                data: parseResult.data,
                callbacks,
              });
            }
          }
        }
      }
    } // end if (choice?.delta)

    // Check for finish reason — outside the delta guard so that a chunk with
    // finish_reason but a null/undefined delta still finalizes the stream.
    if (choice.finish_reason) {
      state.stopReason = mapOpenaiFinishReason(choice.finish_reason);
      // Parse final tool arguments and mark tool_use blocks as complete
      for (const [indexStr, toolCall] of Object.entries(toolCalls)) {
        const index = parseInt(indexStr, 10);
        const toolUseEntry = state.toolUses[index];
        if (toolCall && toolCall.arguments && toolUseEntry) {
          try {
            const parsedInput = JSON.parse(toolCall.arguments);
            toolUseEntry.input = parsedInput;
          } catch (error) {
            // Don't log raw toolCall.arguments; tool inputs can contain
            // user-authored file content, patches, paths, etc. Record
            // length only so we can still diagnose truncation issues.
            logWarn('[OpenAI Chat] Failed to parse tool arguments', {
              cause: error,
              toolId: toolCall.id,
              toolName: toolCall.name,
              length: toolCall.arguments?.length ?? 0,
            });

            // Reuse optimistic parser to extract valid parameters
            const parseResult = parseOptimisticToolInput(
              toolCall.arguments,
              toolCall.name
            );
            toolUseEntry.input = parseResult.data;
          }
        }

        // Mark tool_use block as complete in contentBlocks
        if (toolCall) {
          const toolBlock = state.contentBlocks.find(
            (b) =>
              b.type === StreamingContentBlockType.ToolUse &&
              b.toolUseId === toolCall.id
          );
          if (toolBlock) {
            toolBlock.isComplete = true;
          }
        }
      }

      completeLatestIncompleteContentBlock(state, callbacks);

      // Notify message completion
      if (callbacks.onMessageComplete) {
        callbacks.onMessageComplete();
      }
    }
  }

  // Store message ID if present
  if (chunk.id) {
    state.openaiMessageId = chunk.id;
  }
}

/**
 * Processes a native Gemini API GenerateContentResponse chunk and updates state
 * @param response - The native Gemini GenerateContentResponse
 * @param state - The streaming state (will be mutated)
 * @param callbacks - Callbacks for streaming events
 */
export function processGeminiSSEChunk(
  response: GenerateContentResponse,
  state: StreamingState,
  callbacks: StreamingCallbacks,
  options: ChunkProcessingOptions = {}
): void {
  // Note: Error responses from the API are handled at the HTTP level,
  // not in the SSE stream. The SDK's GenerateContentResponse only contains
  // successful response data.

  // Process candidates (content)
  const candidate = response.candidates?.[0];
  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      // Handle thinking content (thought: true)
      if (part.thought && part.text) {
        let thinkingBlockIndex = state.contentBlocks.findIndex(
          (b) => b.type === StreamingContentBlockType.Thinking && !b.isComplete
        );

        if (thinkingBlockIndex === -1) {
          thinkingBlockIndex = state.contentBlocks.length;
          state.contentBlocks.push({
            type: StreamingContentBlockType.Thinking,
            index: thinkingBlockIndex,
            content: '',
            signatureProvider: ModelProvider.GOOGLE,
            isComplete: false,
          });
          callbacks.onThinkingBlockStart?.(thinkingBlockIndex);
        }

        const thinkingBlock = state.contentBlocks[thinkingBlockIndex];
        startThinkingDuration(thinkingBlock);
        thinkingBlock.content += part.text;
        callbacks.onThinkingDelta?.(thinkingBlockIndex, part.text);
        callbacks.onThinking?.();

        if (!state.thinkingContent) {
          state.thinkingContent = '';
        }
        state.thinkingContent += part.text;

        if (part.thoughtSignature) {
          stampGeminiThoughtSignatureOnThinkingBlocks(
            state,
            part.thoughtSignature
          );
        }

        const deltaTokens = approxTokensFromChars(part.text.length);
        state.usage.thinkingTokens =
          (state.usage.thinkingTokens || 0) + deltaTokens;
      }
      // Handle regular text content (not thought, has text)
      else if (part.text !== undefined && !part.thought) {
        state.streamingContent += part.text;

        let textBlockIndex = state.contentBlocks.findIndex(
          (b) => b.type === StreamingContentBlockType.Text && !b.isComplete
        );

        if (textBlockIndex === -1) {
          textBlockIndex = state.contentBlocks.length;
          state.contentBlocks.push({
            type: StreamingContentBlockType.Text,
            index: textBlockIndex,
            content: '',
            isComplete: false,
          });
        }

        const textBlock = state.contentBlocks[textBlockIndex];
        textBlock.content += part.text;
        callbacks.onTextDelta?.(textBlockIndex, part.text);

        if (part.thoughtSignature) {
          stampGeminiThoughtSignatureOnThinkingBlocks(
            state,
            part.thoughtSignature
          );
        }
      }
      // Handle function calls
      else if (part.functionCall?.name) {
        const toolCallId = generateToolCallId();
        const index = state.toolUses.length;
        const functionName = part.functionCall.name;

        state.toolUses.push({
          id: toolCallId,
          name: functionName,
          input: part.functionCall.args || {},
          thoughtSignature: part.thoughtSignature,
        });

        if (part.thoughtSignature) {
          if (!state.toolCallSignatures) {
            state.toolCallSignatures = {};
          }
          state.toolCallSignatures[index] = part.thoughtSignature;
        }

        state.toolInputBuffers[index] = JSON.stringify(
          part.functionCall.args || {}
        );

        state.contentBlocks.push({
          type: StreamingContentBlockType.ToolUse,
          index: state.contentBlocks.length,
          content: '',
          toolUseId: toolCallId,
          toolName: functionName,
          isComplete: false,
        });

        callbacks.onToolUseDetected?.({
          id: toolCallId,
          name: functionName,
          input: part.functionCall.args || {},
          ...(part.thoughtSignature && {
            thoughtSignature: part.thoughtSignature,
          }),
        });
      }
    }

    // Mark blocks as complete on finish
    if (candidate.finishReason) {
      state.stopReason = mapGeminiFinishReason(
        candidate.finishReason,
        state.toolUses.some((t) => t !== null)
      );
      for (const block of state.contentBlocks) {
        if (!block.isComplete) {
          completeThinkingDuration(block);
          block.isComplete = true;
          callbacks.onContentBlockComplete?.(block.index, block);
        }
      }
    }
  }

  // Process usage metadata
  if (response.usageMetadata) {
    const usage = response.usageMetadata;
    const promptTokenCount = usage.promptTokenCount;
    const candidatesTokenCount = usage.candidatesTokenCount;
    const thoughtsTokenCount = usage.thoughtsTokenCount;
    const cachedContentTokenCount = usage.cachedContentTokenCount;
    const hasPromptTokenCount = typeof promptTokenCount === 'number';
    const hasCandidatesTokenCount = typeof candidatesTokenCount === 'number';
    const hasThoughtsTokenCount = typeof thoughtsTokenCount === 'number';
    const hasCachedContentTokenCount =
      typeof cachedContentTokenCount === 'number';
    const hasTokenUsage =
      hasPromptTokenCount ||
      hasCandidatesTokenCount ||
      hasThoughtsTokenCount ||
      hasCachedContentTokenCount;
    if (!hasTokenUsage) return;

    // Gemini's promptTokenCount includes cached tokens, so we store total for state
    if (hasPromptTokenCount) {
      state.usage.inputTokens = promptTokenCount;
    }
    if (hasCandidatesTokenCount || hasThoughtsTokenCount) {
      state.usage.outputTokens =
        (hasCandidatesTokenCount ? candidatesTokenCount : 0) +
        (hasThoughtsTokenCount ? thoughtsTokenCount : 0);
    }
    if (hasCachedContentTokenCount) {
      state.usage.cacheReadInputTokens = cachedContentTokenCount;
    }

    // Subtract cached tokens from input to avoid double-counting
    // (cacheReadTokens is tracked separately)
    const rawInputTokens =
      state.usage.inputTokens - state.usage.cacheReadInputTokens;
    if (rawInputTokens < 0) {
      logError(
        '[Gemini] cachedContentTokenCount exceeds promptTokenCount, clamping to 0',
        {
          inputTokens: state.usage.inputTokens,
          cachedTokensRead: state.usage.cacheReadInputTokens,
        }
      );
    }
    const inputTokensExcludingCache = Math.max(0, rawInputTokens);
    options.onTokenUsage?.(
      {
        inputTokens: inputTokensExcludingCache,
        outputTokens: state.usage.outputTokens,
        cacheReadTokens: state.usage.cacheReadInputTokens,
      },
      true
    );
  }
}

/**
 * Create the per-send empty-response retry state. Callers create one per
 * send and share it across that send's provider retry attempts so the
 * empty-retry cap and output-budget escalation survive rotation.
 */
export function createEmptyResponseRetryState(): EmptyResponseRetryState {
  return { attempts: 0 };
}

/**
 * Empty streams are retried at most once per send: a second empty answer in
 * a row is almost always deterministic, and attempts against slow local
 * models can take minutes each.
 */
const MAX_EMPTY_RESPONSE_RETRIES = 1;

/**
 * When an `expectsText` completion came back empty because the output budget
 * was exhausted (`length` stop), the retry gets a larger budget so
 * shared-budget reasoning cannot starve the text again.
 */
const EMPTY_RESPONSE_BUDGET_ESCALATION_FACTOR = 3;

/**
 * Apply (and consume) a pending output-budget escalation for the current
 * attempt. Never lowers the current value; bounded by `ceiling` when known.
 */
export function applyEmptyResponseBudgetEscalation({
  retryState,
  currentMaxTokens,
  ceiling,
}: {
  retryState: EmptyResponseRetryState;
  currentMaxTokens: unknown;
  ceiling: number | undefined;
}): number | undefined {
  const factor = retryState.outputBudgetEscalationFactor;
  if (factor === undefined || typeof currentMaxTokens !== 'number') {
    return undefined;
  }
  retryState.outputBudgetEscalationFactor = undefined;
  const raised = Math.round(currentMaxTokens * factor);
  const bounded = ceiling !== undefined ? Math.min(raised, ceiling) : raised;
  return Math.max(currentMaxTokens, bounded);
}

/**
 * Throw {@link LLMEmptyResponseError} from inside a provider `attemptStream`
 * when the finished stream produced no usable output, so the retry/rotation
 * machinery re-issues the request instead of surfacing an empty turn as
 * success. `expectsText` callers (text completions) require assistant text
 * specifically: tool-only output does not satisfy them. Refusals
 * (`content-filter`) are deterministic moderation outcomes, not empty-stream
 * transients: they are left for the shared post-stream content-filter
 * mapping in `sendMessage`, which raises `LLMContentModerationError` exactly
 * once (no empty retry, no provider rotation) so moderation-aware consumers
 * (e.g. the compaction summarizer's cross-vendor fallback) can react.
 */
export function assertNonEmptyLLMResponse({
  state,
  wasAborted,
  expectsText,
  modelId,
  providerName,
  retryState,
}: {
  state: StreamingState;
  wasAborted: boolean;
  expectsText: boolean | undefined;
  modelId: string;
  providerName: ModelProvider;
  retryState: EmptyResponseRetryState;
}): void {
  if (wasAborted) return;
  if (state.stopReason === LanguageModelFinishReason.ContentFilter) return;

  const trulyEmpty = isEmptyResponseError(state, wasAborted);
  const emptyForText =
    Boolean(expectsText) && state.streamingContent.length === 0;
  if (!trulyEmpty && !emptyForText) return;

  retryState.attempts += 1;

  const retryable = retryState.attempts <= MAX_EMPTY_RESPONSE_RETRIES;
  if (
    retryable &&
    Boolean(expectsText) &&
    state.stopReason === LanguageModelFinishReason.Length
  ) {
    retryState.outputBudgetEscalationFactor =
      EMPTY_RESPONSE_BUDGET_ESCALATION_FACTOR;
  }

  throw new LLMEmptyResponseError({
    retryable,
    stopReason: state.stopReason,
    outputTokens: state.usage.outputTokens,
    thinkingContentLength:
      getStreamingThinkingOrReasoningContent(state)?.length,
    modelId,
    providerName,
    emptyAttempts: retryState.attempts,
  });
}
