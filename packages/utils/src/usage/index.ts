import {
  CACHE_CREATION_TOKENS_MULTIPLIER,
  DEFAULT_CACHE_READ_TOKENS_MULTIPLIER,
} from '@industry/common/usage';
import { ModelID, ModelProvider } from '@industry/drool-sdk-ext/protocol/llm';

import { getEffectiveTokenMultiplier, getModel } from '../llm';

// Provider-level output token multipliers (fallback when model doesn't specify)
const PROVIDER_OUTPUT_MULTIPLIER: Partial<Record<ModelProvider, number>> = {
  [ModelProvider.ANTHROPIC]: 5.0,
  [ModelProvider.OPENAI]: 8.0,
  [ModelProvider.GOOGLE]: 6.0,
  [ModelProvider.INDUSTRY]: 4.0,
  [ModelProvider.XAI]: 5.0,
};
const DEFAULT_OUTPUT_MULTIPLIER = 4.0;

export function formatTokenCount(value: number): string {
  const safeValue = Number.isFinite(value) ? value : 0;

  if (safeValue >= 1_000_000_000) {
    return `${(safeValue / 1_000_000_000).toFixed(1)}B`;
  }
  if (safeValue >= 1_000_000) {
    return `${(safeValue / 1_000_000).toFixed(1)}M`;
  }
  if (safeValue >= 1_000) {
    return `${(safeValue / 1_000).toFixed(1)}K`;
  }
  return `${safeValue}`;
}

interface GetOutputTokenMultiplierOptions {
  defaultOutputMultiplier?: number;
}

function getOutputTokenMultiplierForModelConfig(
  modelConfig: ReturnType<typeof getModel>,
  {
    defaultOutputMultiplier = DEFAULT_OUTPUT_MULTIPLIER,
  }: GetOutputTokenMultiplierOptions = {}
): number {
  return (
    modelConfig.cost.outputTokenMultiplier ??
    PROVIDER_OUTPUT_MULTIPLIER[modelConfig.provider] ??
    defaultOutputMultiplier
  );
}

export function getOutputTokenMultiplier(
  model: ModelID | string,
  options?: GetOutputTokenMultiplierOptions
): number {
  return getOutputTokenMultiplierForModelConfig(getModel(model), options);
}

interface CalculateIndustryTokenUsageParams {
  model: ModelID;
  inputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
}

export function calculateIndustryTokenUsage({
  model,
  inputTokens,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0,
  outputTokens = 0,
}: CalculateIndustryTokenUsageParams): number {
  // getModel throws for unknown models (preserves original behavior)
  const modelConfig = getModel(model);
  const cacheReadTokenMultiplier =
    modelConfig.cost.cacheReadTokenMultiplier ??
    DEFAULT_CACHE_READ_TOKENS_MULTIPLIER;
  const outputMultiplier = getOutputTokenMultiplierForModelConfig(modelConfig);

  let totalTokens =
    inputTokens +
    CACHE_CREATION_TOKENS_MULTIPLIER * cacheCreationInputTokens +
    cacheReadTokenMultiplier * cacheReadInputTokens +
    outputMultiplier * outputTokens;

  totalTokens *= getEffectiveTokenMultiplier(modelConfig.cost);
  totalTokens = Math.ceil(totalTokens);
  return totalTokens;
}
