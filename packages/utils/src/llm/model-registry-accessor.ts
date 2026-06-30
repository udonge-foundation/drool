import type { LLMModelConfig } from './types';
import type { ModelID } from '@industry/drool-sdk-ext/protocol/llm';

let getModelRegistryEntryImpl: (
  modelId: ModelID | string
) => LLMModelConfig | undefined = () => undefined;

let findClosestModelIdImpl: (modelId: string) => ModelID | undefined = () =>
  undefined;

export function configureModelRegistryAccessors(accessors: {
  getModelRegistryEntry: (
    modelId: ModelID | string
  ) => LLMModelConfig | undefined;
  findClosestModelId: (modelId: string) => ModelID | undefined;
}): void {
  getModelRegistryEntryImpl = accessors.getModelRegistryEntry;
  findClosestModelIdImpl = accessors.findClosestModelId;
}

export function getModelRegistryEntry(
  modelId: ModelID | string
): LLMModelConfig | undefined {
  return getModelRegistryEntryImpl(modelId);
}

export function findClosestModelIdFromRegistry(
  modelId: string
): ModelID | undefined {
  return findClosestModelIdImpl(modelId);
}
