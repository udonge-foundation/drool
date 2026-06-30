import { TuiModelConfig } from '@industry/common/cli';
import {
  INDUSTRY_ROUTER_MODEL_ID,
  ModelProvider,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';
import { logWarnOnce } from '@industry/logging';
import {
  getModelConfig,
  isAvailableInCLI,
  resolveModelId,
} from '@industry/utils/llm';
import {
  findCustomModel,
  getCustomModelReasoningMetadata,
  parseCustomModelId,
} from '@industry/utils/models';

import { getI18n } from '@/i18n';
import { getDefaultModelId } from '@/models/availability';
import { getSettingsService } from '@/services/SettingsService';

const REASONING_EFFORT_DISPLAY_NAME_KEYS: Record<ReasoningEffort, string> = {
  [ReasoningEffort.None]: 'common:reasoningEffort.dynamic',
  [ReasoningEffort.Dynamic]: 'common:reasoningEffort.dynamic',
  [ReasoningEffort.Off]: 'common:reasoningEffort.off',
  [ReasoningEffort.Minimal]: 'common:reasoningEffort.minimal',
  [ReasoningEffort.Low]: 'common:reasoningEffort.low',
  [ReasoningEffort.Medium]: 'common:reasoningEffort.medium',
  [ReasoningEffort.High]: 'common:reasoningEffort.high',
  [ReasoningEffort.ExtraHigh]: 'common:reasoningEffort.extraHigh',
  [ReasoningEffort.Max]: 'common:reasoningEffort.max',
};

/**
 * Get the configuration for a TUI model.
 * @param model The model option to get configuration for
 * @returns The model configuration object
 */
export function getTuiModelConfig(model: string): TuiModelConfig {
  if (isAvailableInCLI(model)) {
    const config = getModelConfig(model);
    if (model === INDUSTRY_ROUTER_MODEL_ID) {
      // Strip cost fields: routers bill at the routed pick's rate.
      const {
        modelId: _modelId,
        tokenMultiplier: _tokenMultiplier,
        promoLabel: _promoLabel,
        ...rest
      } = config;
      return rest;
    }
    return config;
  }
  // Alias canonicalization: a deprecated alias (e.g. `gemini-3-pro-preview`)
  // resolves via MODEL_ALIASES to a canonical id that IS in CLI_MODEL_ORDER
  // (e.g. `gemini-3.1-pro-preview`). Returning the canonical config keeps
  // routing aligned with the request body for users on a model line whose
  // canonical id is still available -- without this, routing call sites
  // would fall through to the isUnknownFallback branch and bump them off
  // the model line entirely (Pattern A of FAC-16834).
  const canonical = resolveModelId(model);
  if (canonical && canonical !== model && isAvailableInCLI(canonical)) {
    return getModelConfig(canonical);
  }
  // Custom model fallback
  const customModels = getSettingsService().getCustomModels();
  const custom = findCustomModel(model, customModels);
  if (custom) {
    const displayName = custom.displayName || custom.model;
    const reasoningMetadata = getCustomModelReasoningMetadata(
      custom.reasoningEffort,
      custom.model
    );

    return {
      id: custom.model,
      modelProvider: custom.provider,
      displayName,
      shortDisplayName: displayName,
      ...reasoningMetadata,
      isCustom: true,
      noImageSupport: custom.noImageSupport,
    };
  }

  // If model starts with custom: but wasn't found, return a safe default
  // This can happen during rendering before the custom models are fully loaded
  if (model.startsWith('custom:')) {
    const parsed = parseCustomModelId(model);
    const displayName = parsed?.displayName || model.slice('custom:'.length);

    return {
      id: displayName,
      modelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API, // Safe default
      displayName,
      shortDisplayName: displayName,
      supportedReasoningEfforts: [ReasoningEffort.None],
      defaultReasoningEffort: ReasoningEffort.None,
      isCustom: true,
      noImageSupport: true, // Safe default for unknown custom models
    };
  }

  // Unknown model - log warning and return default model config tagged
  // with `isUnknownFallback: true` so request-routing call sites can
  // refuse to send a request keyed on the original unknown id (FAC-19594).
  // Renderer call sites can ignore the flag -- display data is still safe.
  const defaultModelId = getDefaultModelId();
  logWarnOnce(
    `unknown-model:${model}`,
    '[getTuiModelConfig] Unknown model, falling back to default',
    {
      modelId: model,
      fallbackModelId: defaultModelId,
    }
  );

  return { ...getModelConfig(defaultModelId), isUnknownFallback: true };
}

/**
 * Get the default reasoning effort for a model.
 * @param model The model option to get the default reasoning effort for
 * @returns The default reasoning effort, or High if not specified
 */
export function getModelDefaultReasoningEffort(model: string): ReasoningEffort {
  return getTuiModelConfig(model).defaultReasoningEffort;
}

/**
 * Get the display name for a reasoning effort level.
 * @param effort The reasoning effort to get the display name for
 * @returns The human-readable display name
 */
export function getReasoningEffortDisplayName(effort: ReasoningEffort): string {
  const key = REASONING_EFFORT_DISPLAY_NAME_KEYS[effort];
  return key ? getI18n().t(key) : effort;
}

/**
 * Check if a model supports image attachments.
 * @param model The model option to check
 * @returns True if the model supports images, false otherwise
 *
 * Note: This function reads from the model config's noImageSupport property,
 * which is set by getTuiModelConfig() based on the model's provider and configuration.
 */
export function modelSupportsImages(model: string): boolean {
  const config = getTuiModelConfig(model);
  // If noImageSupport is explicitly set, use its inverse
  // Otherwise default to true for built-in models, false for custom models
  return config.noImageSupport !== undefined
    ? !config.noImageSupport
    : !config.isCustom;
}

/**
 * Check if a model supports native PDF document input.
 * Reads from the `supportsPDFs` field in the model config (set via `pdf` in the model registry).
 * Defaults to false for custom/unknown models.
 */
export function modelSupportsPDFs(model: string): boolean {
  const config = getTuiModelConfig(model);
  return config.supportsPDFs === true;
}
