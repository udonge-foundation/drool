import { ApiProvider } from '@industry/drool-sdk-ext/protocol/llm';
import { logInfo, MetaError } from '@industry/logging';
import { getCachedRegion } from '@industry/runtime/auth';
import { getAvailableProvidersForModel } from '@industry/utils/llm';

import { getModelProviderInfo } from '@/llm-proxy/getModelProviderInfo';
import type { ModelProviderInfo } from '@/llm-proxy/types';
import { getEnabledProviders } from '@/utils/providerLocking';

/**
 * Returns the ordered list of routed API providers enabled for a model.
 *
 * On empty intersection we deliberately fall back to the first region-eligible
 * registry provider rather than the full registry list: expanding to the
 * registry would re-introduce deprecated providers from stale model definitions
 * when dyncon hasn't loaded yet, which is exactly how FAC-18429 snuck through.
 */
export function getRoutedApiProviders(
  modelInfo: ModelProviderInfo
): ApiProvider[] {
  const staticProviderSet = new Set<ApiProvider>(modelInfo.apiProviders);
  const regionEligibleForModel = new Set<ApiProvider>(
    getAvailableProvidersForModel(modelInfo.id, getCachedRegion())
  );
  const enabledProviders = getEnabledProviders(modelInfo.id);
  const filtered = enabledProviders.filter(
    (p) => staticProviderSet.has(p) && regionEligibleForModel.has(p)
  );

  if (filtered.length > 0) {
    return filtered;
  }

  const primary = modelInfo.apiProviders.find((p) =>
    regionEligibleForModel.has(p)
  );
  return primary ? [primary] : [];
}

export function getNextProvider({
  model,
  currentProvider,
  lockedProvider,
  onRotate,
  rotateIfValid = true,
}: {
  model: string;
  currentProvider?: ApiProvider;
  lockedProvider?: ApiProvider | null;
  onRotate?: (from: ApiProvider, to: ApiProvider) => void;
  rotateIfValid?: boolean;
}): ApiProvider {
  const modelInfo = getModelProviderInfo(model);
  const providers = getRoutedApiProviders(modelInfo);

  if (providers.length === 0) {
    throw new MetaError('No providers available', {
      modelId: model,
      providerType: modelInfo.modelProvider,
    });
  }

  if (lockedProvider && providers.includes(lockedProvider)) {
    return lockedProvider;
  }

  if (!currentProvider || !providers.includes(currentProvider)) {
    return providers[0];
  }

  if (providers.length <= 1 || !rotateIfValid) {
    return currentProvider;
  }

  const currentIndex = providers.indexOf(currentProvider);
  const nextIndex = (currentIndex + 1) % providers.length;
  const nextProvider = providers[nextIndex];

  logInfo('Rotating provider', {
    modelId: model,
    providerType: modelInfo.modelProvider,
    fromApiProvider: currentProvider,
    toApiProvider: nextProvider,
  });

  onRotate?.(currentProvider, nextProvider);

  return nextProvider;
}
