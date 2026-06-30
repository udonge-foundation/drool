import { IndustryRegion } from '@industry/common/shared';
import { ModelID } from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn } from '@industry/logging';

import {
  CLI_MODELS,
  getLLMConfig,
  getModelConfig,
  isModelAvailableInRegion,
} from '../llm';
import { getCustomModelReasoningMetadata } from './customModels';
import { MODEL_REGISTRY, resolveModelId } from '../llm/model-registry';

import type { FeatureFlagFetcher } from './types';
import type {
  HardDeprecatedModelFallbackResolution,
  LLMModelConfig,
} from '../llm/types';
import type { CustomModel } from '@industry/common/settings';
import type { AvailableModelConfig } from '@industry/drool-sdk-ext/protocol/drool';

type HardDeprecationConfig = NonNullable<
  NonNullable<LLMModelConfig['deprecation']>['hard']
>;
type HardDeprecationFlag = HardDeprecationConfig['featureFlag'];

export function getHardDeprecatedModelFlag(
  modelId: string
): HardDeprecationFlag | undefined {
  const resolvedModelId = resolveModelId(modelId);
  if (!resolvedModelId) return undefined;
  return MODEL_REGISTRY[resolvedModelId]?.deprecation?.hard?.featureFlag;
}

function getHardDeprecationFallbackModelId(
  modelId: string
): ModelID | undefined {
  const resolvedModelId = resolveModelId(modelId);
  if (!resolvedModelId) return undefined;
  return MODEL_REGISTRY[resolvedModelId]?.deprecation?.hard?.fallbackModelId;
}

export function resolveHardDeprecatedModelFallbackCore(
  modelId: string,
  options: {
    getFlag: (flag: HardDeprecationFlag) => boolean;
    isCandidateAvailable?: (candidateModelId: ModelID) => boolean;
    isCandidateAllowed?: (candidateModelId: ModelID) => boolean;
  }
): HardDeprecatedModelFallbackResolution | null {
  const deprecatedModelId = resolveModelId(modelId);
  if (!deprecatedModelId) return null;

  const hardDeprecationFlag = getHardDeprecatedModelFlag(deprecatedModelId);
  if (!hardDeprecationFlag || !options.getFlag(hardDeprecationFlag)) {
    return null;
  }

  const resolveFallbackCandidate = (
    candidateModelId: ModelID,
    seenModelIds: ReadonlySet<ModelID>
  ): ModelID | undefined => {
    if (seenModelIds.has(candidateModelId)) {
      return undefined;
    }

    const candidateConfig = MODEL_REGISTRY[candidateModelId];
    if (!candidateConfig) {
      return undefined;
    }

    const nextSeenModelIds = new Set(seenModelIds).add(candidateModelId);
    const candidateHardDeprecationFlag =
      candidateConfig.deprecation?.hard?.featureFlag;
    if (
      candidateHardDeprecationFlag &&
      options.getFlag(candidateHardDeprecationFlag)
    ) {
      const nextFallbackModelId =
        getHardDeprecationFallbackModelId(candidateModelId);
      return nextFallbackModelId
        ? resolveFallbackCandidate(nextFallbackModelId, nextSeenModelIds)
        : undefined;
    }

    if (candidateConfig.deprecation) return undefined;

    if (
      options.isCandidateAvailable &&
      !options.isCandidateAvailable(candidateModelId)
    ) {
      return undefined;
    }

    const isCandidateAllowed =
      options.isCandidateAllowed?.(candidateModelId) ?? true;
    return isCandidateAllowed ? candidateModelId : undefined;
  };

  const fallbackCandidateModelId =
    getHardDeprecationFallbackModelId(deprecatedModelId);
  return {
    deprecatedModelId,
    fallbackModelId: fallbackCandidateModelId
      ? resolveFallbackCandidate(
          fallbackCandidateModelId,
          new Set([deprecatedModelId])
        )
      : undefined,
  };
}

/**
 * Get models enabled by default (sync - safe fallback when feature flags unavailable)
 */
export function getDefaultEnabledModels(): ModelID[] {
  return CLI_MODELS.filter((modelId) => {
    const config = getLLMConfig({ modelId });
    const isModelFeatureEnabled =
      !config.featureFlag || config.featureFlag.defaultValue;
    const isHardDeprecated =
      config.deprecation?.hard?.featureFlag.defaultValue === true;
    return isModelFeatureEnabled && !isHardDeprecated;
  });
}

/**
 * Filter models based on feature flags
 */
export function filterModelsByFlags(flags: Record<string, boolean>): ModelID[] {
  return CLI_MODELS.filter((modelId) => {
    const config = getLLMConfig({ modelId });
    const modelFeatureFlag = config.featureFlag;
    const isModelFeatureEnabled = modelFeatureFlag
      ? (flags[modelFeatureFlag.statsigName] ?? modelFeatureFlag.defaultValue)
      : true;
    if (!isModelFeatureEnabled) return false;

    const hardDeprecationFeatureFlag = config.deprecation?.hard?.featureFlag;
    const isHardDeprecated = hardDeprecationFeatureFlag
      ? (flags[hardDeprecationFeatureFlag.statsigName] ??
        hardDeprecationFeatureFlag.defaultValue)
      : false;
    return !isHardDeprecated;
  });
}

/**
 * Filter models by deployment region. Drops models with no
 * region-eligible backend (e.g. Fireworks-only models on EU).
 */
export function filterModelsByRegion(
  modelIds: ModelID[],
  region: IndustryRegion
): ModelID[] {
  return modelIds.filter((id) => isModelAvailableInRegion(id, region));
}

/**
 * Get available models for the exec context.
 * Accepts a feature flag fetcher function so both CLI and daemon can use it.
 */
async function getAvailableModelsForExec(
  fetchFeatureFlags: FeatureFlagFetcher
): Promise<ModelID[]> {
  try {
    const allFlags = await fetchFeatureFlags();
    return filterModelsByFlags(allFlags);
  } catch (err) {
    logWarn('Failed to fetch feature flags for model availability', {
      cause: err,
    });
    return getDefaultEnabledModels();
  }
}

/**
 * Format available models for the session init/load/settings response.
 * Combines built-in models (feature-flag + region filtered) with custom
 * BYOK models. Callers pass their own `region` (each host knows its
 * own — the helper stays explicit, no hidden global reads).
 */
export async function getAvailableModelsForResponse(
  fetchFeatureFlags: FeatureFlagFetcher,
  customModels: CustomModel[],
  region: IndustryRegion
): Promise<AvailableModelConfig[]> {
  const flagEnabled = await getAvailableModelsForExec(fetchFeatureFlags);
  const builtInModelIds = filterModelsByRegion(flagEnabled, region);

  const builtInModels: AvailableModelConfig[] = builtInModelIds.map((id) => {
    const config = getModelConfig(id);
    return {
      ...config,
      isCustom: false,
    };
  });

  const customModelConfigs: AvailableModelConfig[] = customModels.map((m) => {
    const reasoningMetadata = getCustomModelReasoningMetadata(
      m.reasoningEffort,
      m.model
    );
    return {
      id: m.id,
      displayName: m.displayName,
      shortDisplayName: m.displayName,
      modelProvider: m.provider,
      ...reasoningMetadata,
      isCustom: true,
      noImageSupport: m.noImageSupport,
    };
  });

  return [...builtInModels, ...customModelConfigs];
}
