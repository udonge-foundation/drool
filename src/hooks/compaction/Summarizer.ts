import { CURRENT_COMPACTION_MODEL } from '@industry/common/settings';
import { sendCompletion } from '@industry/drool-core/llms/client/sendMessage';
import {
  LLMEmptyResponseError,
  isContentModerationError,
  isContextLimitError,
  LLMContentModerationError,
} from '@industry/drool-core/llms/errors';
import { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logInfo } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { COMPACTION_MODERATION_FALLBACK_MODEL_PREFERENCE } from '@industry/utils/llm';
import { findCustomModel } from '@industry/utils/models';

import { formatTodoForSummary } from '@/hooks/compaction/CompactionManager';
import { serializeConversation } from '@/hooks/compaction/messageSerializer';
import type { SummarizeFn } from '@/hooks/compaction/types';
import { isModelAllowed } from '@/models/availability';
import { generateIterativeSummarizationSystemPrompt } from '@/prompts/_utils/generateIterativeSummarizationSystemPrompt';
import { createOneShotSendMessageClient } from '@/services/llmStreamingClient';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';

import type { TodoWriteToolParams } from '@industry/drool-core/tools/definitions/todo';

const DEFAULT_MAX_OUTPUT_TOKENS = 4000;
const CUSTOM_MODEL_MAX_OUTPUT_TOKENS_CAP = 4000;

/**
 * Creates a summarizer function that generates summaries via the shared
 * drool-core `sendCompletion` helper. Provider routing, retry, and BYOK
 * plumbing live in the engine.
 */
