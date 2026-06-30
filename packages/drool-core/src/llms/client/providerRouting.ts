import { IndustryRegion } from '@industry/common/shared';
import {
  ApiProvider,
  ModelID,
  ModelProvider,
} from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn } from '@industry/logging';
import {
  getLLMConfig,
  getProvidersAvailableInRegion,
} from '@industry/utils/llm';
import { isOpenAIResponsesApiProvider } from '@industry/utils/llm/providers/openai';

// ---------------------------------------------------------------------------
// Provider detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if a model provider is Google and should use the Gemini native API.
 */
export function isGoogleProvider(modelProvider: ModelProvider): boolean {
  return modelProvider === ModelProvider.GOOGLE;
}

/**
 * Determine whether the given model should use the OpenAI SDK (and `/api/llm/o/v1` proxy).
 * This mirrors the provider routing logic in `createLLMStreamingCore.ts`.
 *
 * Note: Google is NOT included here because it uses the Gemini native API
 * (`/api/llm/g/v1/generate`) with raw fetch + SSE, not the OpenAI SDK.
 * However, Google still creates an OpenAI client as a placeholder — see
 * {@link needsOpenAIClient} for that broader check.
 */
function isOpenAICompatibleProvider(modelProvider: ModelProvider): boolean {
  return (
    modelProvider === ModelProvider.OPENAI ||
    modelProvider === ModelProvider.XAI ||
    modelProvider === ModelProvider.INDUSTRY ||
    modelProvider === ModelProvider.GENERIC_CHAT_COMPLETION_API
  );
}

/**
 * Determine whether the model should use the OpenAI Responses API (responses.create)
 * vs Chat Completions (chat.completions.create).
 *
 * OpenAI and XAI models use `responses.create`, matching the main CLI routing
 * in createLLMStreamingCore.ts (sendOpenAIMessage).
 * Industry and Generic models use `chat.completions.create`, matching sendOpenAIChatMessage.
 */
export function shouldUseResponsesAPI(modelProvider: ModelProvider): boolean {
  return (
    modelProvider === ModelProvider.OPENAI ||
    modelProvider === ModelProvider.XAI
  );
}

/**
 * Check if a model is a Fireworks Anthropic-compat model (Industry model routed
 * via Fireworks using Anthropic wire format). These use the Anthropic SDK despite
 * having a INDUSTRY modelProvider.
 *
 * Examples: MiniMax M2.5 (provider: INDUSTRY, apiModelProvider: ANTHROPIC,
 * apiProviders: [FIREWORKS]).
 */
export function isFireworksAnthropicCompatModel(
  modelId: string,
  modelProvider: ModelProvider
): boolean {
  if (modelProvider !== ModelProvider.INDUSTRY) return false;
  try {
    const registryConfig = getLLMConfig({ modelId: modelId as ModelID });
    return (
      (registryConfig.apiProviders?.includes(ApiProvider.FIREWORKS) ?? false) &&
      registryConfig.apiModelProvider === ModelProvider.ANTHROPIC
    );
  } catch (error) {
    logWarn(
      '[isFireworksAnthropicCompatModel] Unknown model, defaulting to false',
      { modelId, cause: error }
    );
    return false;
  }
}

/**
 * Determine whether the Anthropic SDK should be used for the given model.
 * Returns true for native Anthropic models and Fireworks Anthropic-compat models.
 * Returns false for Google (uses Gemini native), OpenAI/XAI (uses responses API),
 * and Industry/Generic (uses chat completions).
 */
export function shouldUseAnthropicSDK(
  modelId: string,
  modelProvider: ModelProvider
): boolean {
  if (isFireworksAnthropicCompatModel(modelId, modelProvider)) return true;
  if (isGoogleProvider(modelProvider)) return false;
  return !isOpenAICompatibleProvider(modelProvider);
}

