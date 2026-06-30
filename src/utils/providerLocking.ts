import { z } from 'zod';

import {
  PROVIDER_FAMILY_KEYS,
  DYNAMIC_CONFIG_SCHEMAS,
  PROVIDER_ROUTING,
} from '@industry/common/feature-flags';
import {
  ApiProvider,
  type ModelID,
  ModelProvider,
} from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn } from '@industry/logging';
import { getDynamicConfig } from '@industry/runtime/feature-flags';
import { getLLMConfig } from '@industry/utils/llm';
import { isOpenAIResponsesApiProvider } from '@industry/utils/llm/providers/openai';

// eslint-disable-next-line industry/types-file-organization -- co-located with the consumer that owns this config
export type ProviderRoutingConfig = z.infer<
  (typeof DYNAMIC_CONFIG_SCHEMAS)[typeof PROVIDER_ROUTING]
>;

/**
 * Read and parse the `provider_routing` dynamic config from the package
 * cache. Returns `null` until `fetchFeatureFlags()` has lifted a payload
 * or when the payload fails schema validation.
 */
function getProviderRoutingConfig(): ProviderRoutingConfig | null {
  const raw = getDynamicConfig(PROVIDER_ROUTING);
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== 'object') {
    logWarn(
      '[providerLocking] provider_routing config is missing or not an object',
      { type: typeof raw }
    );
    return null;
  }
  const parsed = DYNAMIC_CONFIG_SCHEMAS[PROVIDER_ROUTING].safeParse(raw);
  if (!parsed.success) {
    logWarn(
      '[providerLocking] provider_routing config failed schema validation',
      {
        error: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      }
    );
    return null;
  }
  return parsed.data;
}

type ProviderFamilyKey =
  (typeof PROVIDER_FAMILY_KEYS)[keyof typeof PROVIDER_FAMILY_KEYS];

const PROVIDER_FAMILY_KEY: Partial<Record<ModelProvider, ProviderFamilyKey>> = {
  [ModelProvider.ANTHROPIC]: PROVIDER_FAMILY_KEYS.anthropic,
  [ModelProvider.OPENAI]: PROVIDER_FAMILY_KEYS.openai,
  [ModelProvider.INDUSTRY]: PROVIDER_FAMILY_KEYS.industry,
  [ModelProvider.GENERIC_CHAT_COMPLETION_API]: PROVIDER_FAMILY_KEYS.industry,
};

/**
 * Pure resolution logic: given a routing config, resolve the ordered provider list.
 * Exported for testing.
 */
export function resolveProviders(
  routingConfig: ProviderRoutingConfig,
  modelId: ModelID | string,
  modelProvider: ModelProvider,
  registryProviders: ApiProvider[]
): ApiProvider[] {
  // Check model-specific override first
  let providers: ApiProvider[] | undefined =
    routingConfig.models[modelId as string];

  // Fall back to family default
  if (!providers || providers.length === 0) {
    const familyKey = PROVIDER_FAMILY_KEY[modelProvider];
    if (familyKey) {
      providers = routingConfig.defaults[familyKey];
    }
  }

  if (!providers || providers.length === 0) {
    return registryProviders[0] ? [registryProviders[0]] : [];
  }

  // Filter against apiProviders from the model registry
  const registrySet = new Set<ApiProvider>(registryProviders);
  const filtered = providers.filter((p) => registrySet.has(p));

  if (filtered.length === 0) {
    return registryProviders[0] ? [registryProviders[0]] : [];
  }

  return filtered;
}

/**
 * Resolve the ordered list of enabled API providers for a model from the
 * provider routing config. Falls back to `apiProviders[0]` when no config
 * is available.
 */
export function getEnabledProviders(modelId: ModelID | string): ApiProvider[] {
  let registryProviders: ApiProvider[];
  let modelProvider: ModelProvider;
  try {
    const config = getLLMConfig({ modelId: modelId as ModelID });
    registryProviders = config.apiProviders;
    modelProvider = config.provider;
  } catch {
    return [];
  }

  const routingConfig = getProviderRoutingConfig();

  if (!routingConfig) {
    return registryProviders[0] ? [registryProviders[0]] : [];
  }

  return resolveProviders(
    routingConfig,
    modelId,
    modelProvider,
    registryProviders
  );
}

interface SessionServiceLike {
  setLockedModelProviderOnce: (provider: ModelProvider) => void;
  getLockedApiProvider: () => ApiProvider | null;
  setLockedApiProviderOnce: (apiProvider: ApiProvider) => void;
  updateLockedApiProvider: (apiProvider: ApiProvider) => void;
  clearLockedApiProvider: () => void;
}

interface EnsureProviderLocksParams {
  sessionService: SessionServiceLike;
  provider: ModelProvider;
  modelId?: ModelID;
  isCustomModel?: boolean;
}

/**
 * Ensures session provider locks (model provider and API provider family) are
 * consistent with the selected model.
 */
export function ensureProviderLocks({
  sessionService,
  provider,
  modelId,
  isCustomModel,
}: EnsureProviderLocksParams): void {
  sessionService.setLockedModelProviderOnce(provider);

  const existingApiLock = sessionService.getLockedApiProvider();

  // Custom models bypass the Industry proxy. Clear any stale built-in
  // apiProviderLock so routing relies on the custom model settings instead.
  if (isCustomModel) {
    if (existingApiLock) {
      sessionService.clearLockedApiProvider();
    }
    return;
  }

  if (provider === ModelProvider.OPENAI && modelId) {
    // Resolve desired provider from dynamic config (first enabled provider)
    const enabledProviders = getEnabledProviders(modelId);
    const desired =
      enabledProviders.find(isOpenAIResponsesApiProvider) ?? ApiProvider.OPENAI;
    const existingLockAllowed =
      !!existingApiLock &&
      isOpenAIResponsesApiProvider(existingApiLock) &&
      enabledProviders.includes(existingApiLock);
    if (!existingLockAllowed) {
      if (existingApiLock) {
        sessionService.updateLockedApiProvider(desired);
      } else {
        sessionService.setLockedApiProviderOnce(desired);
      }
    }
    return;
  }

  if (provider === ModelProvider.XAI) {
    if (!existingApiLock) {
      sessionService.setLockedApiProviderOnce(ApiProvider.XAI);
    } else if (existingApiLock !== ApiProvider.XAI) {
      sessionService.updateLockedApiProvider(ApiProvider.XAI);
    }
    return;
  }

  if (provider === ModelProvider.GOOGLE) {
    if (!existingApiLock) {
      sessionService.setLockedApiProviderOnce(ApiProvider.GOOGLE);
    } else if (existingApiLock !== ApiProvider.GOOGLE) {
      sessionService.updateLockedApiProvider(ApiProvider.GOOGLE);
    }
  }
  // Routed API provider locks (Anthropic, Industry, and generic chat completions)
  // are resolved, rotated, and persisted after successful responses in the send
  // path so failed providers are not saved before retry rotation can run.
}
