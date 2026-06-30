import {
  ApiProvider,
  ChatCompletionReasoningField,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn } from '@industry/logging';

import { buildChatCompletionsReasoningRequestConfig } from './buildChatCompletionsReasoningRequestConfig';
import { mapToOpenAIEffort } from './reasoning';
import {
  coerceProviderReasoningEffort,
  getProviderChatCompletionsConfig,
  getProviderThinkingOptInParam,
  resolveProviderReasoningEffortValue,
  shouldOmitDisabledReasoningParams,
} from '../provider-registry';

import type { ChatCompletionRequestConfig, LLMModelConfig } from '../types';
import type { CustomModel } from '@industry/common/settings';

type ChatCompletionsReasoningRequestConfig = ReturnType<
  typeof buildChatCompletionsReasoningRequestConfig
>['requestConfig'];

export function hasReasoningEnabled(
  reasoningEffort?: ReasoningEffort
): boolean {
  if (!reasoningEffort) return false;
  return (
    reasoningEffort !== ReasoningEffort.Off &&
    reasoningEffort !== ReasoningEffort.None
  );
}

export function resolveChatCompletionsProviderReasoningEffort({
  apiProvider,
  config,
  reasoningEffort,
}: {
  apiProvider: ApiProvider | null | undefined;
  config?: Pick<LLMModelConfig, 'apiProviderConfig'>;
  reasoningEffort: ReasoningEffort;
}): ReasoningEffort {
  return coerceProviderReasoningEffort({
    apiProvider,
    modelConfig: config,
    reasoningEffort,
  });
}

/**
 * Provider-level extras merged into the OpenAI-compatible Chat Completions
 * request body.
 *
 * Currently covers:
 * - Fireworks' `service_tier: "priority"`: Fireworks' standard serverless
 *   pool is best-effort and returns HTTP 429 under shared-load congestion;
 *   priority traffic uses a separate, less-contended queue and is strongly
 *   recommended for production Industry workloads (see
 *   https://docs.fireworks.ai/guides/serverless-products#priority-serverless).
 * - Baseten's `chat_template_args.enable_thinking` flag for models with a
 *   thinking toggle.
 *
 * Notes:
 * - Priority is only accepted on the Fireworks OpenAI-compatible
 *   `/v1/chat/completions` endpoint; the Anthropic-compat `/v1/messages`
 *   endpoint rejects `service_tier`, so this helper deliberately returns
 *   nothing for non-chat-completions paths (callers simply don't invoke it).
 * - We skip BYOK custom models because we don't know whether the user's
 *   Fireworks account has priority enabled — BYOK callers can opt in
 *   explicitly via `customModel.extraArgs`.
 * - Fireworks treats `service_tier` as a no-op on models that are not
 *   listed for priority, so gating on `apiProvider` alone is safe and
 *   avoids per-model bookkeeping.
 */
export function chatCompletionsProviderParams({
  apiProvider,
  hasCustomModel,
  customModelThinkingEnabled = false,
  supportsThinkingToggle = false,
  reasoningEffort,
  modelConfig,
}: {
  apiProvider: ApiProvider | null | undefined;
  hasCustomModel: boolean;
  customModelThinkingEnabled?: boolean;
  supportsThinkingToggle?: boolean;
  reasoningEffort: ReasoningEffort;
  modelConfig?: Pick<LLMModelConfig, 'apiProviderConfig'>;
}):
  | {
      service_tier?: 'priority';
      chat_template_args?: { enable_thinking: boolean };
    }
  | undefined {
  const params: {
    service_tier?: 'priority';
    chat_template_args?: { enable_thinking: boolean };
  } = {};
  const providerConfig = getProviderChatCompletionsConfig(apiProvider);

  if (!hasCustomModel && providerConfig?.serviceTier) {
    params.service_tier = providerConfig.serviceTier;
  }

  const enableThinking =
    customModelThinkingEnabled || hasReasoningEnabled(reasoningEffort);
  const optInParam = getProviderThinkingOptInParam({
    apiProvider,
    modelConfig,
    forCustomModel: customModelThinkingEnabled,
  });

  if (
    optInParam?.type === 'chat_template_args' &&
    (enableThinking || supportsThinkingToggle)
  ) {
    params.chat_template_args = { [optInParam.key]: enableThinking };
  }

  if (Object.keys(params).length === 0) return undefined;
  return params;
}

