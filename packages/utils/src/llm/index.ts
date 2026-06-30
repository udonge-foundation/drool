import { TuiModelConfig } from '@industry/common/cli';
import {
  type getLLMModelParams,
  type LLMModel,
  UserModelSelection,
} from '@industry/common/llm';
import {
  ApiProvider,
  BillingPool,
  ModelID,
  ModelKind,
  ModelProvider,
  ReasoningEffort,
  BuiltInModelID,
  ConcreteModelID,
  CustomModelID,
  RouterID,
  ROUTER_MODEL_IDS,
} from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import {
  DEFAULT_INDUSTRY_MODEL as _DEFAULT_INDUSTRY_MODEL,
  DEFAULT_INDUSTRY_MODEL_CANDIDATES as _DEFAULT_INDUSTRY_MODEL_CANDIDATES,
  SESSION_MODEL_UPGRADE_TARGETS,
} from './constants';
import {
  CLI_MODEL_ORDER,
  MODEL_REGISTRY,
  resolveModelId,
} from './model-registry';

import type { LLMModelConfig } from './types';
import type { IndustryFeatureFlag } from '@industry/common/feature-flags';

export { getCanonicalModelId } from './model-registry';

// ============ TYPE EXPORTS ============
// Types needed by consumers - import directly from './types' when possible

export type { ApiProviderModelConfig, LLMModelConfig } from './types';
export { hasReasoningEnabled } from './providers/completions';

// ============ MODEL UTILITIES (from model-utils.ts) ============

/**
 * Get a model config by ID. Supports model aliases for backwards compatibility.
 */
export function getModel(modelId: ModelID | string): LLMModelConfig {
  const resolvedId = resolveModelId(modelId);
  if (!resolvedId) {
    throw new MetaError(`Unknown model: ${modelId}`, { modelId });
  }
  const model = MODEL_REGISTRY[resolvedId];
  if (!model) {
    throw new MetaError(`Unknown model: ${modelId}`, { modelId });
  }
  return model;
}

export function isAvailableInCLI(modelId: ModelID | string): boolean {
  return (CLI_MODEL_ORDER as string[]).includes(modelId);
}

/**
 * Resolves the Bedrock Mantle region for built-in OpenAI Responses models.
 */
export function resolveBedrockOpenAIRegion(
  modelId: ModelID | string,
  defaultRegion: string
): string {
  const resolvedId = resolveModelId(modelId);
  return resolvedId
    ? (MODEL_REGISTRY[resolvedId]?.bedrockOpenAIRegion ?? defaultRegion)
    : defaultRegion;
}

/**
 * Get unique feature flags declared by CLI-available model registry entries.
 */
export function getModelFeatureFlags(): IndustryFeatureFlag[] {
  const flags = new Map<string, IndustryFeatureFlag>();
  const addFlag = (flag: IndustryFeatureFlag | undefined) => {
    if (flag) {
      flags.set(flag.statsigName, flag);
    }
  };

  for (const modelId of CLI_MODEL_ORDER) {
    const config = MODEL_REGISTRY[modelId];
    addFlag(config?.featureFlag);
    addFlag(config?.deprecation?.hard?.featureFlag);
  }
  return Array.from(flags.values());
}

/**
 * Get model IDs that are disabled for unpaid enterprise (pilot) orgs.
 */
export function getPilotDisabledModelIds(): ModelID[] {
  return CLI_MODEL_ORDER.filter(
    (modelId) => MODEL_REGISTRY[modelId]?.disabledForPilots
  );
}

/**
 * Get model IDs that are fast-mode variants of another model.
 * Detected via the `baseVariant` field on the registry entry — no separate
 * flag required. Orgs opt in to these as a group via modelPolicy.isFastModelsAllowed.
 */
export function getFastModelIds(): ModelID[] {
  return CLI_MODEL_ORDER.filter(
    (modelId) => !!MODEL_REGISTRY[modelId]?.baseVariant
  );
}

/**
 * Whether a given model is a fast-mode variant.
 */
export function isFastModel(modelId: ModelID | string): boolean {
  return !!MODEL_REGISTRY[modelId as ModelID]?.baseVariant;
}

