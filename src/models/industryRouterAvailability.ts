import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { DEFAULT_CANDIDATES } from '@industry/drool-core/model-router';
import { INDUSTRY_ROUTER_MODEL_ID } from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn } from '@industry/logging';
import { getFlag } from '@industry/runtime/feature-flags';
import { INDUSTRY_ROUTER_CLASSIFIER_MODEL_PREFERENCE } from '@industry/utils/llm';

import { getDefaultModelId, isModelAllowed } from '@/models/availability';
import { isIndustryRouterCandidateAllowed } from '@/models/industryRouterByok';

import type { CandidateModel } from '@industry/drool-core/model-router';

export function getAllowedIndustryRouterCandidates(): CandidateModel[] {
  return DEFAULT_CANDIDATES.filter((candidate) =>
    isIndustryRouterCandidateAllowed(candidate.modelId)
  );
}

export function pickClassifierModelId(): string | undefined {
  return INDUSTRY_ROUTER_CLASSIFIER_MODEL_PREFERENCE.find(isModelAllowed);
}

export function hasAnyAllowedIndustryRouterCandidate(): boolean {
  return DEFAULT_CANDIDATES.some((candidate) =>
    isIndustryRouterCandidateAllowed(candidate.modelId)
  );
}

/** Flag + at least one candidate allowed. Use for every Router entry point. */
export function isIndustryRouterSelectable(): boolean {
  if (!getFlag(IndustryFeatureFlags.IndustryRouter)) return false;
  return hasAnyAllowedIndustryRouterCandidate();
}

/**
 * Pass-through for non-Router ids; for `auto`, returns it unchanged
 * if Router is still selectable, otherwise returns the default model
 * id. Defensive net for any setter that may receive `auto` from a
 * programmatic caller (resume, daemon protocol, mission file write)
 * after the user lost Router access.
 */
export function resolveIfIndustryRouterOrFallback(
  model: string,
  options: { slotLabel: string; sessionId?: string }
): string {
  if (model !== INDUSTRY_ROUTER_MODEL_ID) return model;
  if (isIndustryRouterSelectable()) return model;
  const fallback = getDefaultModelId();
  logWarn('[Router] Router is not selectable; coercing setter to default', {
    sessionId: options.sessionId,
    slot: options.slotLabel,
    fallbackModelId: fallback,
  });
  return fallback;
}
