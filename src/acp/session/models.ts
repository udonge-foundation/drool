/**
 * Shared helpers for building the ACP model list used by both
 * session lifecycle responses (`models` field) and the
 * `configOptions[id === "model"]` advertisement.
 *
 * Extracted into a standalone module so both ACPAdapter and
 * AcpProtocolAdapter can import without a circular dependency.
 */
import {
  getModelConfig,
  getTokenMultiplier,
  isAvailableInCLI,
} from '@industry/utils/llm';

import {
  getAvailableModelsForResponse,
  getDefaultModelId,
} from '@/models/availability';
import { getSettingsService } from '@/services/SettingsService';

import type { SessionModelState } from '@agentclientprotocol/sdk';

/**
 * Fetch available models from the server, mapping to the ACP wire shape used
 * by `SessionModelState.availableModels`. The same list backs the
 * `configOptions[id === "model"].options` entries.
 */
export async function buildModelState(): Promise<
  SessionModelState['availableModels']
> {
  const available = await getAvailableModelsForResponse();
  const settings = getSettingsService();

  return available
    .filter((model) => settings.validateModelAccess(model.id).allowed)
    .map((model) => {
      const tuiConfig =
        !model.isCustom && isAvailableInCLI(model.id)
          ? getModelConfig(model.id)
          : null;
      const multiplier = tuiConfig?.modelId
        ? getTokenMultiplier(tuiConfig.modelId)
        : undefined;
      const description =
        multiplier !== undefined ? `${multiplier}x Industry token rate` : null;

      return {
        modelId: model.id,
        name: model.displayName,
        description,
      };
    });
}

/**
 * Combine pre-fetched available models with the session's current model ID,
 * falling back to the first available model if the current one is not in the
 * list.
 */
export function applyCurrentModel(
  availableModels: SessionModelState['availableModels'],
  currentModelId: string
): SessionModelState {
  const settings = getSettingsService();
  const fallbackModel =
    currentModelId && availableModels.some((m) => m.modelId === currentModelId)
      ? currentModelId
      : (availableModels[0]?.modelId ??
        (currentModelId && settings.validateModelAccess(currentModelId).allowed
          ? currentModelId
          : (settings.getFirstAllowedModel() ?? getDefaultModelId())));

  return { availableModels, currentModelId: fallbackModel };
}
