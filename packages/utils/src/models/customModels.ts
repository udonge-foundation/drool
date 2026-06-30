import { LLM_BEDROCK_DEFAULT_REGION } from '@industry/common/settings';
import {
  ModelProvider,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn, MetaError } from '@industry/logging';

import { findClosestModelId, getModelConfig } from '../llm';

import type { HttpCustomModel } from './types';
import type {
  CustomModel,
  CustomModelBedrockConfig,
} from '@industry/common/settings';
import type {
  BuiltInModelID,
  CustomModelID,
} from '@industry/drool-sdk-ext/protocol/llm';

function sanitizeDisplayName(name: string): string {
  return name.trim().replace(/\s+/g, '-');
}

const ALL_REASONING_EFFORTS: ReasoningEffort[] = Object.values(ReasoningEffort);

// Conservative baseline for custom models whose upstream `model` string does
// not resolve to a known builtin (or resolves to a non-reasoning builtin).
// If the user explicitly configures a different valid ReasoningEffort, it is
// unioned in by `withConfiguredReasoningEffort` below.
const CUSTOM_MODEL_REASONING_EFFORTS_FALLBACK: ReasoningEffort[] = [
  ReasoningEffort.Off,
  ReasoningEffort.Low,
  ReasoningEffort.Medium,
  ReasoningEffort.High,
];

function withConfiguredReasoningEffort(
  supportedEfforts: readonly ReasoningEffort[],
  configuredEffort: ReasoningEffort | undefined
): ReasoningEffort[] {
  const supported = new Set(supportedEfforts);
  if (configuredEffort) {
    supported.add(configuredEffort);
  }
  return ALL_REASONING_EFFORTS.filter((effort) => supported.has(effort));
}

function getSupportedCustomModelDefaultEffort(
  configuredEffort: ReasoningEffort | undefined,
  supportedEfforts: readonly ReasoningEffort[]
): ReasoningEffort {
  if (configuredEffort && supportedEfforts.includes(configuredEffort)) {
    return configuredEffort;
  }
  if (supportedEfforts.includes(ReasoningEffort.None)) {
    return ReasoningEffort.None;
  }
  return supportedEfforts[0] ?? ReasoningEffort.None;
}

function resolveBuiltinReasoningMetadata(modelString: string):
  | {
      supportedReasoningEfforts: ReasoningEffort[];
      defaultReasoningEffort: ReasoningEffort;
    }
  | undefined {
  const builtinId = findClosestModelId(modelString);
  if (!builtinId) return undefined;

  try {
    const config = getModelConfig(builtinId);
    return {
      supportedReasoningEfforts: [...config.supportedReasoningEfforts],
      defaultReasoningEffort: config.defaultReasoningEffort,
    };
  } catch (err) {
    logWarn(
      'getCustomModelSupportedEfforts: failed to load builtin model config',
      { cause: err, modelId: builtinId }
    );
    return undefined;
  }
}

/**
 * Compute the reasoning effort levels surfaced for a custom BYOK model.
 *
 * Resolution order:
 * 1. If `modelString` resolves to a known builtin via `findClosestModelId`,
 *    surface that builtin's registry-backed `supportedReasoningEfforts`.
 * 2. If `reasoningEffort` is `undefined` or `None`, the model has not opted
 *    into reasoning -> return `[None]`.
 * 3. Otherwise (truly unknown custom endpoint) surface the conservative
 *    `[Off, Low, Medium, High]` list while preserving any explicitly
 *    configured ReasoningEffort enum value.
 *
 * Note: each provider request path applies its own additional validation on
 * the resolved effort (Chat Completions: logs + omits via
 * `resolveChatCompletionsReasoningRequestConfig`; Anthropic: drops thinking
 * config via `model.reasoningEffort.supported`; Responses API: relies on the
 * surfaced supported list; Gemini: registry-only). This helper is the single
 * source of truth for what gets *surfaced* in the UI / model switcher.
 */
export function getCustomModelSupportedEfforts(
  reasoningEffort: ReasoningEffort | undefined,
  modelString?: string
): ReasoningEffort[] {
  const builtinMetadata = modelString
    ? resolveBuiltinReasoningMetadata(modelString)
    : undefined;
  if (builtinMetadata) {
    return builtinMetadata.supportedReasoningEfforts;
  }

  const hasReasoningEffort =
    reasoningEffort !== undefined && reasoningEffort !== ReasoningEffort.None;
  if (!hasReasoningEffort) {
    return [ReasoningEffort.None];
  }

  return withConfiguredReasoningEffort(
    CUSTOM_MODEL_REASONING_EFFORTS_FALLBACK,
    reasoningEffort
  );
}

