/**
 * OpenAI provider-specific configuration closures.
 */
import {
  INDUSTRY_OPENAI_ORG_ID,
  OPENAI_PLATFORM_HEADER,
} from '@industry/common/llm';
import {
  ApiProvider,
  type ModelID,
  ModelProvider,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';

import { mapToOpenAIEffort } from './reasoning';
import {
  findClosestModelIdFromRegistry,
  getModelRegistryEntry,
} from '../model-registry-accessor';

import type {
  ApiRequestFn,
  ApiRequestParams,
  ConfigureOpenAIRequestParams,
  ContextLimitsFn,
  OpenAIRequestConfig,
  TokenLimits,
} from '../types';

// ============ OPENAI PLATFORM HEADER ============
//
// The constants (OPENAI_PLATFORM_HEADER, INDUSTRY_OPENAI_ORG_ID) live in
// @industry/common/llm so that lightweight consumers (signal cloud function,
// backend direct OpenAI clients) can attach the header without pulling in
// the full @industry/utils dependency.
//
// The helpers below centralize the decision of *when* to include the header:
//   - Industry proxy path → baked into createProxyHeaders based on api provider
//   - BYOK path → `getOpenAIPlatformHeadersForCustomModel(customModel)`

/**
 * Whether a BYOK/custom model id resolves to an OpenAI-provider model in our
 * model registry. Used to decide whether to attach the OpenAI-Platform header
 * for BYOK requests (we only want it set when the traffic is actually going
 * to OpenAI).
 */
function isOpenAIRegistryModel(modelId: string): boolean {
  const closestId = findClosestModelIdFromRegistry(modelId);
  if (!closestId) return false;
  return getModelRegistryEntry(closestId)?.provider === ModelProvider.OPENAI;
}

/**
 * Return the `OpenAI-Platform` header (or an empty object) for a BYOK custom
 * model. Included when the custom model's id matches an OpenAI-provider model
 * in the registry (e.g. a user bringing their own OpenAI key for gpt-5).
 *
 * For Industry-proxied requests, the header is added automatically inside
 * `createProxyHeaders` based on the resolved `proxyApiProvider`.
 */
export function getOpenAIPlatformHeadersForCustomModel(
  customModel: { model: string } | null | undefined
): Record<string, string> {
  if (!customModel) return {};
  return isOpenAIRegistryModel(customModel.model)
    ? { [OPENAI_PLATFORM_HEADER]: INDUSTRY_OPENAI_ORG_ID }
    : {};
}

/**
 * Whether an `ApiProvider` value denotes an OpenAI-backed route (either
 * OpenAI direct or Azure OpenAI for built-in OpenAI models). Used by the
 * Industry proxy header builder to decide whether to attach
 * `OpenAI-Platform`.
 */
export function isOpenAIBackedApiProvider(
  apiProvider: ApiProvider | null | undefined
): apiProvider is ApiProvider.OPENAI | ApiProvider.AZURE_OPENAI {
  return (
    apiProvider === ApiProvider.OPENAI ||
    apiProvider === ApiProvider.AZURE_OPENAI
  );
}

/**
 * Returns true for API providers that speak the OpenAI Responses wire protocol.
 */
export function isOpenAIResponsesApiProvider(
  apiProvider: ApiProvider | null | undefined
): apiProvider is
  | ApiProvider.OPENAI
  | ApiProvider.AZURE_OPENAI
  | ApiProvider.BEDROCK_OPENAI {
  return (
    apiProvider === ApiProvider.BEDROCK_OPENAI ||
    isOpenAIBackedApiProvider(apiProvider)
  );
}

/**
 * Fixed context limits (no dynamic adjustment).
 * Automatically sets defaultCompactionLimit to min(maxInputTokens, 250K) if not provided.
 */
export function fixedLimits(
  limits: TokenLimits | Omit<TokenLimits, 'defaultCompactionLimit'>
): ContextLimitsFn {
  const fullLimits: TokenLimits = {
    ...limits,
    defaultCompactionLimit:
      'defaultCompactionLimit' in limits
        ? limits.defaultCompactionLimit
        : Math.min(limits.maxInputTokens, 250000),
  };
  return () => fullLimits;
}

/**
 * Configure OpenAI API request parameters.
 *
 * Options:
 * - parallelToolCalls: Enable/disable parallel tool calls (default true)
 * - extendedCache: Enable extended cache retention (24h)
 * - serviceTier: 'priority' for priority service tier
 * - verbosity: Response verbosity level
 * - safetyId: Include safety_identifier using userId (GPT-5.2-Codex and later)
 */
export function openaiRequest(opts?: {
  parallelToolCalls?: boolean;
  extendedCache?: boolean;
  serviceTier?: 'priority';
  verbosity?: 'low' | 'medium' | 'high';
  safetyId?: boolean;
}): ApiRequestFn {
  return (ctx): ApiRequestParams => {
    const isReasoning =
      ctx.effort !== ReasoningEffort.None && ctx.effort !== ReasoningEffort.Off;

    return {
      openai: {
        parallel_tool_calls: opts?.parallelToolCalls ?? true,
        reasoning: isReasoning
          ? { effort: mapToOpenAIEffort(ctx.effort), summary: 'auto' }
          : undefined,
        prompt_cache_key: opts?.extendedCache ? ctx.sessionId : undefined,
        prompt_cache_retention: opts?.extendedCache ? '900' : undefined,
        verbosity: opts?.verbosity,
        service_tier: opts?.serviceTier,
        // Safety identifier must be a stable per-user ID (not session-scoped)
        safety_identifier: opts?.safetyId
          ? (ctx.userId ?? ctx.sessionId)
          : undefined,
      },
    };
  };
}

// ============ OPENAI REQUEST CONFIGURATION ============

/**
 * Configure OpenAI Responses API request parameters.
 * Looks up model-specific config from the registry.
 *
 * This centralizes all OpenAI reasoning/thinking configuration logic.
 */
export function configureOpenAIRequest(
  params: ConfigureOpenAIRequestParams
): OpenAIRequestConfig {
  const {
    modelId,
    reasoningEffort,
    sessionId,
    apiProvider,
    maxOutputTokens,
    modelProvider,
    effectiveModelId,
    userId,
    isCustomModel,
  } = params;

  // Use pre-resolved effectiveModelId if provided, otherwise do fuzzy lookup
  const registryModelId =
    effectiveModelId ??
    findClosestModelIdFromRegistry(modelId) ??
    (modelId as ModelID);
  const model = getModelRegistryEntry(registryModelId);
  const apiParams = model?.apiRequest?.({
    effort: reasoningEffort,
    sessionId,
    apiProvider,
    userId,
  });
  const openaiConfig = apiParams?.openai ?? {};

  // Use model provider from registry, or fallback to passed-in provider (for custom models)
  const effectiveProvider = model?.provider ?? modelProvider;

  const isNonReasoningMode =
    reasoningEffort === ReasoningEffort.None ||
    reasoningEffort === ReasoningEffort.Off ||
    reasoningEffort === ReasoningEffort.Dynamic;

  // XAI models use auto-thinking (no explicit reasoning config, but include reasoning content)
  const isXAIModel = effectiveProvider === ModelProvider.XAI;

  // Include reasoning content when reasoning is enabled or XAI auto-thinking
  type IncludeType = OpenAIRequestConfig['requestParams']['include'];
  const include: IncludeType =
    isNonReasoningMode && !isXAIModel
      ? undefined
      : ['reasoning.encrypted_content'];

  // Reasoning config - omit for non-reasoning or XAI auto-thinking
  type ReasoningType = OpenAIRequestConfig['requestParams']['reasoning'];
  const reasoning: ReasoningType =
    isNonReasoningMode || isXAIModel
      ? undefined
      : {
          effort: mapToOpenAIEffort(reasoningEffort),
          summary: 'auto' as const,
        };

  // Extended cache retention (OpenAI direct only, from registry).
  //
  // BYOK custom models reach the `responses` path with no locked apiProvider,
  // so the caller falls back to `ApiProvider.OPENAI` even though the endpoint
  // is whatever baseUrl the user configured — most commonly Azure OpenAI. The
  // `24h` extended-cache-retention value is an OpenAI-direct-only optimization;
  // Azure OpenAI's Responses API rejects it with a messageless `response.failed`
  // event that surfaces as "OpenAI response failed: OpenAI response failed".
  // Only `gpt-5.2` (the lone GPT-5.x family entry without extended cache in the
  // registry) escaped this, which is exactly the working/failing split users
  // reported. Suppress the param for custom models so we never send an
  // OpenAI-direct-only field to an endpoint we can't assume is OpenAI direct
  // (CL-304).
  const promptCacheRetention =
    openaiConfig.prompt_cache_retention &&
    apiProvider === ApiProvider.OPENAI &&
    !isCustomModel
      ? ('24h' as const)
      : undefined;

  // Verbosity from registry
  const verbosity = openaiConfig.verbosity as
    | 'low'
    | 'medium'
    | 'high'
    | undefined;

  // OpenAI-compatible models (GPT-5 family or custom openai provider) need explicit tool_choice
  // and handle output tokens automatically
  const isOpenAIModel = effectiveProvider === ModelProvider.OPENAI;

  // Safety identifier from registry (GPT-5.2-Codex and later)
  const safetyIdentifier = openaiConfig.safety_identifier;

  // Service tier from registry (e.g. 'priority' for GPT-5.4 Fast Mode)
  const serviceTier = openaiConfig.service_tier;

  return {
    requestParams: {
      tool_choice: isOpenAIModel ? 'auto' : undefined,
      parallel_tool_calls: openaiConfig.parallel_tool_calls ?? true,
      // OpenAI models handle output tokens automatically
      max_output_tokens: isOpenAIModel ? undefined : maxOutputTokens,
      include,
      reasoning,
      prompt_cache_key: sessionId,
      prompt_cache_retention: promptCacheRetention,
      ...(verbosity ? { text: { verbosity } } : {}),
      ...(safetyIdentifier ? { safety_identifier: safetyIdentifier } : {}),
      ...(serviceTier ? { service_tier: serviceTier } : {}),
    },
  };
}
