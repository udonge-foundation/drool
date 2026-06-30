// Kept in its own file so the export has a cross-file production
// consumer; otherwise knip flags it as test-only.
import {
  ApiProvider,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';
import { MetaError } from '@industry/logging/errors';
import { getLLMConfig } from '@industry/utils/llm';

import { MODEL_CARDS } from './model-cards';

import type { CandidateModel } from './types';
import type { BuiltInModelID } from '@industry/drool-sdk-ext/protocol/llm';

/**
 * Cross-checks apiProvider / reasoningEffort / shortDescription
 * against the model registry at module load — any drift throws on
 * import and surfaces at CLI/backend boot, not at routing time.
 * `supportsImages` is derived from the registry, not overridable.
 */
export function defineCandidate<Id extends BuiltInModelID>(
  modelId: Id,
  opts: {
    apiProvider?: ApiProvider;
    reasoningEffort?: ReasoningEffort;
    shortDescription?: string;
    inputCostPer1M: number;
    outputCostPer1M: number;
  }
): CandidateModel {
  const config = getLLMConfig({ modelId });

  const apiProvider = opts.apiProvider ?? config.apiProviders[0];
  if (apiProvider === undefined) {
    throw new MetaError(
      'Router candidate has no usable apiProvider: registry entry advertises none',
      { modelId }
    );
  }
  if (!config.apiProviders.includes(apiProvider)) {
    throw new MetaError(
      'Router candidate apiProvider is not in the registry allow-list',
      {
        modelId,
        apiProvider,
        value: { registryApiProviders: config.apiProviders },
      }
    );
  }

  const reasoningEffort =
    opts.reasoningEffort ?? config.reasoningEffort.default;
  if (!config.reasoningEffort.supported.includes(reasoningEffort)) {
    throw new MetaError(
      'Router candidate reasoningEffort is not in the registry supported set',
      {
        modelId,
        reasoningEffort,
        value: { registrySupportedEfforts: config.reasoningEffort.supported },
      }
    );
  }

  const shortDescription = opts.shortDescription ?? MODEL_CARDS[modelId];
  if (shortDescription === undefined || shortDescription.trim() === '') {
    throw new MetaError(
      'Router candidate has no prompt card: pass shortDescription or register the model in MODEL_CARDS',
      { modelId }
    );
  }

  return {
    modelId,
    apiProvider,
    reasoningEffort,
    supportsImages: config.images !== false,
    shortDescription,
    inputCostPer1M: opts.inputCostPer1M,
    outputCostPer1M: opts.outputCostPer1M,
  };
}
