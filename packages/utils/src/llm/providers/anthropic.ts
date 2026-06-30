/**
 * Anthropic/Claude provider-specific configuration closures.
 */

import {
  ApiProvider,
  ModelID,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';

import { getModelRegistryEntry } from '../model-registry-accessor';
import {
  shouldDisableThinkingForCompaction,
  shouldDisableThinkingForModelSwitching,
  stripThinkingFromHistory,
} from '../thinking-guards';
import {
  clampMaxTokensAboveThinkingBudget,
  getClaudeReasoningTokens,
} from './reasoning';

import type {
  AnthropicRequestConfig,
  AnthropicThinkingResult,
  ConfigureAnthropicRequestParams,
  ConfigureAnthropicRequestResult,
  ContextLimitsFn,
  CustomModelThinkingConfig,
  MessageForThinkingGuards,
} from '../types';

// ============ TOKEN UTILITIES ============

/**
 * Get reasoning effort level from token count.
 */
export function getClaudeReasoningEffort(
  reasoningTokens?: number
): ReasoningEffort {
  if (!reasoningTokens || reasoningTokens <= 0) {
    return ReasoningEffort.Off;
  }
  if (reasoningTokens <= getClaudeReasoningTokens(ReasoningEffort.Low)) {
    return ReasoningEffort.Low;
  }
  if (reasoningTokens <= getClaudeReasoningTokens(ReasoningEffort.Medium)) {
    return ReasoningEffort.Medium;
  }
  return ReasoningEffort.High;
}

/**
 * Check if a model uses output_config.effort instead of thinking budget.
 */
export function isEffortModel(modelId: string): boolean {
  const model = getModelRegistryEntry(modelId as ModelID);
  if (!model?.thinking) return false;
  const thinkingResult = model.thinking(ReasoningEffort.Medium);
  return thinkingResult?.output_config?.effort !== undefined;
}

// ============ CONTEXT LIMITS ============

/**
 * Default Claude context limits with thinking budget considerations.
 * Used by models with 32K max output (Sonnet 4.0/4.5, Opus 4.1, Haiku 4.5).
 * For models with higher output limits, use claudeLimits({ maxOutputTokens }) instead.
 */
export function claudeDefaultLimits(effort: ReasoningEffort) {
  const isThinking =
    effort !== ReasoningEffort.Off && effort !== ReasoningEffort.None;

  if (!isThinking) {
    return {
      maxInputTokens: 180000,
      defaultCompactionLimit: 180000,
      maxOutputTokens: 32000,
    };
  }

  const thinkingBudget = getClaudeReasoningTokens(effort);
  const inputTokens = 200000 - thinkingBudget - 32000 - 10000;
  return {
    maxInputTokens: inputTokens,
    defaultCompactionLimit: inputTokens,
    maxOutputTokens: 32000,
    temperature: 1,
  };
}

/**
 * Claude limits with custom options.
 *
 * @param opts.maxInputTokens - Absolute max input tokens allowed by the API provider.
 *   Defaults to 180000 (200K context window minus output).
 * @param opts.defaultCompactionLimit - Default compaction threshold. When the model's
 *   maxInputTokens >= 250K, this defaults to 250K. Otherwise matches maxInputTokens.
 * @param opts.thinkingConsumesContext - Whether thinking tokens reduce available input tokens.
 * @param opts.maxOutputTokens - Maximum output tokens.
 */
export function claudeLimits(opts: {
  thinkingConsumesContext?: boolean;
  maxInputTokens?: number;
  defaultCompactionLimit?: number;
  maxOutputTokens?: number;
}): ContextLimitsFn {
  const maxInput = opts.maxInputTokens ?? 180000;
  const maxOutput = opts.maxOutputTokens ?? 32000;
  const consumesContext = opts.thinkingConsumesContext ?? true;
  const compactionLimit =
    opts.defaultCompactionLimit ?? (maxInput >= 250000 ? 250000 : maxInput);

  return (effort) => {
    const isThinking =
      effort !== ReasoningEffort.Off && effort !== ReasoningEffort.None;

    if (!isThinking) {
      return {
        maxInputTokens: maxInput,
        defaultCompactionLimit: Math.min(compactionLimit, maxInput),
        maxOutputTokens: maxOutput,
      };
    }

    const thinkingBudget = getClaudeReasoningTokens(effort);
    const inputTokens = consumesContext
      ? 200000 - thinkingBudget - maxOutput - 10000
      : maxInput;

    return {
      maxInputTokens: inputTokens,
      defaultCompactionLimit: Math.min(compactionLimit, inputTokens),
      maxOutputTokens: maxOutput,
      temperature: 1,
    };
  };
}

/**
 * Fixed limits for legacy Claude models (Haiku 3.5, Sonnet 3.5).
 */
export function claudeHaikuLimits() {
  return {
    maxInputTokens: 190000,
    defaultCompactionLimit: 190000,
    maxOutputTokens: 8192,
  };
}

// ============ THINKING CONFIGURATION ============

/**
 * Standard Claude thinking configuration.
 */
export function claudeThinking(
  effort: ReasoningEffort
): AnthropicThinkingResult | undefined {
  if (effort === ReasoningEffort.Off || effort === ReasoningEffort.None) {
    return undefined;
  }

  const budgetTokens = getClaudeReasoningTokens(effort);
  return {
    thinking: { type: 'enabled', budget_tokens: budgetTokens },
    betaFlags: ['interleaved-thinking-2025-05-14'],
  };
}

function buildEnabledThinkingWithEffort(
  effort: ReasoningEffort,
  betaFlags: readonly string[]
): AnthropicThinkingResult | undefined {
  if (effort === ReasoningEffort.Off || effort === ReasoningEffort.None) {
    return undefined;
  }

  const budgetTokens = getClaudeReasoningTokens(effort);
  const effortMap: Partial<Record<ReasoningEffort, 'low' | 'medium' | 'high'>> =
    {
      [ReasoningEffort.Low]: 'low',
      [ReasoningEffort.Medium]: 'medium',
      [ReasoningEffort.High]: 'high',
    };

  return {
    thinking: { type: 'enabled', budget_tokens: budgetTokens },
    output_config: { effort: effortMap[effort] ?? 'high' },
    betaFlags: [...betaFlags],
  };
}

/**
 * Claude effort mode thinking (Opus 4.5).
 * Uses output_config.effort alongside an enabled-thinking budget. The
 * `effort-2025-11-24` Anthropic beta flag is required for upstream
 * validators (direct Anthropic / Bedrock / Vertex) to accept the
 * top-level `output_config` field; without it Bedrock and Vertex
 * reject the request with `400 Extra inputs are not permitted`.
 */
export function claudeEffortThinking(
  effort: ReasoningEffort
): AnthropicThinkingResult | undefined {
  return buildEnabledThinkingWithEffort(effort, ['effort-2025-11-24']);
}

/**
 * MiniMax effort thinking (Fireworks-hosted MiniMax M2.5 / M2.7).
 *
 * Mirrors the Claude effort-mode wire shape (Anthropic Messages API with
 * `output_config.effort` + an enabled-thinking budget) since Fireworks
 * accepts that body for its MiniMax deployments — but does NOT carry the
 * Anthropic-specific `effort-2025-11-24` beta flag, which Fireworks
 * neither understands nor needs.
 */
export function minimaxEffortThinking(
  effort: ReasoningEffort
): AnthropicThinkingResult | undefined {
  return buildEnabledThinkingWithEffort(effort, []);
}

/**
 * Claude adaptive thinking mode (Sonnet 4.6, Opus 4.6, and later models).
 * Uses thinking.type='adaptive' — Claude dynamically decides when and how
 * much to think. Works on all providers (direct, Bedrock, Vertex).
 *
 * @param opts.display - When set to 'summarized', opts in to receiving
 *   thinking block summaries. Models like Nectarine omit thinking content
 *   by default; this makes summaries visible.
 */
export function claudeAdaptiveThinking(
  effort: ReasoningEffort,
  opts?: { display?: 'summarized' }
): AnthropicThinkingResult | undefined {
  if (effort === ReasoningEffort.Off || effort === ReasoningEffort.None) {
    return undefined;
  }

  const effortMap: Partial<
    Record<ReasoningEffort, 'low' | 'medium' | 'high' | 'xhigh' | 'max'>
  > = {
    [ReasoningEffort.Low]: 'low',
    [ReasoningEffort.Medium]: 'medium',
    [ReasoningEffort.High]: 'high',
    [ReasoningEffort.ExtraHigh]: 'xhigh',
    [ReasoningEffort.Max]: 'max',
  };

  const thinking: { type: 'adaptive'; display?: 'summarized' } = {
    type: 'adaptive',
  };
  if (opts?.display) {
    thinking.display = opts.display;
  }

  return {
    thinking,
    output_config: { effort: effortMap[effort] ?? 'high' },
    betaFlags: [],
  };
}

// ============ API REQUEST CONFIGURATION ============

function getCustomModelConfig(
  customThinkingConfig: CustomModelThinkingConfig,
  reasoningEffort: ReasoningEffort
): AnthropicRequestConfig {
  const budgetTokens =
    customThinkingConfig.thinkingMaxTokens ??
    getClaudeReasoningTokens(reasoningEffort);
  if (budgetTokens <= 0) {
    return { betaFlags: [] };
  }

  return {
    thinking: {
      type: 'enabled',
      budget_tokens: budgetTokens,
    },
    betaFlags: ['interleaved-thinking-2025-05-14'],
  };
}

/**
 * Gets Anthropic API request configuration for a model and reasoning effort.
 * Uses the model's thinking closure from the registry to get the correct config.
 */
function getAnthropicRequestConfig(
  modelId: ModelID,
  reasoningEffort: ReasoningEffort
): AnthropicRequestConfig {
  const model = getModelRegistryEntry(modelId);

  // No thinking closure = model doesn't support thinking
  if (!model?.thinking) {
    return { betaFlags: [] };
  }

  // Off/None = no thinking
  if (
    reasoningEffort === ReasoningEffort.None ||
    reasoningEffort === ReasoningEffort.Off
  ) {
    return { betaFlags: [] };
  }

  // Get thinking config from registry closure
  const thinkingResult = model.thinking(reasoningEffort);
  if (!thinkingResult) {
    return { betaFlags: [] };
  }

  return {
    thinking: thinkingResult.thinking,
    outputConfig: thinkingResult.output_config,
    speed: thinkingResult.speed,
    betaFlags: thinkingResult.betaFlags,
  };
}

/**
 * Configures Anthropic request with thinking/effort parameters and guards.
 *
 * Main entry point for configuring Anthropic API requests. Handles:
 * - Custom model thinking configuration
 * - Standard model thinking/effort configuration
 * - Thinking guards for compaction and model switching
 * - Applying config to request params
 * - Merging beta flags into headers
 */
export function configureAnthropicRequest(
  params: ConfigureAnthropicRequestParams
): ConfigureAnthropicRequestResult {
  const {
    model,
    reasoningEffort,
    apiProvider,
    customThinkingConfig,
    conversationHistory,
    baseParams,
    baseHeaders,
  } = params;

  let config: AnthropicRequestConfig;

  if (customThinkingConfig?.enableThinking) {
    // For custom models with thinking enabled:
    // If we have a matched model that uses effort mode, use its config
    // Otherwise use the generic interleaved-thinking config
    if (model && isEffortModel(model.id)) {
      config = getAnthropicRequestConfig(model.id, reasoningEffort);
      // Override thinking budget if custom thinkingMaxTokens was specified
      // (only for 'enabled' type thinking, not 'auto' type)
      if (
        config.thinking?.type === 'enabled' &&
        customThinkingConfig.thinkingMaxTokens
      ) {
        config.thinking = {
          type: 'enabled',
          budget_tokens: customThinkingConfig.thinkingMaxTokens,
        };
      }
    } else {
      config = getCustomModelConfig(customThinkingConfig, reasoningEffort);
    }
  } else if (!model) {
    // No model definition provided (custom model without thinking config)
    return { headers: { ...baseHeaders }, config: { betaFlags: [] } };
  } else {
    // Validate reasoning effort against model's supported efforts
    if (
      reasoningEffort !== ReasoningEffort.None &&
      reasoningEffort !== ReasoningEffort.Off &&
      !model.reasoningEffort.supported.includes(reasoningEffort)
    ) {
      return { headers: { ...baseHeaders }, config: { betaFlags: [] } };
    }

    config = getAnthropicRequestConfig(model.id, reasoningEffort);
  }

  const modelId = model?.id ?? '';

  if (config.thinking && config.thinking.type !== 'adaptive') {
    if (
      shouldDisableThinkingForCompaction(conversationHistory) ||
      shouldDisableThinkingForModelSwitching(conversationHistory)
    ) {
      if (isEffortModel(modelId)) {
        config = {
          outputConfig: config.outputConfig,
          betaFlags: config.betaFlags,
        };
      } else {
        config = { betaFlags: [] };
      }

      if (baseParams.messages && Array.isArray(baseParams.messages)) {
        baseParams.messages = stripThinkingFromHistory(
          baseParams.messages as MessageForThinkingGuards[]
        );
      }
    }
  }

  // Apply custom model maxOutputTokens override
  if (customThinkingConfig?.maxOutputTokens != null) {
    baseParams.max_tokens = customThinkingConfig.maxOutputTokens;
  }

  // Apply config to base params
  if (config.thinking) {
    baseParams.thinking = config.thinking;
  }

  // Anthropic requires `max_tokens > thinking.budget_tokens` for enabled
  // thinking, so small output caps (completions, title generation,
  // BYOK `thinkingMaxTokens` configs) would be rejected with a deterministic
  // 400. Raise the cap so the requested budget remains available for text on
  // top of the thinking budget. No-op for normal turns, whose caps already
  // exceed every thinking budget.
  if (
    config.thinking?.type === 'enabled' &&
    config.thinking.budget_tokens > 0 &&
    typeof baseParams.max_tokens === 'number'
  ) {
    // BYOK customs without a registry model still have a real provider
    // ceiling; fall back to the user-configured output cap so the raise
    // cannot exceed it.
    const ceiling =
      model?.contextLimits(reasoningEffort).maxOutputTokens ??
      customThinkingConfig?.maxOutputTokens;
    const { budgetTokens, maxTokens } = clampMaxTokensAboveThinkingBudget({
      budgetTokens: config.thinking.budget_tokens,
      requestedMaxTokens: baseParams.max_tokens,
      ceiling,
    });
    if (budgetTokens !== config.thinking.budget_tokens) {
      baseParams.thinking = { ...config.thinking, budget_tokens: budgetTokens };
    }
    baseParams.max_tokens = maxTokens;
  }
  if (config.outputConfig) {
    baseParams.output_config = config.outputConfig;
  }
  if (config.speed) {
    baseParams.speed = config.speed;
  }

  // Bedrock / Vertex Anthropic upstreams reject the top-level
  // `output_config` field with `400 Extra inputs are not permitted`
  // unless the `effort-2025-11-24` Anthropic beta flag is sent. Direct
  // Anthropic accepts the field unconditionally for adaptive thinking,
  // and `claudeEffortThinking` already emits the flag for effort mode,
  // so this gate only fires for Bedrock / Vertex adaptive callers.
  if (
    config.outputConfig &&
    (apiProvider === ApiProvider.BEDROCK_ANTHROPIC ||
      apiProvider === ApiProvider.VERTEX_ANTHROPIC) &&
    !config.betaFlags.includes('effort-2025-11-24')
  ) {
    config.betaFlags = [...config.betaFlags, 'effort-2025-11-24'];
  }

  // Apply fast mode from model config (independent of thinking state)
  if (model?.anthropicFastMode) {
    baseParams.speed = 'fast';
    if (!config.betaFlags.includes('fast-mode-2026-02-01')) {
      config.betaFlags = [...config.betaFlags, 'fast-mode-2026-02-01'];
    }
  }

  // Build headers with beta flags
  let headers = { ...baseHeaders };
  if (config.betaFlags.length > 0) {
    const existingBeta = headers['anthropic-beta'];
    const allFlags = existingBeta
      ? `${existingBeta},${config.betaFlags.join(',')}`
      : config.betaFlags.join(',');
    headers = { ...headers, 'anthropic-beta': allFlags };
  }

  return { headers, config };
}
