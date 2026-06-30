import { IndustryRegion } from '@industry/common/shared';
import { ApiProvider } from '@industry/drool-sdk-ext/protocol/llm';
import { MetaError } from '@industry/logging/errors';

import { MODEL_PROVIDER_REGION_OVERRIDES, PROVIDER_REGIONS } from './constants';
import { MODEL_REGISTRY, resolveModelId } from './model-registry';

import type { ModelID } from '@industry/drool-sdk-ext/protocol/llm';

export function getProvidersAvailableInRegion(
  region: IndustryRegion
): Set<ApiProvider> {
  const result = new Set<ApiProvider>();
  for (const [provider, regions] of Object.entries(PROVIDER_REGIONS) as Array<
    [ApiProvider, IndustryRegion[]]
  >) {
    if (regions.includes(region)) {
      result.add(provider);
    }
  }
  return result;
}

/**
 * Intersection of model.apiProviders ∩ PROVIDER_REGIONS[provider],
 * further narrowed by MODEL_PROVIDER_REGION_OVERRIDES[modelId][provider]
 * if present. Empty array → model not available in this region.
 */
export function getAvailableProvidersForModel(
  modelId: ModelID,
  region: IndustryRegion
): ApiProvider[] {
  const resolvedId = resolveModelId(modelId);
  const config = resolvedId ? MODEL_REGISTRY[resolvedId] : undefined;
  if (!resolvedId || !config) {
    throw new MetaError('Unknown model', { modelId });
  }
  const allowed = getProvidersAvailableInRegion(region);
  const overrides = MODEL_PROVIDER_REGION_OVERRIDES[resolvedId];
  return config.apiProviders.filter((p) => {
    if (!allowed.has(p)) return false;
    const override = overrides?.[p];
    return override === undefined || override.includes(region);
  });
}

export function isModelAvailableInRegion(
  modelId: ModelID,
  region: IndustryRegion
): boolean {
  return getAvailableProvidersForModel(modelId, region).length > 0;
}
