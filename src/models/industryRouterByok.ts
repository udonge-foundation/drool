import { parseBuiltInModelID, isCustomModelID } from '@industry/utils/llm';
import { findRouterByokCustomModels } from '@industry/utils/models';

import { isModelAllowed } from '@/models/availability';
import { getSettingsService } from '@/services/SettingsService';

import type {
  BuiltInModelID,
  ConcreteModelID,
  CustomModelID,
} from '@industry/drool-sdk-ext/protocol/llm';

function getAllowedRouterByokModel(
  baseModelId: BuiltInModelID
): CustomModelID | undefined {
  const settings = getSettingsService();
  const policy = settings.getModelPolicy();
  if (policy.allowIndustryRouterByok !== true) return undefined;

  const candidates = findRouterByokCustomModels(
    baseModelId,
    settings.getCustomModels()
  );
  for (const candidate of candidates) {
    if (!isCustomModelID(candidate.id)) continue;
    if (!settings.validateModelAccess(candidate.id).allowed) continue;
    return candidate.id;
  }
  return undefined;
}

export function isIndustryRouterCandidateAllowed(modelId: string): boolean {
  const baseModelId = parseBuiltInModelID(modelId);
  if (!baseModelId) return false;
  return (
    getAllowedRouterByokModel(baseModelId) !== undefined ||
    isModelAllowed(baseModelId)
  );
}

export function resolveIndustryRouterGenerationModel(
  modelId: BuiltInModelID
): ConcreteModelID {
  return getAllowedRouterByokModel(modelId) ?? modelId;
}