export function getCustomModelReasoningMetadata(
  reasoningEffort: ReasoningEffort | undefined,
  modelString?: string
): {
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
} {
  const builtinMetadata = modelString
    ? resolveBuiltinReasoningMetadata(modelString)
    : undefined;
  if (builtinMetadata) {
    return builtinMetadata;
  }

  const supportedReasoningEfforts = getCustomModelSupportedEfforts(
    reasoningEffort,
    modelString
  );
  return {
    supportedReasoningEfforts,
    defaultReasoningEffort: getSupportedCustomModelDefaultEffort(
      reasoningEffort,
      supportedReasoningEfforts
    ),
  };
}

/**
 * Build a custom model ID from display name and index
 * Format: "custom:<displayName>-<index>"
 */
export function buildCustomModelId(
  displayName: string,
  index: number
): CustomModelID {
  return `custom:${sanitizeDisplayName(displayName)}-${index}`;
}

/**
 * Compute stable per-display-name indices for an array of display names.
 * Unlike array positions, these indices only change when models with the
 * *same* display name are added/removed — not when unrelated models are
 * inserted elsewhere in the list.
 *
 * First occurrence of a name gets 0, second gets 1, etc.
 */
export function computeStableIndices(displayNames: string[]): number[] {
  const seen = new Map<string, number>();
  return displayNames.map((name) => {
    const key = sanitizeDisplayName(name);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count;
  });
}

/**
 * Parse a custom model ID to extract display name and index
 */
export function parseCustomModelId(
  fullId: string,
  models?: CustomModel[]
): { displayName: string; index: number; isNewFormat: boolean } | null {
  if (!fullId.startsWith('custom:')) return null;

  const withoutPrefix = fullId.slice('custom:'.length);

  const lastDashIndex = withoutPrefix.lastIndexOf('-');
  if (lastDashIndex > 0) {
    const potentialIndex = withoutPrefix.slice(lastDashIndex + 1);
    const index = parseInt(potentialIndex, 10);

    if (
      !Number.isNaN(index) &&
      index >= 0 &&
      potentialIndex === index.toString()
    ) {
      const displayName = withoutPrefix.slice(0, lastDashIndex);

      if (models) {
        if (index < models.length) {
          const expectedId = buildCustomModelId(
            models[index].displayName,
            index
          );
          if (expectedId === fullId) {
            return { displayName, index, isNewFormat: true };
          }
        }

        // The numeric suffix was out of bounds (or didn't match the expected
        // canonical form), but the full ID may still be a stored model's
        // canonical id — e.g. "custom:claude-opus-4-6-thinking-32000" where
        // "-32000" looks like an index but is actually part of the model name.
        // A direct id match means no migration is needed.
        const directMatch = models.find((m) => m.id === fullId);
        if (directMatch) {
          return {
            displayName: directMatch.displayName,
            index: directMatch.index,
            isNewFormat: true,
          };
        }
      } else {
        return { displayName, index, isNewFormat: true };
      }
    }
  }

  return { displayName: withoutPrefix, index: -1, isNewFormat: false };
}

/**
 * Find a custom model by ID from the provided models array.
 * Supports both new format (custom:<displayName>-<index>) and legacy format (custom:<modelName>).
 */
export function findCustomModel(
  modelId: string,
  models: CustomModel[]
): CustomModel | null {
  if (!modelId.startsWith('custom:')) return null;
  if (!Array.isArray(models) || models.length === 0) return null;

  const parsed = parseCustomModelId(modelId, models);
  const syntacticParsed = parseCustomModelId(modelId);
  if (!parsed) return null;

  if (parsed.isNewFormat && parsed.index >= 0) {
    if (parsed.index < models.length) {
      const model = models[parsed.index];
      if (model && model.id === modelId) {
        return model;
      }
    }
    // Index-based lookup failed (models may have been reordered by settings
    // hierarchy merging). Fall through to linear scan by id.
  }

  // Match by model.id (the canonical custom model ID)
  const matchById = models.find((m) => m.id === modelId);
  if (matchById) {
    return matchById;
  }

  if (syntacticParsed?.isNewFormat) {
    const matchByLegacyPositionId = models.find(
      (m) =>
        m.id.startsWith(`custom:${sanitizeDisplayName(m.displayName)}-`) &&
        buildCustomModelId(m.displayName, m.index) === modelId
    );
    if (matchByLegacyPositionId) {
      return matchByLegacyPositionId;
    }

    const displayNameMatches = models.filter(
      (m) => sanitizeDisplayName(m.displayName) === syntacticParsed.displayName
    );
    if (
      displayNameMatches.length === 1 &&
      displayNameMatches[0].id.startsWith(
        `custom:${syntacticParsed.displayName}-`
      )
    ) {
      return displayNameMatches[0];
    }
  }

  // Legacy format: match by model name
  const rawModel = modelId.slice('custom:'.length);
  return models.find((m) => m.model === rawModel) ?? null;
}

