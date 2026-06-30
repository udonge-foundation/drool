import {
  MODEL_POLICY_VIOLATION_ERROR,
  type ModelPolicy,
} from '@industry/common/policy';
import { ModelID } from '@industry/drool-sdk-ext/protocol/llm';
import {
  getCustomModelPolicyBaseUrl,
  isCustomModelBaseUrlAllowed,
} from '@industry/utils/models';
import { isModelAllowedByPolicy } from '@industry/utils/models/policy';

import {
  CUSTOM_MODEL_BASE_URL_BLOCKED_MESSAGE,
  CUSTOM_MODELS_BLOCKED_MESSAGE,
} from '@/utils/constants';
import { ModelValidationResult } from '@/utils/types';

import type { CustomModel } from '@industry/common/settings';

/**
 * Validate if a model can be used based on organization model policy.
 * This is the single source of truth for CLI model validation.
 *
 * @param modelId - The model ID to validate (may include 'custom:' prefix)
 * @param modelPolicy - The model policy to validate against
 * @returns Validation result with allowed status and reason if blocked
 */
export function validateModelAccess(
  modelId: string,
  modelPolicy: ModelPolicy,
  customModel?: Pick<CustomModel, 'baseUrl' | 'bedrock'> | null,
  environment: Record<string, string | undefined> = {}
): ModelValidationResult {
  const isCustomModel = modelId.startsWith('custom:');

  // Check custom models
  if (isCustomModel) {
    const customModelsAllowed = modelPolicy.allowCustomModels ?? true;

    if (!customModelsAllowed) {
      return {
        allowed: false,
        reason: CUSTOM_MODELS_BLOCKED_MESSAGE,
        isCustomModel: true,
      };
    }

    const allowedBaseUrls = modelPolicy.allowedBaseUrls;
    if (allowedBaseUrls && allowedBaseUrls.length > 0) {
      const customBaseUrl = getCustomModelPolicyBaseUrl(
        customModel as CustomModel | null | undefined,
        environment
      );
      const isAllowed =
        typeof customBaseUrl === 'string' &&
        isCustomModelBaseUrlAllowed(customBaseUrl, allowedBaseUrls);

      if (!isAllowed) {
        return {
          allowed: false,
          reason: CUSTOM_MODEL_BASE_URL_BLOCKED_MESSAGE,
          isCustomModel: true,
        };
      }
    }

    return { allowed: true, isCustomModel: true };
  }

  // Check built-in models using centralized policy logic
  const allowed = isModelAllowedByPolicy(modelId as ModelID, modelPolicy);

  if (!allowed) {
    return {
      allowed: false,
      reason: MODEL_POLICY_VIOLATION_ERROR,
      isCustomModel: false,
    };
  }

  return { allowed: true, isCustomModel: false };
}
