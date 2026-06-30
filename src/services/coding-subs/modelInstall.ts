import {
  ModelProvider,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';
import {
  type CodingSubscriptionAuthRecord,
  type CodingSubscriptionProvider,
} from '@industry/runtime/auth';
import { CLI_MODELS, getModel } from '@industry/utils/llm';

import { getSettingsService } from '@/services/SettingsService';

import type { CustomModel } from '@industry/common/settings';

const API_KEY_PREFIX = 'coding-subs://';

interface ProviderModelConfig {
  displayName: string;
  baseUrl: string;
  provider: ModelProvider;
  reasoningEffort: ReasoningEffort;
}

const PROVIDER_MODELS: Record<
  CodingSubscriptionProvider,
  ProviderModelConfig
> = {
  codex: {
    displayName: 'Codex',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    provider: ModelProvider.OPENAI,
    reasoningEffort: ReasoningEffort.Medium,
  },
  claude: {
    displayName: 'Claude Code',
    baseUrl: 'https://api.anthropic.com',
    provider: ModelProvider.ANTHROPIC,
    reasoningEffort: ReasoningEffort.Medium,
  },
  antigravity: {
    displayName: 'Antigravity',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    provider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
    reasoningEffort: ReasoningEffort.Medium,
  },
  kimi: {
    displayName: 'Kimi',
    baseUrl: 'https://api.kimi.com/coding',
    provider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
    reasoningEffort: ReasoningEffort.Medium,
  },
  xai: {
    displayName: 'Grok Build / xAI',
    baseUrl: 'https://api.x.ai/v1',
    provider: ModelProvider.XAI,
    reasoningEffort: ReasoningEffort.Medium,
  },
};

export const CODING_SUBSCRIPTION_PROVIDER_LABELS: Record<
  CodingSubscriptionProvider,
  string
> = {
  codex: 'Codex',
  claude: 'Claude Code',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  xai: 'Grok Build / xAI',
};

function customModelId(provider: CodingSubscriptionProvider, model: string): string {
  return `custom:${provider}-${model.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
}

function cleanModelDisplayName(value: string): string {
  return value.replace(/\s*\([^)]*Drool Core[^)]*\)\s*/gi, ' ').replace(/\bDeprecate(?:d)?\b/gi, '').trim();
}

function isCodingSubscriptionModel(model: CustomModel): boolean {
  return parseCodingSubscriptionApiKey(model.apiKey) !== null;
}

function providerMatchesRegistryModel(
  provider: CodingSubscriptionProvider,
  modelId: string
): boolean {
  const config = getModel(modelId);
  if (provider === 'codex') return config.provider === ModelProvider.OPENAI;
  if (provider === 'claude') return config.provider === ModelProvider.ANTHROPIC;
  if (provider === 'antigravity') return config.provider === ModelProvider.GOOGLE;
  if (provider === 'xai') return config.provider === ModelProvider.XAI;
  if (provider === 'kimi') {
    return (
      modelId.toLowerCase().startsWith('kimi-') ||
      config.name.toLowerCase().includes('kimi')
    );
  }
  return false;
}

function registryModelsForProvider(provider: CodingSubscriptionProvider): string[] {
  return CLI_MODELS.filter((modelId) =>
    providerMatchesRegistryModel(provider, modelId)
  );
}

function createSubscriptionModel(
  provider: CodingSubscriptionProvider,
  model: string,
  auth: CodingSubscriptionAuthRecord,
  index: number,
  existing?: CustomModel
): CustomModel {
  const template = PROVIDER_MODELS[provider];
  const displayName = cleanModelDisplayName(model);
  const registryConfig = getModel(model);
  return {
    ...template,
    model,
    displayName: cleanModelDisplayName(registryConfig.name ?? displayName),
    reasoningEffort: registryConfig.reasoningEffort?.default ?? template.reasoningEffort,
    apiKey: `${API_KEY_PREFIX}${provider}`,
    baseUrl: auth.base_url || template.baseUrl,
    index,
    id: existing?.id ?? customModelId(provider, model),
  };
}

export async function installCodingSubscriptionModels(
  auth: CodingSubscriptionAuthRecord
): Promise<boolean> {
  const settings = getSettingsService();
  const current = settings.getCustomModels();
  const preservedModels = current.filter(
    (model) => parseCodingSubscriptionApiKey(model.apiKey) !== auth.type
  );
  const existingByProviderModel = new Map<string, CustomModel>();
  for (const model of current) {
    const provider = parseCodingSubscriptionApiKey(model.apiKey);
    if (provider !== auth.type) continue;
    existingByProviderModel.set(`${provider}:${model.model}`, model);
  }

  const refreshedModels: CustomModel[] = [];
  const models = registryModelsForProvider(auth.type);
  for (const model of models) {
    const index = preservedModels.length + refreshedModels.length;
    refreshedModels.push(
      createSubscriptionModel(
        auth.type,
        model,
        auth,
        index,
        existingByProviderModel.get(`${auth.type}:${model}`)
      )
    );
  }

  const next = [...preservedModels, ...refreshedModels];
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) {
    settings.updateSettings({ general: { customModels: next } });
  }
  return changed;
}

export function parseCodingSubscriptionApiKey(
  apiKey: string | undefined
): CodingSubscriptionProvider | null {
  if (!apiKey?.startsWith(API_KEY_PREFIX)) return null;
  return apiKey.slice(API_KEY_PREFIX.length) as CodingSubscriptionProvider;
}