/**
 * Returns every custom model opted into Industry Router BYOK (`useInRouter`)
 * for the given built-in base model, preserving the order of `models` (the
 * caller's configured/stable-index order).
 *
 * Callers MUST still validate access and policy (e.g. `validateModelAccess`
 * and `allowIndustryRouterByok`) before dispatching to any returned model:
 * this lookup matches only on `useInRouter` + `baseModelId` and performs no
 * access checks, so the first match is not guaranteed to be usable.
 */
export function findRouterByokCustomModels(
  baseModelId: BuiltInModelID,
  models: readonly CustomModel[]
): CustomModel[] {
  return models.filter(
    (model) => model.useInRouter === true && model.baseModelId === baseModelId
  );
}

/**
 * Returns true when the host should defer SDK client construction to
 * drool-core's Bedrock branch instead of building its own
 * `Anthropic` / `OpenAI` SDK client. The Bedrock streaming path
 * constructs an `AnthropicBedrock` client inside `bedrock/anthropic.ts`
 * and caches it on the shared `llmClientsRef.bedrock` slot, so the
 * host's `llmClientsRef.anthropic` / `.openai` are not consulted for
 * those turns.
 */
export function isBedrockCustomModel(
  customModel: CustomModel | null | undefined
): boolean {
  return !!customModel?.bedrock;
}

/**
 * Returns true when the custom model is routed over the AWS Bedrock
 * **Converse** API (native Converse schema) rather than the
 * Anthropic-on-Bedrock path. Both share the same `bedrock` credential
 * block; the discriminator is the `bedrock-converse` provider.
 *
 * Note: {@link isBedrockCustomModel} still returns true for Converse
 * models — it gates SDK-client deferral and the synthetic usage URL,
 * which apply to every Bedrock-routed custom model regardless of dialect.
 */
export function isConverseBedrockCustomModel(
  customModel: CustomModel | null | undefined
): boolean {
  return (
    customModel?.provider === ModelProvider.BEDROCK_CONVERSE &&
    !!customModel?.bedrock
  );
}

/**
 * Returns true when an OpenAI custom model should use Bedrock Mantle instead of direct HTTP.
 */
export function isOpenAIBedrockCustomModel(
  customModel: CustomModel | null | undefined
): boolean {
  return (
    customModel?.provider === ModelProvider.OPENAI && !!customModel?.bedrock
  );
}

/**
 * Type guard: true when `customModel` is reachable over plain HTTP and
 * the regular Anthropic / OpenAI SDK client paths can be used directly.
 * Internal helper for {@link getRequiredHttpCustomModel}.
 */
function isHttpCustomModel(
  customModel: CustomModel | null | undefined
): customModel is HttpCustomModel {
  return (
    !!customModel &&
    typeof customModel.apiKey === 'string' &&
    typeof customModel.baseUrl === 'string'
  );
}

/**
 * Resolves the {@link HttpCustomModel} subset of `customModel` for code
 * paths that need direct HTTP transport. Returns `null` for Bedrock-routed
 * custom models (they should be sent through the dedicated Bedrock branch
 * instead). Throws when a non-Bedrock custom model is missing `apiKey` /
 * `baseUrl`, which would otherwise produce confusing downstream errors.
 */
export function getRequiredHttpCustomModel(
  customModel: CustomModel | null | undefined
): HttpCustomModel | null {
  if (!customModel) return null;
  if (isHttpCustomModel(customModel)) return customModel;
  if (customModel.bedrock) return null;
  throw new MetaError('Custom model is missing baseUrl or apiKey', {
    modelId: customModel.id,
  });
}