/** Whether a model resolves to a concrete pick per-turn. See {@link LLMModelConfig.kind}. */
export function isRouterModel(modelId: ModelID | string): boolean {
  return MODEL_REGISTRY[modelId as ModelID]?.kind === ModelKind.Router;
}

/**
 * Get TUI model config for a model.
 */

/**
 * Check whether a promotional discount is currently active.
 * Returns true when a discount is set and hasn't expired yet.
 */
function isPromoActive(cost: {
  promoDiscount?: number;
  promoExpiresAt?: Date;
}): boolean {
  if (!cost.promoDiscount) return false;
  if (!cost.promoExpiresAt) return true;
  return new Date() < cost.promoExpiresAt;
}

/**
 * Compute the effective token multiplier after applying any promotional discount.
 * If the promo has expired (past promoExpiresAt), the base multiplier is returned.
 */
export function getEffectiveTokenMultiplier(cost: {
  tokenMultiplier: number;
  promoDiscount?: number;
  promoExpiresAt?: Date;
}): number {
  if (!isPromoActive(cost)) return cost.tokenMultiplier;
  return cost.tokenMultiplier * (1 - cost.promoDiscount!);
}

export function getModelConfig(modelId: ModelID | string): TuiModelConfig {
  const config = MODEL_REGISTRY[modelId as ModelID];
  if (!config) {
    throw new MetaError(`Unknown model: ${modelId}`, { modelId });
  }
  const deprecated = config.deprecation !== undefined;
  const suffix = deprecated ? ' [Deprecated]' : '';
  return {
    id: config.id,
    modelId: config.id,
    kind: config.kind,
    modelProvider: config.provider,
    displayName: `${config.name}${suffix}`,
    shortDisplayName: `${config.shortName}${suffix}`,
    supportedReasoningEfforts: config.reasoningEffort.supported,
    defaultReasoningEffort: config.reasoningEffort.default,
    featureFlag: config.featureFlag,
    deprecated,
    deprecationDate: config.deprecation?.date,
    noImageSupport: config.images === false,
    supportsPDFs: config.pdf,
    usesUSBasedInference: config.usesUSBasedInference,
    tokenMultiplier: getEffectiveTokenMultiplier(config.cost),
    promoLabel: isPromoActive(config.cost) ? config.cost.promoLabel : undefined,
    variantBadge: config.variantBadge,
    isNew: config.isNew,
  };
}

export function getAllModels(): LLMModelConfig[] {
  return Object.values(MODEL_REGISTRY);
}

export function isModelAlwaysAllowed(modelId: ModelID): boolean {
  try {
    return getModel(modelId).alwaysAllowed === true;
  } catch (err) {
    logWarn('Failed to check if model is always allowed', { cause: err });
    return false;
  }
}

/**
 * Get the effective token usage multiplier for a model (for Industry billing).
 * Applies any promotional discount. Returns undefined for unknown models.
 */
export function getTokenMultiplier(modelId: ModelID): number | undefined {
  const cost = MODEL_REGISTRY[modelId]?.cost;
  return cost ? getEffectiveTokenMultiplier(cost) : undefined;
}

/**
 * Get the promo label for a model (shown in model selector).
 * Returns undefined if no promo is active.
 */
export function getPromoLabel(modelId: ModelID): string | undefined {
  const cost = MODEL_REGISTRY[modelId]?.cost;
  if (!cost) return undefined;
  return isPromoActive(cost) ? cost.promoLabel : undefined;
}

// Re-export constants
export {
  COMPACTION_MODERATION_FALLBACK_MODEL_PREFERENCE,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_CORE_MODEL,
  DEFAULT_DROOL_GENERATOR_MODEL,
  DROOL_CORE_CONTEXT_LIMIT_COMPACTION_MODEL,
  DEFAULT_OPENAI_MODEL,
  INDUSTRY_ROUTER_CLASSIFIER_MODEL_PREFERENCE,
  DEFAULT_WORKSPACE_MODEL,
  MEMORY_CURATION_MODEL,
  MISSION_FEATURE_WORKER_MODEL,
  MISSION_VALIDATION_WORKER_MODEL,
  MISSION_ORCHESTRATOR_MIN_REASONING_EFFORTS,
  MISSION_ORCHESTRATOR_MODEL,
  MISSION_ORCHESTRATOR_REASONING_EFFORT,
  MISSION_ORCHESTRATOR_RECOMMENDED_MODELS,
  ROUTER_FALLBACK_MODEL,
} from './constants';