/**
 * Whether a model provider needs an OpenAI client instance.
 * Returns true for OPENAI, XAI, INDUSTRY, GENERIC, **and GOOGLE**.
 *
 * Google is included because `useLLMStreaming` creates an OpenAI client as a
 * placeholder for the base URL / header setup, even though Gemini actually
 * sends requests via raw fetch to `/api/llm/g/v1/generate`.
 *
 * Note: Fireworks Anthropic-compat models (INDUSTRY with Anthropic wire format)
 * should be checked via `shouldUseAnthropicSDK` **first** — this function
 * does not account for them and would return `true` for their INDUSTRY provider.
 */
export function needsOpenAIClient(modelProvider: ModelProvider): boolean {
  return (
    isOpenAICompatibleProvider(modelProvider) || isGoogleProvider(modelProvider)
  );
}

/**
 * Resolve the effective provider semantics for OpenAI Chat Completions interop.
 *
 * Some BYOK/custom models use the generic chat-completions path while still
 * speaking Gemini's OpenAI-compatible dialect, which requires preserving
 * `extra_content.google.thought_signature` across tool turns.
 */
export function resolveChatCompletionsInteropProvider(
  modelId: string,
  modelProvider: ModelProvider,
  customModel?: { baseUrl?: string | null } | null
): ModelProvider {
  if (modelProvider !== ModelProvider.GENERIC_CHAT_COMPLETION_API) {
    return modelProvider;
  }

  const normalizedModelId = modelId.toLowerCase();
  const normalizedBaseUrl = customModel?.baseUrl?.toLowerCase() ?? '';
  const isGeminiModel = normalizedModelId.startsWith('gemini-');
  const isGoogleCompatibleBaseUrl =
    normalizedBaseUrl.includes('generativelanguage.googleapis.com') ||
    normalizedBaseUrl.includes('aiplatform.googleapis.com');

  return isGeminiModel || isGoogleCompatibleBaseUrl
    ? ModelProvider.GOOGLE
    : modelProvider;
}

// ---------------------------------------------------------------------------
// URL resolution helpers
// ---------------------------------------------------------------------------

/**
 * Determine the proxy base URL for the given model and provider.
 *
 * - Fireworks Anthropic-compat → `/api/llm/a` (Anthropic SDK path)
 * - OpenAI, XAI, Industry, Generic → `/api/llm/o/v1`
 * - Google → `/api/llm/o/v1` (OpenAI client placeholder; Gemini actually
 *   uses raw fetch to `/api/llm/g/v1/generate` — see {@link getGeminiEndpoint})
 * - Anthropic → `/api/llm/a`
 */
export function getProxyBaseURL(
  modelId: string,
  modelProvider: ModelProvider,
  apiBaseUrl: string
): string {
  if (isFireworksAnthropicCompatModel(modelId, modelProvider)) {
    return `${apiBaseUrl}/api/llm/a`;
  }
  // Google gets /api/llm/o/v1 because useLLMStreaming creates an OpenAI client
  // as a placeholder, even though Gemini uses raw fetch to a different endpoint.
  if (
    isOpenAICompatibleProvider(modelProvider) ||
    isGoogleProvider(modelProvider)
  ) {
    return `${apiBaseUrl}/api/llm/o/v1`;
  }
  // Anthropic and other non-OpenAI-compatible providers
  return `${apiBaseUrl}/api/llm/a`;
}

/**
 * Get the full Gemini API endpoint URL for Google models.
 * The model is passed in the request body, not the URL path.
 */
export function getGeminiEndpoint(apiBaseUrl: string, _model: string): string {
  return `${apiBaseUrl}/api/llm/g/v1/generate`;
}

// ---------------------------------------------------------------------------
// Provider header resolution helpers
// ---------------------------------------------------------------------------

function isRegionEligible(
  provider: ApiProvider,
  region: IndustryRegion
): boolean {
  return getProvidersAvailableInRegion(region).has(provider);
}

/**
 * Resolve the ApiProvider for Industry/Generic models based on the model registry.
 *
 * - Defaults to FIREWORKS
 * - Returns BASETEN only if the model's `apiProviders` includes BASETEN but
 *   not FIREWORKS
 * - If `existingLock` is FIREWORKS or BASETEN, preserves it (caller already
 *   determined the correct provider from a previous request in the session)
 */
