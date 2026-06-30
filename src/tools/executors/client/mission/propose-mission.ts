import { ToolExecutionErrorType } from '@industry/common/session';
import { proposeMissionSchema } from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import {
  ProgressLogEntryType,
  ToolConfirmationOutcome,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logInfo, Metric, Metrics } from '@industry/logging';
import { ToolAbortError } from '@industry/logging/errors';

import { getMissionFileService } from '@/services/mission/MissionFileService';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

import type { MissionModelSettings } from '@industry/common/settings';
import type {
  ProposeMissionParams,
  ProposeMissionResult,
} from '@industry/drool-core/tools/definitions';

/**
 * Build a self-contained snapshot of the effective mission model settings to
 * persist at launch time.
 *
 * Missions must be insulated from later changes to org-wide / global mission
 * model defaults: starting a mission with one set of models and having a
 * separate `/settings` change rewrite mid-flight breaks reproducibility and
 * can swap a worker model out from under a running mission. We therefore
 * snapshot ALL fields here (not just deltas vs globals) so subsequent reads
 * via `readEffectiveModelSettings()` are stable for the lifetime of the
 * mission.
 */
function buildMissionSettingsSnapshot(params: {
  currentSettings: MissionModelSettings | undefined;
  globalSettings: Required<MissionModelSettings>;
}): Required<MissionModelSettings> {
  const { currentSettings, globalSettings } = params;

  return {
    workerModel: currentSettings?.workerModel ?? globalSettings.workerModel,
    workerReasoningEffort:
      currentSettings?.workerReasoningEffort ??
      globalSettings.workerReasoningEffort,
    validationWorkerModel:
      currentSettings?.validationWorkerModel ??
      globalSettings.validationWorkerModel,
    validationWorkerReasoningEffort:
      currentSettings?.validationWorkerReasoningEffort ??
      globalSettings.validationWorkerReasoningEffort,
    skipScrutiny: currentSettings?.skipScrutiny ?? globalSettings.skipScrutiny,
    skipUserTesting:
      currentSettings?.skipUserTesting ?? globalSettings.skipUserTesting,
  };
}

/**
 * Executor for the propose_mission tool.
 *
 * Presents a mission proposal to the user for review. The proposal includes
 * the plan overview, environment setup, and feature list.
 *
 * On acceptance:
 * - Creates the mission directory structure
 * - Initializes mission state
 * - Returns missionDir so orchestrator can create artifacts
 */
export class ProposeMissionExecutor
  implements
    ClientToolExecutor<CliClientSpecificToolDependencies, ProposeMissionResult>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: ProposeMissionParams
  ): AsyncGenerator<DraftToolFeedback<ProposeMissionResult>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const parsed = proposeMissionSchema.safeParse(parameters);
    if (!parsed.success) {
      const fieldErrors = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: 'Invalid mission proposal parameters',
        llmError: `ProposeMission requires "title" (string) and "proposal" (string). Invalid parameters: ${fieldErrors}. Re-call ProposeMission with both fields present.`,
      };
      return;
    }

    const { title, proposal, workingDirectory } = parsed.data;

    logInfo('[ProposeMission] Presenting proposal to user', {
      hasInput: Boolean(title),
      length: title.length,
      proposalLength: proposal.length,
    });

    const sessionService = getSessionService();
    const settingsService = getSettingsService();

    Metrics.addToCounter(Metric.MISSION_PROPOSED_COUNT, 1, {
      modelId: settingsService.getModel(),
      reasoningEffort: sessionService.getReasoningEffort(),
    });

    // Check if user approved via confirmation modal
    // In exec mode without confirmation, confirmationOutcome is undefined - treat as approved for prototype
    const approved =
      dependencies.confirmationOutcome === undefined ||
      dependencies.confirmationOutcome ===
        ToolConfirmationOutcome.ProceedOnce ||
      dependencies.confirmationOutcome ===
        ToolConfirmationOutcome.ProceedAlways;

    if (!approved) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: {
          accepted: false,
        },
      };
      return;
    }

    // User accepted - initialize mission directory
    const sessionId = dependencies.sessionId;
    if (!sessionId) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: 'No session ID available',
        llmError: 'Cannot create mission without a session ID',
      };
      return;
    }

    try {
      const missionSessionId = sessionService.getDecompMissionId() ?? sessionId;
      const missionFileService = getMissionFileService(missionSessionId);
      await missionFileService.initializeMissionDir();

      const missionDir = missionFileService.getMissionDir();

      // Save the working directory for this mission (workers will spawn here)
      const missionWorkingDirectory = workingDirectory ?? process.cwd();
      await missionFileService.writeWorkingDirectory(missionWorkingDirectory);

      if (await missionFileService.readState()) {
        await missionFileService.updateState({
          workingDirectory: missionWorkingDirectory,
        });
      }

      // Save the proposal to missionDir as mission.md for workers to reference
      await missionFileService.writeMissionMd(title, proposal);

      const missionSettings = sessionService.getMissionSettings();
      const missionSettingsSnapshot = buildMissionSettingsSnapshot({
        currentSettings: missionSettings,
        globalSettings: settingsService.getMissionModelSettings(),
      });
      // Always persist the full snapshot at launch so later changes to global
      // mission model defaults do not propagate into this running mission.
      await missionFileService.writeModelSettings(missionSettingsSnapshot);

      logInfo('[ProposeMission] Mission accepted, directory created', {
        sessionId,
        missionSessionId,
      });

      // Log to progress log
      await missionFileService.appendProgressLog({
        timestamp: new Date().toISOString(),
        type: ProgressLogEntryType.MissionAccepted,
        title,
      });

      Metrics.addToCounter(Metric.MISSION_ACCEPTED_COUNT, 1, {
        modelId: settingsService.getModel(),
        reasoningEffort: sessionService.getReasoningEffort(),
      });

      // Build the result message based on mode
      const userComment = dependencies.missionProposalComment;
      let llmGuidance: string | undefined;

      if (userComment) {
        llmGuidance = `Mission was approved but the user has left a required comment to address. User comment: ${userComment}`;
      }

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: {
          accepted: true,
          missionDir,
          llmGuidance,
        },
      };
    } catch (error) {
      logInfo('[ProposeMission] Failed to initialize mission directory', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: `Failed to create mission: ${error instanceof Error ? error.message : String(error)}`,
        llmError: `Failed to initialize mission directory: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