export function resolveChatCompletionsReasoningRequestConfig({
  apiProvider,
  customModel,
  customModelSupportedEfforts,
  config,
  reasoningEffort,
  model,
}: {
  apiProvider?: ApiProvider | null;
  customModel?: Pick<
    CustomModel,
    'enableThinking' | 'thinkingMaxTokens' | 'reasoningEffort' | 'model'
  > | null;
  customModelSupportedEfforts?: readonly ReasoningEffort[];
  config?: Pick<
    LLMModelConfig,
    'apiProviderConfig' | 'reasoningEffort' | 'chatCompletionRequest'
  >;
  reasoningEffort: ReasoningEffort;
  model: string;
}): ChatCompletionsReasoningRequestConfig {
  if (
    shouldOmitDisabledReasoningParams({
      apiProvider,
      modelConfig: config,
      reasoningEffort,
    })
  ) {
    return {};
  }

  const supportedEfforts = customModel
    ? (customModelSupportedEfforts ?? [ReasoningEffort.None])
    : (config?.reasoningEffort?.supported ?? [ReasoningEffort.None]);
  const { requestConfig, shouldLogUnsupportedEffort } =
    buildChatCompletionsReasoningRequestConfig({
      apiProvider,
      reasoningEffort,
      supportedEfforts,
      thinkingEnabled: customModel?.enableThinking ?? false,
      thinkingTokens: customModel?.thinkingMaxTokens,
      buildRequestParams: config?.chatCompletionRequest?.buildRequestParams,
    });

  if (shouldLogUnsupportedEffort) {
    logWarn(
      '[sendOpenAIChatMessage] Reasoning effort not supported by model, skipping',
      {
        modelId: model,
        reasoningEffort,
        // eslint-disable-next-line industry/no-nested-log-metadata -- supported reasoning-effort list consumed as a unit
        value: { supportedEfforts },
      }
    );
  }

  return requestConfig;
}

type ReasoningHistoryMode = 'interleaved' | 'preserved';
type ReasoningEffortMapper = (
  effort: ReasoningEffort,
  apiProvider?: ApiProvider | null
) => string;

function defaultReasoningEffortMapper(effort: ReasoningEffort): string {
  return effort === ReasoningEffort.Off ? 'none' : mapToOpenAIEffort(effort);
}

function deepSeekReasoningEffortMapper(
  effort: ReasoningEffort,
  apiProvider?: ApiProvider | null
): string {
  if (effort === ReasoningEffort.Off) {
    return ReasoningEffort.None;
  }

  return resolveProviderReasoningEffortValue({
    apiProvider,
    effort,
  });
}

function glmReasoningEffortMapper(
  effort: ReasoningEffort,
  apiProvider?: ApiProvider | null
): string {
  if (effort === ReasoningEffort.Off) {
    return ReasoningEffort.None;
  }

  return resolveProviderReasoningEffortValue({
    apiProvider,
    effort,
  });
}

function reasoningContentChatCompletionRequest(
  reasoningHistory: ReasoningHistoryMode,
  mapReasoningEffort: ReasoningEffortMapper = defaultReasoningEffortMapper
): ChatCompletionRequestConfig {
  return {
    acceptsReasoning: true,
    reasoningFieldName: ChatCompletionReasoningField.ReasoningContent,
    buildRequestParams: ({ effort, apiProvider }) => {
      if (
        effort === ReasoningEffort.None ||
        effort === ReasoningEffort.Dynamic
      ) {
        return {};
      }
      const params: Record<string, unknown> = {
        reasoning_effort: mapReasoningEffort(effort, apiProvider),
      };
      if (effort !== ReasoningEffort.Off) {
        params.reasoning_history = reasoningHistory;
      }
      return params;
    },
  };
}

export function kimiReasoningContentChatCompletionRequest(): ChatCompletionRequestConfig {
  return reasoningContentChatCompletionRequest('preserved');
}

export function deepSeekReasoningContentChatCompletionRequest(): ChatCompletionRequestConfig {
  return {
    ...reasoningContentChatCompletionRequest(
      'interleaved',
      deepSeekReasoningEffortMapper
    ),
    // DeepSeek V4 thinking mode 400s if any assistant tool-call turn omits
    // reasoning_content on replay, so it must be present on every such turn.
    reasoningRequiredOnReplay: true,
  };
}

export function glmReasoningContentChatCompletionRequest(): ChatCompletionRequestConfig {
  return reasoningContentChatCompletionRequest(
    'preserved',
    glmReasoningEffortMapper
  );
}