export function resolveBedrockCustomModelRegion(
  bedrock: CustomModelBedrockConfig,
  environment: Record<string, string | undefined> = {}
): string {
  return (
    bedrock.awsRegion ||
    environment.AWS_REGION ||
    environment.AWS_DEFAULT_REGION ||
    LLM_BEDROCK_DEFAULT_REGION
  );
}

/**
 * Builds the Bedrock Mantle OpenAI Responses base URL, honoring explicit endpoint overrides.
 */
export function buildBedrockOpenAIBaseUrl(
  bedrock: CustomModelBedrockConfig,
  environment: Record<string, string | undefined> = {}
): string {
  const region = resolveBedrockCustomModelRegion(bedrock, environment);
  return (
    bedrock.bedrockBaseUrl ||
    `https://bedrock-mantle.${region}.api.aws/openai/v1`
  );
}

type BuildBedrockCustomModelBaseUrlParams = {
  bedrock: CustomModelBedrockConfig;
  provider?: ModelProvider | undefined;
  environment?: Record<string, string | undefined> | undefined;
};

export function buildBedrockCustomModelBaseUrl({
  bedrock,
  provider,
  environment = {},
}: BuildBedrockCustomModelBaseUrlParams): string {
  if (provider === ModelProvider.OPENAI) {
    return buildBedrockOpenAIBaseUrl(bedrock, environment);
  }
  const region = resolveBedrockCustomModelRegion(bedrock, environment);
  return (
    bedrock.bedrockBaseUrl ||
    environment.BEDROCK_RUNTIME_BASE_URL ||
    environment.ANTHROPIC_BEDROCK_BASE_URL ||
    `https://bedrock-runtime.${region}.amazonaws.com`
  );
}

function parsePolicyUrl(value: string): URL | null {
  if (!URL.canParse(value)) return null;
  return new URL(value);
}

function stripTrailingSlash(pathname: string): string {
  if (pathname === '/') return pathname;
  return pathname.replace(/\/+$/, '');
}

export function isCustomModelBaseUrlAllowed(
  customBaseUrl: string,
  allowedBaseUrls: string[]
): boolean {
  const customUrl = parsePolicyUrl(customBaseUrl);
  if (!customUrl) return false;
  const customPath = stripTrailingSlash(customUrl.pathname);

  return allowedBaseUrls.some((allowedBaseUrl) => {
    const allowedUrl = parsePolicyUrl(allowedBaseUrl);
    if (!allowedUrl) return false;
    if (customUrl.origin !== allowedUrl.origin) return false;

    const allowedPath = stripTrailingSlash(allowedUrl.pathname);
    return (
      allowedPath === '/' ||
      customPath === allowedPath ||
      customPath.startsWith(`${allowedPath}/`)
    );
  });
}

/**
 * Returns the URL that policy code (organization `allowedBaseUrls`, usage
 * telemetry, debugging) should treat as the effective endpoint for a
 * custom model. Bedrock entries derive a synthetic provider-specific AWS URL
 * from their config so the same allowlist mechanism works for Bedrock and
 * HTTP BYOK endpoints alike.
 *
 * Returns `undefined` when no URL can be derived (e.g. legacy custom-model
 * rows missing `baseUrl`).
 */
export function getCustomModelPolicyBaseUrl(
  customModel:
    | (Pick<CustomModel, 'baseUrl' | 'bedrock'> &
        Partial<Pick<CustomModel, 'provider'>>)
    | null
    | undefined,
  environment: Record<string, string | undefined> = {}
): string | undefined {
  if (!customModel) return undefined;
  const bedrock = customModel.bedrock;
  if (bedrock) {
    return buildBedrockCustomModelBaseUrl({
      bedrock,
      provider: customModel.provider,
      environment,
    });
  }
  return customModel.baseUrl;
}

/**
 * URL-shaped identifier emitted on telemetry / cost-usage records so the
 * same accounting pipeline can distinguish each provider. HTTP BYOK rows
 * use their `baseUrl`; Bedrock rows use a `bedrock://<region>/<modelId>`
 * pseudo-URL keyed by region + Bedrock model id for downstream grouping.
 */
export function getCustomModelUsageBaseUrl(customModel: CustomModel): string {
  if (customModel.bedrock) {
    return `bedrock://${customModel.bedrock.awsRegion ?? LLM_BEDROCK_DEFAULT_REGION}/${customModel.model}`;
  }
  return customModel.baseUrl ?? '';
}
