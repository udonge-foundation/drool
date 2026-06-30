/**
 * Centralized model registry.
 * Single source of truth for all model configurations.
 */

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { INDUSTRY_ROUTER_DISPLAY_NAME, VariantBadge } from '@industry/common/llm';
import {
  MODEL_EXPLICIT_OPT_IN_TOS_VERSION,
  ModelExplicitOptInRequirementKind,
} from '@industry/common/policy';
import {
  ApiProvider,
  BillingPool,
  LLMModelTier,
  ModelID,
  ModelKind,
  ModelProvider,
  ReasoningEffort as RE,
} from '@industry/drool-sdk-ext/protocol/llm';

import { ROUTING_CONFIG_KEYS } from './constants';
import { configureModelRegistryAccessors } from './model-registry-accessor';
import {
  claudeAdaptiveThinking,
  claudeDefaultLimits,
  claudeEffortThinking,
  claudeHaikuLimits,
  claudeLimits,
  claudeThinking,
  minimaxEffortThinking,
} from './providers/anthropic';
import {
  deepSeekReasoningContentChatCompletionRequest,
  glmReasoningContentChatCompletionRequest,
  kimiReasoningContentChatCompletionRequest,
} from './providers/completions';
import {
  geminiLimits,
  geminiRequest,
  geminiThinking,
} from './providers/google';
import { fixedLimits, openaiRequest } from './providers/openai';

import type {
  ApiProviderModelConfig,
  LLMModelConfig,
  ThinkingFn,
} from './types';

/**
 * Model aliases for backwards compatibility.
 * Maps legacy/alternate model IDs to their canonical ModelID.
 */
const MODEL_ALIASES: Record<string, ModelID> = {
  'claude-opus-4-20250514': ModelID.CLAUDE_OPUS_4,
  'claude-opus-4-6-fast': ModelID.CLAUDE_OPUS_4_6_FAST,
  'claude-opus-4-7-fast': ModelID.CLAUDE_OPUS_4_7_FAST,
  'claude-opus-4-8-fast': ModelID.CLAUDE_OPUS_4_8_FAST,
  'gpt-5.3-codex-fast': ModelID.GPT_5_3_CODEX_FAST,
  'gpt-5.4-fast': ModelID.GPT_5_4_FAST,
  'gpt-5.5-fast': ModelID.GPT_5_5_FAST,
  'gemini-3-pro-preview': ModelID.GEMINI_3_1_PRO,
  'industry-router': ModelID.INDUSTRY_ROUTER,
};

// Shared provider tuples used by multiple registry entries.
const ANTHROPIC_ALL_PROVIDERS: ApiProvider[] = [
  ApiProvider.ANTHROPIC,
  ApiProvider.VERTEX_ANTHROPIC,
  ApiProvider.BEDROCK_ANTHROPIC,
];

const ANTHROPIC_BEDROCK_ONLY: ApiProvider[] = [
  ApiProvider.ANTHROPIC,
  ApiProvider.BEDROCK_ANTHROPIC,
];

const BASETEN_OPT_IN_THINKING: ApiProviderModelConfig = {
  chatCompletions: { thinkingMode: 'opt-in' },
};

// Shared context-limit closures used by multiple Claude entries.
const CLAUDE_OPUS_LIMITS_867K_128K = claudeLimits({
  thinkingConsumesContext: false,
  maxInputTokens: 867000,
  maxOutputTokens: 128000,
});

const CLAUDE_LIMITS_64K_OUTPUT = claudeLimits({
  thinkingConsumesContext: false,
  maxOutputTokens: 64000,
});

const CLAUDE_SONNET_46_LIMITS = claudeLimits({
  thinkingConsumesContext: false,
  maxInputTokens: 931000,
  maxOutputTokens: 64000,
});

// Shared fixed-limit closures used by multiple OpenAI entries.
const OPENAI_400K_32K_LIMITS = fixedLimits({
  maxInputTokens: 400000,
  maxOutputTokens: 32768,
});

const OPENAI_400K_128K_LIMITS = fixedLimits({
  maxInputTokens: 400000,
  maxOutputTokens: 128000,
});

const OPENAI_922K_128K_LIMITS = fixedLimits({
  maxInputTokens: 922000,
  maxOutputTokens: 128000,
});

// Adaptive thinking with summarized display, shared by Opus 4.7 and Acorn.
const claudeAdaptiveThinkingSummarized: ThinkingFn = (effort) =>
  claudeAdaptiveThinking(effort, { display: 'summarized' });

// Shared OpenAI request closures used by multiple registry entries.
const OPENAI_PARALLEL_CACHED_LOW = openaiRequest({
  parallelToolCalls: true,
  extendedCache: true,
  safetyId: true,
  verbosity: 'low',
});

const OPENAI_PARALLEL_CACHED_LOW_PRIORITY = openaiRequest({
  parallelToolCalls: true,
  extendedCache: true,
  safetyId: true,
  verbosity: 'low',
  serviceTier: 'priority',
});

const OPENAI_PARALLEL_NOCACHE_MEDIUM = openaiRequest({
  parallelToolCalls: true,
  extendedCache: false,
  safetyId: true,
  verbosity: 'medium',
});

/**
 * Resolve a model ID, checking aliases first.
 */
export function resolveModelId(modelId: string): ModelID | undefined {
  if (MODEL_ALIASES[modelId]) {
    return MODEL_ALIASES[modelId];
  }
  if (modelId in ModelID) {
    return modelId as ModelID;
  }
  // Check if it's a valid ModelID value
  const allModelIds = Object.values(ModelID) as string[];
  if (allModelIds.includes(modelId)) {
    return modelId as ModelID;
  }
  return undefined;
}

export function getCanonicalModelId(modelId: string): string {
  return resolveModelId(modelId) ?? modelId;
}