export function getSessionModelUpgradeTarget(
  modelId: string
): BuiltInModelID | undefined {
  for (const [from, to] of Object.entries(SESSION_MODEL_UPGRADE_TARGETS)) {
    if (from === modelId && to !== undefined) return to;
  }
  return undefined;
}

/**
 * Pick the best default Industry model from the candidates list.
 * Returns the first candidate present in `availableModelIds`.
 * Falls back to CLAUDE_OPUS_4_6.
 */
export function resolveDefaultIndustryModel(
  availableModelIds: ReadonlySet<string>
): BuiltInModelID {
  return (
    _DEFAULT_INDUSTRY_MODEL_CANDIDATES.find((c) => availableModelIds.has(c)) ??
    _DEFAULT_INDUSTRY_MODEL
  );
}

/**
 * Check whether a model ID is one of the default Industry model candidates.
 */
export function isDefaultModelCandidate(modelId: string): boolean {
  return _DEFAULT_INDUSTRY_MODEL_CANDIDATES.some((c) => c === modelId);
}

export { MISSION_ORCHESTRATOR_MODEL_WARNING } from './mission-warnings';

export { resolvePreferredModels } from './model-registry';

// Re-export model matching utilities
export { findClosestModelId } from './model-matching';

// Re-export model resolution utilities
export {
  getExplicitOptInRequiredModelIds,
  resolveModelId,
} from './model-registry';

/**
 * Ordered list of models available in CLI.
 * @internal — do NOT import from outside packages/utils.
 * External consumers should use @industry/utils/models helpers
 * (filterModelsByFlags, etc.)
 */
// eslint-disable-next-line industry/constants-file-organization -- Re-exporting from registry
export const CLI_MODELS: ModelID[] = [...CLI_MODEL_ORDER];

// Memoize once at module load — CLI_MODEL_ORDER is static.
const CLI_MODEL_DISPLAY_INDEX: ReadonlyMap<string, number> = new Map(
  CLI_MODEL_ORDER.map((id, i) => [id as string, i])
);

/**
 * Display index of a model in the canonical CLI_MODEL_ORDER (newest-first per
 * provider). Returns Number.POSITIVE_INFINITY for models not listed, so they
 * sort to the end. Used by UI surfaces (e.g. enterprise-controls ModelAccessTable)
 * that want the same ordering as the CLI model selector.
 */
export function getCliModelDisplayIndex(modelId: ModelID | string): number {
  const index = CLI_MODEL_DISPLAY_INDEX.get(modelId);
  return index ?? Number.POSITIVE_INFINITY;
}

/**
 * Get all models that support a given API provider.
 * Useful for validating provider-specific routes.
 */
export function getModelsForApiProvider(apiProvider: ApiProvider): ModelID[] {
  return Object.values(MODEL_REGISTRY)
    .filter((model) => model.apiProviders.includes(apiProvider))
    .map((model) => model.id);
}

/**
 * Cached model routing configs computed once at module load.
 * Since MODEL_REGISTRY is static, we can compute this once instead of per-request.
 */
const MODEL_ROUTING_CONFIGS = (() => {
  const configs = new Map<ModelID, string>();
  for (const model of Object.values(MODEL_REGISTRY)) {
    if (model.routingConfig) {
      configs.set(model.id, model.routingConfig);
    }
  }
  return configs;
})();

/**
 * Get all model-specific routing config keys from the registry.
 * Returns a map of ModelID → Statsig dynamic config key for models that have
 * a `routingConfig` override. Used by the backend to evaluate per-model configs.
 */
export function getModelRoutingConfigs(): Map<ModelID, string> {
  return MODEL_ROUTING_CONFIGS;
}

// Re-export Gemini-specific utilities
export { configureGeminiRequest } from './providers/google';

// Re-export Claude reasoning-budget helper (thinking budget per effort)
export {
  getClaudeReasoningTokens,
  clampMaxTokensAboveThinkingBudget,
} from './providers/reasoning';

