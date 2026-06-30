import { ToolExecutionErrorType } from '@industry/common/session';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import {
  FeatureStatus,
  FeatureSuccessState,
  FeatureSuccessStateSchema,
  HandoffSchema,
  ProgressLogEntryType,
  MissionState,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logError, logInfo, logWarn } from '@industry/logging';
import { ToolAbortError } from '@industry/logging/errors';

import { getMissionFileService } from '@/services/mission/MissionFileService';
import { generateTranscriptSkeleton } from '@/services/mission/transcriptSkeleton';
import { getSessionService } from '@/services/SessionService';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

import type {
  EndFeatureRunParams,
  EndFeatureRunResult,
} from '@industry/drool-core/tools/definitions';

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return undefined;
}

function countSentences(text: string): number {
  const normalized = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+\s*$/, '');
  if (!normalized) return 0;
  return normalized.split(/[.!?]+\s+/).filter(Boolean).length;
}

/**
 * Executor for the end_feature_run tool (worker).
 *
 * Reports the results of a feature implementation.
 * Must be called before the worker session exits.
 *
 * Effects:
 * - Records result in progress_log.jsonl
 * - Updates feature status in features.json
 * - Determines next action (continue, orchestrator_turn, completed)
 */
export class EndFeatureRunExecutor
  implements
    ClientToolExecutor<CliClientSpecificToolDependencies, EndFeatureRunResult>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: EndFeatureRunParams
  ): AsyncGenerator<DraftToolFeedback<EndFeatureRunResult>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const {
      successState,
      returnToOrchestrator: requestedReturnToOrchestrator,
      featureId: explicitFeatureId,
      commitId: rawCommitId,
      repoPath: rawRepoPath,
      validatorsPassed,
      handoff,
    } = parameters;
    const commitId = rawCommitId?.trim() || undefined;
    const repoPath = rawRepoPath?.trim() || undefined;

    const normalizedValidatorsPassed =
      normalizeOptionalBoolean(validatorsPassed);
    const normalizedRequestedReturnToOrchestrator =
      normalizeOptionalBoolean(requestedReturnToOrchestrator) ?? false;

    // Automatically return to orchestrator if there are discovered issues or
    // unfinished work. This ensures the orchestrator is always informed of
    // problems, even if the worker didn't explicitly request to return.
    const hasDiscoveredIssues = (handoff?.discoveredIssues?.length ?? 0) > 0;
    const unfinishedWork = handoff?.whatWasLeftUndone?.trim();
    const hasUnfinishedWork =
      unfinishedWork !== undefined &&
      unfinishedWork !== '' &&
      unfinishedWork.toLowerCase() !== 'none';
    const returnToOrchestrator =
      normalizedRequestedReturnToOrchestrator ||
      hasDiscoveredIssues ||
      hasUnfinishedWork;

    const sessionId = dependencies.sessionId;
    if (!sessionId) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: 'No session ID available',
        llmError: 'Cannot end feature run without a session ID',
      };
      return;
    }

    // Get the mission ID from the session metadata (this is the orchestrator session ID)
    const sessionService = getSessionService();
    const orchestratorSessionId = sessionService.getDecompMissionId();
    if (!orchestratorSessionId) {
      logWarn(
        '[AGI:Worker] EndFeatureRun called but session not linked to mission',
        {
          workerSessionId: sessionId,
        }
      );
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: 'This session is not linked to a mission run',
        llmError:
          'Worker session not linked to a mission run: decompMissionId not found in session metadata',
      };
      return;
    }
    const missionFileService = getMissionFileService(orchestratorSessionId);

    logInfo('[AGI:Worker] Ending feature run', {
      sessionId: orchestratorSessionId,
      workerSessionId: sessionId,
      featureId: explicitFeatureId,
      successState,
      returnToOrchestrator: normalizedRequestedReturnToOrchestrator,
    });

    // Check if mission exists
    const exists = await missionFileService.missionExists();
    if (!exists) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: {
          recorded: false,
          nextAction: 'orchestrator',
          message:
            'Mission not found. This session may not be part of a mission.',
        },
      };
      return;
    }

    const inProgressFeature = await missionFileService.getInProgressFeature();
    let featureId = explicitFeatureId || inProgressFeature?.id;

    // Auto-resolve featureId: if none available, check if there's exactly one
    // in-progress feature and use that (a worker ending its run should only
    // match features that are already InProgress).
    if (!featureId) {
      const featuresFile = await missionFileService.readFeatures();
      const candidates =
        featuresFile?.features.filter(
          (f) => f.status === FeatureStatus.InProgress
        ) ?? [];
      if (candidates.length === 1) {
        featureId = candidates[0].id;
        logWarn(
          '[AGI:Worker] Auto-resolved featureId from the in-progress feature',
          { featureId }
        );
      }
    }

    if (!featureId) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: 'No feature ID provided and no in-progress feature found',
        llmError:
          'Either provide featureId explicitly or ensure there is exactly one in-progress feature in features.json so the CLI can auto-resolve it.',
      };
      return;
    }

    const state = await missionFileService.readState();
    const resolvedRepoPath = commitId
      ? (repoPath ?? state?.workingDirectory)
      : undefined;

    if (commitId && !resolvedRepoPath) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: 'repoPath is required when commitId is provided',
        llmError:
          'Provide repoPath with commitId so validators can inspect the correct repository.',
      };
      return;
    }

    // Validate success requirements
    if (successState === 'success') {
      if (normalizedValidatorsPassed !== true) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          userError: 'validatorsPassed must be true for success',
          llmError:
            'When successState is "success", validatorsPassed must be true. Ensure all validators/tests pass before reporting success.',
        };
        return;
      }
    }

    try {
      // Parse LLM input using zod schemas
      const parsedSuccessState = FeatureSuccessStateSchema.parse(successState);
      const parsedHandoff = HandoffSchema.parse(handoff);

      const summary = parsedHandoff.salientSummary?.trim();
      if (!summary) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          userError: 'handoff.salientSummary is required',
          llmError:
            'handoff.salientSummary is required and must be a short (1–4 sentence) summary of what happened in your session.',
        };
        return;
      }

      if (summary.length < 20 || summary.length > 750) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          userError: 'handoff.salientSummary must be 20-500 characters',
          llmError: `handoff.salientSummary must be 20-500 characters; got ${summary.length}.`,
        };
        return;
      }
      if (summary.includes('\n')) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          userError: 'handoff.salientSummary must be 1–4 sentences',
          llmError:
            'handoff.salientSummary must be 1–4 sentences (no newlines).',
        };
        return;
      }
      const sentenceCount = countSentences(summary);
      if (sentenceCount < 1 || sentenceCount > 6) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          userError: 'handoff.salientSummary must be 1–4 sentences',
          llmError: `handoff.salientSummary must be 1–4 sentences; got ${sentenceCount}.`,
        };
        return;
      }

      // Update feature status (only after validating all inputs)
      const newStatus =
        successState === 'success'
          ? FeatureStatus.Completed
          : FeatureStatus.Pending;
      await missionFileService.updateFeature(featureId, {
        status: newStatus,
      });

      // Move completed features to the bottom of features.json
      if (successState === 'success') {
        await missionFileService.moveFeatureToBottom(featureId);
      }

      // Write the full handoff to a per-worker JSON file
      const feature = await missionFileService.getFeature(featureId);
      const completionTimestamp = new Date().toISOString();
      await missionFileService.ensureWorkerHandoffJson({
        timestamp: completionTimestamp,
        workerSessionId: sessionId,
        featureId,
        milestone: feature?.milestone,
        commitId,
        repoPath: resolvedRepoPath,
        successState: parsedSuccessState,
        returnToOrchestrator,
        handoff: parsedHandoff,
      });

      // Generate and store transcript skeleton for scrutiny
      try {
        const messageEvents =
          await sessionService.getAllMessageEvents(sessionId);
        const skeleton = generateTranscriptSkeleton(messageEvents);
        await missionFileService.appendTranscriptSkeleton({
          workerSessionId: sessionId,
          featureId,
          milestone: feature?.milestone,
          skeleton,
        });
      } catch (error) {
        // Non-fatal: log but don't fail the feature run
        logError('[EndFeatureRun] Failed to generate transcript skeleton', {
          featureId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }

      // Determine next action
      let nextAction: 'continue' | 'orchestrator' | 'completed';

      if (
        returnToOrchestrator ||
        parsedSuccessState === FeatureSuccessState.Failure ||
        parsedSuccessState === FeatureSuccessState.Partial
      ) {
        nextAction = 'orchestrator';
        await missionFileService.updateState({
          state: MissionState.OrchestratorTurn,
        });
      } else {
        // NOTE: Do not mark the mission as Completed from within a worker.
        // The MissionRunner may inject validation features (e.g. work-scrutiny)
        // after this tool returns, and is the single authority for completion.
        nextAction = 'continue';
      }

      // Append WorkerCompleted to progress log last. The emitted mission
      // notification is the worker-done signal, so writing it after all other
      // file updates (feature status, handoff, transcript, state) avoids a
      // race where the orchestrator acts before the rest of the data is on
      // disk.
      await missionFileService.appendProgressLog({
        timestamp: completionTimestamp,
        type: ProgressLogEntryType.WorkerCompleted,
        workerSessionId: sessionId,
        featureId,
        successState: parsedSuccessState,
        returnToOrchestrator,
        commitId,
        repoPath: resolvedRepoPath,
        exitCode: 0, // Worker completed normally
        validatorsPassed: normalizedValidatorsPassed,
        handoff: parsedHandoff,
      });

      logInfo('[AGI:Worker] Feature run ended', {
        sessionId: orchestratorSessionId,
        workerSessionId: sessionId,
        featureId,
        successState,
        nextAction,
        returnToOrchestrator,
        commitSha: commitId,
        repoPath: resolvedRepoPath,
        // eslint-disable-next-line industry/no-nested-log-metadata -- feature-run validation outcome flags consumed as a unit
        value: {
          validatorsPassed: normalizedValidatorsPassed,
          hasDiscoveredIssues,
          hasUnfinishedWork,
        },
      });

      const baseMessage =
        nextAction === 'orchestrator'
          ? 'Returning control to orchestrator.'
          : 'Another worker will continue with next feature.';

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: {
          recorded: true,
          nextAction,
          message: `${baseMessage} IMPORTANT: Your session is now complete. Do not make any further tool calls or continue working. End your turn immediately.`,
        },
      };
    } catch (error) {
      logWarn('[AGI:Worker] Failed to end feature run', {
        sessionId: orchestratorSessionId,
        workerSessionId: sessionId,
        featureId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: `Failed to end feature run: ${error instanceof Error ? error.message : String(error)}`,
        llmError: `Failed to end feature run: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