export function createSummarizer(): SummarizeFn {
  /**
   * Builds the user content for the summarization prompt
   */
  function buildUserContent(params: {
    transcript: string;
    previousSummary?: string;
    summarySoftCap?: number;
    previousSummaryTokens?: number;
    customInstructions?: string;
    toolsAbbreviated?: boolean;
  }): string {
    const {
      transcript,
      previousSummary,
      summarySoftCap,
      previousSummaryTokens,
      customInstructions,
      toolsAbbreviated = false,
    } = params;

    const toolsNote = toolsAbbreviated
      ? '\n\nNote: Tool call details have been abbreviated to save space.'
      : '';

    const instructionsNote = customInstructions
      ? `\n\nThe user has provided the following instructions for this summary:\n${customInstructions}\n\nIf necessary, you may add new sections or modify existing ones to align with the user's intent.`
      : '';

    if (previousSummary) {
      const capNote =
        summarySoftCap &&
        previousSummaryTokens &&
        previousSummaryTokens > summarySoftCap
          ? `\nIMPORTANT: Please keep your new <summary> around a similar length by trimming or condensing the least important information while preserving key facts.`
          : '';

      return `Previous summary:
\`\`\`
${previousSummary}
\`\`\`
${capNote}

These messages were sent since the previous summary:
\`\`\`
${transcript}
\`\`\`${toolsNote}${instructionsNote}

Please incorporate the new messages into the existing summary, preserving important details from both. Remember to wrap your final summary in <summary> tags.`;
    }

    return `Please summarize the following conversation:
\`\`\`
${transcript}
\`\`\`${toolsNote}${instructionsNote}

Remember to wrap your final summary in <summary> tags.`;
  }

  /**
   * Extracts summary from response text
   */
  function extractSummary(text: string): string {
    const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i);
    if (summaryMatch) {
      return summaryMatch[1].trim();
    }
    // A `length`-truncated response can lose the closing tag; keep the
    // content after the opening tag instead of leaking the tag (and any
    // preamble before it) into the stored summary.
    const openTagMatch = text.match(/<summary>/i);
    if (openTagMatch?.index !== undefined) {
      return text.slice(openTagMatch.index + openTagMatch[0].length).trim();
    }
    return text.trim();
  }

  return async function summarize({
    messages,
    sessionId,
    previousSummary,
    previousSummaryTokens,
    summarySoftCap,
    summaryReserve,
    latestTodos,
    signal,
    customInstructions,
    contextLimitFallbackModelId,
  }: {
    messages: IndustryDroolMessage[];
    sessionId: string;
    previousSummary?: string;
    previousSummaryTokens?: number;
    summarySoftCap?: number;
    summaryReserve?: number;
    latestTodos?: TodoWriteToolParams;
    signal?: AbortSignal;
    customInstructions?: string;
    contextLimitFallbackModelId?: string;
  }): Promise<string> {
    logInfo('[Summarizer] Start', {
      messagesToSummarizeCount: messages.length,
      usesConversationSummary: !!previousSummary,
    });
    // Early return behavior:
    // - If no new messages and we have a previous summary, return it unchanged
    //   to avoid unnecessary API call
    // - If no messages and no previous summary, return empty string
    if (!messages.length) {
      logInfo('[Summarizer] Early return', {
        messagesToSummarizeCount: 0,
        usesConversationSummary: !!previousSummary,
      });
      if (previousSummary) return previousSummary;
      return '';
    }

    const systemPrompt =
      generateIterativeSummarizationSystemPrompt(!!previousSummary);

    const settingsService = getSettingsService();
    const sessionService = getSessionService();
    const configuredCompactionModel = settingsService.getCompactionModel();
    const currentSessionModel =
      sessionService.isSpecMode() && sessionService.hasSpecModeModel()
        ? sessionService.getSpecModeModel()
        : sessionService.getModel();
    const requestedModelId =
      configuredCompactionModel === CURRENT_COMPACTION_MODEL
        ? currentSessionModel
        : configuredCompactionModel;
    const customModel = findCustomModel(
      requestedModelId,
      settingsService.getCustomModels()
    );

    // Resolve any custom-model max-output cap up-front so we don't blow past
    // the user's advertised ceiling. The drool-core engine still applies its
    // own caps — this only narrows the request.
    let maxOutputTokens = summaryReserve || DEFAULT_MAX_OUTPUT_TOKENS;
    if (customModel?.maxOutputTokens) {
      maxOutputTokens = Math.min(maxOutputTokens, customModel.maxOutputTokens);
    } else if (customModel) {
      maxOutputTokens = Math.min(
        maxOutputTokens,
        CUSTOM_MODEL_MAX_OUTPUT_TOKENS_CAP
      );
    }

    logInfo('[Summarizer] Using model', {
      modelId: requestedModelId,
      maxOutputTokens,
    });

    const client = createOneShotSendMessageClient();
    // External abort -> cancel the in-flight streaming turn. The engine
    // owns its own AbortController internally, so we proxy the user signal
    // via the public `abortStreaming()` surface. The listener is cleared
    // in the `finally` block below so a long-lived signal that never aborts
    // doesn't retain the closure (and the one-shot client) past completion.
    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = () => client.abortStreaming();
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }

    // First attempt with full transcript
    let formattedTranscript = serializeConversation(messages);
    let userContent = buildUserContent({
      transcript: formattedTranscript,
      previousSummary,
      previousSummaryTokens,
      summarySoftCap,
      customInstructions,
      toolsAbbreviated: false,
    });

    const fullText = await (async () => {
      try {
        const sendSummaryRequest = (modelId: string) =>
          sendCompletion(client, {
            systemPrompt,
            userContent,
            modelId,
            maxTokensOverride: maxOutputTokens,
            sessionId,
            // Honor spec mode if the session is in it — keeps the summarizer
            // model selection consistent with the active turn's model.
            isSpecMode: sessionService.isSpecMode(),
          });

        try {
          return await sendSummaryRequest(requestedModelId);
        } catch (error) {
          // Context-limit fallback is owned here because it requires
          // re-serializing the transcript with abbreviated tools.
          if (isContextLimitError(error)) {
            const fallbackModelId =
              contextLimitFallbackModelId &&
              contextLimitFallbackModelId !== requestedModelId
                ? contextLimitFallbackModelId
                : undefined;
            let abbreviatedRetryError = error;

            if (fallbackModelId) {
              logException(
                error,
                '[Summarizer] Context limit hit, retrying with fallback model',
                { modelId: fallbackModelId }
              );
              try {
                return await sendSummaryRequest(fallbackModelId);
              } catch (fallbackError) {
                if (!isContextLimitError(fallbackError)) {
                  throw fallbackError;
                }
                logException(
                  fallbackError,
                  '[Summarizer] Fallback model context limit hit, retrying with abbreviated tools',
                  { modelId: fallbackModelId }
                );
                abbreviatedRetryError = fallbackError;
              }
            }

            logException(
              abbreviatedRetryError,
              '[Summarizer] Retrying with abbreviated tools'
            );
            formattedTranscript = serializeConversation(messages, {
              abbreviateTools: true,
            });
            userContent = buildUserContent({
              transcript: formattedTranscript,
              previousSummary,
              previousSummaryTokens,
              summarySoftCap,
              customInstructions,
              toolsAbbreviated: true,
            });
            return await sendSummaryRequest(
              fallbackModelId ?? requestedModelId
            );
          }

          if (isContentModerationError(error)) {
            const moderationFallbackModelId =
              COMPACTION_MODERATION_FALLBACK_MODEL_PREFERENCE.find(
                (modelId) =>
                  modelId !== requestedModelId && isModelAllowed(modelId)
              );
            const refusal =
              error instanceof LLMContentModerationError ? error : undefined;
            if (moderationFallbackModelId) {
              logException(
                error,
                '[Summarizer] Summarization refused, retrying with fallback model',
                {
                  modelId: moderationFallbackModelId,
                  refusalCategory: refusal?.refusalCategory,
                  refusalExplanation: refusal?.refusalExplanation,
                }
              );
              return await sendSummaryRequest(moderationFallbackModelId);
            }
            logException(
              error,
              '[Summarizer] Summarization refused; no fallback model available',
              {
                modelId: requestedModelId,
                refusalCategory: refusal?.refusalCategory,
                refusalExplanation: refusal?.refusalExplanation,
              }
            );
          }

          throw error;
        }
      } finally {
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
        }
      }
    })().catch((error: unknown) => {
      // Engine-level empty retries are exhausted. Refusals surface as
      // LLMContentModerationError and are handled by the moderation fallback
      // above; this catch covers transient/length-burn empties. Surface an
      // actionable message instead of an opaque failure so users with a
      // deterministically-empty provider don't retry-loop for days.
      if (error instanceof LLMEmptyResponseError) {
        // Report the model that actually returned empty: the summarizer may
        // have rotated to `contextLimitFallbackModelId`, so the failing model
        // can differ from the originally requested one.
        const emptyModelId = error.modelId || requestedModelId;
        throw new MetaError(
          `Summarizer model "${emptyModelId}" returned no text` +
            `${error.stopReason ? ` (stop reason: ${error.stopReason})` : ''}. ` +
            'Run /compact with a different compaction model, or check your model provider.',
          {
            contextId: 'summarizer_empty_response',
            modelId: emptyModelId,
            reason: error.stopReason ?? 'none',
            cause: error,
          }
        );
      }
      throw error;
    });

    // Defense-in-depth: `sendCompletion` sets `expectsText`, so the engine
    // already throws `LLMEmptyResponseError` for a text-less completion before
    // returning. This guards the contract for any future caller/provider path
    // that resolves an empty string without going through that check.
    if (!fullText) {
      throw new MetaError('Summarizer model response contained no text', {
        contextId: 'summarizer_no_text_content',
        modelId: requestedModelId,
      });
    }

    // Extract summary section
    let summary = extractSummary(fullText);

    // Append TODO list if present
    if (latestTodos) {
      const todoText = formatTodoForSummary(latestTodos);
      if (todoText) {
        summary += `\n\n${todoText}`;
      }
    }

    logInfo('[Summarizer] Response OK, extracted summary', {
      summaryLength: summary.length,
    });
    return summary;
  };
}
