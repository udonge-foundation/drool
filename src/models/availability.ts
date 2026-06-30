import { useMemo } from 'react';

import { ModelID } from '@industry/drool-sdk-ext/protocol/llm';
import { getCachedRegion, getRegion } from '@industry/runtime/auth';
import { getFlag, getFlagValues } from '@industry/runtime/feature-flags';
import {
  getModelConfig,
  getModelFeatureFlags,
  resolveDefaultIndustryModel,
} from '@industry/utils/llm';
import {
  getAvailableModelsForResponse as getAvailableModelsForResponseShared,
  filterModelsByFlags,
  filterModelsByRegion,
} from '@industry/utils/models';

import { getRuntimeAuthConfig } from '@/environment';
import { getSettingsService } from '@/services/SettingsService';

import type { AvailableModelConfig } from '@industry/drool-sdk-ext/protocol/drool';
import type { BuiltInModelID } from '@industry/drool-sdk-ext/protocol/llm';

/*
 * All model-availability queries in this module read synchronously through
 * `@industry/runtime/feature-flags` (remote -> disk -> defaultValue). The
 * package owns the remote-fetch lifecycle: a small set of designated entry
 * points (`apps/cli/src/index.ts` startup, `renderlessExecRunner`,
 * `sharedAgentRunner`) call `fetchFeatureFlags()` once during their init.
 * Code outside those entry points must NEVER trigger a remote refresh.
 */

function getModelFlagValues(): Record<string, boolean> {
  return getFlagValues(getModelFeatureFlags());
}

function getAvailableModels(): ModelID[] {
  // Airgap mode: hide every non-BYOK model. Built-in models all route
  // through Industry's LLM proxy, which is blocked under airgap; selectors
  // should only show custom (BYOK) models.
  if (getRuntimeAuthConfig().airgapEnabled) return [];
  const flagEnabled = filterModelsByFlags(getModelFlagValues());
  return filterModelsByRegion(flagEnabled, getCachedRegion());
}

export function getAvailableModelIds(): ReadonlySet<string> {
  return new Set(getAvailableModels());
}

export function getDefaultModelId(): BuiltInModelID {
  return resolveDefaultIndustryModel(getAvailableModelIds());
}

/** Get available models for CLI exec context (non-React). */
export async function getAvailableModelsForExec(): Promise<ModelID[]> {
  return getAvailableModels();
}

export function useAvailableModels(): ModelID[] {
  return useMemo(getAvailableModels, [getModelFlagValues()]);
}

/**
 * Format available models for the session init/load response.
 * Combines built-in models (feature-flag filtered) with custom BYOK models.
 */
export async function getAvailableModelsForResponse(): Promise<
  AvailableModelConfig[]
> {
  const models = await getAvailableModelsForResponseShared(
    () => Promise.resolve(getModelFlagValues()),
    getSettingsService().getCustomModels(),
    await getRegion(getRuntimeAuthConfig())
  );
  // Airgap: ACP/session surfaces must only advertise BYOK custom models;
  // built-ins route through Industry's LLM proxy, which is blocked.
  if (getRuntimeAuthConfig().airgapEnabled) {
    return models.filter((m) => m.isCustom);
  }
  return models;
}

/**
 * Check whether a model is allowed by its feature flag.
 * Returns true for models without a feature flag.
 */
export function isModelFeatureFlagEnabled(modelId: string): boolean {
  try {
    const flag = getModelConfig(modelId).featureFlag;
    if (!flag) return true;
    return getFlag(flag);
  } catch {
    return false;
  }
}

/**
 * Region + feature-flag + org-policy. Canonical "is this model
 * usable right now?" predicate; the region precondition matters
 * for Router (Fireworks-only candidates can't run in EU).
 */
export function isModelAllowed(modelId: string): boolean {
  if (!getAvailableModelIds().has(modelId)) return false;
  return getSettingsService().validateModelAccess(modelId).allowed;
}

export function getAllowedModelIds(): ReadonlySet<string> {
  const settings = getSettingsService();
  return new Set(
    filterModelsByRegion(
      filterModelsByFlags(getModelFlagValues()),
      getCachedRegion()
    ).filter((modelId) => settings.validateModelAccess(modelId).allowed)
  );
}