// Re-export provider-region policy helpers
export {
  getAvailableProvidersForModel,
  getProvidersAvailableInRegion,
  isModelAvailableInRegion,
} from './provider-regions';

// Re-export Vertex AI location brand
export { asVertexLocation } from './vertex';
export type { VertexLocation } from './types';

// ============ GENERAL UTILITIES ============

const EFFORT_MAP: Record<string, ReasoningEffort> = Object.values(
  ReasoningEffort
).reduce(
  (map, value) => {
    map[value.toLowerCase()] = value;
    return map;
  },
  {} as Record<string, ReasoningEffort>
);

/**
 * Parse reasoning effort string to enum.
 * Returns undefined for unrecognized values, letting callers provide their own defaults.
 */
export function parseReasoningEffort(
  effort?: string
): ReasoningEffort | undefined {
  if (!effort) return undefined;
  return EFFORT_MAP[effort.toLowerCase()];
}

/**
 * Approximate tokens from character count using the 4-chars-per-token heuristic.
 * Shared by CompactionManager, context telemetry, and streaming chunk accounting.
 */
export function approxTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

// ============ ENDPOINT UTILITIES ============

// ============ getLLMModel ============

/**
 * Get a model with computed token limits for a specific reasoning effort.
 * This is the recommended way to get model information.
 *
 * Returns LLMModel which includes all static model properties plus
 * computed maxInputTokens/maxOutputTokens/temperature for the given effort.
 */
export function getLLMModel({
  modelId,
  reasoningEffort,
}: getLLMModelParams): LLMModel {
  const modelConfig = getModel(modelId);
  const limits = modelConfig.contextLimits(reasoningEffort);

  return {
    id: modelConfig.id,
    name: modelConfig.name,
    shortName: modelConfig.shortName,
    modelProvider: modelConfig.provider,
    apiProviders: modelConfig.apiProviders,
    tier: modelConfig.tier,
    billingPool: modelConfig.billingPool ?? BillingPool.Standard,
    supportedReasoningEfforts: modelConfig.reasoningEffort.supported,
    supportsImages: modelConfig.images,
    featureFlag: modelConfig.featureFlag,
    verbosity: modelConfig.verbosity,
    reasoningEffort,
    maxInputTokens: limits.maxInputTokens,
    defaultCompactionLimit: limits.defaultCompactionLimit,
    maxOutputTokens: limits.maxOutputTokens,
    temperature: limits.temperature,
  } as const;
}

/**
 * Get the raw model config without computed limits.
 * Use this when you need access to the closures (contextLimits, thinking, apiRequest).
 */
export function getLLMConfig({
  modelId,
}: {
  modelId: ModelID;
}): LLMModelConfig {
  return getModel(modelId);
}

// ============ MODEL PROVIDER UTILITIES ============

/**
 * Provider for a concrete model id (apiModelProvider if set, else provider).
 * Internal: callers at the loose boundary use resolveProviderForSelection.
 */
function getModelProvider(modelId: ConcreteModelID): ModelProvider {
  if (modelId.startsWith('custom:')) {
    return ModelProvider.GENERIC_CHAT_COMPLETION_API;
  }

  const resolvedId = resolveModelId(modelId);
  if (resolvedId) {
    const modelConfig = MODEL_REGISTRY[resolvedId];
    if (modelConfig) {
      return modelConfig.apiModelProvider ?? modelConfig.provider;
    }
  }

  return ModelProvider.GENERIC_CHAT_COMPLETION_API;
}

function modelSupportsImages(modelId: ConcreteModelID): boolean {
  if (modelId.startsWith('custom:')) {
    return false;
  }

  const resolvedId = resolveModelId(modelId);
  if (resolvedId) {
    const modelConfig = MODEL_REGISTRY[resolvedId];
    if (modelConfig) {
      return modelConfig.images !== false;
    }
  }

  return false;
}

function willModelSwitchLoseImageSupport({
  currentModelId,
  newModelId,
}: {
  currentModelId: ConcreteModelID;
  newModelId: ConcreteModelID;
}): boolean {
  return (
    modelSupportsImages(currentModelId) && !modelSupportsImages(newModelId)
  );
}

