import { BillingPool, ModelID } from '@industry/drool-sdk-ext/protocol/llm';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo, logWarn } from '@industry/logging';
import { getModel } from '@industry/utils/llm';

import { getTuiModelConfig } from '@/models/config';
import { getMissionFileService } from '@/services/mission/MissionFileService';
import {
  isMissionOrchestratorSession,
  isMissionWorkerSession,
} from '@/services/mission/sessionTags';
import { getSessionService } from '@/services/SessionService';

/**
 * Handle an HTTP 402 from the LLM proxy by attempting a transparent
 * fallback to the recommended Drool Core model on every eligible slot
 * (main, spec-mode, mission worker, mission validator).
 *
 * A slot is eligible when the model id is non-custom, non-Core, and
 * different from the recommended core model. At least one slot must
 * be eligible AND the user must have opted into the `droolCore`
 * overage preference for the fallback to fire; otherwise the caller
 * re-throws the 402 to the normal error handler.
 *
 * The fallback is one-shot per `runAgent` invocation
 * (`hasAttemptedDroolCoreFallback`) so a follow-up 402 from the core
 * model itself cannot loop.
 *
 * Side effects on success:
 * - `sessionService.setModel(coreModel)` for the main model when
 *   eligible. This emits `AgentEvent.SettingsUpdated` with the new
 *   `modelId`, which the stream-jsonrpc adapter forwards as a
 *   `settings_updated` notification.
 * - `sessionService.setSpecModeModel(coreModel, defaultEffort)` for
 *   the spec-mode model when eligible. Same notification path.
 * - `missionFileService.writeModelSettings(...)` for the mission
 *   worker/validator models when the active session is a mission
 *   orchestrator OR mission worker. Reasoning efforts are reset to
 *   the core model's defaults. Subsequent worker spawns read this
 *   file at spawn time so future workers automatically use the new
 *   core model.
 * - One persisted user-only system message that names every slot
 *   that was swapped, so the UI can surface the auto-switch.
 */
export async function attemptDroolCoreFallback402(args: {
  sessionId: string;
  sessionService: ReturnType<typeof getSessionService>;
  overagePreferenceSnapshot: 'droolCore' | 'extraUsage' | null;
  recommendedCoreModelSnapshot: string | null;
  hasAttemptedDroolCoreFallback: boolean;
  persistSystem: (text: string, visibility?: MessageVisibility) => void;
}): Promise<{ didSwap: boolean }> {
  const {
    sessionId,
    sessionService,
    overagePreferenceSnapshot,
    recommendedCoreModelSnapshot,
    hasAttemptedDroolCoreFallback,
    persistSystem,
  } = args;

  if (
    hasAttemptedDroolCoreFallback ||
    overagePreferenceSnapshot !== 'droolCore' ||
    !recommendedCoreModelSnapshot
  ) {
    return { didSwap: false };
  }

  const coreModelId = recommendedCoreModelSnapshot;
  const coreEffort = getTuiModelConfig(coreModelId).defaultReasoningEffort;

  // A slot is swap-eligible when its model is non-custom, non-Core,
  // and different from the recommended core model.
  const isEligibleSlotModel = (modelId: string | undefined): boolean => {
    if (!modelId) return false;
    if (modelId === coreModelId) return false;
    if (modelId.startsWith('custom:')) return false;
    try {
      const cfg = getModel(modelId as ModelID);
      return cfg.billingPool !== BillingPool.Core;
    } catch {
      // Unknown / not a registered built-in. Treat as not Core: it's
      // already filtered above on `custom:` so unknown built-ins are
      // safe to swap.
      return true;
    }
  };

  const swappedSlots: string[] = [];

  // ── Main model ──
  const previousMainModelId = sessionService.getModel();
  if (isEligibleSlotModel(previousMainModelId)) {
    sessionService.setModel(coreModelId);
    swappedSlots.push('main model');
    logInfo('[Agent] 402: swapped main session model to Drool Core', {
      previousModelId: previousMainModelId,
      modelId: coreModelId,
    });
  }

  // ── Spec-mode model ──
  if (sessionService.hasSpecModeModel()) {
    const previousSpecModelId = sessionService.getSpecModeModel();
    if (isEligibleSlotModel(previousSpecModelId)) {
      sessionService.setSpecModeModel(coreModelId, coreEffort);
      swappedSlots.push('spec-mode model');
      logInfo('[Agent] 402: swapped spec-mode model to Drool Core', {
        previousModelId: previousSpecModelId,
        modelId: coreModelId,
      });
    }
  }

  // ── Mission worker / validator models ──
  const tags = sessionService.getCurrentSessionTags?.();
  const isMissionOrchestrator = isMissionOrchestratorSession(tags);
  const isMissionWorker = isMissionWorkerSession(tags);
  if (isMissionOrchestrator || isMissionWorker) {
    const missionId = sessionService.getDecompMissionId() ?? sessionId;
    try {
      const missionFileService = getMissionFileService(missionId);
      const existing = await missionFileService.readEffectiveModelSettings();
      const desiredWorker = isEligibleSlotModel(existing.workerModel)
        ? coreModelId
        : existing.workerModel;
      const desiredValidator = isEligibleSlotModel(
        existing.validationWorkerModel
      )
        ? coreModelId
        : existing.validationWorkerModel;

      const workerNeedsWrite =
        existing.workerModel !== desiredWorker ||
        (desiredWorker === coreModelId &&
          existing.workerReasoningEffort !== coreEffort);
      const validatorNeedsWrite =
        existing.validationWorkerModel !== desiredValidator ||
        (desiredValidator === coreModelId &&
          existing.validationWorkerReasoningEffort !== coreEffort);

      if (workerNeedsWrite || validatorNeedsWrite) {
        await missionFileService.writeModelSettings({
          ...(workerNeedsWrite && {
            workerModel: desiredWorker,
            workerReasoningEffort: coreEffort,
          }),
          ...(validatorNeedsWrite && {
            validationWorkerModel: desiredValidator,
            validationWorkerReasoningEffort: coreEffort,
          }),
        });
        if (workerNeedsWrite) {
          swappedSlots.push('mission worker model');
        }
        if (validatorNeedsWrite) {
          swappedSlots.push('mission validator model');
        }
        logInfo('[Agent] 402: persisted mission core models to disk', {
          modelId: coreModelId,
        });
      }
    } catch (error) {
      logWarn('[Agent] 402: failed to persist mission core models', {
        cause: error,
      });
    }
  }

  if (swappedSlots.length === 0) {
    return { didSwap: false };
  }

  persistSystem(
    `Your standard model budget is exhausted. You have been switched to ${coreModelId} (Drool Core) to continue this session as per your overage preference. To set your preferences, run the \`/limits\` slash command.`,
    MessageVisibility.UserOnly
  );

  return { didSwap: true };
}
