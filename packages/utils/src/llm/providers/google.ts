/**
 * Google/Gemini provider-specific configuration closures.
 */

import {
  ApiProvider,
  ModelID,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';

import { getModelRegistryEntry } from '../model-registry-accessor';

import type {
  AnthropicThinkingResult,
  ApiRequestFn,
  ApiRequestParams,
  ConfigureGeminiRequestParams,
  ContextLimitsFn,
  GeminiRequestConfig,
  ThinkingFn,
} from '../types';

const REASONING_BUDGET: Partial<Record<ReasoningEffort, number>> = {
  [ReasoningEffort.Low]: 8192,
  [ReasoningEffort.Medium]: 16384,
  [ReasoningEffort.High]: 24576,
};

function isThinkingOff(effort: ReasoningEffort | undefined): boolean {
  return (
    !effort || effort === ReasoningEffort.Off || effort === ReasoningEffort.None
  );
}

// ============ CONTEXT LIMITS ============

/**
 * Gemini context limits.
 *
 * @param contextWindow - Total context window size
 * @param baseOutputTokens - Base output tokens (before thinking budget)
 * @param opts.adjustForThinkingBudget - If true, deducts thinking budget from context.
 *        Only GEMINI_2_5_FLASH uses this because it has explicit token budgets.
 */
export function geminiLimits(
  contextWindow: number,
  baseOutputTokens: number,
  opts?: { hasThinking?: boolean }
): ContextLimitsFn {
  const adjustForThinkingBudget = opts?.hasThinking ?? false;

  const compactionLimit = Math.min(contextWindow, 250000);

  return (effort) => {
    // No budget adjustment needed (Off, Dynamic, undefined, or model doesn't adjust)
    if (
      !adjustForThinkingBudget ||
      isThinkingOff(effort) ||
      effort === ReasoningEffort.Dynamic
    ) {
      return {
        maxInputTokens: contextWindow,
        defaultCompactionLimit: compactionLimit,
        maxOutputTokens: baseOutputTokens,
        temperature: 0.5,
      };
    }

    // Deduct thinking budget from context window (Low/Medium/High)
    const thinkingBudget = REASONING_BUDGET[effort] ?? 0;
    const inputTokens = contextWindow - thinkingBudget;
    return {
      maxInputTokens: inputTokens,
      defaultCompactionLimit: Math.min(compactionLimit, inputTokens),
      maxOutputTokens: thinkingBudget + baseOutputTokens,
      temperature: 1.0,
    };
  };
}

// ============ THINKING CONFIGURATION ============

/**
 * Gemini thinking configuration.
 */
export function geminiThinking(opts?: {
  supportsDynamic?: boolean;
}): ThinkingFn {
  const supportsDynamic = opts?.supportsDynamic ?? false;

  return (effort): AnthropicThinkingResult | undefined => {
    if (isThinkingOff(effort)) return undefined;
    if (effort === ReasoningEffort.Dynamic && !supportsDynamic)
      return undefined;

    // Gemini doesn't use beta flags, but we return the common type for consistency
    return { betaFlags: [] };
  };
}

// ============ API REQUEST CONFIGURATION ============

/**
 * Map reasoning effort to Gemini thinkingLevel.
 * Google SDK only supports LOW and HIGH - no MEDIUM.
 * Only called for Low/Medium/High/ExtraHigh - not for Off/None/Dynamic.
 */
function effortToThinkingLevel(
  effort: ReasoningEffort,
  opts?: { supportsMedium?: boolean }
): 'LOW' | 'MEDIUM' | 'HIGH' {
  switch (effort) {
    case ReasoningEffort.Low:
    case ReasoningEffort.Minimal:
      return 'LOW';
    case ReasoningEffort.Medium:
      return opts?.supportsMedium ? 'MEDIUM' : 'HIGH';
    default:
      return 'HIGH';
  }
}

/**
 * Configure Gemini API request parameters.
 * For models with explicit thinking budgets (Gemini 2.5 Flash) use useBudget: true.
 * For models with thinking levels (Gemini 3) use default (useBudget: false).
 */
export function geminiRequest(opts?: {
  useBudget?: boolean;
  supportsMedium?: boolean;
}): ApiRequestFn {
  const useBudget = opts?.useBudget ?? false;
  const supportsMedium = opts?.supportsMedium ?? false;

  return (ctx): ApiRequestParams => {
    // Budget models (Gemini 2.5 Flash) use explicit token budgets
    if (useBudget) {
      if (isThinkingOff(ctx.effort)) {
        // Off/None: disable thinking with budget 0
        return { gemini: { includeThoughts: false, thinkingBudget: 0 } };
      }
      if (ctx.effort === ReasoningEffort.Dynamic) {
        // Dynamic: enable thinking with budget -1
        return { gemini: { includeThoughts: true, thinkingBudget: -1 } };
      }
      // Low/Medium/High: use explicit budget
      const thinkingBudget = REASONING_BUDGET[ctx.effort] ?? 0;
      return { gemini: { includeThoughts: true, thinkingBudget } };
    }

    // Level models (Gemini 3): Off and None both disable thinking
    if (isThinkingOff(ctx.effort)) {
      return { gemini: { includeThoughts: false } };
    }

    // Dynamic: let the model decide (don't send thinkingLevel)
    if (ctx.effort === ReasoningEffort.Dynamic) {
      return { gemini: { includeThoughts: true } };
    }

    // Low/Medium/High: set explicit thinkingLevel
    return {
      gemini: {
        includeThoughts: true,
        thinkingLevel: effortToThinkingLevel(ctx.effort, { supportsMedium }),
      },
    };
  };
}

/**
 * Configure Gemini API request parameters.
 * Looks up model-specific config from the registry.
 *
 * This centralizes all Gemini generation/thinking configuration logic.
 */
export function configureGeminiRequest(
  params: ConfigureGeminiRequestParams
): GeminiRequestConfig {
  const { modelId, reasoningEffort } = params;

  // Get model-specific config from registry
  const model = getModelRegistryEntry(modelId as ModelID);
  const apiParams = model?.apiRequest?.({
    effort: reasoningEffort,
    sessionId: '',
    apiProvider: ApiProvider.GOOGLE,
  });
  const geminiConfig = apiParams?.gemini;

  const includeThoughts =
    geminiConfig?.includeThoughts ?? !isThinkingOff(reasoningEffort);

  // Use thinkingBudget if provided by registry (Gemini 2.5 Flash),
  // otherwise use thinkingLevel (Gemini 3+ models)
  const thinkingBudget = geminiConfig?.thinkingBudget;
  const thinkingLevel =
    !thinkingBudget && includeThoughts
      ? (geminiConfig?.thinkingLevel ?? effortToThinkingLevel(reasoningEffort))
      : undefined;

  return {
    generationConfig: {
      temperature: 1,
      topP: 0.95,
      topK: 64,
      thinkingConfig: {
        includeThoughts,
        thinkingBudget,
        thinkingLevel,
      },
    },
  };
}
