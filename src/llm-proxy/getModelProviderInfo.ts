import {
  ApiProvider,
  LLMModelTier,
  ModelID,
} from '@industry/drool-sdk-ext/protocol/llm';
import { getLLMConfig } from '@industry/utils/llm';

import type { ModelProviderInfo } from '@/llm-proxy/types';
import { getTuiModelConfig } from '@/models/config';

/**
 * Gets model provider info for a given model, with fallback construction for custom models.
 */
export function getModelProviderInfo(selectedModel: string): ModelProviderInfo {
  const tuiModelConfig = getTuiModelConfig(selectedModel);
  const modelId = tuiModelConfig.modelId || (selectedModel as ModelID);

  try {
    const modelConfig = getLLMConfig({ modelId });
    return {
      id: modelConfig.id,
      name: modelConfig.name,
      shortName: modelConfig.shortName,
      modelProvider: modelConfig.provider,
      apiProviders: modelConfig.apiProviders,
      tier: modelConfig.tier,
      supportedReasoningEfforts: modelConfig.reasoningEffort.supported,
    };
  } catch {
    // Custom model fallback
    return {
      id: modelId,
      name: selectedModel,
      shortName: selectedModel,
      modelProvider: tuiModelConfig.modelProvider,
      apiProviders: [ApiProvider.ANTHROPIC], // Safe fallback for custom models
      tier: LLMModelTier.Standard,
      supportedReasoningEfforts: tuiModelConfig.supportedReasoningEfforts,
    };
  }
}
