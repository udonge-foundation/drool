/**
 * Centralized inference-provider registry.
 *
 * Owns provider-specific Chat Completions request behavior and mechanics:
 * service tiers, reasoning effort value rewrites, disabled-reasoning coercions,
 * and thinking toggle wire params.
 *
 * Keep `model-registry` as the source of truth for model availability and
 * capabilities, including per-model provider config consumed by this file.
 */
import {
  ApiProvider,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';

import type { LLMModelConfig } from './types';

type ProviderThinkingMode = 'forced-on' | 'opt-in';
type ProviderThinkingOptInParam = {
  type: 'chat_template_args';
  key: 'enable_thinking';
};
type ProviderThinkingConfig =
  | {
      defaultMode: 'forced-on';
      optInParam?: ProviderThinkingOptInParam;
    }
  | {
      defaultMode: 'opt-in';
      optInParam: ProviderThinkingOptInParam;
    };

interface ProviderReasoningEffortCoercion {
  from: readonly ReasoningEffort[];
  to: ReasoningEffort;
}

interface ProviderReasoningEffortConfig {
  valueOverrides?: Partial<Record<ReasoningEffort, string>>;
  coercions?: readonly ProviderReasoningEffortCoercion[];
}

interface ProviderChatCompletionsConfig {
  serviceTier?: 'priority';
  thinking?: ProviderThinkingConfig;
  reasoningEffort?: ProviderReasoningEffortConfig;
}

interface InferenceProviderConfig {
  chatCompletions?: ProviderChatCompletionsConfig;
}

const INFERENCE_PROVIDER_CONFIGS: Partial<
  Record<ApiProvider, InferenceProviderConfig>
> = {
  [ApiProvider.FIREWORKS]: {
    chatCompletions: {
      serviceTier: 'priority',
    },
  },
  [ApiProvider.BASETEN]: {
    chatCompletions: {
      thinking: {
        defaultMode: 'forced-on',
        optInParam: {
          type: 'chat_template_args',
          key: 'enable_thinking',
        },
      },
      reasoningEffort: {
        valueOverrides: {
          [ReasoningEffort.Max]: 'xhigh',
        },
        coercions: [
          {
            from: [ReasoningEffort.Off, ReasoningEffort.None],
            to: ReasoningEffort.Low,
          },
        ],
      },
    },
  },
} as const;

export function getProviderChatCompletionsConfig(
  apiProvider: ApiProvider | null | undefined
): ProviderChatCompletionsConfig | undefined {
  if (!apiProvider) return undefined;
  return INFERENCE_PROVIDER_CONFIGS[apiProvider]?.chatCompletions;
}

function getProviderThinkingMode({
  apiProvider,
  modelConfig,
}: {
  apiProvider: ApiProvider | null | undefined;
  modelConfig?: Pick<LLMModelConfig, 'apiProviderConfig'>;
}): ProviderThinkingMode {
  const thinking = getProviderChatCompletionsConfig(apiProvider)?.thinking;
  if (!thinking) return 'forced-on';
  const modelThinkingMode = apiProvider
    ? modelConfig?.apiProviderConfig?.[apiProvider]?.chatCompletions
        ?.thinkingMode
    : undefined;
  if (modelThinkingMode) return modelThinkingMode;
  return thinking.defaultMode;
}

export function getProviderThinkingOptInParam({
  apiProvider,
  modelConfig,
  forCustomModel = false,
}: {
  apiProvider: ApiProvider | null | undefined;
  modelConfig?: Pick<LLMModelConfig, 'apiProviderConfig'>;
  forCustomModel?: boolean;
}): ProviderThinkingOptInParam | undefined {
  const thinking = getProviderChatCompletionsConfig(apiProvider)?.thinking;

  if (!thinking?.optInParam) return undefined;
  if (forCustomModel) return thinking.optInParam;
  if (getProviderThinkingMode({ apiProvider, modelConfig }) === 'opt-in') {
    return thinking.optInParam;
  }
  return undefined;
}

export function shouldOmitDisabledReasoningParams({
  apiProvider,
  modelConfig,
  reasoningEffort,
}: {
  apiProvider: ApiProvider | null | undefined;
  modelConfig?: Pick<LLMModelConfig, 'apiProviderConfig'>;
  reasoningEffort: ReasoningEffort;
}): boolean {
  if (
    reasoningEffort !== ReasoningEffort.Off &&
    reasoningEffort !== ReasoningEffort.None
  ) {
    return false;
  }
  return getProviderThinkingMode({ apiProvider, modelConfig }) === 'opt-in';
}

export function resolveProviderReasoningEffortValue({
  apiProvider,
  effort,
}: {
  apiProvider: ApiProvider | null | undefined;
  effort: ReasoningEffort;
}): string {
  return (
    getProviderChatCompletionsConfig(apiProvider)?.reasoningEffort
      ?.valueOverrides?.[effort] ?? effort
  );
}

export function coerceProviderReasoningEffort({
  apiProvider,
  modelConfig,
  reasoningEffort,
}: {
  apiProvider: ApiProvider | null | undefined;
  modelConfig?: Pick<LLMModelConfig, 'apiProviderConfig'>;
  reasoningEffort: ReasoningEffort;
}): ReasoningEffort {
  if (getProviderThinkingMode({ apiProvider, modelConfig }) === 'opt-in') {
    return reasoningEffort;
  }

  const coercions =
    getProviderChatCompletionsConfig(apiProvider)?.reasoningEffort?.coercions ??
    [];

  for (const coercion of coercions) {
    if (!coercion.from.includes(reasoningEffort)) continue;
    return coercion.to;
  }

  return reasoningEffort;
}
