import { SessionSurface } from '@industry/common/cli';
import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { getFlag } from '@industry/runtime/feature-flags';

import { cliIndustryRouter } from '@/models/industryRouter';
import { isIndustryRouterCandidateAllowed } from '@/models/industryRouterByok';
import { getDroolRuntimeService } from '@/services/DroolRuntimeService';
import { isMissionWorkerSession } from '@/services/mission/sessionTags';
import { getSessionService } from '@/services/SessionService';

import type { EffectiveIndustryRouterModel } from '@industry/common/session/settings';
import type { ModelRoutingDeps } from '@industry/drool-core/llms/client/types';

// Branch order matters: exec dominates; sub-agent / mission worker
// must beat the daemon check so workers aren't lumped into the
// interactive bucket.
function detectSessionSurface(): SessionSurface {
  const runtime = getDroolRuntimeService();
  if (runtime.isNonInteractiveCLIMode()) return SessionSurface.Exec;
  const session = getSessionService();
  if (
    session.isSubAgentSession() ||
    isMissionWorkerSession(session.getCurrentSessionTags())
  ) {
    return SessionSurface.SubAgent;
  }
  if (runtime.isJsonRpcMode()) return SessionSurface.Daemon;
  return SessionSurface.InteractiveTui;
}

export function buildCliModelRoutingDeps(): ModelRoutingDeps {
  return {
    isEnabled: () => getFlag(IndustryFeatureFlags.IndustryRouter),
    getRouter: () => cliIndustryRouter,
    getSurface: detectSessionSurface,
    isSubAgentSession: () => getSessionService().isSubAgentSession(),
    getEffectiveIndustryRouterModel: () =>
      getSessionService().getEffectiveIndustryRouterModel(),
    setEffectiveIndustryRouterModel: (decision: EffectiveIndustryRouterModel) =>
      getSessionService().setEffectiveIndustryRouterModel(decision),
    clearEffectiveIndustryRouterModel: () =>
      getSessionService().clearEffectiveIndustryRouterModel(),
    isModelAllowed: (modelId: string) =>
      isIndustryRouterCandidateAllowed(modelId),
  };
}
