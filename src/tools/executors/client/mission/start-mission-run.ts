import fs from 'fs/promises';
import path from 'path';

import { TodoDisplayMode } from '@industry/common/cli';
import { ToolExecutionErrorType } from '@industry/common/session';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import {
  MissionPauseReason,
  ProgressLogEntryType,
  MissionState,
  SessionNotificationType,
  type MissionFeature,
  type ProgressLogEntry,
  type SessionNotificationParams,
  type ToolStreamingUpdate,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logInfo, logWarn, Metric, Metrics } from '@industry/logging';

import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { collectAndMarkNewWorkerHandoffs } from '@/services/mission/handoffs';
import { getMissionFileService } from '@/services/mission/MissionFileService';
import {
  pauseMissionRunner,
  startMissionRunner,
} from '@/services/mission/missionRunnerOperations';
import { validateMissionScopedFeatureSkills } from '@/services/mission/missionSkillValidation';
import {
  buildStartMissionRunProgressSnapshot,
  createStartMissionRunProgressUpdate,
  getWorkerSessionIdForFeature,
} from '@/services/mission/startMissionRunProgress';
import type {
  StartMissionRunProgressDetails,
  WorkerCompletedEntry,
} from '@/services/mission/types';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { MissionFailureCategory } from '@/telemetry/customer/enums';
import {
  getMissionFailureCategoryFromReasonCode,
  getMissionFailureReasonCode,
} from '@/telemetry/customer/missionMetrics';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

import type {
  StartMissionRunParams,
  StartMissionRunResult,
  WorkerHandoff,
} from '@industry/drool-core/tools/definitions';

function isMissionProgressNotification(
  notification: SessionNotificationParams['notification']
): boolean {
  return (
    notification.type === SessionNotificationType.MISSION_STATE_CHANGED ||
    notification.type === SessionNotificationType.MISSION_FEATURES_CHANGED ||
    notification.type === SessionNotificationType.MISSION_PROGRESS_ENTRY
  );
}

const HANDOFF_ACTION_ARTIFACT_FILES = ['features.json', 'mission.md'] as const;

async function hasRelevantMissionArtifactChangesSince(
  missionDir: string,
  timestamp: string
): Promise<boolean> {
  const sinceMs = new Date(timestamp).getTime();
  if (!Number.isFinite(sinceMs)) {
    return false;
  }

  for (const artifactFile of HANDOFF_ACTION_ARTIFACT_FILES) {
    try {
      const stat = await fs.stat(path.join(missionDir, artifactFile));
      if (stat.isFile() && stat.mtimeMs > sinceMs) {
        return true;
      }
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== 'ENOENT') {
        logWarn('[StartMissionRun] Failed to inspect mission artifact mtime', {
          cause: error,
          fileName: artifactFile,
        });
      }
    }
  }

  return false;
}

/**
 * Executor for the start_mission_run tool.
 *
 * Signals that mission initialization is complete and starts the runner.
 *
 * Preconditions:
 * - features.json must exist and be valid
 *
 * Effects:
 * - State transitions to "running"
 * - Appends entry to progress_log
 * - Runner will be started (handled by the orchestration layer)
 */
