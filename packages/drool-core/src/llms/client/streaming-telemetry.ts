import {
  ChatCompletionReasoningField,
  type ApiProvider,
  type ModelProvider,
} from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn, Metric, type MetricLabels, Metrics } from '@industry/logging';

import {
  getStreamingThinkingOrReasoningContent,
  hasStreamingTextOrToolUse,
  isEmptyResponseError,
} from './chunk-processing';

import type { StreamingState } from './types';
import type OpenAI from 'openai';

export function createTimeToFirstTokenRecorder({
  model,
  provider,
  isSpecMode,
  streamStartTime,
  getApiProvider,
  getBaseUrl,
}: {
  model: string;
  provider: ModelProvider;
  isSpecMode: boolean;
  streamStartTime: number;
  getApiProvider?: () => ApiProvider | undefined;
  getBaseUrl?: () => string | undefined;
}): () => void {
  let recorded = false;

  return () => {
    if (recorded) {
      return;
    }
    recorded = true;
    const metricDimensions: MetricLabels = {
      modelId: model,
      modelProvider: provider,
      isSpecMode,
      surface: 'industry-cli',
    };
    const apiProvider = getApiProvider?.();
    if (apiProvider) {
      metricDimensions.apiProvider = apiProvider;
    }
    const baseUrl = getBaseUrl?.();
    if (baseUrl) {
      metricDimensions.baseUrl = baseUrl;
    }
    Metrics.recordHistogram(
      Metric.CHAT_CLIENT_TIME_TO_FIRST_TOKEN,
      (Date.now() - streamStartTime) / 1000,
      metricDimensions
    );
  };
}

export function hasOpenAIChatTimeToFirstTokenDelta(
  choice: OpenAI.Chat.ChatCompletionChunk.Choice
): boolean {
  const delta = choice.delta as Record<string, unknown> | undefined;
  return Boolean(
    delta?.content ||
      delta?.tool_calls ||
      delta?.[ChatCompletionReasoningField.Reasoning] ||
      delta?.[ChatCompletionReasoningField.ReasoningContent]
  );
}

export function logProviderResponseDiagnostics({
  state,
  model,
  providerName,
  wasAborted,
}: {
  state: StreamingState;
  model: string;
  providerName: ModelProvider;
  wasAborted: boolean;
}): void {
  if (isEmptyResponseError(state, wasAborted)) {
    logWarn('[LLM] 200 OK response body was empty — treating as empty turn', {
      modelId: model,
      modelProvider: providerName,
    });
  }

  const thinkingOrReasoningContent =
    getStreamingThinkingOrReasoningContent(state);
  if (
    hasStreamingTextOrToolUse(state) ||
    !thinkingOrReasoningContent ||
    wasAborted
  ) {
    return;
  }

  logWarn(
    '[LLM] Response contained only thinking content with no text or tool calls',
    {
      modelId: model,
      modelProvider: providerName,
      outputTokens: state.usage.outputTokens,
      length: thinkingOrReasoningContent.length,
      reason: state.stopReason,
    }
  );
}