// eslint-disable-next-line industry/constants-file-organization -- Registry, not constant
export const MODEL_REGISTRY: Record<ModelID, LLMModelConfig> = {
  // ============ ANTHROPIC - CLAUDE ============

  [ModelID.CLAUDE_SONNET_3_5]: {
    id: ModelID.CLAUDE_SONNET_3_5,
    name: 'Claude Sonnet 3.5 v2',
    shortName: 'Sonnet 3.5 v2',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: ANTHROPIC_BEDROCK_ONLY,
    reasoningEffort: { supported: [RE.None], default: RE.None },
    tier: LLMModelTier.Standard,
    availableInCLI: false,
    pdf: true,
    contextLimits: claudeHaikuLimits,
    disabledForPilots: false,
    cost: { tokenMultiplier: 1.2 },
  },

  [ModelID.CLAUDE_SONNET_3_7]: {
    id: ModelID.CLAUDE_SONNET_3_7,
    name: 'Claude Sonnet 3.7',
    shortName: 'Sonnet 3.7',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: ANTHROPIC_ALL_PROVIDERS,
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High],
      default: RE.Off,
    },
    tier: LLMModelTier.Standard,
    availableInCLI: false,
    pdf: true,
    contextLimits: claudeDefaultLimits,
    thinking: claudeThinking,
    disabledForPilots: false,
    cost: { tokenMultiplier: 1.2 },
  },

  [ModelID.CLAUDE_SONNET_4]: {
    id: ModelID.CLAUDE_SONNET_4,
    name: 'Claude Sonnet 4',
    shortName: 'Sonnet 4',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: ANTHROPIC_ALL_PROVIDERS,
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High],
      default: RE.Off,
    },
    tier: LLMModelTier.Standard,
    availableInCLI: false,
    pdf: true,
    contextLimits: claudeDefaultLimits,
    thinking: claudeThinking,
    disabledForPilots: false,
    cost: { tokenMultiplier: 1.2 },
    matchPatterns: [/sonnet[^a-z0-9]*4(?![.\d])/i],
  },

  [ModelID.CLAUDE_OPUS_4]: {
    id: ModelID.CLAUDE_OPUS_4,
    name: 'Claude Opus 4.1',
    shortName: 'Opus 4.1',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: ANTHROPIC_ALL_PROVIDERS,
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High],
      default: RE.Off,
    },
    tier: LLMModelTier.Premium,
    availableInCLI: false,
    pdf: true,
    contextLimits: claudeDefaultLimits,
    thinking: claudeThinking,
    disabledForPilots: false,
    cost: { tokenMultiplier: 6 },
    matchPatterns: [/opus[^a-z0-9]*4[.-]?1/i],
  },

  [ModelID.CLAUDE_SONNET_4_5]: {
    id: ModelID.CLAUDE_SONNET_4_5,
    name: 'Claude Sonnet 4.5',
    shortName: 'Sonnet 4.5',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: ANTHROPIC_ALL_PROVIDERS,
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High],
      default: RE.Off,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    contextLimits: claudeDefaultLimits,
    thinking: claudeThinking,
    disabledForPilots: false,
    cost: { tokenMultiplier: 1.2 },
    matchPatterns: [/sonnet[^a-z0-9]*4\.?5/i, /claude-sonnet-4-5/i],
  },

  [ModelID.CLAUDE_OPUS_4_5]: {
    id: ModelID.CLAUDE_OPUS_4_5,
    name: 'Claude Opus 4.5',
    shortName: 'Opus 4.5',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: ANTHROPIC_ALL_PROVIDERS,
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High],
      default: RE.Off,
    },
    tier: LLMModelTier.Premium,
    pdf: true,
    contextLimits: CLAUDE_LIMITS_64K_OUTPUT,
    thinking: claudeEffortThinking,
    disabledForPilots: false,
    cost: { tokenMultiplier: 2.0 },
    matchPatterns: [/opus[^a-z0-9]*4[.-]?5/i, /claude-opus-4-5/i],
  },

  [ModelID.CLAUDE_SONNET_4_6]: {
    id: ModelID.CLAUDE_SONNET_4_6,
    name: 'Claude Sonnet 4.6',
    shortName: 'Sonnet 4.6',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: ANTHROPIC_ALL_PROVIDERS,
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High, RE.Max],
      default: RE.High,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    contextLimits: CLAUDE_SONNET_46_LIMITS,
    thinking: claudeAdaptiveThinking,
    disabledForPilots: false,
    cost: { tokenMultiplier: 1.2 },
    matchPatterns: [/sonnet[^a-z0-9]*4[.-]?6/i, /claude-sonnet-4-6/i],
  },

  [ModelID.CLAUDE_OPUS_4_6]: {
    id: ModelID.CLAUDE_OPUS_4_6,
    name: 'Claude Opus 4.6',
    shortName: 'Opus 4.6',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: ANTHROPIC_ALL_PROVIDERS,
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High, RE.Max],
      default: RE.High,
    },
    tier: LLMModelTier.Premium,
    pdf: true,
    contextLimits: CLAUDE_OPUS_LIMITS_867K_128K,
    thinking: claudeAdaptiveThinking,
    disabledForPilots: false,
    cost: { tokenMultiplier: 2.0 },
    matchPatterns: [/opus[^a-z0-9]*4[.-]?6/i, /claude-opus-4-6/i],
  },

  [ModelID.CLAUDE_OPUS_4_6_FAST]: {
    id: ModelID.CLAUDE_OPUS_4_6_FAST,
    name: 'Claude Opus 4.6 Fast Mode',
    shortName: 'Opus 4.6 Fast Mode',
    baseVariant: ModelID.CLAUDE_OPUS_4_6,
    provider: ModelProvider.ANTHROPIC,
    apiProviders: [ApiProvider.ANTHROPIC],
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High, RE.Max],
      default: RE.High,
    },
    tier: LLMModelTier.Premium,
    pdf: true,
    contextLimits: CLAUDE_OPUS_LIMITS_867K_128K,
    thinking: claudeAdaptiveThinking,
    anthropicFastMode: true,
    disabledForPilots: true,
    cost: { tokenMultiplier: 12.0 },
    matchPatterns: [/opus[^a-z0-9]*4[.-]?6[^a-z0-9]*fast/i],
  },

  [ModelID.CLAUDE_OPUS_4_7]: {
    id: ModelID.CLAUDE_OPUS_4_7,
    name: 'Claude Opus 4.7',
    shortName: 'Opus 4.7',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: ANTHROPIC_ALL_PROVIDERS,
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High, RE.ExtraHigh, RE.Max],
      default: RE.High,
    },
    tier: LLMModelTier.Premium,
    pdf: true,
    systemPromptAdditions: { noComments: true },
    contextLimits: CLAUDE_OPUS_LIMITS_867K_128K,
    thinking: claudeAdaptiveThinkingSummarized,
    disabledForPilots: false,
    cost: {
      tokenMultiplier: 2.0,
      promoDiscount: 0.5,
      promoExpiresAt: new Date('2026-05-01T00:00:00Z'),
      promoLabel: ', 50% Off',
    },
    matchPatterns: [/opus[^a-z0-9]*4[.-]?7/i, /claude-opus-4-7/i],
  },

  [ModelID.CLAUDE_OPUS_4_7_FAST]: {
    id: ModelID.CLAUDE_OPUS_4_7_FAST,
    name: 'Claude Opus 4.7 Fast Mode',
    shortName: 'Opus 4.7 Fast Mode',
    baseVariant: ModelID.CLAUDE_OPUS_4_7,
    provider: ModelProvider.ANTHROPIC,
    apiProviders: [ApiProvider.ANTHROPIC],
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High, RE.ExtraHigh, RE.Max],
      default: RE.High,
    },
    tier: LLMModelTier.Premium,
    pdf: true,
    systemPromptAdditions: { noComments: true },
    contextLimits: claudeLimits({
      thinkingConsumesContext: false,
      maxInputTokens: 867000,
      maxOutputTokens: 128000,
    }),
    thinking: (effort) =>
      claudeAdaptiveThinking(effort, { display: 'summarized' }),
    anthropicFastMode: true,
    disabledForPilots: true,
    cost: { tokenMultiplier: 12.0 },
    matchPatterns: [
      /opus[^a-z0-9]*4[.-]?7[^a-z0-9]*fast/i,
      /claude-opus-4-7-fast/i,
    ],
  },

  [ModelID.CLAUDE_OPUS_4_8]: {
    id: ModelID.CLAUDE_OPUS_4_8,
    name: 'Claude Opus 4.8',
    shortName: 'Opus 4.8',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: ANTHROPIC_ALL_PROVIDERS,
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High, RE.ExtraHigh, RE.Max],
      default: RE.High,
    },
    tier: LLMModelTier.Premium,
    featureFlag: IndustryFeatureFlags.ClaudeOpus48,
    pdf: true,
    systemPromptAdditions: { noComments: true },
    contextLimits: CLAUDE_OPUS_LIMITS_867K_128K,
    thinking: claudeAdaptiveThinkingSummarized,
    disabledForPilots: false,
    cost: { tokenMultiplier: 2.0 },
    matchPatterns: [/opus[^a-z0-9]*4[.-]?8/i, /claude-opus-4-8/i],
    isNew: true,
  },

  [ModelID.CLAUDE_OPUS_4_8_FAST]: {
    id: ModelID.CLAUDE_OPUS_4_8_FAST,
    name: 'Claude Opus 4.8 Fast Mode',
    shortName: 'Opus 4.8 Fast Mode',
    baseVariant: ModelID.CLAUDE_OPUS_4_8,
    provider: ModelProvider.ANTHROPIC,
    apiProviders: [ApiProvider.ANTHROPIC],
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High, RE.ExtraHigh, RE.Max],
      default: RE.High,
    },
    tier: LLMModelTier.Premium,
    featureFlag: IndustryFeatureFlags.ClaudeOpus48Fast,
    pdf: true,
    systemPromptAdditions: { noComments: true },
    contextLimits: CLAUDE_OPUS_LIMITS_867K_128K,
    thinking: claudeAdaptiveThinkingSummarized,
    anthropicFastMode: true,
    disabledForPilots: false,
    cost: { tokenMultiplier: 4.0 },
    matchPatterns: [
      /opus[^a-z0-9]*4[.-]?8[^a-z0-9]*fast/i,
      /claude-opus-4-8-fast/i,
    ],
  },

  [ModelID.CLAUDE_FABLE_5]: {
    id: ModelID.CLAUDE_FABLE_5,
    name: 'Claude Fable 5',
    shortName: 'Fable 5',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: [ApiProvider.ANTHROPIC],
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High, RE.ExtraHigh, RE.Max],
      default: RE.High,
    },
    tier: LLMModelTier.Premium,
    featureFlag: IndustryFeatureFlags.ClaudeFable5,
    explicitOptInRequirement: {
      kind: ModelExplicitOptInRequirementKind.DataRetention,
      tosVersion: MODEL_EXPLICIT_OPT_IN_TOS_VERSION,
    },
    pdf: true,
    systemPromptAdditions: { noComments: true },
    contextLimits: CLAUDE_OPUS_LIMITS_867K_128K,
    thinking: claudeAdaptiveThinkingSummarized,
    disabledForPilots: false,
    cost: { tokenMultiplier: 4.0, outputTokenMultiplier: 5.0 },
    matchPatterns: [/fable[^a-z0-9]*5/i, /claude-fable-5/i],
    isNew: true,
  },

  [ModelID.CLAUDE_HAIKU_3_5]: {
    id: ModelID.CLAUDE_HAIKU_3_5,
    name: 'Claude Haiku 3.5 v1',
    shortName: 'Haiku 3.5 v1',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: [ApiProvider.ANTHROPIC],
    reasoningEffort: { supported: [RE.None], default: RE.None },
    tier: LLMModelTier.Standard,
    availableInCLI: false,
    pdf: true,
    contextLimits: claudeHaikuLimits,
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.32 },
  },

  [ModelID.CLAUDE_HAIKU_4_5]: {
    id: ModelID.CLAUDE_HAIKU_4_5,
    name: 'Claude Haiku 4.5',
    shortName: 'Haiku 4.5',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: ANTHROPIC_ALL_PROVIDERS,
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High],
      default: RE.Off,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    contextLimits: claudeDefaultLimits,
    thinking: claudeThinking,
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.4 },
    matchPatterns: [
      /haiku[^a-z0-9]*4\.?5/i,
      /claude-haiku-4-5/i, // Without date suffix
    ],
  },

  [ModelID.ASPEN_0515]: {
    id: ModelID.ASPEN_0515,
    name: 'Aspen 05/15 (Preview)',
    shortName: 'Aspen 05/15',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: [ApiProvider.ANTHROPIC],
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.High,
    },
    tier: LLMModelTier.Premium,
    featureFlag: IndustryFeatureFlags.Aspen0515,
    pdf: true,
    contextLimits: CLAUDE_OPUS_LIMITS_867K_128K,
    thinking: claudeAdaptiveThinkingSummarized,
    disabledForPilots: false,
    cost: { tokenMultiplier: 2.0 },
  },

  [ModelID.ALMOND_0527]: {
    id: ModelID.ALMOND_0527,
    name: 'Almond 05/27 (Preview)',
    shortName: 'Almond 05/27',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: [ApiProvider.ANTHROPIC],
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.High,
    },
    tier: LLMModelTier.Premium,
    featureFlag: IndustryFeatureFlags.Almond0527,
    pdf: true,
    contextLimits: CLAUDE_OPUS_LIMITS_867K_128K,
    thinking: claudeAdaptiveThinkingSummarized,
    disabledForPilots: false,
    cost: { tokenMultiplier: 2.0 },
  },

  [ModelID.ANISE_0616]: {
    id: ModelID.ANISE_0616,
    name: 'Anise 06/16 (Preview)',
    shortName: 'Anise 06/16',
    provider: ModelProvider.ANTHROPIC,
    apiProviders: [ApiProvider.ANTHROPIC],
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.High,
    },
    tier: LLMModelTier.Premium,
    featureFlag: IndustryFeatureFlags.Anise0616,
    pdf: true,
    contextLimits: CLAUDE_OPUS_LIMITS_867K_128K,
    thinking: claudeAdaptiveThinkingSummarized,
    disabledForPilots: false,
    cost: { tokenMultiplier: 2.0 },
  },

  // ============ OPENAI - GPT ============

  [ModelID.GPT_5]: {
    id: ModelID.GPT_5,
    name: 'GPT-5',
    shortName: 'GPT-5',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI, ApiProvider.AZURE_OPENAI],
    routingConfig: ROUTING_CONFIG_KEYS.GPT5,
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High],
      default: RE.Medium,
    },
    tier: LLMModelTier.Standard,
    availableInCLI: false,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    contextLimits: OPENAI_400K_32K_LIMITS,
    apiRequest: openaiRequest({ verbosity: 'low' }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.5 },
    matchPatterns: [/gpt[^a-z0-9]*5(?![.\-\d])/i],
  },

  [ModelID.GPT_5_MINI]: {
    id: ModelID.GPT_5_MINI,
    name: 'GPT-5-mini',
    shortName: 'GPT-5-mini',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High],
      default: RE.Medium,
    },
    tier: LLMModelTier.Standard,
    availableInCLI: false,
    pdf: true,
    contextLimits: OPENAI_400K_32K_LIMITS,
    apiRequest: openaiRequest(),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.1 },
    matchPatterns: [/gpt[^a-z0-9]*5[^a-z0-9]*mini/i],
  },

  [ModelID.GPT_5_NANO]: {
    id: ModelID.GPT_5_NANO,
    name: 'GPT-5-nano',
    shortName: 'GPT-5-nano',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High],
      default: RE.Medium,
    },
    tier: LLMModelTier.Standard,
    availableInCLI: false,
    pdf: true,
    contextLimits: OPENAI_400K_32K_LIMITS,
    apiRequest: openaiRequest(),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.02 },
  },

  [ModelID.GPT_5_CODEX]: {
    id: ModelID.GPT_5_CODEX,
    name: 'GPT-5-Codex',
    shortName: 'GPT-5-Codex',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI, ApiProvider.AZURE_OPENAI],
    routingConfig: ROUTING_CONFIG_KEYS.GPT5_CODEX,
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High],
      default: RE.Medium,
    },
    tier: LLMModelTier.Standard,
    deprecation: {
      date: '2026-07-23',
      hard: {
        featureFlag: IndustryFeatureFlags.DeprecateGpt5Codex,
        fallbackModelId: ModelID.GPT_5_5,
      },
    },
    availableInCLI: false,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    contextLimits: OPENAI_400K_32K_LIMITS,
    apiRequest: openaiRequest({
      parallelToolCalls: false,
    }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.5 },
    matchPatterns: [/gpt[^a-z0-9]*5[^a-z0-9]*codex(?![a-z0-9])/i],
  },

  [ModelID.GPT_5_1]: {
    id: ModelID.GPT_5_1,
    name: 'GPT-5.1',
    shortName: 'GPT-5.1',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI, ApiProvider.AZURE_OPENAI],
    routingConfig: ROUTING_CONFIG_KEYS.GPT51,
    reasoningEffort: {
      supported: [RE.None, RE.Low, RE.Medium, RE.High],
      default: RE.None,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    availableInCLI: false,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    contextLimits: OPENAI_400K_32K_LIMITS,
    // GPT-5.1 doesn't support verbosity parameter (only GPT-5.2+)
    apiRequest: openaiRequest(),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.5 },
    matchPatterns: [/gpt[^a-z0-9]*5[.-]?1(?![a-z0-9]*codex|[.\da-z])/i],
  },

  [ModelID.GPT_5_1_CODEX]: {
    id: ModelID.GPT_5_1_CODEX,
    name: 'GPT-5.1-Codex',
    shortName: 'GPT-5.1-Codex',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI, ApiProvider.AZURE_OPENAI],
    routingConfig: ROUTING_CONFIG_KEYS.GPT51_CODEX,
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High],
      default: RE.Medium,
    },
    tier: LLMModelTier.Standard,
    deprecation: {
      date: '2026-07-23',
      hard: {
        featureFlag: IndustryFeatureFlags.DeprecateGpt51Codex,
        fallbackModelId: ModelID.GPT_5_5,
      },
    },
    pdf: true,
    availableInCLI: false,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    contextLimits: OPENAI_400K_32K_LIMITS,
    apiRequest: openaiRequest({
      parallelToolCalls: false,
      extendedCache: true,
    }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.5 },
    matchPatterns: [
      /gpt[^a-z0-9]*5[.-]?1[^a-z0-9]*codex(?![a-z0-9]*(max|mini))/i,
    ],
  },

  [ModelID.GPT_5_1_CODEX_MAX]: {
    id: ModelID.GPT_5_1_CODEX_MAX,
    name: 'GPT-5.1-Codex-Max',
    shortName: 'GPT-5.1-Codex-Max',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.None],
      default: RE.None,
    },
    tier: LLMModelTier.Standard,
    deprecation: {
      date: '2026-07-23',
      hard: {
        featureFlag: IndustryFeatureFlags.DeprecateGpt51CodexMax,
        fallbackModelId: ModelID.GPT_5_5,
      },
    },
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    contextLimits: OPENAI_400K_32K_LIMITS,
    apiRequest: openaiRequest({
      parallelToolCalls: false,
      extendedCache: true,
    }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.5 },
    matchPatterns: [/gpt[^a-z0-9]*5[.-]?1[^a-z0-9]*codex[^a-z0-9]*max/i],
  },

  [ModelID.GPT_5_2]: {
    id: ModelID.GPT_5_2,
    name: 'GPT-5.2',
    shortName: 'GPT-5.2',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Low,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    contextLimits: OPENAI_400K_32K_LIMITS,
    apiRequest: openaiRequest({ verbosity: 'low' }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.7 },
    matchPatterns: [/gpt[^a-z0-9]*5[.-]?2(?![.\d])/i],
  },

  [ModelID.GPT_5_2_CODEX]: {
    id: ModelID.GPT_5_2_CODEX,
    name: 'GPT-5.2-Codex',
    shortName: 'GPT-5.2-Codex',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Medium,
    },
    tier: LLMModelTier.Standard,
    deprecation: {
      date: '2026-07-23',
      hard: {
        featureFlag: IndustryFeatureFlags.DeprecateGpt52Codex,
        fallbackModelId: ModelID.GPT_5_5,
      },
    },
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    contextLimits: OPENAI_400K_32K_LIMITS,
    apiRequest: openaiRequest({
      parallelToolCalls: true,
      extendedCache: true,
      safetyId: true,
    }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.7 },
    matchPatterns: [
      /gpt[^a-z0-9]*5[.-]?2[^a-z0-9]*codex/i,
      /codex[^a-z0-9]*gpt[^a-z0-9]*5[.-]?2/i,
    ],
  },

  [ModelID.GPT_5_3_CODEX]: {
    id: ModelID.GPT_5_3_CODEX,
    name: 'GPT-5.3-Codex',
    shortName: 'GPT-5.3-Codex',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Medium,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    contextLimits: OPENAI_400K_32K_LIMITS,
    apiRequest: OPENAI_PARALLEL_CACHED_LOW,
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.7 },
    matchPatterns: [
      /gpt[^a-z0-9]*5[.-]?3[^a-z0-9]*codex(?![.\d])/i,
      /codex[^a-z0-9]*gpt[^a-z0-9]*5[.-]?3(?![.\d])/i,
    ],
  },

  [ModelID.GPT_5_3_CODEX_SPARK]: {
    id: ModelID.GPT_5_3_CODEX_SPARK,
    name: 'GPT-5.3-Codex Spark',
    shortName: 'GPT-5.3-Codex Spark',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Medium,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    contextLimits: OPENAI_400K_32K_LIMITS,
    apiRequest: OPENAI_PARALLEL_CACHED_LOW,
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.7 },
    matchPatterns: [
      /gpt[^a-z0-9]*5[.-]?3[^a-z0-9]*codex[^a-z0-9]*spark/i,
      /codex[^a-z0-9]*spark[^a-z0-9]*gpt[^a-z0-9]*5[.-]?3/i,
    ],
  },

  [ModelID.GPT_5_3_CODEX_FAST]: {
    id: ModelID.GPT_5_3_CODEX_FAST,
    name: 'GPT-5.3-Codex Fast Mode',
    shortName: 'GPT-5.3-Codex Fast',
    baseVariant: ModelID.GPT_5_3_CODEX,
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Medium,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    contextLimits: OPENAI_400K_32K_LIMITS,
    apiRequest: OPENAI_PARALLEL_CACHED_LOW_PRIORITY,
    disabledForPilots: false,
    cost: { tokenMultiplier: 1.4, outputTokenMultiplier: 6 },
    matchPatterns: [
      /gpt[^a-z0-9]*5[.-]?3[^a-z0-9]*codex[^a-z0-9]*fast/i,
      /codex[^a-z0-9]*gpt[^a-z0-9]*5[.-]?3[^a-z0-9]*fast/i,
    ],
  },

  [ModelID.GPT_5_4]: {
    id: ModelID.GPT_5_4,
    name: 'GPT-5.4',
    shortName: 'GPT-5.4',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI, ApiProvider.BEDROCK_OPENAI],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Medium,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    bedrockOpenAIRegion: 'us-west-2',
    contextLimits: OPENAI_922K_128K_LIMITS,
    apiRequest: OPENAI_PARALLEL_CACHED_LOW,
    disabledForPilots: false,
    cost: { tokenMultiplier: 1.0, outputTokenMultiplier: 6 },
    matchPatterns: [/gpt[^a-z0-9]*5[.-]?4(?![.\d])/i],
  },

  [ModelID.GPT_5_4_FAST]: {
    id: ModelID.GPT_5_4_FAST,
    name: 'GPT-5.4 Fast Mode',
    shortName: 'GPT-5.4 Fast Mode',
    baseVariant: ModelID.GPT_5_4,
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Medium,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    contextLimits: OPENAI_922K_128K_LIMITS,
    apiRequest: OPENAI_PARALLEL_CACHED_LOW_PRIORITY,
    disabledForPilots: false,
    cost: { tokenMultiplier: 2.0, outputTokenMultiplier: 6 },
    matchPatterns: [/gpt[^a-z0-9]*5[.-]?4[^a-z0-9]*fast/i],
  },

  [ModelID.GPT_5_4_MINI]: {
    id: ModelID.GPT_5_4_MINI,
    name: 'GPT-5.4 Mini',
    shortName: 'GPT-5.4 Mini',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.High,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    contextLimits: OPENAI_400K_128K_LIMITS,
    apiRequest: OPENAI_PARALLEL_CACHED_LOW,
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.3, outputTokenMultiplier: 6 },
    matchPatterns: [/gpt[^a-z0-9]*5[.-]?4[^a-z0-9]*mini/i],
  },

  [ModelID.GPT_5_5]: {
    id: ModelID.GPT_5_5,
    name: 'GPT-5.5',
    shortName: 'GPT-5.5',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI, ApiProvider.BEDROCK_OPENAI],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Medium,
    },
    tier: LLMModelTier.Premium,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    bedrockOpenAIRegion: 'us-east-2',
    contextLimits: OPENAI_922K_128K_LIMITS,
    apiRequest: OPENAI_PARALLEL_CACHED_LOW,
    disabledForPilots: false,
    cost: { tokenMultiplier: 2.0, outputTokenMultiplier: 6 },
    matchPatterns: [/gpt[^a-z0-9]*5[.-]?5(?![.\d])/i],
  },

  [ModelID.GPT_5_5_FAST]: {
    id: ModelID.GPT_5_5_FAST,
    name: 'GPT-5.5 Fast Mode',
    shortName: 'GPT-5.5 Fast Mode',
    baseVariant: ModelID.GPT_5_5,
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Medium,
    },
    tier: LLMModelTier.Premium,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    contextLimits: OPENAI_922K_128K_LIMITS,
    apiRequest: OPENAI_PARALLEL_CACHED_LOW_PRIORITY,
    disabledForPilots: false,
    cost: { tokenMultiplier: 5.0, outputTokenMultiplier: 6 },
    matchPatterns: [/gpt[^a-z0-9]*5[.-]?5[^a-z0-9]*fast/i],
  },

  [ModelID.GPT_5_5_PRO]: {
    id: ModelID.GPT_5_5_PRO,
    name: 'GPT-5.5 Pro',
    shortName: 'GPT-5.5 Pro',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Medium,
    },
    tier: LLMModelTier.Premium,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    contextLimits: OPENAI_922K_128K_LIMITS,
    apiRequest: OPENAI_PARALLEL_CACHED_LOW,
    disabledForPilots: true,
    cost: { tokenMultiplier: 12.0, outputTokenMultiplier: 6 },
    matchPatterns: [/gpt[^a-z0-9]*5[.-]?5[^a-z0-9]*pro/i],
  },

  [ModelID.ORBIT_0409]: {
    id: ModelID.ORBIT_0409,
    name: 'Orbit 04/09 (Preview)',
    shortName: 'Orbit 04/09',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.None, RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Medium,
    },
    tier: LLMModelTier.Premium,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    featureFlag: IndustryFeatureFlags.Orbit0409,
    contextLimits: OPENAI_400K_128K_LIMITS,
    apiRequest: OPENAI_PARALLEL_NOCACHE_MEDIUM,
    disabledForPilots: false,
    cost: { tokenMultiplier: 1.5, outputTokenMultiplier: 6 },
  },

  [ModelID.OXIDE_0601]: {
    id: ModelID.OXIDE_0601,
    name: 'Oxide 06/01 (Preview)',
    shortName: 'Oxide 06/01',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.None, RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Medium,
    },
    tier: LLMModelTier.Premium,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    featureFlag: IndustryFeatureFlags.Oxide0601,
    contextLimits: OPENAI_922K_128K_LIMITS,
    apiRequest: OPENAI_PARALLEL_NOCACHE_MEDIUM,
    disabledForPilots: false,
    cost: { tokenMultiplier: 1.5, outputTokenMultiplier: 6 },
  },

  [ModelID.OXBOW_0601]: {
    id: ModelID.OXBOW_0601,
    name: 'Oxbow 06/01 Code Mode (Preview)',
    shortName: 'Oxbow 06/01 Code Mode',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.None, RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Medium,
    },
    tier: LLMModelTier.Premium,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    openaiCodeMode: { language: 'javascript' },
    featureFlag: IndustryFeatureFlags.Oxbow0601,
    contextLimits: OPENAI_922K_128K_LIMITS,
    apiRequest: OPENAI_PARALLEL_NOCACHE_MEDIUM,
    disabledForPilots: false,
    cost: { tokenMultiplier: 2.0, outputTokenMultiplier: 6 },
  },

  [ModelID.OWL_0621]: {
    id: ModelID.OWL_0621,
    name: 'Owl 06/21 (Preview)',
    shortName: 'Owl 06/21',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.None, RE.Low, RE.Medium, RE.High, RE.ExtraHigh, RE.Max],
      default: RE.Medium,
    },
    tier: LLMModelTier.Premium,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    featureFlag: IndustryFeatureFlags.Owl0621,
    contextLimits: OPENAI_922K_128K_LIMITS,
    apiRequest: OPENAI_PARALLEL_NOCACHE_MEDIUM,
    disabledForPilots: false,
    cost: { tokenMultiplier: 2.0, outputTokenMultiplier: 6 },
  },

  [ModelID.OLM_0305]: {
    id: ModelID.OLM_0305,
    name: 'Olm 03/05 (Preview)',
    shortName: 'Olm 03/05',
    provider: ModelProvider.OPENAI,
    apiProviders: [ApiProvider.OPENAI],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High, RE.ExtraHigh],
      default: RE.Low,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    compatibilityGroup: 'gpt5-family',
    systemPromptAdditions: { persistence: true },
    supportsVerbosity: true,
    featureFlag: IndustryFeatureFlags.Olm0305,
    contextLimits: OPENAI_400K_128K_LIMITS,
    apiRequest: openaiRequest({
      parallelToolCalls: true,
      extendedCache: false,
      safetyId: true,
      verbosity: 'low',
    }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.2 },
  },

  // ============ GOOGLE - GEMINI ============

  [ModelID.GEMINI_2_5_FLASH]: {
    id: ModelID.GEMINI_2_5_FLASH,
    name: 'Gemini 2.5 Flash',
    shortName: 'Gemini 2.5 Flash',
    provider: ModelProvider.GOOGLE,
    apiProviders: [ApiProvider.GOOGLE],
    reasoningEffort: {
      supported: [RE.Dynamic, RE.Off, RE.Low, RE.Medium, RE.High],
      default: RE.Dynamic,
    },
    tier: LLMModelTier.Standard,
    availableInCLI: false,
    pdf: true,
    contextLimits: geminiLimits(1048576, 8192, { hasThinking: true }),
    thinking: geminiThinking({ supportsDynamic: true }),
    // Gemini 2.5 Flash uses explicit token budgets for thinking
    apiRequest: geminiRequest({ useBudget: true }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.12 },
  },

  [ModelID.GEMINI_2_5_PRO]: {
    id: ModelID.GEMINI_2_5_PRO,
    name: 'Gemini 2.5 Pro',
    shortName: 'Gemini 2.5 Pro',
    provider: ModelProvider.GOOGLE,
    apiProviders: [ApiProvider.GOOGLE],
    reasoningEffort: {
      supported: [RE.None, RE.Low, RE.Medium, RE.High],
      default: RE.High,
    },
    tier: LLMModelTier.Standard,
    availableInCLI: false,
    pdf: true,
    contextLimits: geminiLimits(1048576, 8192),
    thinking: geminiThinking(),
    apiRequest: geminiRequest(),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.5 },
  },

  [ModelID.GEMINI_3_PRO]: {
    id: ModelID.GEMINI_3_PRO,
    name: 'Gemini 3 Pro',
    shortName: 'Gemini 3 Pro',
    provider: ModelProvider.GOOGLE,
    apiProviders: [ApiProvider.GOOGLE],
    reasoningEffort: {
      supported: [RE.None, RE.Low, RE.Medium, RE.High],
      default: RE.High,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    availableInCLI: false,
    contextLimits: geminiLimits(1000000, 65536),
    thinking: geminiThinking(),
    apiRequest: geminiRequest(),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.8 },
    matchPatterns: [/gemini[^a-z0-9]*3[^a-z0-9]*pro/i],
  },

  [ModelID.GEMINI_3_1_PRO]: {
    id: ModelID.GEMINI_3_1_PRO,
    name: 'Gemini 3.1 Pro',
    shortName: 'Gemini 3.1 Pro',
    provider: ModelProvider.GOOGLE,
    apiProviders: [ApiProvider.GOOGLE],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High],
      default: RE.High,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    contextLimits: geminiLimits(1000000, 65536),
    thinking: geminiThinking(),
    apiRequest: geminiRequest({ supportsMedium: true }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.8 },
    matchPatterns: [/gemini[^a-z0-9]*3\.?1[^a-z0-9]*pro/i],
  },

  [ModelID.GEMINI_3_FLASH]: {
    id: ModelID.GEMINI_3_FLASH,
    name: 'Gemini 3 Flash',
    shortName: 'Gemini 3 Flash',
    provider: ModelProvider.GOOGLE,
    apiProviders: [ApiProvider.GOOGLE],
    reasoningEffort: {
      supported: [RE.Minimal, RE.Low, RE.Medium, RE.High],
      default: RE.High,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    contextLimits: geminiLimits(1000000, 65536),
    thinking: geminiThinking(),
    apiRequest: geminiRequest(),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.2 },
    matchPatterns: [/gemini[^a-z0-9]*3[^a-z0-9]*flash/i],
  },

  [ModelID.GANTRY_0507]: {
    id: ModelID.GANTRY_0507,
    name: 'Gantry 05/07 (Preview)',
    shortName: 'Gantry 05/07',
    provider: ModelProvider.GOOGLE,
    apiProviders: [ApiProvider.GOOGLE],
    reasoningEffort: {
      supported: [RE.Minimal, RE.Low, RE.Medium, RE.High],
      default: RE.High,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    featureFlag: IndustryFeatureFlags.Gantry0507,
    contextLimits: geminiLimits(1000000, 65536),
    thinking: geminiThinking(),
    apiRequest: geminiRequest(),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.2 },
  },

  [ModelID.GEMINI_3_5_FLASH]: {
    id: ModelID.GEMINI_3_5_FLASH,
    name: 'Gemini 3.5 Flash',
    shortName: 'Gemini 3.5 Flash',
    provider: ModelProvider.GOOGLE,
    apiProviders: [ApiProvider.GOOGLE],
    reasoningEffort: {
      supported: [RE.Minimal, RE.Low, RE.Medium, RE.High],
      default: RE.High,
    },
    tier: LLMModelTier.Standard,
    pdf: true,
    featureFlag: IndustryFeatureFlags.Gemini35Flash,
    contextLimits: geminiLimits(1000000, 65536),
    thinking: geminiThinking(),
    apiRequest: geminiRequest(),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.6 },
    matchPatterns: [/gemini[^a-z0-9]*3\.?5[^a-z0-9]*flash/i],
  },

  // ============ XAI - GROK ============

  [ModelID.TITAN_0212]: {
    id: ModelID.TITAN_0212,
    name: 'Titan 02/12 (Preview)',
    shortName: 'Titan 02/12',
    provider: ModelProvider.XAI,
    apiProviders: [ApiProvider.XAI],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High],
      default: RE.Medium,
    },
    tier: LLMModelTier.Premium,
    pdf: false,
    featureFlag: IndustryFeatureFlags.Titan0212,
    caching: false,
    contextLimits: fixedLimits({
      maxInputTokens: 2000000,
      maxOutputTokens: 16384,
    }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 1.2, outputTokenMultiplier: 4.0 },
  },

  // ============ INDUSTRY - GLM ============

  [ModelID.GLM_4_6]: {
    id: ModelID.GLM_4_6,
    name: 'Drool Core (GLM-4.6)',
    shortName: 'Drool Core (GLM-4.6)',
    provider: ModelProvider.INDUSTRY,
    apiModelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
    apiProviders: [ApiProvider.BASETEN],
    reasoningEffort: { supported: [RE.None], default: RE.None },
    tier: LLMModelTier.Standard,
    billingPool: BillingPool.Core,
    images: false,
    pdf: false,
    caching: false,
    contextLimits: fixedLimits({
      maxInputTokens: 200000,
      maxOutputTokens: 128000,
    }),
    availableInCLI: false,
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.25 },
    usesUSBasedInference: true,
  },

  [ModelID.GLM_4_7]: {
    id: ModelID.GLM_4_7,
    name: 'Drool Core (GLM-4.7)',
    shortName: 'Drool Core (GLM-4.7)',
    provider: ModelProvider.INDUSTRY,
    apiModelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
    apiProviders: [ApiProvider.FIREWORKS],
    reasoningEffort: { supported: [RE.None], default: RE.None },
    tier: LLMModelTier.Standard,
    billingPool: BillingPool.Core,
    images: false,
    pdf: false,
    caching: false,
    deprecation: {
      date: '2026-05-14',
      hard: {
        featureFlag: IndustryFeatureFlags.DeprecateGlm47,
        fallbackModelId: ModelID.GLM_5_1,
      },
    },
    contextLimits: fixedLimits({
      maxInputTokens: 198000,
      maxOutputTokens: 25344,
    }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.25 },
    usesUSBasedInference: true,
  },

  [ModelID.KIMI_K2_5]: {
    id: ModelID.KIMI_K2_5,
    name: 'Drool Core (Kimi K2.5)',
    shortName: 'Drool Core (Kimi K2.5)',
    provider: ModelProvider.INDUSTRY,
    apiModelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
    apiProviders: [ApiProvider.FIREWORKS, ApiProvider.BASETEN],
    apiProviderConfig: {
      [ApiProvider.BASETEN]: BASETEN_OPT_IN_THINKING,
    },
    // Kimi exposes thinking as a binary toggle (see Kimi K2.6 model card,
    // section "Model Usage"). We use `High` for the "on" slot so it maps
    // cleanly to Fireworks' `reasoning_effort: 'high'`.
    reasoningEffort: { supported: [RE.Off, RE.High], default: RE.High },
    // Accept replayed `reasoning_content` across turns and ask Fireworks to
    // preserve reasoning history — required for agentic eval performance
    // parity with Moonshot's native preserve_thinking mode.
    chatCompletionRequest: kimiReasoningContentChatCompletionRequest(),
    tier: LLMModelTier.Standard,
    billingPool: BillingPool.Core,
    images: true,
    pdf: false,
    caching: false,
    deprecation: {
      date: '2026-06-26',
      hard: {
        featureFlag: IndustryFeatureFlags.DeprecateKimiK25,
        fallbackModelId: ModelID.KIMI_K2_6,
      },
    },
    contextLimits: fixedLimits({
      maxInputTokens: 256000,
      maxOutputTokens: 32768,
    }),
    disabledForPilots: false,
    // Fireworks serverless: $0.60 input per 1M tokens.
    cost: {
      tokenMultiplier: 0.25,
      outputTokenMultiplier: 5.0,
    },
    usesUSBasedInference: true,
  },
  [ModelID.KIMI_K2_6]: {
    id: ModelID.KIMI_K2_6,
    name: 'Drool Core (Kimi K2.6)',
    shortName: 'Drool Core (Kimi K2.6)',
    provider: ModelProvider.INDUSTRY,
    apiModelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
    apiProviders: [ApiProvider.FIREWORKS, ApiProvider.BASETEN],
    apiProviderConfig: {
      [ApiProvider.BASETEN]: BASETEN_OPT_IN_THINKING,
    },
    reasoningEffort: { supported: [RE.Off, RE.High], default: RE.High },
    chatCompletionRequest: kimiReasoningContentChatCompletionRequest(),
    tier: LLMModelTier.Standard,
    billingPool: BillingPool.Core,
    images: true,
    pdf: false,
    caching: false,
    // Kimi K2.6 context length = 262,144 tokens (see model card:
    // https://huggingface.co/moonshotai/Kimi-K2.6). Fireworks silently
    // truncates `max_tokens` to `context_window - prompt_length`, so any
    // value is accepted — we cap output at 64K for sane streaming/cost.
    contextLimits: fixedLimits({
      maxInputTokens: 262144,
      maxOutputTokens: 65536,
    }),
    disabledForPilots: false,
    cost: {
      tokenMultiplier: 0.4,
      outputTokenMultiplier: 4.0,
    },
    usesUSBasedInference: true,
  },
  [ModelID.KIMI_K2_7_CODE]: {
    id: ModelID.KIMI_K2_7_CODE,
    name: 'Drool Core (Kimi K2.7 Code)',
    shortName: 'Drool Core (Kimi K2.7 Code)',
    provider: ModelProvider.INDUSTRY,
    apiModelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
    apiProviders: [ApiProvider.FIREWORKS],
    reasoningEffort: { supported: [RE.Off, RE.High], default: RE.High },
    chatCompletionRequest: kimiReasoningContentChatCompletionRequest(),
    tier: LLMModelTier.Standard,
    billingPool: BillingPool.Core,
    featureFlag: IndustryFeatureFlags.KimiK27Code,
    images: true,
    pdf: false,
    caching: false,
    contextLimits: fixedLimits({
      maxInputTokens: 262144,
      maxOutputTokens: 65536,
    }),
    disabledForPilots: false,
    // List price: $0.95/M input (cache miss), $4.00/M output. Multipliers vs
    // the $2.50/M base: 0.95/2.50 = 0.38; output 4.00/0.95 ≈ 4.21.
    cost: {
      tokenMultiplier: 0.38,
      outputTokenMultiplier: 4.21,
    },
    usesUSBasedInference: true,
    isNew: true,
  },

  [ModelID.DEEPSEEK_V4_PRO]: {
    id: ModelID.DEEPSEEK_V4_PRO,
    name: 'Drool Core (DeepSeek V4 Pro)',
    shortName: 'Drool Core (DeepSeek V4 Pro)',
    provider: ModelProvider.INDUSTRY,
    apiModelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
    apiProviders: [ApiProvider.FIREWORKS, ApiProvider.BASETEN],
    reasoningEffort: {
      supported: [RE.Off, RE.Low, RE.High, RE.Max],
      default: RE.High,
    },
    chatCompletionRequest: deepSeekReasoningContentChatCompletionRequest(),
    tier: LLMModelTier.Standard,
    billingPool: BillingPool.Core,
    images: false,
    pdf: false,
    caching: false,
    contextLimits: fixedLimits({
      maxInputTokens: 1048576,
      maxOutputTokens: 65536,
    }),
    disabledForPilots: false,
    cost: {
      tokenMultiplier: 0.7,
      outputTokenMultiplier: 2.0,
    },
    usesUSBasedInference: true,
    matchPatterns: [/deepseek[^a-z0-9]*v?4[^a-z0-9]*pro/i],
  },

  [ModelID.MINIMAX_M2_5]: {
    id: ModelID.MINIMAX_M2_5,
    name: 'Drool Core (MiniMax M2.5)',
    shortName: 'Drool Core (MiniMax M2.5)',
    provider: ModelProvider.INDUSTRY,
    apiModelProvider: ModelProvider.ANTHROPIC,
    apiProviders: [ApiProvider.FIREWORKS],
    reasoningEffort: {
      supported: [RE.Low, RE.Medium, RE.High],
      default: RE.High,
    },
    thinking: minimaxEffortThinking,
    tier: LLMModelTier.Standard,
    billingPool: BillingPool.Core,
    images: false,
    pdf: false,
    caching: false,
    contextLimits: fixedLimits({
      maxInputTokens: 204800,
      maxOutputTokens: 64000,
    }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.12, outputTokenMultiplier: 4.0 },
    usesUSBasedInference: true,
  },
  [ModelID.MINIMAX_M2_7]: {
    id: ModelID.MINIMAX_M2_7,
    name: 'Drool Core (MiniMax M2.7)',
    shortName: 'Drool Core (MiniMax M2.7)',
    provider: ModelProvider.INDUSTRY,
    apiModelProvider: ModelProvider.ANTHROPIC,
    apiProviders: [ApiProvider.FIREWORKS],
    // TODO: public docs only mention generic thinking support without reasoning effort, with another contradictory note saying thinking is ignored.
    reasoningEffort: { supported: [RE.High], default: RE.High },
    thinking: minimaxEffortThinking,
    tier: LLMModelTier.Standard,
    billingPool: BillingPool.Core,
    images: false,
    pdf: false,
    caching: false,
    contextLimits: fixedLimits({
      maxInputTokens: 196600,
      maxOutputTokens: 64000,
    }),
    disabledForPilots: false,
    cost: {
      tokenMultiplier: 0.12,
      outputTokenMultiplier: 4.0,
    },
    usesUSBasedInference: true,
  },
  [ModelID.MINIMAX_M3]: {
    id: ModelID.MINIMAX_M3,
    name: 'Drool Core (MiniMax M3)',
    shortName: 'Drool Core (MiniMax M3)',
    provider: ModelProvider.INDUSTRY,
    apiModelProvider: ModelProvider.ANTHROPIC,
    apiProviders: [ApiProvider.FIREWORKS],
    reasoningEffort: { supported: [RE.High], default: RE.High },
    thinking: minimaxEffortThinking,
    tier: LLMModelTier.Standard,
    billingPool: BillingPool.Core,
    featureFlag: IndustryFeatureFlags.MinimaxM3,
    images: true,
    pdf: false,
    caching: false,
    // Early-access endpoint supports 512k context (1M not yet available).
    contextLimits: fixedLimits({
      maxInputTokens: 512000,
      maxOutputTokens: 64000,
    }),
    disabledForPilots: false,
    cost: {
      tokenMultiplier: 0.12,
      outputTokenMultiplier: 4.0,
    },
    usesUSBasedInference: true,
    isNew: true,
  },
  [ModelID.GLM_5]: {
    id: ModelID.GLM_5,
    name: 'Drool Core (GLM-5)',
    shortName: 'Drool Core (GLM-5)',
    provider: ModelProvider.INDUSTRY,
    apiModelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
    apiProviders: [ApiProvider.FIREWORKS],
    reasoningEffort: { supported: [RE.None], default: RE.None },
    tier: LLMModelTier.Standard,
    billingPool: BillingPool.Core,
    images: false,
    pdf: false,
    caching: false,
    deprecation: {
      date: '2026-04-24',
      hard: {
        featureFlag: IndustryFeatureFlags.DeprecateGlm5,
        fallbackModelId: ModelID.GLM_5_1,
      },
    },
    contextLimits: fixedLimits({
      maxInputTokens: 190000,
      maxOutputTokens: 32000,
    }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 0.4, outputTokenMultiplier: 3.2 },
    usesUSBasedInference: true,
  },
  [ModelID.GLM_5_1]: {
    id: ModelID.GLM_5_1,
    name: 'Drool Core (GLM-5.1)',
    shortName: 'Drool Core (GLM-5.1)',
    provider: ModelProvider.INDUSTRY,
    apiModelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
    apiProviders: [ApiProvider.FIREWORKS, ApiProvider.BASETEN],
    apiProviderConfig: {
      [ApiProvider.BASETEN]: BASETEN_OPT_IN_THINKING,
    },
    reasoningEffort: { supported: [RE.Off, RE.High], default: RE.High },
    chatCompletionRequest: glmReasoningContentChatCompletionRequest(),
    tier: LLMModelTier.Standard,
    billingPool: BillingPool.Core,
    images: false,
    pdf: false,
    caching: false,
    contextLimits: fixedLimits({
      maxInputTokens: 190000,
      maxOutputTokens: 131072,
    }),
    disabledForPilots: false,
    // Fireworks serverless: $1.40 input per 1M tokens.
    cost: {
      tokenMultiplier: 0.55,
      outputTokenMultiplier: 3.2,
    },
    usesUSBasedInference: true,
  },
  [ModelID.GLM_5_2]: {
    id: ModelID.GLM_5_2,
    name: 'Drool Core (GLM-5.2)',
    shortName: 'Drool Core (GLM-5.2)',
    provider: ModelProvider.INDUSTRY,
    apiModelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
    apiProviders: [ApiProvider.FIREWORKS],
    reasoningEffort: {
      supported: [RE.Off, RE.High, RE.Max],
      default: RE.High,
    },
    chatCompletionRequest: glmReasoningContentChatCompletionRequest(),
    tier: LLMModelTier.Standard,
    billingPool: BillingPool.Core,
    featureFlag: IndustryFeatureFlags.Glm52,
    images: false,
    pdf: false,
    caching: false,
    contextLimits: fixedLimits({
      maxInputTokens: 1_040_000,
      maxOutputTokens: 131_072,
    }),
    disabledForPilots: false,
    // Fireworks serverless: $1.40 input / $4.40 output per 1M tokens.
    // Cached input uses the global cache-read multiplier policy.
    cost: {
      tokenMultiplier: 0.55,
      outputTokenMultiplier: 3.2,
    },
    usesUSBasedInference: true,
    isNew: true,
  },
  [ModelID.NEMOTRON_3_ULTRA]: {
    id: ModelID.NEMOTRON_3_ULTRA,
    name: 'Drool Core (Nemotron 3 Ultra)',
    shortName: 'Drool Core (Nemotron 3 Ultra)',
    provider: ModelProvider.INDUSTRY,
    apiModelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
    apiProviders: [ApiProvider.FIREWORKS],
    reasoningEffort: { supported: [RE.Off, RE.High], default: RE.High },
    chatCompletionRequest: glmReasoningContentChatCompletionRequest(),
    tier: LLMModelTier.Standard,
    billingPool: BillingPool.Core,
    featureFlag: IndustryFeatureFlags.Nemotron3Ultra,
    images: false,
    pdf: false,
    caching: false,
    contextLimits: fixedLimits({
      maxInputTokens: 262144,
      maxOutputTokens: 65536,
    }),
    disabledForPilots: false,
    // TODO(CL-594): Revisit after we have production usage data for Nemotron 3 Ultra.
    cost: {
      tokenMultiplier: 0.4,
      outputTokenMultiplier: 6.0,
    },
    usesUSBasedInference: true,
  },

  // Router; provider/apiProviders/cost/contextLimits are synthetic safe defaults.
  [ModelID.INDUSTRY_ROUTER]: {
    id: ModelID.INDUSTRY_ROUTER,
    kind: ModelKind.Router,
    name: INDUSTRY_ROUTER_DISPLAY_NAME,
    shortName: INDUSTRY_ROUTER_DISPLAY_NAME,
    variantBadge: VariantBadge.ResearchPreview,
    provider: ModelProvider.INDUSTRY,
    apiProviders: [ApiProvider.ANTHROPIC],
    reasoningEffort: { supported: [RE.None], default: RE.None },
    tier: LLMModelTier.Standard,
    featureFlag: IndustryFeatureFlags.IndustryRouter,
    pdf: false,
    contextLimits: fixedLimits({
      maxInputTokens: 1_000_000,
      maxOutputTokens: 64_000,
    }),
    disabledForPilots: false,
    cost: { tokenMultiplier: 1 },
  },
};

