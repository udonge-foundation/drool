import { INDUSTRY_ROUTER_MODEL_ID } from '@industry/drool-sdk-ext/protocol/llm';
import { getSessionModelUpgradeTarget } from '@industry/utils/llm';

import type { EffectiveIndustryRouterModel } from '@industry/common/session/settings';

/** Returns undefined for unprimed Router sessions (no router decision yet). */
export function resolveConcreteTurnModelId(
  sessionModelId: string,
  effectiveIndustryRouterModel: EffectiveIndustryRouterModel | undefined
): string | undefined {
  if (sessionModelId !== INDUSTRY_ROUTER_MODEL_ID) return sessionModelId;
  return effectiveIndustryRouterModel?.modelId;
}

/**
 * Router-only: regular sessions explicitly picked their model and the
 * agent shouldn't override that choice. The presence of
 * `effectiveIndustryRouterModel` is the canonical signal that the session is
 * Router and has been primed by the router (it is only ever set for
 * Router sessions). Tool is available when the routed model has a
 * defined upgrade target.
 */
export function isSessionModelUpgradeAvailable(
  effectiveIndustryRouterModel: EffectiveIndustryRouterModel | undefined
): boolean {
  if (effectiveIndustryRouterModel === undefined) return false;
  return (
    getSessionModelUpgradeTarget(effectiveIndustryRouterModel.modelId) !==
    undefined
  );
}
