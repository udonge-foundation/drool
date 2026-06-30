import {
  ApiProvider,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';

import { mapToOpenAIEffort } from './reasoning';

import type { ChatCompletionRequestConfig } from '../types';

type ChatCompletionsReasoningEffort = ReturnType<typeof mapToOpenAIEffort>;

type ChatCompletionsReasoningRequestConfig = {
  reasoning_effort?: ChatCompletionsReasoningEffort;
  thinking?: {
    type: 'enabled';
    budget_tokens: number;
  };
} & Record<string, unknown>;

export function buildChatCompletionsReasoningRequestConfig(params: {
  apiProvider?: ApiProvider | null;
  reasoningEffort: ReasoningEffort;
  supportedEfforts: readonly ReasoningEffort[];
  thinkingEnabled?: boolean;
  thinkingTokens?: number;
  buildRequestParams?: ChatCompletionRequestConfig['buildRequestParams'];
}): {
  requestConfig: ChatCompletionsReasoningRequestConfig;
  shouldLogUnsupportedEffort: boolean;
} {
  const {
    apiProvider,
    reasoningEffort,
    supportedEfforts,
    thinkingEnabled,
    thinkingTokens,
    buildRequestParams,
  } = params;

  const requestConfig: ChatCompletionsReasoningRequestConfig = {};

  if (thinkingEnabled && thinkingTokens) {
    requestConfig.reasoning_effort = 'high';
    requestConfig.thinking = {
      type: 'enabled',
      budget_tokens: thinkingTokens,
    };
    return {
      requestConfig,
      shouldLogUnsupportedEffort: false,
    };
  }

  if (reasoningEffort === ReasoningEffort.None) {
    return {
      requestConfig,
      shouldLogUnsupportedEffort: false,
    };
  }

  if (reasoningEffort === ReasoningEffort.Dynamic) {
    return {
      requestConfig,
      shouldLogUnsupportedEffort: false,
    };
  }

  if (!supportedEfforts.includes(reasoningEffort)) {
    return {
      requestConfig,
      shouldLogUnsupportedEffort: true,
    };
  }

  if (buildRequestParams) {
    Object.assign(
      requestConfig,
      buildRequestParams({ effort: reasoningEffort, apiProvider })
    );
    return {
      requestConfig,
      shouldLogUnsupportedEffort: false,
    };
  }

  if (reasoningEffort !== ReasoningEffort.Off) {
    requestConfig.reasoning_effort = mapToOpenAIEffort(reasoningEffort);
  }

  return {
    requestConfig,
    shouldLogUnsupportedEffort: false,
  };
}