configureModelRegistryAccessors({
  getModelRegistryEntry: (modelId) => MODEL_REGISTRY[modelId as ModelID],
  findClosestModelId: (modelString) => {
    const exact = resolveModelId(modelString);
    if (exact) return exact;

    const normalized = modelString.toLowerCase();
    const allModelIds = (Object.values(ModelID) as string[]).filter(
      (modelId) => modelId !== ModelID.INDUSTRY_ROUTER
    );
    const sortedIds = [...allModelIds].sort((a, b) => b.length - a.length);
    for (const modelId of sortedIds) {
      if (normalized.includes(modelId.toLowerCase())) {
        return modelId as ModelID;
      }
    }

    const patternMatches: ModelID[] = [];
    for (const [modelId, config] of Object.entries(MODEL_REGISTRY)) {
      if (config.matchPatterns?.some((pattern) => pattern.test(normalized))) {
        patternMatches.push(modelId as ModelID);
      }
    }

    patternMatches.sort((a, b) => b.length - a.length || a.localeCompare(b));
    return patternMatches[0];
  },
});

/**
 * Display order for models in the CLI selector.
 * Only includes models where availableInCLI !== false.
 */
// eslint-disable-next-line industry/constants-file-organization -- Part of model registry
export const CLI_MODEL_ORDER: readonly ModelID[] = [
  // Routers
  ModelID.INDUSTRY_ROUTER,

  // Anthropic — Opus (newest first)
  ModelID.CLAUDE_OPUS_4_8,
  ModelID.CLAUDE_OPUS_4_8_FAST,
  ModelID.CLAUDE_OPUS_4_7,
  ModelID.CLAUDE_OPUS_4_7_FAST,
  ModelID.CLAUDE_OPUS_4_6,
  ModelID.CLAUDE_OPUS_4_6_FAST,
  ModelID.CLAUDE_OPUS_4_5,
  // Anthropic — Fable (ranked below all Opus models; gated + data-retention opt-in)
  ModelID.CLAUDE_FABLE_5,
  // Anthropic — Sonnet (newest first)
  ModelID.CLAUDE_SONNET_4_6,
  ModelID.CLAUDE_SONNET_4_5,
  // Anthropic — Haiku
  ModelID.CLAUDE_HAIKU_4_5,

  // OpenAI (newest first)
  ModelID.GPT_5_5,
  ModelID.GPT_5_5_FAST,
  ModelID.GPT_5_5_PRO,
  ModelID.GPT_5_4,
  ModelID.GPT_5_4_FAST,
  ModelID.GPT_5_4_MINI,
  ModelID.GPT_5_3_CODEX,
  ModelID.GPT_5_3_CODEX_SPARK,
  ModelID.GPT_5_3_CODEX_FAST,
  ModelID.GPT_5_2,
  ModelID.OLM_0305,

  // Gemini
  ModelID.GEMINI_3_1_PRO,
  ModelID.GEMINI_3_5_FLASH,
  ModelID.GEMINI_3_FLASH,

  // Drool Core
  ModelID.GLM_5_2,
  ModelID.GLM_5_1,
  ModelID.KIMI_K2_7_CODE,
  ModelID.KIMI_K2_6,
  ModelID.NEMOTRON_3_ULTRA,
  ModelID.DEEPSEEK_V4_PRO,
  ModelID.MINIMAX_M3,
  ModelID.MINIMAX_M2_7,
  ModelID.MINIMAX_M2_5,

  // Grok
  ModelID.TITAN_0212,

  // Early access
  ModelID.ANISE_0616,
  ModelID.OWL_0621,
  ModelID.ALMOND_0527,
  ModelID.OXBOW_0601,
  ModelID.OXIDE_0601,
  ModelID.ORBIT_0409,
  ModelID.ASPEN_0515,
  ModelID.GANTRY_0507,

  // Deprecated
  ModelID.KIMI_K2_5, // Deprecated 2026-06-26
  ModelID.GPT_5_2_CODEX, // Deprecated 2026-07-23
  ModelID.GLM_5, // Deprecated 2026-04-24
  ModelID.GLM_4_7, // Deprecated 2026-04-01
  ModelID.GPT_5_1_CODEX_MAX, // Deprecated 2026-07-23
];