export class StartMissionRunExecutor
  implements
    ClientToolExecutor<
      CliClientSpecificToolDependencies,
      StartMissionRunResult,
      ToolStreamingUpdate
    >
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: StartMissionRunParams
  ): AsyncGenerator<
    DraftToolFeedback<StartMissionRunResult, ToolStreamingUpdate>
  > {
    // Unpin todo list so only mission progress is visible
    getSettingsService().setTodoDisplayMode(TodoDisplayMode.Inline);

    // Check if already aborted before starting - treat as pause, not error
    if (dependencies.abortSignal?.aborted) {
      const sessionId = dependencies.sessionId;
      if (sessionId) {
        const missionSessionId =
          getSessionService().getDecompMissionId() ?? sessionId;
        const missionFileService = getMissionFileService(missionSessionId);
        const state = await missionFileService.readState();
        const canPauseExistingMission =
          state?.state === MissionState.Initializing ||
          state?.state === MissionState.Running ||
          state?.state === MissionState.OrchestratorTurn ||
          state?.state === MissionState.Paused;

        if (canPauseExistingMission) {
          try {
            if (state.state !== MissionState.Paused) {
              await pauseMissionRunner(missionSessionId);
            }
          } catch (error) {
            logWarn('[StartMissionRun] Failed to pause pre-aborted mission', {
              cause: error,
              sessionId,
              missionSessionId,
              state: state.state,
            });
          }

          yield {
            type: DraftToolFeedbackType.Result,
            isError: false,
            value: {
              started: true,
              workerHandoffs: [], // Don't return handoffs. they will be injected in the next user message.
              systemMessage:
                '<system>\nMission was cancelled and paused. Call start_mission_run when ready to continue.\n</system>',
            },
          };
          return;
        }
      }

      // Fallback: mission doesn't exist or sessionId missing - treat as soft error
      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: {
          started: false,
          workerHandoffs: [],
          systemMessage:
            '<system>\nMission run was cancelled before starting.\n</system>',
        },
      };
      return;
    }

    const sessionId = dependencies.sessionId;
    if (!sessionId) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: 'No session ID available',
        llmError: 'Cannot start mission run without a session ID',
      };
      return;
    }

    const missionSessionId =
      getSessionService().getDecompMissionId() ?? sessionId;

    const missionFileService = getMissionFileService(missionSessionId);

    // Check if mission exists
    const exists = await missionFileService.missionExists();
    if (!exists) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: 'Mission not found',
        llmError:
          'Mission directory does not exist. Call propose_mission first and create mission artifacts.',
      };
      return;
    }

    // Validate missionDir/features.json exists
    const featuresFile = await missionFileService.readFeatures();
    const featuresFilePath = path.join(
      missionFileService.getMissionDir(),
      'features.json'
    );
    if (
      !featuresFile ||
      !featuresFile.features ||
      featuresFile.features.length === 0
    ) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: 'No features defined',
        llmError: `${featuresFilePath} must exist with at least one feature before starting the run.`,
      };
      return;
    }

    const skillValidation = await validateMissionScopedFeatureSkills({
      missionDir: missionFileService.getMissionDir(),
      features: featuresFile.features,
    });
    if (!skillValidation.ok) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: skillValidation.userError,
        llmError: skillValidation.llmError,
      };
      return;
    }

    // Emit features notification (LLM created the file directly, so we emit here)
    agentEventBus.emit(AgentEvent.ProjectNotification, {
      notification: {
        type: SessionNotificationType.MISSION_FEATURES_CHANGED,
        features: featuresFile.features,
      },
    });

    // Move any completed/cancelled features that are stranded above active
    // features down to the bottom of the list (preserving relative order).
    await missionFileService.moveStrandedDoneFeaturesToBottom();

    try {
      // Create or update mission state
      let state = await missionFileService.readState();
      if (!state) {
        // Read working directory from propose_mission, fall back to current cwd
        const workingDirectory =
          (await missionFileService.readWorkingDirectory()) ?? process.cwd();
        state = await missionFileService.createInitialState(workingDirectory);
      }

      // Surface the canonical mission id to telemetry so every event emitted
      // during this run carries the ambient `missionId` tag.
      if (state.missionId) {
        getSessionService().setActiveMissionStateId(
          missionSessionId,
          state.missionId
        );
      }

      // Check if orchestrator should have taken action on previous handoff.
      // Also enforce this when the mission was manually paused between workers
      // (Paused with no tracked worker), so pausing doesn't bypass handoff checks.
      const inProgressFeature = await missionFileService.getInProgressFeature();
      const currentWorkerSessionId =
        getWorkerSessionIdForFeature(inProgressFeature);
      const isPausedBetweenWorkers =
        state.state === MissionState.Paused && !currentWorkerSessionId;
      if (
        state.state === MissionState.OrchestratorTurn ||
        isPausedBetweenWorkers
      ) {
        const progressLog = await missionFileService.readProgressLog();
        const lastWorkerCompleted = [...progressLog]
          .reverse()
          .find(
            (entry): entry is WorkerCompletedEntry =>
              entry.type === ProgressLogEntryType.WorkerCompleted &&
              entry.handoff !== undefined
          );

        if (lastWorkerCompleted?.handoff) {
          const { handoff } = lastWorkerCompleted;
          const hasDiscoveredIssues =
            handoff.discoveredIssues && handoff.discoveredIssues.length > 0;
          const normalizedUnfinishedWork = handoff.whatWasLeftUndone
            ?.trim()
            .toLowerCase();
          const hasUnfinishedWork =
            Boolean(normalizedUnfinishedWork) &&
            normalizedUnfinishedWork !== 'none';

          if (hasDiscoveredIssues || hasUnfinishedWork) {
            const handoffTimestampMs = new Date(
              lastWorkerCompleted.timestamp
            ).getTime();
            const hasDismissedItems = progressLog.some(
              (entry) =>
                entry.type === ProgressLogEntryType.HandoffItemsDismissed &&
                new Date(entry.timestamp).getTime() > handoffTimestampMs
            );
            const hasUpdatedMissionArtifacts =
              !hasDismissedItems &&
              (await hasRelevantMissionArtifactChangesSince(
                missionFileService.getMissionDir(),
                lastWorkerCompleted.timestamp
              ));

            if (!hasDismissedItems && !hasUpdatedMissionArtifacts) {
              const actionableItems: string[] = [];
              if (hasDiscoveredIssues) {
                actionableItems.push(
                  `${handoff.discoveredIssues.length} discovered issue(s)`
                );
              }
              if (hasUnfinishedWork) {
                actionableItems.push('incomplete work');
              }

              yield {
                type: DraftToolFeedbackType.Result,
                isError: true,
                errorType: ToolExecutionErrorType.InvalidParameterLLMError,
                userError: `Cannot resume without addressing worker handoff items`,
                llmError: `Your action is needed before the mission run can resume.

The previous worker handoff includes items that still need to be addressed: ${actionableItems.join(', ')}.

If discoveredIssues and/or whatWasLeftUndone exist, either create new features or update existing feature descriptions if the issue belongs to a pending feature's scope.

Skip only if it is already tracked as an existing feature (cite the ID), or truly irrelevant and will never need to be fixed.

After taking the appropriate action, update features.json or mission.md, or call dismiss_handoff_items to record each handoff item as handled. For items tracked by a feature, cite the feature ID in the justification. Then call start_mission_run again to continue.`,
              };
              return;
            }
          }
        }
      }

      const inferredResumeWorkerSessionId =
        !parameters.resumeWorkerSessionId &&
        !parameters.restartFeature &&
        state.state === MissionState.Paused &&
        currentWorkerSessionId &&
        inProgressFeature
          ? currentWorkerSessionId
          : undefined;

      const effectiveResumeWorkerSessionId = parameters.restartFeature
        ? undefined
        : (parameters.resumeWorkerSessionId ?? inferredResumeWorkerSessionId);

      if (inferredResumeWorkerSessionId) {
        logInfo('[StartMissionRun] Auto-resuming paused worker session', {
          sessionId,
          missionSessionId,
          workerSessionId: inferredResumeWorkerSessionId,
        });
      }

      // Transition to running state
      const wasPaused = state.state === MissionState.Paused;

      if (wasPaused) {
        // If the mission was paused because a feature exhausted its retry
        // budget, grant that feature a fresh attempt budget so resuming
        // actually lets it run again (unless the user cancelled it).
        const resumeProgressLog = await missionFileService.readProgressLog();
        const latestPauseEntry = [...resumeProgressLog]
          .reverse()
          .find((e) => e.type === ProgressLogEntryType.MissionPaused);
        const latestPauseReason =
          latestPauseEntry?.type === ProgressLogEntryType.MissionPaused
            ? latestPauseEntry.pauseReason
            : undefined;

        if (
          latestPauseReason === MissionPauseReason.FeatureRetryLimitExceeded
        ) {
          try {
            const bumpedFeatureIds =
              await missionFileService.grantRetryBudgetForExhaustedFeatures();
            if (bumpedFeatureIds.length > 0) {
              logInfo(
                '[StartMissionRun] Granted fresh retry budget on resume',
                {
                  sessionId,
                  missionSessionId,
                  featureId: bumpedFeatureIds.join(', '),
                }
              );
            }
          } catch (error) {
            logWarn(
              '[StartMissionRun] Failed to grant retry budget on resume',
              { cause: error, sessionId, missionSessionId }
            );
          }
        }

        await missionFileService.appendProgressLog({
          timestamp: new Date().toISOString(),
          type: ProgressLogEntryType.MissionResumed,
          ...(effectiveResumeWorkerSessionId
            ? { resumeWorkerSessionId: effectiveResumeWorkerSessionId }
            : {}),
        });
      }

      await missionFileService.updateState({
        state: MissionState.Running,
      });

      // Log to progress log
      await missionFileService.appendProgressLog({
        timestamp: new Date().toISOString(),
        type: ProgressLogEntryType.MissionRunStarted,
        message: parameters.message,
      });

      Metrics.addToCounter(Metric.MISSION_RUN_STARTED_COUNT, 1, {
        missionTotalFeatures: featuresFile.features.length,
        modelId: getSettingsService().getModel(),
        reasoningEffort: getSettingsService().getReasoningEffort(),
      });

      logInfo('[StartMissionRun] Mission run started', {
        sessionId,
        missionSessionId,
        featureCount: featuresFile.features.length,
        ...(effectiveResumeWorkerSessionId
          ? { workerSessionId: effectiveResumeWorkerSessionId }
          : {}),
      });

      let wasAborted = Boolean(dependencies.abortSignal?.aborted);
      const sessionStateManager =
        getTuiDaemonAdapter().getSessionStateManager();
      const [snapshotState, snapshotFeaturesFile, snapshotProgressLog] =
        await Promise.all([
          missionFileService.readState(),
          missionFileService.readFeatures(),
          missionFileService.readProgressLog(),
        ]);
      const missionProgressCache: {
        state: MissionState;
        updatedAt?: string;
        features: MissionFeature[];
        progressLog: ProgressLogEntry[];
      } = {
        state: snapshotState?.state ?? MissionState.Running,
        ...(snapshotState?.updatedAt
          ? { updatedAt: snapshotState.updatedAt }
          : {}),
        features: snapshotFeaturesFile?.features ?? featuresFile.features,
        progressLog: snapshotProgressLog,
      };

      let pendingProgressUpdate: ToolStreamingUpdate | null = null;
      let lastQueuedSnapshotKey: string | null = null;
      let snapshotScheduled = false;
      let runnerCompleted = false;
      let runnerError: unknown;
      let resolveWaiting: (() => void) | null = null;
      const wake = () => {
        resolveWaiting?.();
        resolveWaiting = null;
      };
      const waitForProgress = () =>
        new Promise<void>((resolve) => {
          if (pendingProgressUpdate || runnerCompleted) {
            resolve();
            return;
          }
          resolveWaiting = resolve;
        });
      const getSnapshotKey = (snapshot: StartMissionRunProgressDetails) =>
        JSON.stringify({
          ...snapshot,
          activeTime: snapshot.activeTime ? true : undefined,
        });
      const queueProgressSnapshot = (
        snapshot: StartMissionRunProgressDetails
      ) => {
        const snapshotKey = getSnapshotKey(snapshot);
        if (snapshotKey === lastQueuedSnapshotKey) {
          return;
        }
        lastQueuedSnapshotKey = snapshotKey;
        pendingProgressUpdate = createStartMissionRunProgressUpdate(snapshot);
        wake();
      };
      const getMissionSettings = () =>
        sessionStateManager
          .getSessionManager(sessionId)
          ?.getStore()
          .getMissionSettings() ??
        sessionStateManager
          .getSessionManager(missionSessionId)
          ?.getStore()
          .getMissionSettings() ??
        getSessionService().getMissionSettings() ??
        getSettingsService().getMissionModelSettings();
      let queueSnapshot: () => void = () => undefined;
      const scheduleSnapshot = () => {
        if (snapshotScheduled) {
          return;
        }
        snapshotScheduled = true;
        queueMicrotask(() => {
          snapshotScheduled = false;
          queueSnapshot();
        });
      };
      queueSnapshot = () => {
        try {
          queueProgressSnapshot(
            buildStartMissionRunProgressSnapshot({
              state: missionProgressCache.state,
              updatedAt: missionProgressCache.updatedAt,
              features: missionProgressCache.features,
              progressLog: missionProgressCache.progressLog,
              missionSettings: getMissionSettings(),
            })
          );
        } catch (error) {
          logWarn('[StartMissionRun] Failed to queue progress snapshot', {
            cause: error,
            sessionId,
            missionSessionId,
          });
        }
      };
      const applyMissionNotificationToCache = (
        notification: SessionNotificationParams['notification']
      ) => {
        if (!isMissionProgressNotification(notification)) {
          return;
        }

        switch (notification.type) {
          case SessionNotificationType.MISSION_STATE_CHANGED:
            missionProgressCache.state = notification.state;
            if (notification.updatedAt !== undefined) {
              missionProgressCache.updatedAt = notification.updatedAt;
            }
            break;
          case SessionNotificationType.MISSION_FEATURES_CHANGED:
            missionProgressCache.features = notification.features;
            break;
          case SessionNotificationType.MISSION_PROGRESS_ENTRY:
            missionProgressCache.progressLog = notification.progressLog;
            break;
          default:
            break;
        }
        scheduleSnapshot();
      };
      const flushProgressUpdates = function* (): Generator<
        DraftToolFeedback<StartMissionRunResult, ToolStreamingUpdate>
      > {
        const update = pendingProgressUpdate;
        pendingProgressUpdate = null;
        if (update) {
          yield {
            type: DraftToolFeedbackType.Update,
            value: update,
          };
        }
      };
      const handleMissionNotification = ({
        notification,
      }: {
        notification: SessionNotificationParams['notification'];
      }) => {
        applyMissionNotificationToCache(notification);
      };
      const abortSignal = dependencies.abortSignal;
      const handleAbort = () => {
        wasAborted = true;
        runnerCompleted = true;
        // Tool cancellation can abort the executor without giving the runner a chance
        // to flush its pause state; force a best-effort pause so resume works.
        void pauseMissionRunner(missionSessionId).catch((error) => {
          logWarn('[StartMissionRun] Failed to pause mission runner on abort', {
            cause: error,
            sessionId,
            missionSessionId,
          });
        });

        // Do NOT keep waiting for a potentially hung runner. Exiting here prevents
        // the session from getting stuck in an "agent running" state where all
        // input is queued (and slash commands are dropped).
        wake();
      };
      agentEventBus.on(
        AgentEvent.ProjectNotification,
        handleMissionNotification
      );

      try {
        queueSnapshot();
        yield* flushProgressUpdates();

        const runnerPromise = startMissionRunner(
          missionSessionId,
          dependencies.abortSignal,
          effectiveResumeWorkerSessionId
        )
          .then(() => {
            runnerCompleted = true;
            wake();
          })
          .catch((error) => {
            runnerCompleted = true;
            runnerError = error;
            wake();
            if (wasAborted) {
              logWarn('[StartMissionRun] Mission runner rejected after abort', {
                cause: error,
                sessionId,
                missionSessionId,
              });
            }
          });

        abortSignal?.addEventListener('abort', handleAbort, { once: true });

        while (!runnerCompleted) {
          yield* flushProgressUpdates();

          if (runnerCompleted) {
            break;
          }

          await waitForProgress();
        }

        yield* flushProgressUpdates();

        if (!wasAborted) {
          await runnerPromise;
          if (runnerError) {
            throw runnerError;
          }
        }

        // Read final state to report what happened
        const [finalState, finalFeaturesFile, finalProgressLog] =
          await Promise.all([
            missionFileService.readState(),
            missionFileService.readFeatures(),
            missionFileService.readProgressLog(),
          ]);
        const finalFeatures = finalFeaturesFile?.features ?? [];
        const finalTotalFeatures = finalFeatures.length;
        const finalCompletedFeatures = finalFeatures.filter(
          (f) => f.status === 'completed'
        ).length;
        const finalStatus = finalState?.state || 'unknown';
        const finalProgressSnapshot =
          finalState && finalFeaturesFile
            ? buildStartMissionRunProgressSnapshot({
                state: finalState.state,
                updatedAt: finalState.updatedAt,
                features: finalFeatures,
                progressLog: finalProgressLog,
                missionSettings: getMissionSettings(),
              })
            : null;
        if (finalProgressSnapshot) {
          queueProgressSnapshot(finalProgressSnapshot);
          yield* flushProgressUpdates();
        }

        let resultMessage: string;
        let structuredPauseReason:
          | StartMissionRunResult['pauseReason']
          | undefined;
        if (finalStatus === MissionState.Completed) {
          resultMessage = `All features completed successfully. Mission is done.`;

          if (finalState?.missionId) {
            Metrics.addToCounter(Metric.MISSION_COMPLETED_COUNT, 1, {
              missionTotalFeatures: finalTotalFeatures,
              missionCompletedFeatures: finalCompletedFeatures,
            });

            const durationMs =
              Date.now() - new Date(finalState.createdAt).getTime();
            if (durationMs >= 0) {
              Metrics.recordHistogram(Metric.MISSION_DURATION_MS, durationMs, {
                missionTotalFeatures: finalTotalFeatures,
              });
            }

            Metrics.recordHistogram(
              Metric.MISSION_FEATURES_COMPLETED,
              finalCompletedFeatures,
              {
                missionTotalFeatures: finalTotalFeatures,
              }
            );
          }
        } else if (finalStatus === MissionState.OrchestratorTurn) {
          let hasNewHandoffs = false;
          let lastFailureReason: string | undefined;
          let lastFailureCategory = MissionFailureCategory.OTHER;
          let lastOutcomeWasFailure = false;
          let lastCompletedSuccessState:
            | 'success'
            | 'partial'
            | 'failure'
            | undefined;

          try {
            const progressLog = finalProgressLog;

            const lastWorkerFailedIndex = progressLog.findLastIndex(
              (e) => e.type === ProgressLogEntryType.WorkerFailed
            );
            const lastWorkerCompletedIndex = progressLog.findLastIndex(
              (e) => e.type === ProgressLogEntryType.WorkerCompleted
            );

            lastOutcomeWasFailure =
              lastWorkerFailedIndex > lastWorkerCompletedIndex;

            if (lastOutcomeWasFailure) {
              const lastFailed = progressLog[lastWorkerFailedIndex] as {
                reason?: string;
              };
              if (lastFailed.reason) {
                lastFailureReason = lastFailed.reason;
                lastFailureCategory = getMissionFailureCategoryFromReasonCode(
                  getMissionFailureReasonCode(lastFailed.reason)
                );
              }
            }

            if (lastWorkerCompletedIndex >= 0) {
              const lastCompleted = progressLog[
                lastWorkerCompletedIndex
              ] as WorkerCompletedEntry;
              lastCompletedSuccessState = lastCompleted.successState;
            }

            const completedWithHandoffCount = progressLog.reduce(
              (count, entry) => {
                if (entry.type !== ProgressLogEntryType.WorkerCompleted) {
                  return count;
                }
                // Older missions may not have handoff attached.
                if (!('handoff' in entry) || entry.handoff === undefined) {
                  return count;
                }
                return count + 1;
              },
              0
            );

            const lastReviewedCount = finalState?.lastReviewedHandoffCount ?? 0;
            hasNewHandoffs = completedWithHandoffCount > lastReviewedCount;
          } catch {
            // Best effort
          }

          if (
            lastFailureCategory ===
              MissionFailureCategory.DAEMON_CONNECTIVITY &&
            lastFailureReason
          ) {
            resultMessage = `The mission runner returned control because the most recent worker failed due to a daemon (industryd) connectivity issue.\n\nMost recent worker failure: ${lastFailureReason}\n\nNext steps: call start_mission_run again once to retry — it will attempt to reconnect or restart the daemon automatically. If the same industryd error occurs again on the retry, do NOT attempt further retries. Instead, tell the user: "The mission daemon failed to start and could not be automatically recovered. Please run /quit to exit Drool, restart it, then re-enter mission mode and resume the mission."`;
          } else if (lastOutcomeWasFailure && lastFailureReason) {
            resultMessage = `The mission runner returned control because the most recent worker failed.\n\nMost recent worker failure: ${lastFailureReason}\n\nNext steps: investigate what happened, then call start_mission_run again to start another worker.`;
          } else if (hasNewHandoffs) {
            resultMessage = `The mission runner has returned control to you because the most recent worker's handoff contains actionable items and/or returnToOrchestrator=true. If discoveredIssues and whatWasLeftUndone exist, either create new features or update existing feature descriptions if the issue belongs to a pending feature's scope. Skip only if already tracked as an existing feature, or truly irrelevant and will never need to be fixed. Once you have addressed the issues, call dismiss_handoff_items to record each handoff item as handled, then call start_mission_run again to continue.`;
            if (
              lastCompletedSuccessState === 'failure' ||
              lastCompletedSuccessState === 'partial'
            ) {
              resultMessage += `\n\nNote: the feature that just returned "${lastCompletedSuccessState}" has been reset to pending and remains at the top of the queue. It will be picked again by the next start_mission_run unless you reorder features.json or change scope.`;
            }
          } else {
            resultMessage =
              'The mission runner has returned control to you. Review the progress_log.jsonl file for details on the most recent run, then call start_mission_run again to continue when ready.';
          }

          if (lastOutcomeWasFailure) {
            const failureReason = lastFailureReason ?? 'Unknown failure reason';
            const failureReasonCode =
              getMissionFailureReasonCode(failureReason);
            const failureCategory =
              getMissionFailureCategoryFromReasonCode(failureReasonCode);

            Metrics.addToCounter(Metric.MISSION_RUN_FAILED_COUNT, 1, {
              missionState: finalStatus,
              missionFailureCategory: failureCategory,
              missionFailureReason: failureReasonCode,
              missionTotalFeatures: finalTotalFeatures,
            });
          }
        } else if (finalStatus === MissionState.Paused) {
          // If the most recent MissionPaused entry has a structured pauseReason
          // (e.g. unrecoverable_usage_402), surface that to the orchestrator so
          // it can wait for the user to top up credits / change their overage
          // preference before retrying. We don't block start_mission_run from
          // running again — the user may add credits and ask to retry.
          const latestPauseEntry = [...finalProgressLog]
            .reverse()
            .find((e) => e.type === ProgressLogEntryType.MissionPaused);
          const latestPauseReason =
            latestPauseEntry?.type === ProgressLogEntryType.MissionPaused
              ? latestPauseEntry.pauseReason
              : undefined;

          if (latestPauseReason === MissionPauseReason.UnrecoverableUsage402) {
            resultMessage = `Mission paused: usage limit reached. The worker hit a 402 from the LLM provider that could not be auto-recovered (this happens when the user's overage preference is not "droolCore" or no swap-eligible model was available). Tell the user to top up credits, run /limits to change their overage preference, or upgrade their plan; once they have done so they can call start_mission_run again to resume.`;
            structuredPauseReason = MissionPauseReason.UnrecoverableUsage402;
          } else if (
            latestPauseReason === MissionPauseReason.FeatureRetryLimitExceeded
          ) {
            resultMessage = `Mission paused: a feature exhausted its worker-attempt budget and kept failing, so the mission was aborted to avoid an endless retry loop. Review progress_log.jsonl for the most recent WorkerFailed reason to see what went wrong. If you call start_mission_run again to resume, the feature is granted a fresh attempt budget and will run again; if it should be skipped instead, cancel it in features.json before resuming.`;
            structuredPauseReason =
              MissionPauseReason.FeatureRetryLimitExceeded;
          } else {
            // Check if there's an interrupted worker that can be resumed
            const interruptedWorkerSessionId =
              await missionFileService.getInterruptedWorkerSessionId();
            if (interruptedWorkerSessionId) {
              resultMessage = `The user interrupted you while worker session "${interruptedWorkerSessionId}" was in progress. When you receive the next user message, if they are asking you to resume work on the same feature, call start_mission_run with resumeWorkerSessionId="${interruptedWorkerSessionId}" to continue from where the worker left off. If resumeWorkerSessionId is omitted and this paused worker is still tracked, start_mission_run will auto-resume it. To start fresh instead, clear/kill the paused worker first, then call start_mission_run without resumeWorkerSessionId.`;
            } else {
              resultMessage = `Mission was paused. Call start_mission_run when ready to continue.`;
            }
          }
        } else {
          resultMessage = `Runner stopped with state: ${finalStatus}. Check progress_log.jsonl for details.`;
        }

        // Get all worker handoffs since last review
        // Return handoffs when mission ends in any terminal or paused state:
        // - OrchestratorTurn: orchestrator needs to review and act on handoff items
        // - Paused: include handoffs to preserve context when resuming
        // - Completed: include handoffs so orchestrator can review final work
        // Always include workerHandoffs (even if empty) per expectedBehavior
        let workerHandoffs: WorkerHandoff[] | undefined;
        let latestWorkerHandoff: StartMissionRunResult['latestWorkerHandoff'];

        const shouldIncludeHandoffs =
          finalStatus === MissionState.OrchestratorTurn ||
          finalStatus === MissionState.Paused ||
          finalStatus === MissionState.Completed;

        if (shouldIncludeHandoffs) {
          // Initialize to empty array - will be populated if there are new completions
          workerHandoffs = [];
          const collectedHandoffs = await collectAndMarkNewWorkerHandoffs({
            missionFileService,
            includeLatestWorkerHandoff: true,
          });
          workerHandoffs = collectedHandoffs.workerHandoffs;
          latestWorkerHandoff = collectedHandoffs.latestWorkerHandoff;
        }

        yield {
          type: DraftToolFeedbackType.Result,
          isError: false,
          value: {
            started: true,
            workerHandoffs,
            latestWorkerHandoff,
            systemMessage: `<system>\n${resultMessage}\n</system>`,
            ...(finalProgressSnapshot
              ? { progressSnapshot: finalProgressSnapshot }
              : {}),
            ...(structuredPauseReason
              ? { pauseReason: structuredPauseReason }
              : {}),
          },
        };
      } finally {
        agentEventBus.off(
          AgentEvent.ProjectNotification,
          handleMissionNotification
        );
        abortSignal?.removeEventListener('abort', handleAbort);
      }
    } catch (error) {
      logWarn('[StartMissionRun] Failed to start mission run', {
        cause: error,
      });

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: `Failed to start mission run: ${error instanceof Error ? error.message : String(error)}`,
        llmError: `Failed to start mission run: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
