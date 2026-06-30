/**
 * LLM-related constants.
 */

import { IndustryRegion } from '@industry/common/shared';
import {
  ApiProvider,
  ModelID,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';

import type { BuiltInModelID } from '@industry/drool-sdk-ext/protocol/llm';

/** Default model for drool configuration generation */
export const DEFAULT_DROOL_GENERATOR_MODEL = ModelID.CLAUDE_SONNET_4_5;

// ============ PROVIDER DEFAULT MODELS ============
// Used when switching/resuming sessions with a locked provider

/** Default Anthropic model for provider fallback */
export const DEFAULT_ANTHROPIC_MODEL = ModelID.CLAUDE_SONNET_4_5;

/** Default OpenAI model for provider fallback */
export const DEFAULT_OPENAI_MODEL = ModelID.GPT_5_2;

// ============ TASK-SPECIFIC MODELS ============
// Models for specific use cases throughout the codebase

/** Model for memory curation */
export const MEMORY_CURATION_MODEL = ModelID.GPT_5;

// ============ DROOL CONNECTION TYPE DEFAULTS ============
// Default models for different machine connection types

/** Default model for Workspace connections */
export const DEFAULT_WORKSPACE_MODEL = {
  id: ModelID.CLAUDE_SONNET_4,
  reasoningEffort: ReasoningEffort.Medium,
} as const;

// ============ DEFAULT INDUSTRY MODEL ============
// Used for default settings in CLI and web when user hasn't configured a preference

/**
 * Static fallback default model (always available, no feature flag).
 * Used internally by resolveDefaultIndustryModel() as the safe fallback.
 */
export const DEFAULT_INDUSTRY_MODEL: BuiltInModelID = ModelID.CLAUDE_OPUS_4_6;

/**
 * Ordered list of candidate default models, most preferred first.
 * The first model that is available (passes feature-flag checks) is used.
 */
export const DEFAULT_INDUSTRY_MODEL_CANDIDATES: readonly BuiltInModelID[] = [
  ModelID.CLAUDE_OPUS_4_8,
  ModelID.CLAUDE_OPUS_4_7,
  ModelID.CLAUDE_OPUS_4_6,
];

// ============ MISSION WORKER MODELS ============
// Models for mission decomposition workers

/** Model for feature implementation workers */
export const MISSION_FEATURE_WORKER_MODEL = ModelID.CLAUDE_OPUS_4_5;

/** Default model for mission validation workers */
export const MISSION_VALIDATION_WORKER_MODEL = ModelID.GPT_5_3_CODEX;

// ============ MISSION ORCHESTRATOR MODELS ============
// Models for mission orchestrator sessions

/** Default model for mission orchestrator sessions (used when user's current model is not recommended) */
export const MISSION_ORCHESTRATOR_MODEL = ModelID.CLAUDE_OPUS_4_6;

/** Reasoning effort for mission orchestrator sessions */
export const MISSION_ORCHESTRATOR_REASONING_EFFORT = ReasoningEffort.High;

/** Recommended models for mission orchestration */
export const MISSION_ORCHESTRATOR_RECOMMENDED_MODELS: readonly string[] = [
  ModelID.GPT_5_4,
  ModelID.GPT_5_4_FAST,
  ModelID.GPT_5_3_CODEX,
  ModelID.GPT_5_3_CODEX_FAST,
  ModelID.CLAUDE_OPUS_4_8,
  ModelID.CLAUDE_OPUS_4_8_FAST,
  ModelID.CLAUDE_OPUS_4_7,
  ModelID.CLAUDE_OPUS_4_7_FAST,
  ModelID.CLAUDE_OPUS_4_6,
  ModelID.CLAUDE_OPUS_4_6_FAST,
] as const;

/** Minimum reasoning efforts acceptable for mission orchestration */
export const MISSION_ORCHESTRATOR_MIN_REASONING_EFFORTS: readonly string[] = [
  ReasoningEffort.High,
  ReasoningEffort.ExtraHigh,
] as const;

// ============ DROOL CORE (FREE TIER) MODEL ============

/**
 * Default model to recommend when user needs to switch to Drool Core (free tier).
 * This is returned by the backend in 402 responses so CLIs don't hardcode the model.
 */
export const DEFAULT_CORE_MODEL = ModelID.GLM_5;

/** Drool Core model used for context-limit recovery compaction. */
export const DROOL_CORE_CONTEXT_LIMIT_COMPACTION_MODEL =
  ModelID.DEEPSEEK_V4_PRO;

/**
 * Compaction summarizer fallbacks when the requested model refuses the
 * transcript. Cross-vendor: a different safety stack is unlikely to
 * co-refuse. First entry that passes isModelAllowed wins.
 */
export const COMPACTION_MODERATION_FALLBACK_MODEL_PREFERENCE: readonly ModelID[] =
  [ModelID.DEEPSEEK_V4_PRO, ModelID.CLAUDE_HAIKU_4_5, ModelID.GPT_5_4_MINI];

/** Safety-net model when Auto Model can't produce a decision. */
export const ROUTER_FALLBACK_MODEL = ModelID.CLAUDE_OPUS_4_8;

/** First entry that passes isModelAllowed wins. */
export const INDUSTRY_ROUTER_CLASSIFIER_MODEL_PREFERENCE: readonly ModelID[] = [
  ModelID.GPT_5_4_MINI,
  ModelID.CLAUDE_HAIKU_4_5,
  ModelID.GLM_5_1,
  ModelID.KIMI_K2_7_CODE,
];

/** Stuck-phrase upgrade target keyed by currently-running concrete model. */
export const SESSION_MODEL_UPGRADE_TARGETS: Readonly<
  Partial<Record<BuiltInModelID, BuiltInModelID>>
> = {
  [ModelID.GPT_5_4_MINI]: ModelID.GPT_5_4,

  [ModelID.CLAUDE_SONNET_4_5]: ModelID.CLAUDE_OPUS_4_8,
  [ModelID.CLAUDE_SONNET_4_6]: ModelID.CLAUDE_OPUS_4_8,
  [ModelID.CLAUDE_HAIKU_4_5]: ModelID.CLAUDE_OPUS_4_8,
  [ModelID.CLAUDE_OPUS_4_6]: ModelID.CLAUDE_OPUS_4_8,
  [ModelID.CLAUDE_OPUS_4_7]: ModelID.CLAUDE_OPUS_4_8,

  [ModelID.GEMINI_3_FLASH]: ModelID.GEMINI_3_1_PRO,

  [ModelID.GLM_5_2]: ModelID.CLAUDE_OPUS_4_8,
  [ModelID.GLM_5_1]: ModelID.CLAUDE_OPUS_4_8,
  [ModelID.GLM_5]: ModelID.CLAUDE_OPUS_4_8,
  [ModelID.KIMI_K2_6]: ModelID.CLAUDE_OPUS_4_8,
  [ModelID.KIMI_K2_7_CODE]: ModelID.CLAUDE_OPUS_4_8,
  [ModelID.MINIMAX_M2_5]: ModelID.CLAUDE_OPUS_4_8,
  [ModelID.MINIMAX_M2_7]: ModelID.CLAUDE_OPUS_4_8,
  [ModelID.MINIMAX_M3]: ModelID.CLAUDE_OPUS_4_8,
};

// ============ PROVIDER ROUTING CONFIG KEYS ============

/**
 * Valid Statsig dynamic config keys for provider routing overrides.
 * @deprecated Keep these configs wired for older clients until provider-family routing is fully rolled out.
 */
export const ROUTING_CONFIG_KEYS = {
  /** @deprecated Use provider_routing_anthropic. */
  OPUS_46: 'provider_routing_opus46',
  /** @deprecated Use provider_routing_anthropic. */
  SONNET_46: 'provider_routing_sonnet46',
  /** @deprecated Use provider_routing_openai. */
  GPT5: 'provider_routing_gpt5',
  /** @deprecated Use provider_routing_openai. */
  GPT5_CODEX: 'provider_routing_gpt5_codex',
  /** @deprecated Use provider_routing_openai. */
  GPT51: 'provider_routing_gpt51',
  /** @deprecated Use provider_routing_openai. */
  GPT51_CODEX: 'provider_routing_gpt51_codex',
} as const;

// Regions in which each ApiProvider can be used. Consumed by the
// picker filter and the server's enforceModelRegion gate.
export const PROVIDER_REGIONS: Record<ApiProvider, IndustryRegion[]> = {
  [ApiProvider.ANTHROPIC]: [IndustryRegion.Global],
  [ApiProvider.VERTEX_ANTHROPIC]: [IndustryRegion.Global, IndustryRegion.Eu],
  [ApiProvider.BEDROCK_ANTHROPIC]: [IndustryRegion.Global, IndustryRegion.Eu],
  // BYOK-only (Converse). Not server provider-routed; entry exists to keep
  // this exhaustive Record complete and is never consulted for BYOK turns.
  [ApiProvider.BEDROCK_CONVERSE]: [IndustryRegion.Global],
  [ApiProvider.BEDROCK_OPENAI]: [IndustryRegion.Global, IndustryRegion.Eu],
  [ApiProvider.BEDROCK]: [IndustryRegion.Global, IndustryRegion.Eu],
  [ApiProvider.OPENAI]: [IndustryRegion.Global, IndustryRegion.Eu],
  [ApiProvider.AZURE_OPENAI]: [IndustryRegion.Global],
  // Gemini in EU is unverified. Re-add IndustryRegion.Eu after smoke-testing
  // each Gemini model against `europe-west1` end-to-end.
  [ApiProvider.GOOGLE]: [IndustryRegion.Global],
  [ApiProvider.XAI]: [IndustryRegion.Global],
  [ApiProvider.FIREWORKS]: [IndustryRegion.Global],
  [ApiProvider.BASETEN]: [IndustryRegion.Global],
  [ApiProvider.SNOWFLAKE]: [IndustryRegion.Global],
};

// Per-(model, provider) allowlist that *replaces* PROVIDER_REGIONS for
// publisher availability gaps. Models without an entry inherit the
// provider default.
//
// - Claude Opus on Vertex: default GCP per-region quota 429s in EU; keep
//   these on Global until the quota raise lands.
// - Claude Opus 4.8 on Bedrock: US CRIS streaming works, while the current
//   EU runtime path is still blocked by Marketplace subscription access.
export const MODEL_PROVIDER_REGION_OVERRIDES: Partial<
  Record<ModelID, Partial<Record<ApiProvider, IndustryRegion[]>>>
> = {
  [ModelID.CLAUDE_OPUS_4_7]: {
    [ApiProvider.VERTEX_ANTHROPIC]: [IndustryRegion.Global],
  },
  [ModelID.CLAUDE_OPUS_4_8]: {
    [ApiProvider.VERTEX_ANTHROPIC]: [IndustryRegion.Global],
    [ApiProvider.BEDROCK_ANTHROPIC]: [IndustryRegion.Global],
  },
};