/**
 * Get model IDs that require org-level data retention opt-in before use.
 * Derived from the registry (the source of truth for
 * `explicitOptInRequirement`), not `CLI_MODEL_ORDER`, so an opt-in model
 * missing from the CLI ordering still flows through policy derivations.
 */
export function getExplicitOptInRequiredModelIds(): ModelID[] {
  return Object.values(MODEL_REGISTRY)
    .filter((model) => model.explicitOptInRequirement !== undefined)
    .map((model) => model.id);
}

/** Each sublist is a model line, ordered by preference (first = most preferred). */
const CLI_PREFERRED_MODEL_LINES: readonly (readonly ModelID[])[] = [
  [ModelID.INDUSTRY_ROUTER],
  [ModelID.CLAUDE_OPUS_4_8, ModelID.CLAUDE_OPUS_4_7, ModelID.CLAUDE_OPUS_4_6],
  // Claude Fable 5 gets its own line AFTER the Opus line so it appears in the
  // preferred list but never displaces Opus as the top Anthropic pick (and the
  // preferred section doesn't reshuffle when its feature flag resolves).
  [ModelID.CLAUDE_FABLE_5],
  [ModelID.CLAUDE_SONNET_4_6],
  [ModelID.GPT_5_5, ModelID.GPT_5_4],
  [ModelID.GPT_5_3_CODEX, ModelID.GPT_5_3_CODEX_SPARK],
  [ModelID.GEMINI_3_1_PRO],
  [ModelID.GEMINI_3_5_FLASH],
  [ModelID.GLM_5_2, ModelID.GLM_5_1],
  [ModelID.KIMI_K2_7_CODE, ModelID.KIMI_K2_6, ModelID.KIMI_K2_5],
  [ModelID.DEEPSEEK_V4_PRO],
  [ModelID.MINIMAX_M3, ModelID.MINIMAX_M2_7],
];

function resolvePreferredModelsFromLines<T extends string>(
  preferredModelLines: readonly (readonly T[])[],
  availableModelIds: ReadonlySet<string>
) {
  return preferredModelLines
    .map((line) => line.find((id) => availableModelIds.has(id)))
    .filter((id): id is T => id !== undefined);
}

/** Resolve preferred models: first available model per line. */
export function resolvePreferredModels<T extends string = ModelID>(
  availableModelIds: ReadonlySet<string>,
  preferredModelLines?: readonly (readonly T[])[]
): T[] {
  const lines =
    preferredModelLines ??
    (CLI_PREFERRED_MODEL_LINES as readonly (readonly T[])[]);

  return resolvePreferredModelsFromLines(lines, availableModelIds);
}