function resolveIndustryApiProvider(
  modelId: string,
  region: IndustryRegion,
  existingLock: ApiProvider | undefined
): ApiProvider {
  // Preserve existing valid lock if it's region-eligible.
  if (
    (existingLock === ApiProvider.FIREWORKS ||
      existingLock === ApiProvider.BASETEN) &&
    isRegionEligible(existingLock, region)
  ) {
    return existingLock;
  }
  try {
    const registryConfig = getLLMConfig({ modelId: modelId as ModelID });
    const providers = registryConfig.apiProviders ?? [];
    if (
      providers.includes(ApiProvider.BASETEN) &&
      !providers.includes(ApiProvider.FIREWORKS)
    ) {
      return ApiProvider.BASETEN;
    }
    return ApiProvider.FIREWORKS;
  } catch (error) {
    logWarn(
      '[resolveIndustryApiProvider] Unknown/custom model, defaulting to FIREWORKS',
      { modelId, cause: error }
    );
    return ApiProvider.FIREWORKS;
  }
}

/**
 * Resolve the correct ApiProvider for the proxy headers based on model
 * provider.
 *
 * Provider-selection precedence:
 *
 * | Provider path              | ApiProvider                                            |
 * | -------------------------- | ------------------------------------------------------ |
 * | Google                     | GOOGLE                                                 |
 * | Fireworks Anthropic-compat | FIREWORKS                                              |
 * | Anthropic                  | ANTHROPIC                                              |
 * | XAI                        | XAI                                                    |
 * | OpenAI                     | OPENAI (preserves AZURE_OPENAI if `existingLock`)      |
 * | Industry / Generic          | FIREWORKS or BASETEN (preserves valid `existingLock`)  |
 *
 * Region enforcement remains authoritative on the server
 * (`enforceModelRegion` in the proxy validation layer). The defaults
 * picked here (OPENAI, FIREWORKS, ANTHROPIC, GOOGLE, XAI) are the
 * canonical safe choices for each wire format and are assumed
 * region-eligible everywhere we ship a backend.
 *
 * Client-side region checks live only on the `existingLock` paths —
 * a session may have persisted a secondary provider (AZURE_OPENAI,
 * BASETEN) that isn't eligible in the current region. Rather than
 * send a request the server will reject, we drop the stale lock and
 * fall through to the regional-safe default.
 *
 * @param existingLock - API provider already locked for the current
 *   session (from `deps.getLockedApiProvider()`). When set, the function
 *   preserves compatible locks (AZURE_OPENAI for OpenAI, BASETEN for
 *   Industry).
 */
export function resolveProxyApiProvider(
  modelId: string,
  modelProvider: ModelProvider,
  region: IndustryRegion,
  existingLock?: ApiProvider
): ApiProvider {
  // Google always uses GOOGLE
  if (isGoogleProvider(modelProvider)) {
    return ApiProvider.GOOGLE;
  }

  // Fireworks Anthropic-compat Industry models use the Anthropic SDK path
  // but must send ApiProvider.FIREWORKS so the proxy routes correctly.
  if (isFireworksAnthropicCompatModel(modelId, modelProvider)) {
    return ApiProvider.FIREWORKS;
  }

  // Native Anthropic models
  if (!isOpenAICompatibleProvider(modelProvider)) {
    return ApiProvider.ANTHROPIC;
  }

  // OpenAI Responses API path (OpenAI / XAI)
  if (shouldUseResponsesAPI(modelProvider)) {
    if (modelProvider === ModelProvider.XAI) {
      return ApiProvider.XAI;
    }
    // OpenAI: preserve compatible locks if region-eligible; otherwise
    // fall through to OPENAI direct.
    if (
      isOpenAIResponsesApiProvider(existingLock) &&
      isRegionEligible(existingLock, region)
    ) {
      return existingLock;
    }
    return ApiProvider.OPENAI;
  }

  // Chat Completions path (Industry / Generic)
  // Preserve FIREWORKS or BASETEN if already locked; otherwise resolve from
  // the model registry (defaults to FIREWORKS).
  return resolveIndustryApiProvider(modelId, region, existingLock);
}
