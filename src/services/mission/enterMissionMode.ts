import { DecompSessionType } from '@industry/drool-sdk-ext/protocol/drool';
import { DroolInteractionMode } from '@industry/drool-sdk-ext/protocol/shared';
import { Metric, Metrics } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getAuthedUser } from '@industry/runtime/auth';
import {
  MISSION_ORCHESTRATOR_MIN_REASONING_EFFORTS,
  MISSION_ORCHESTRATOR_RECOMMENDED_MODELS,
} from '@industry/utils/llm';

import { getRuntimeAuthConfig } from '@/environment';
import { getMissionOveragePreferenceBlockMessage } from '@/services/mission/overagePreferenceGate';
import { EnterMissionResult } from '@/services/mission/types';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { fetchOveragePreferenceStatus } from '@/services/TokenLimitService';

/**
 * Enter Mission mode for the current session.
 * Upgrades the session to orchestrator type, sets the interaction mode to Mission,
 * and configures the model/effort for mission orchestration.
 *
 * Policy is checked here for fast UX feedback when creating a new mission.
 * AgentLoop.runAgentInternal() is the universal backstop that also covers
 * resumed sessions and exec paths.
 *
 * Returns the resolved settings so callers can propagate them to the daemon
 * explicitly rather than reading back from SessionService.
 */
/**
 * Throws when the current user/org is not allowed to start a mission, either
 * because mission access is restricted by the org admin or an overage
 * preference blocks new missions. Callers run this before any user-facing
 * mission entry UI (e.g. the readiness gate) so a restricted user sees the
 * restriction error rather than the gate.
 */
export async function assertMissionEntryAllowed(): Promise<void> {
  const policy = getSettingsService().getSettings().general?.missionPolicy;
  if (policy?.restrictedAccess) {
    const user = await getAuthedUser(getRuntimeAuthConfig());
    const allowedUserIds = policy.allowedUserIds ?? [];
    if (!user?.userId || !allowedUserIds.includes(user.userId)) {
      throw new MetaError(
        'Missions have been restricted by your organization admin. Contact your admin to request access.'
      );
    }
  }

  const overageStatus = await fetchOveragePreferenceStatus();
  const overageBlockMessage =
    getMissionOveragePreferenceBlockMessage(overageStatus);
  if (overageBlockMessage) {
    throw new MetaError(overageBlockMessage);
  }
}

export async function enterMissionMode(): Promise<EnterMissionResult> {
  const sessionService = getSessionService();
  const currentSessionType = sessionService.getDecompSessionType();

  if (currentSessionType === DecompSessionType.Orchestrator) {
    if (sessionService.getInteractionMode() !== DroolInteractionMode.Mission) {
      sessionService.setInteractionMode(DroolInteractionMode.Mission);
    }
    return {
      wasNew: false,
      modelId: sessionService.getModel(),
      reasoningEffort: sessionService.getReasoningEffort(),
      tags: sessionService.getCurrentSessionTags(),
    };
  }

  await sessionService.upgradeToOrchestratorSession();
  sessionService.setInteractionMode(DroolInteractionMode.Mission);

  const currentModel = sessionService.getModel();
  const currentEffort = sessionService.getReasoningEffort();
  const defaultOrchestratorModel =
    getSettingsService().getMissionOrchestratorModel();
  const defaultOrchestratorEffort =
    getSettingsService().getMissionOrchestratorReasoningEffort();

  if (MISSION_ORCHESTRATOR_RECOMMENDED_MODELS.includes(currentModel)) {
    if (!MISSION_ORCHESTRATOR_MIN_REASONING_EFFORTS.includes(currentEffort)) {
      sessionService.setReasoningEffort(defaultOrchestratorEffort);
    }
  } else {
    sessionService.setModel(
      defaultOrchestratorModel,
      defaultOrchestratorEffort
    );
    sessionService.setReasoningEffort(defaultOrchestratorEffort);
  }

  const resolvedModel = sessionService.getModel();
  const resolvedEffort = sessionService.getReasoningEffort();
  const resolvedTags = sessionService.getCurrentSessionTags();

  Metrics.addToCounter(Metric.MISSION_ENTERED_COUNT, 1, {
    modelId: resolvedModel,
    reasoningEffort: resolvedEffort,
  });

  return {
    wasNew: true,
    modelId: resolvedModel,
    reasoningEffort: resolvedEffort,
    tags: resolvedTags,
  };
}