function willModelSwitchRequireCompaction({
  currentModelId,
  newModelId,
}: {
  currentModelId: ConcreteModelID;
  newModelId: ConcreteModelID;
}): boolean {
  return getModelProvider(currentModelId) !== getModelProvider(newModelId);
}

// ============ FAST MODE UTILITIES ============

const FAST_VARIANT_BY_BASE = new Map<ModelID, ModelID>(
  Object.values(MODEL_REGISTRY)
    .filter((model): model is LLMModelConfig & { baseVariant: ModelID } =>
      Boolean(model.baseVariant)
    )
    .map((model) => [model.baseVariant, model.id] as const)
);

export function getFastVariant(modelId: string): string | undefined {
  const resolvedId = resolveModelId(modelId);
  return resolvedId ? FAST_VARIANT_BY_BASE.get(resolvedId) : undefined;
}

export function getBaseVariant(modelId: string): string | undefined {
  const resolvedId = resolveModelId(modelId);
  return resolvedId ? MODEL_REGISTRY[resolvedId]?.baseVariant : undefined;
}

// ============ MODEL COMPATIBILITY ============

export function isAnthropicModel(modelId: ConcreteModelID): boolean {
  return getModelProvider(modelId) === ModelProvider.ANTHROPIC;
}

// ============ MODEL SELECTION VALIDATORS ============

function isRouterModelID(id: string): id is RouterID {
  return ROUTER_MODEL_IDS.some((r) => r === id);
}

export function isCustomModelID(id: string): id is CustomModelID {
  return id.startsWith('custom:');
}

function isBuiltInModelID(id: string): id is BuiltInModelID {
  if (isRouterModelID(id)) return false;
  for (const enumValue of Object.values(ModelID)) {
    if (enumValue === id) return true;
  }
  return false;
}

function isConcreteModelID(id: string): id is ConcreteModelID {
  return isBuiltInModelID(id) || isCustomModelID(id);
}

function isUserModelSelection(id: string): id is UserModelSelection {
  if (isCustomModelID(id)) return true;
  for (const enumValue of Object.values(ModelID)) {
    if (enumValue === id) return true;
  }
  return false;
}

/** Narrow an untrusted value to a user-selectable id, else `undefined`. */
export function parseUserModelSelection(
  raw: unknown
): UserModelSelection | undefined {
  if (typeof raw !== 'string') return undefined;
  return isUserModelSelection(raw) ? raw : undefined;
}

/** Narrow an untrusted value to an engine-dispatchable id, else `undefined`. */
export function parseConcreteModelID(
  raw: unknown
): ConcreteModelID | undefined {
  if (typeof raw !== 'string') return undefined;
  return isConcreteModelID(raw) ? raw : undefined;
}

/** Narrow an untrusted value to a built-in, non-router model id. */
export function parseBuiltInModelID(raw: unknown): BuiltInModelID | undefined {
  if (typeof raw !== 'string') return undefined;
  return isBuiltInModelID(raw) ? raw : undefined;
}

/**
 * Switch-effect prediction for two raw (possibly router/unknown) selections.
 * A side that can't narrow to a concrete id forces compaction (its provider
 * can't be compared statically) and makes no image-loss claim.
 */
export function predictSelectionSwitchEffects(
  currentModelId: string,
  newModelId: string
): { requiresCompaction: boolean; losingImageSupport: boolean } {
  const current = parseConcreteModelID(currentModelId);
  const next = parseConcreteModelID(newModelId);
  if (current === undefined || next === undefined) {
    return { requiresCompaction: true, losingImageSupport: false };
  }
  return {
    requiresCompaction: willModelSwitchRequireCompaction({
      currentModelId: current,
      newModelId: next,
    }),
    losingImageSupport: willModelSwitchLoseImageSupport({
      currentModelId: current,
      newModelId: next,
    }),
  };
}

/** Provider for a raw selection; unknown/router falls back to generic chat. */
export function resolveProviderForSelection(modelId: string): ModelProvider {
  const concrete = parseConcreteModelID(modelId);
  return concrete !== undefined
    ? getModelProvider(concrete)
    : ModelProvider.GENERIC_CHAT_COMPLETION_API;
}
