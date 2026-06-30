import { v4 as uuidv4 } from 'uuid';

import {
  DaemonSpecificNotificationType,
  type DaemonSessionNotification,
} from '@industry/common/daemon';
import { SESSION_TAG_MISSION_WORKER } from '@industry/common/session';
import {
  DroolErrorType,
  FeatureStatus,
  MissionPauseReason,
  ProgressLogEntryType,
  MissionState,
  SessionNotificationType,
  WorkerFailureReason,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  AutonomyLevel,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { EnvironmentVariable } from '@industry/environment';
import {
  logException,
  logInfo,
  logWarn,
  Metric,
  Metrics,
} from '@industry/logging';

import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { HandoffOutcome } from '@/services/mission/enums';
import {
  deriveCompletionOutcome,
  emitHandoffOutcome,
} from '@/services/mission/handoffOutcome';
import {
  getMissionFileService,
  MissionFileService,
} from '@/services/mission/MissionFileService';
import { getWorkerBootstrapPrompt } from '@/services/mission/prompts';
import { requeueFeatureIfInProgress } from '@/services/mission/requeueFeatureIfInProgress';
import {
  getEffectiveMaxFeatureAttempts,
  getFeatureAttemptCount,
} from '@/services/mission/retryBudget';
import type {
  Feature,
  ProgressLogEntry,
  WorkerCompletedEntry,
  WorkerResult,
} from '@/services/mission/types';
import { getSettingsService } from '@/services/SettingsService';
import {
  SKILL_NAME_SCRUTINY_VALIDATOR,
  SKILL_NAME_USER_TESTING_VALIDATOR,
  VALIDATION_SKILL_NAMES,
} from '@/skills/builtin/constants';
import { getMissionRoleFromSkillName } from '@/telemetry/customer/missionMetrics';

const MISSION_HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_MISSION_WORKER_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

function getMissionWorkerInactivityTimeoutMs(): number {
  const raw =
    process.env[EnvironmentVariable.MISSION_WORKER_INACTIVITY_TIMEOUT_MS];
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_MISSION_WORKER_INACTIVITY_TIMEOUT_MS;
}

const MISSION_WORKER_INACTIVITY_TIMEOUT_MS =
  getMissionWorkerInactivityTimeoutMs();

/**
 * MissionRunner - Deterministic loop that spawns worker sessions
 *
 * This is NOT an LLM component. It's deterministic code that:
 * 1. Spawns a worker session via `drool exec`
 * 2. Waits for completion
 * 3. Reads the updated state from files
 * 4. Decides whether to continue, return to orchestrator, or complete
 */
class MissionRunner {
  private baseSessionId: string;

  private missionFileService: MissionFileService;

  private isRunning = false;

  private abortSignal: AbortSignal | null = null;

  private wakeWorkerCompletionWaiter: (() => void) | null = null;

  constructor(baseSessionId: string) {
    this.baseSessionId = baseSessionId;
    this.missionFileService = getMissionFileService(baseSessionId);
  }

  isActive(): boolean {
    return this.isRunning;
  }

  private async refreshMissionRuntimeCustomModels(): Promise<string> {
    const settingsService = getSettingsService() as {
      getCustomModels?: () => unknown;
    };
    const maybeCustomModels = settingsService.getCustomModels?.();
    const customModels = Array.isArray(maybeCustomModels)
      ? maybeCustomModels
      : [];

    return await this.missionFileService.writeRuntimeCustomModels(
      customModels as Parameters<
        MissionFileService['writeRuntimeCustomModels']
      >[0]
    );
  }

  /**
   * Start the runner loop
   * @param abortSignal Abort signal for cancellation. When aborted, the runner calls pause() for graceful shutdown.
   * @param resumeWorkerSessionId Optional session ID of a paused worker to resume instead of spawning a new one.
   */
  async start(
    abortSignal: AbortSignal,
    resumeWorkerSessionId?: string
  ): Promise<void> {
    if (this.isRunning) {
      logInfo('[MissionRunner] Already running, ignoring start request');
      return;
    }

    // Check if already aborted before starting
    if (abortSignal?.aborted) {
      logInfo('[MissionRunner] Abort signal already aborted, not starting');
      return;
    }

    this.isRunning = true;
    this.abortSignal = abortSignal ?? null;

    logInfo('[MissionRunner] Starting for session', {
      baseSessionId: this.baseSessionId,
      ...(resumeWorkerSessionId ? { resumeWorkerSessionId } : {}),
    });

    // Only clean up orphaned workers if we're NOT resuming
    // If resuming, the "orphaned" worker is the one we want to continue
    if (!resumeWorkerSessionId) {
      await this.cleanupOrphanedWorker();
    }

    // Set up pause on SIGINT (Ctrl+C)
    const pauseHandler = async () => {
      logInfo('[MissionRunner] Received interrupt signal, pausing...');
      await this.pause();
    };
    process.on('SIGINT', pauseHandler);

    try {
      await this.runLoop(resumeWorkerSessionId);
    } finally {
      process.off('SIGINT', pauseHandler);
      this.isRunning = false;
      this.abortSignal = null;
    }
  }

  /**
   * Clean up orphaned worker process if one exists from a previous crash
   */
  private async cleanupOrphanedWorker(): Promise<void> {
    const inProgressFeature =
      await this.missionFileService.getInProgressFeature();
    const featureId = inProgressFeature?.id ?? null;
    const currentWorkerSessionId =
      inProgressFeature?.workerSessionIds?.at(-1) ?? null;

    if (!currentWorkerSessionId) {
      return;
    }

    const workerSessionId = currentWorkerSessionId;

    logInfo('[MissionRunner] Found orphaned worker, attempting cleanup', {
      workerSessionId,
    });

    void Promise.resolve(
      getTuiDaemonAdapter().closeSession(workerSessionId)
    ).catch(() => {
      logWarn('[MissionRunner] Failed to close orphaned Session', {
        sessionId: workerSessionId,
      });
    });

    try {
      await this.missionFileService.appendProgressLog({
        timestamp: new Date().toISOString(),
        type: ProgressLogEntryType.WorkerFailed,
        workerSessionId,
        spawnId: `orphan_${workerSessionId}`,
        exitCode: undefined,
        reason: 'orphan_cleanup',
      });
    } catch {
      // Best effort
    }

    // Variant B (collapsed) handoff outcome: orphan cleanup is a crash
    // branch (worker terminated without ever producing a WorkerCompleted
    // entry). VAL-M3A-005.
    emitHandoffOutcome(HandoffOutcome.Crash);

    try {
      await requeueFeatureIfInProgress({
        missionFileService: this.missionFileService,
        featureId,
        workerSessionId,
      });
    } catch {
      // Best effort
    }
  }

  /**
   * Pause the mission (graceful stop of orchestrator and worker)
   *
   * - Stops the orchestrator loop
   * - Interrupts the worker session
   * - Feature stays InProgress
   * - Current worker session remains discoverable from features.json
   * - WorkerPaused entry is logged
   */
  async pause(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logInfo('[MissionRunner] Pausing mission');

    // Mark as not running so the loop exits
    this.isRunning = false;
    this.wakeWorkerCompletionWaiter?.();

    const inProgressFeature =
      await this.missionFileService.getInProgressFeature();
    const featureId = inProgressFeature?.id ?? null;
    const workerSessionId = inProgressFeature?.workerSessionIds?.at(-1) ?? null;

    if (workerSessionId) {
      void Promise.resolve(
        getTuiDaemonAdapter().interruptSession(workerSessionId)
      ).catch((error) => {
        logException(
          error,
          '[MissionRunner] Failed to interrupt worker session during pause',
          {
            workerSessionId,
          }
        );
      });

      try {
        await this.missionFileService.appendProgressLog({
          timestamp: new Date().toISOString(),
          type: ProgressLogEntryType.WorkerPaused,
          workerSessionId,
          featureId: featureId ?? undefined,
        });
      } catch (error) {
        logException(error, '[MissionRunner] Failed to log WorkerPaused', {
          workerSessionId,
          featureId: featureId ?? undefined,
        });
      }
    }

    // DO NOT requeue the feature - keep it InProgress
    // Worker/feature tracking now lives in features.json, not state.json

    // Log the pause before changing state so consumers can close the active
    // interval from the progress log when they observe the paused state.
    await this.missionFileService.appendProgressLog({
      timestamp: new Date().toISOString(),
      type: ProgressLogEntryType.MissionPaused,
    });

    // Set state to paused but preserve worker/feature tracking for resume
    await this.missionFileService.updateState({
      state: MissionState.Paused,
      // Feature stays InProgress in features.json for resume
    });
  }

  /**
   * Main runner loop
   * @param resumeWorkerSessionId Optional session ID of a paused worker to resume on first iteration
   */
  private async runLoop(resumeWorkerSessionId?: string): Promise<void> {
    let pendingResumeSessionId = resumeWorkerSessionId;
    while (this.isRunning) {
      // Check if abort signal was triggered - if so, pause gracefully
      if (this.abortSignal?.aborted) {
        logInfo('[MissionRunner] Abort signal detected, pausing');
        await this.pause();
        break;
      }
      // Read current state
      const state = await this.missionFileService.readState();
      if (!state) {
        logInfo('[MissionRunner] No state file found, stopping');
        break;
      }

      // Check state transitions
      if (state.state === MissionState.Completed) {
        // Defensive: treat Completed as terminal ONLY if there are truly no
        // pending features. This prevents the runner from stopping if another
        // process (or an older worker tool implementation) marked the mission
        // completed before validation features were injected.
        const pendingFeature =
          await this.missionFileService.getNextPendingFeature();
        if (pendingFeature) {
          logWarn(
            '[MissionRunner] State is Completed but pending features exist; resuming',
            { featureId: pendingFeature.id }
          );
          await this.missionFileService.updateState({
            state: MissionState.Running,
          });
          continue;
        }

        const allComplete =
          await this.missionFileService.areAllFeaturesCompleted();
        if (!allComplete) {
          logWarn(
            '[MissionRunner] State is Completed but mission is not fully complete; resuming'
          );
          await this.missionFileService.updateState({
            state: MissionState.Running,
          });
          continue;
        }

        logInfo('[MissionRunner] Mission completed');
        break;
      }

      if (state.state === MissionState.Paused) {
        logInfo('[MissionRunner] Mission paused, stopping runner');
        break;
      }

      if (state.state === MissionState.OrchestratorTurn) {
        logInfo('[MissionRunner] Orchestrator turn, stopping runner');
        break;
      }

      if (state.state !== MissionState.Running) {
        logInfo('[MissionRunner] Unexpected state, stopping', {
          state: state.state,
        });
        break;
      }

      // Check if we should resume a paused worker (only when explicitly requested)
      const inProgressFeature =
        await this.missionFileService.getInProgressFeature();
      const derivedFeatureId = inProgressFeature?.id ?? null;
      const derivedWorkerSessionId =
        inProgressFeature?.workerSessionIds?.at(-1) ?? null;

      if (pendingResumeSessionId && derivedFeatureId) {
        // Preemption check: if a pending feature was inserted above the
        // in-progress feature, abandon the paused worker and run the
        // higher-priority feature instead.
        const featuresFile = await this.missionFileService.readFeatures();
        if (featuresFile) {
          const features = featuresFile.features;
          const inProgressIdx = features.findIndex(
            (f) => f.id === derivedFeatureId
          );
          const firstPendingIdx = features.findIndex(
            (f) => f.status === FeatureStatus.Pending
          );

          if (
            firstPendingIdx !== -1 &&
            inProgressIdx !== -1 &&
            firstPendingIdx < inProgressIdx
          ) {
            logInfo(
              '[MissionRunner] Preempting paused worker: pending feature exists above in-progress feature',
              {
                featureId: derivedFeatureId,
                newId: features[firstPendingIdx]!.id,
              }
            );

            await requeueFeatureIfInProgress({
              missionFileService: this.missionFileService,
              featureId: derivedFeatureId,
              workerSessionId: derivedWorkerSessionId,
            });

            pendingResumeSessionId = undefined;
            continue;
          }
        }

        const workerToResume = pendingResumeSessionId;
        // Clear so we don't try again on next iteration
        pendingResumeSessionId = undefined;

        // Safety check: verify the requested resume session matches the tracked worker
        if (
          derivedWorkerSessionId &&
          derivedWorkerSessionId !== workerToResume
        ) {
          logWarn(
            '[MissionRunner] Resume session mismatch, ignoring resume request',
            {
              sessionId: workerToResume,
              workerSessionId: derivedWorkerSessionId,
            }
          );
          continue;
        }

        logInfo('[MissionRunner] Resuming monitoring of existing worker', {
          workerSessionId: workerToResume,
        });
        const result = await this.resumeWorker(workerToResume);

        if (this.abortSignal?.aborted) {
          logInfo('[MissionRunner] Aborted during worker resume, pausing');
          await this.pause();
          break;
        }

        // Check for milestone completion
        if (result.featureId) {
          await this.checkMilestoneCompletionAndInjectValidation(
            result.featureId
          );
        }

        // Check if all features are now complete
        const allComplete =
          await this.missionFileService.areAllFeaturesCompleted();
        if (allComplete) {
          await this.missionFileService.updateState({
            state: MissionState.Completed,
          });
          logInfo('[MissionRunner] All features completed (after resume)');
          break;
        }

        // Handle worker result.
        // missionPaused must be checked FIRST so we don't clobber the
        // Paused state that the failure handler just wrote (e.g. an
        // unrecoverable 402) by setting OrchestratorTurn here.
        if (result.missionPaused) {
          logInfo(
            '[MissionRunner] Mission paused by failure handler during resume, stopping loop',
            { featureId: result.featureId }
          );
          break;
        }

        if (result.returnToOrchestrator || !result.success) {
          await this.missionFileService.updateState({
            state: MissionState.OrchestratorTurn,
          });
          logInfo('[MissionRunner] Resumed worker returned to orchestrator');
          break;
        }

        logInfo('[MissionRunner] Resumed worker completed, continuing');
        continue;
      }

      // Check if there are pending features
      const nextFeature = await this.missionFileService.getNextPendingFeature();
      if (!nextFeature) {
        // Before marking complete, check if any milestones need validation.
        // This handles the case where features were cancelled (not completed
        // via worker) so checkMilestoneCompletionAndInjectValidation was never
        // called for them.
        await this.checkAllMilestonesForValidation();

        // Re-check for pending features after potential validation injection
        const pendingAfterValidation =
          await this.missionFileService.getNextPendingFeature();
        if (pendingAfterValidation) {
          // Validation features were injected, continue the loop
          logInfo('[MissionRunner] Validation features injected, continuing', {
            featureId: pendingAfterValidation.id,
          });
          continue;
        }

        const allComplete =
          await this.missionFileService.areAllFeaturesCompleted();
        if (allComplete) {
          await this.missionFileService.updateState({
            state: MissionState.Completed,
          });
          logInfo(
            '[MissionRunner] All features completed (no pending features)'
          );
        } else {
          await this.missionFileService.updateState({
            state: MissionState.OrchestratorTurn,
          });
          logInfo(
            '[MissionRunner] No pending features but mission not complete, returning to orchestrator'
          );
        }
        break;
      }

      // Spawn a worker session
      logInfo('[MissionRunner] Spawning worker for next feature');
      const result = await this.spawnWorker();

      if (this.abortSignal?.aborted) {
        logInfo('[MissionRunner] Aborted during worker execution, pausing');
        await this.pause();
        break;
      }

      // Check for milestone completion regardless of returnToOrchestrator.
      // Must happen BEFORE the all-complete early-exit so we can inject
      // validation even when the worker just finished the final milestone.
      if (result.featureId) {
        await this.checkMilestoneCompletionAndInjectValidation(
          result.featureId
        );
      }

      // Check if all features are now complete (worker may have completed work)
      const allComplete =
        await this.missionFileService.areAllFeaturesCompleted();
      if (allComplete) {
        await this.missionFileService.updateState({
          state: MissionState.Completed,
        });
        logInfo('[MissionRunner] All features completed (after worker)');
        break;
      }

      // Handle worker result
      // missionPaused must be checked FIRST so we don't clobber the
      // Paused state that the failure handler just wrote (e.g. an
      // unrecoverable 402) by setting OrchestratorTurn here.
      if (result.missionPaused) {
        logInfo(
          '[MissionRunner] Mission paused by failure handler, stopping loop',
          { featureId: result.featureId }
        );
        break;
      }

      if (result.returnToOrchestrator) {
        await this.missionFileService.updateState({
          state: MissionState.OrchestratorTurn,
        });
        logInfo('[MissionRunner] Worker requested orchestrator, stopping');
        break;
      }

      if (!result.success) {
        // Worker failed - return to orchestrator
        await this.missionFileService.updateState({
          state: MissionState.OrchestratorTurn,
        });
        logInfo('[MissionRunner] Worker failed, returning to orchestrator');
        break;
      }

      logInfo('[MissionRunner] Worker completed successfully, continuing');
    }

    logInfo('[MissionRunner] Loop ended');
  }

  /**
   * Check if a completed feature's milestone is now fully implemented,
   * and if so, inject the validation features:
   *   1. scrutiny-validator (serial) - runs validators, spawns review subagents, synthesizes
   *   2. user-testing-validator (serial) - determines testable assertions, runs tests, synthesizes
   *
   * Both validators are single features that spawn subagents via Task tool internally.
   */
  private async checkMilestoneCompletionAndInjectValidation(
    completedFeatureId: string
  ): Promise<void> {
    const completedFeature =
      await this.missionFileService.getFeature(completedFeatureId);
    const rawMilestone = completedFeature?.milestone;
    // Nullish check first so falsy-but-coercible values (e.g. `0`) still
    // trigger milestone validation. A truthy check would skip them.
    if (rawMilestone === undefined || rawMilestone === null) {
      return;
    }
    if (typeof rawMilestone !== 'string' && typeof rawMilestone !== 'number') {
      return;
    }

    // Defensive coercion: older CLI builds (and occasional LLM-authored
    // edits) can leave `milestone` as a number on disk. `normalizeFeature`
    // canonicalises the on-disk value to a string at the read boundary, but
    // we coerce again here as a belt-and-braces step so downstream template
    // interpolation, MissionFileService lookups, and the
    // MilestoneValidationTriggered progress-log entry (which requires
    // `z.string()`) all see the canonical form even if a caller constructs
    // a Feature directly.
    const milestone = String(rawMilestone);
    if (milestone.trim().length === 0) {
      return;
    }

    // Check if all implementation features in this milestone are complete
    const isComplete =
      await this.missionFileService.isMilestoneImplementationComplete(
        milestone
      );
    if (!isComplete) {
      return;
    }

    const alreadyPlanned =
      await this.missionFileService.hasValidationPlannerRun(milestone);
    if (alreadyPlanned) {
      return;
    }

    // User testing validator (runs after scrutiny)
    const userTestingFeatureId = `${SKILL_NAME_USER_TESTING_VALIDATOR}-${milestone}`;
    const userTestingFeature: Feature = {
      id: userTestingFeatureId,
      description: `User testing validation for milestone "${milestone}". Determines testable assertions from features' fulfills field, sets up environment, spawns flow validator subagents, synthesizes results. Always returns to orchestrator.`,
      skillName: SKILL_NAME_USER_TESTING_VALIDATOR,
      preconditions: [
        `All implementation features for milestone "${milestone}" are complete`,
      ],
      expectedBehavior: [
        'Testable assertions determined from fulfills mapping',
        'Environment set up (services started, data seeded)',
        'Flow validator subagents spawned and completed',
        'Results synthesized, validation-state.json updated',
      ],
      milestone,
      status: FeatureStatus.Pending,
      workerSessionIds: [],
    };

    // Scrutiny validator (runs first)
    const scrutinyFeatureId = `${SKILL_NAME_SCRUTINY_VALIDATOR}-${milestone}`;
    const scrutinyFeature: Feature = {
      id: scrutinyFeatureId,
      description: `Scrutiny validation for milestone "${milestone}". Runs test suite, typecheck, and lint. Spawns review subagents for each completed feature. Synthesizes findings. Always returns to orchestrator.`,
      skillName: SKILL_NAME_SCRUTINY_VALIDATOR,
      preconditions: [
        `All implementation features for milestone "${milestone}" are complete`,
      ],
      expectedBehavior: [
        'Validators pass (test, typecheck, lint)',
        'Review subagents spawned for each feature',
        'Findings synthesized into scrutiny report',
      ],
      milestone,
      status: FeatureStatus.Pending,
      workerSessionIds: [],
    };

    const missionSettings =
      await this.missionFileService.readEffectiveModelSettings();
    const { skipScrutiny, skipUserTesting } = missionSettings;
    const validationMarkerFeatureId =
      skipScrutiny && skipUserTesting
        ? `validation-skipped-${milestone}`
        : !skipScrutiny
          ? scrutinyFeatureId
          : userTestingFeatureId;

    // If both are skipped, record the milestone-level marker but don't inject features.
    if (skipScrutiny && skipUserTesting) {
      await this.missionFileService.appendProgressLog({
        timestamp: new Date().toISOString(),
        type: ProgressLogEntryType.MilestoneValidationTriggered,
        milestone,
        featureId: validationMarkerFeatureId,
      });
      logInfo(
        '[MissionRunner] Milestone complete, skipping all validation (experimental)',
        { milestone }
      );
      return;
    }

    // Insert in reverse order (each at top) so execution order is:
    // scrutiny-validator -> user-testing-validator
    if (!skipUserTesting) {
      await this.missionFileService.insertFeatureAtTop(userTestingFeature);
    }
    if (!skipScrutiny) {
      await this.missionFileService.insertFeatureAtTop(scrutinyFeature);
    }

    await this.missionFileService.appendProgressLog({
      timestamp: new Date().toISOString(),
      type: ProgressLogEntryType.MilestoneValidationTriggered,
      milestone,
      featureId: validationMarkerFeatureId,
    });

    logInfo(
      '[MissionRunner] Milestone complete, injected validation features',
      {
        milestone,
        featureId: validationMarkerFeatureId,
        newId: skipUserTesting ? '(skipped)' : userTestingFeatureId,
        entryId: skipScrutiny ? '(skipped)' : scrutinyFeatureId,
      }
    );
  }

  /**
   * Check all milestones for validation injection.
   *
   * This is called when there are no pending features left to ensure
   * validation is injected for milestones where features were cancelled
   * (not completed via worker), since the per-feature validation check
   * only triggers when a worker completes a feature.
   */
  private async checkAllMilestonesForValidation(): Promise<void> {
    const milestones = await this.missionFileService.getAllMilestones();

    for (const milestone of milestones) {
      // Find any completed feature in this milestone to use as trigger
      const features =
        await this.missionFileService.getMilestoneFeatures(milestone);
      const completedFeature = features.find(
        (f) => f.status === FeatureStatus.Completed
      );
      if (completedFeature) {
        await this.checkMilestoneCompletionAndInjectValidation(
          completedFeature.id
        );
      }
    }
  }

  private async persistWorkerSessionId(params: {
    workerSessionId: string;
    spawnId: string;
    featureId: string;
  }): Promise<void> {
    const now = new Date().toISOString();

    await this.missionFileService.appendProgressLog({
      timestamp: now,
      type: ProgressLogEntryType.WorkerStarted,
      workerSessionId: params.workerSessionId,
      spawnId: params.spawnId,
      featureId: params.featureId,
    });
  }

  /**
   * Pause the mission because the given feature has exhausted its worker-attempt
   * budget. The feature is intentionally left Pending (not cancelled) so that
   * resuming the mission - which grants a fresh attempt budget - lets it run
   * again. Returns a WorkerResult flagged `missionPaused` so the runner loop
   * stops without re-spawning another worker.
   */
  private async pauseMissionForExhaustedFeature(params: {
    feature: Feature;
    attempts: number;
    maxAttempts: number;
    spawnId: string;
  }): Promise<WorkerResult> {
    const { feature, attempts, maxAttempts, spawnId } = params;

    const reason = `Feature "${feature.id}" exceeded the maximum of ${maxAttempts} worker attempts (${attempts} attempts made) and kept failing. Mission paused so the failure can be reviewed.`;

    logWarn('[MissionRunner] Feature exceeded max attempts, pausing mission', {
      featureId: feature.id,
      attempt: attempts,
      maxAttempts,
    });

    try {
      await this.missionFileService.appendProgressLog({
        timestamp: new Date().toISOString(),
        type: ProgressLogEntryType.WorkerFailed,
        spawnId,
        reason,
      });
      await this.missionFileService.appendProgressLog({
        timestamp: new Date().toISOString(),
        type: ProgressLogEntryType.MissionPaused,
        pauseReason: MissionPauseReason.FeatureRetryLimitExceeded,
      });
      await this.missionFileService.updateState({
        state: MissionState.Paused,
      });
    } catch (error) {
      logWarn('[MissionRunner] Failed to persist pause for exhausted feature', {
        featureId: feature.id,
        cause: error,
      });
    }

    // Variant B (collapsed) handoff outcome: a feature that exhausted its
    // attempt budget never produced a successful WorkerCompleted entry.
    emitHandoffOutcome(HandoffOutcome.Failure);

    return {
      success: false,
      returnToOrchestrator: false,
      featureId: feature.id,
      message: `Mission paused: ${reason} The user can resume the mission to grant this feature a fresh attempt budget; they can also consider rescoping or removing the feature if it cannot pass.`,
      missionPaused: true,
    };
  }

  /**
   * Spawn a worker session via industryd so desktop can stream output.
   * Feature is selected BEFORE spawning and injected into the worker's initial message.
   */
  private async spawnWorker(): Promise<WorkerResult> {
    const spawnId = `worker_${uuidv4().slice(0, 8)}`;

    // Select the next feature BEFORE spawning the worker
    const nextFeature = await this.missionFileService.getNextPendingFeature();
    if (!nextFeature) {
      return {
        success: false,
        returnToOrchestrator: true,
        message: 'No pending features available',
      };
    }

    // If the next feature has exhausted its worker-attempt budget, pause the
    // mission instead of re-spawning. A perpetually-failing feature can't loop
    // forever and burn workers; the user is told what went wrong and resuming
    // grants the feature a fresh attempt budget so it can run again.
    const attempts = getFeatureAttemptCount(nextFeature);
    const missionState = await this.missionFileService.readState();
    const maxAttempts = getEffectiveMaxFeatureAttempts(
      nextFeature.id,
      missionState
    );
    if (attempts >= maxAttempts) {
      return await this.pauseMissionForExhaustedFeature({
        feature: nextFeature,
        attempts,
        maxAttempts,
        spawnId,
      });
    }

    // Determine model based on feature's skill
    const isValidationWorker = VALIDATION_SKILL_NAMES.includes(
      nextFeature.skillName
    );
    const missionSettings =
      await this.missionFileService.readEffectiveModelSettings();

    const workerModel = isValidationWorker
      ? missionSettings.validationWorkerModel
      : missionSettings.workerModel;
    const workerReasoningEffort = isValidationWorker
      ? missionSettings.validationWorkerReasoningEffort
      : missionSettings.workerReasoningEffort;

    const state = await this.missionFileService.readState();
    const missionId = state?.missionId;
    if (!missionId) {
      await this.missionFileService.appendProgressLog({
        timestamp: new Date().toISOString(),
        type: ProgressLogEntryType.WorkerFailed,
        spawnId,
        reason: 'Missing missionId in state.json',
      });

      // Variant B (collapsed) handoff outcome: missing missionId is a
      // crash branch (we never spawned a worker). VAL-M3A-005.
      emitHandoffOutcome(HandoffOutcome.Crash);

      return {
        success: false,
        returnToOrchestrator: true,
        message: 'Missing missionId in state.json',
      };
    }

    // Use working directory from mission state (set during propose_mission)
    // Fall back to current cwd for backward compatibility with existing missions
    const workerCwd = state.workingDirectory ?? process.cwd();

    let workerSessionId: string | null = null;
    try {
      const runtimeSettingsPath =
        await this.refreshMissionRuntimeCustomModels();

      workerSessionId = await getTuiDaemonAdapter().spawnWorkerSession({
        cwd: workerCwd,
        baseSessionId: this.baseSessionId,
        modelId: workerModel,
        interactionMode: DroolInteractionMode.Auto,
        autonomyLevel: AutonomyLevel.High,
        reasoningEffort: workerReasoningEffort,
        inactivityTimeoutMs: MISSION_WORKER_INACTIVITY_TIMEOUT_MS,
        runtimeSettingsPath,
        tags: [{ name: 'exec' }, { name: SESSION_TAG_MISSION_WORKER }],
      });

      if (!workerSessionId) {
        throw new Error('workerSessionId missing from spawn_worker_session');
      }
      const activeWorkerSessionId = workerSessionId;

      // Mark feature as in_progress BEFORE sending user message
      await this.missionFileService.updateFeature(nextFeature.id, {
        status: FeatureStatus.InProgress,
        workerSessionIds: [
          ...(nextFeature.workerSessionIds ?? []),
          activeWorkerSessionId,
        ],
      });

      // Log feature selection
      await this.missionFileService.appendProgressLog({
        timestamp: new Date().toISOString(),
        type: ProgressLogEntryType.WorkerSelectedFeature,
        workerSessionId: activeWorkerSessionId,
        featureId: nextFeature.id,
      });

      await this.persistWorkerSessionId({
        workerSessionId: activeWorkerSessionId,
        spawnId,
        featureId: nextFeature.id,
      });

      const role = getMissionRoleFromSkillName(nextFeature.skillName);
      Metrics.addToCounter(Metric.MISSION_WORKER_STARTED_COUNT, 1, {
        missionRole: role,
        missionFeatureId: nextFeature.id,
        missionSkillName: nextFeature.skillName,
        ...(nextFeature.milestone
          ? { missionMilestone: nextFeature.milestone }
          : {}),
        missionWorkerSessionId: activeWorkerSessionId,
        modelId: workerModel,
        reasoningEffort: workerReasoningEffort,
      });

      // Check if this is the first worker ever spawned for this mission
      const allFeatures = await this.missionFileService.readFeatures();
      const allWorkerSessionIds = (allFeatures?.features ?? []).flatMap(
        (f) => f.workerSessionIds ?? []
      );
      if (
        allWorkerSessionIds.length <= 1 &&
        typeof state?.createdAt === 'string'
      ) {
        const timeToFirstWorkerMs =
          Date.now() - new Date(state.createdAt).getTime();
        if (timeToFirstWorkerMs >= 0) {
          Metrics.recordHistogram(
            Metric.MISSION_TIME_TO_FIRST_WORKER_MS,
            timeToFirstWorkerMs
          );
        }
      }

      // Create worker prompt with assigned feature
      const workerPrompt = getWorkerBootstrapPrompt(
        this.missionFileService.getMissionDir(),
        nextFeature,
        activeWorkerSessionId
      );

      logInfo('[MissionRunner] Worker spawned with pre-assigned feature', {
        featureId: nextFeature.id,
        workerSessionId: activeWorkerSessionId,
      });

      return await this.waitForWorkerCompletion(
        activeWorkerSessionId,
        nextFeature.id,
        workerPrompt
      );
    } catch (error) {
      if (this.abortSignal?.aborted) {
        return {
          success: false,
          returnToOrchestrator: true,
          message: 'Aborted while spawning worker',
        };
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      await this.missionFileService.appendProgressLog({
        timestamp: new Date().toISOString(),
        type: ProgressLogEntryType.WorkerFailed,
        workerSessionId: workerSessionId ?? undefined,
        spawnId,
        reason: `Spawn error: ${errorMessage}`,
      });

      // Variant B (collapsed) handoff outcome: spawn error is a crash
      // branch (worker session never came online). VAL-M3A-005.
      emitHandoffOutcome(HandoffOutcome.Crash);

      if (workerSessionId) {
        await this.closeWorkerSessionAfterFailedDispatch(workerSessionId);
      }

      // Best-effort: if we already marked the feature in-progress, requeue it.
      try {
        await requeueFeatureIfInProgress({
          missionFileService: this.missionFileService,
          featureId: nextFeature.id,
          workerSessionId,
        });
      } catch {
        // Best effort
      }

      return {
        success: false,
        returnToOrchestrator: true,
        message: `Worker spawn error: ${errorMessage}`,
      };
    }
  }

  /**
   * Resume a previously paused worker session.
   * Sends a message to the existing session with a system reminder to continue.
   */
  private async resumeWorker(workerSessionId: string): Promise<WorkerResult> {
    const featureId =
      (await this.missionFileService.getInProgressFeature())?.id ?? null;

    if (!featureId) {
      logWarn('[MissionRunner] No in-progress feature found for resume', {
        workerSessionId,
      });
      return {
        success: false,
        returnToOrchestrator: true,
        message: 'No feature ID found for resumed worker',
      };
    }

    logInfo('[MissionRunner] Resuming worker session', {
      workerSessionId,
      featureId,
    });

    // First load the session to restore its state
    try {
      const runtimeSettingsPath =
        await this.refreshMissionRuntimeCustomModels();
      await getTuiDaemonAdapter().loadSession(
        workerSessionId,
        true,
        runtimeSettingsPath
      );
      logInfo('[MissionRunner] Loaded worker session', { workerSessionId });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logWarn('[MissionRunner] Failed to load worker session for resume', {
        workerSessionId,
        cause: error,
      });

      await this.missionFileService.appendProgressLog({
        timestamp: new Date().toISOString(),
        type: ProgressLogEntryType.WorkerFailed,
        workerSessionId,
        spawnId: `resume_${workerSessionId}`,
        reason: `Load session error: ${errorMessage}`,
      });

      // Variant B (collapsed) handoff outcome: failed to reload an
      // existing worker session is a crash branch. VAL-M3A-005.
      emitHandoffOutcome(HandoffOutcome.Crash);

      await this.closeWorkerSessionAfterFailedDispatch(workerSessionId);

      // Requeue feature so it can be retried with a fresh worker
      await requeueFeatureIfInProgress({
        missionFileService: this.missionFileService,
        featureId,
        workerSessionId,
      });

      return {
        success: false,
        returnToOrchestrator: true,
        featureId,
        message: `Worker load session error: ${errorMessage}`,
      };
    }

    // Send a message to resume the worker with system reminder
    const resumeMessage = `<system-reminder>
You were interrupted mid-work. Continue where you left off.

IMPORTANT: Before continuing:
1. Check the current state of the codebase (git status, check modified files)
2. Review what you have already implemented
3. Continue from where you left off

Do NOT start from scratch - continue your existing work.
</system-reminder>

[continue working on the feature]`;

    try {
      return await this.waitForWorkerCompletion(
        workerSessionId,
        featureId,
        resumeMessage
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logWarn('[MissionRunner] Failed to resume worker session', {
        workerSessionId,
        cause: error,
      });

      await this.missionFileService.appendProgressLog({
        timestamp: new Date().toISOString(),
        type: ProgressLogEntryType.WorkerFailed,
        workerSessionId,
        spawnId: `resume_${workerSessionId}`,
        reason: `Resume error: ${errorMessage}`,
      });

      // Variant B (collapsed) handoff outcome: failed to send the resume
      // user message is a crash branch (worker is dead-on-arrival).
      // VAL-M3A-005.
      emitHandoffOutcome(HandoffOutcome.Crash);

      await this.closeWorkerSessionAfterFailedDispatch(workerSessionId);

      // Requeue feature so it can be retried with a fresh worker
      await requeueFeatureIfInProgress({
        missionFileService: this.missionFileService,
        featureId,
        workerSessionId,
      });

      return {
        success: false,
        returnToOrchestrator: true,
        featureId,
        message: `Worker resume error: ${errorMessage}`,
      };
    }
  }

  private async closeWorkerSessionAfterFailedDispatch(
    workerSessionId: string
  ): Promise<void> {
    try {
      await getTuiDaemonAdapter().closeSession(workerSessionId);
    } catch (error) {
      logWarn(
        '[MissionRunner] Failed to close worker session after dispatch failure',
        {
          workerSessionId,
          cause: error,
        }
      );
    }
  }

  /**
   * Wait for a worker session to complete.
   * Shared by spawnWorker and resumeWorker.
   */
  private async waitForWorkerCompletion(
    workerSessionId: string,
    featureId: string,
    initialUserMessage?: string
  ): Promise<WorkerResult> {
    let lastHeartbeatAt = Date.now();
    let daemonFailureResult: WorkerResult | null = null;
    let workerCompletionResult: WorkerResult | null = null;
    let workerCompletionHandled = false;
    let daemonFailureInFlight = false;
    let isWaitingForWorker = true;
    let wakeWaiter: (() => void) | null = null;

    const hasTerminalWaitCondition = (): boolean =>
      !this.isRunning ||
      this.abortSignal?.aborted === true ||
      daemonFailureResult !== null ||
      workerCompletionResult !== null;

    const wake = (): void => {
      const resolve = wakeWaiter;
      wakeWaiter = null;
      resolve?.();
    };
    this.wakeWorkerCompletionWaiter = wake;

    const waitForWakeOrTimeout = async (ms: number): Promise<void> => {
      if (hasTerminalWaitCondition()) {
        return;
      }

      await new Promise<void>((resolve) => {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let done: () => void;

        const cleanup = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          if (wakeWaiter === done) {
            wakeWaiter = null;
          }
          this.abortSignal?.removeEventListener('abort', done);
        };

        done = () => {
          cleanup();
          resolve();
        };

        wakeWaiter = done;
        this.abortSignal?.addEventListener('abort', done, { once: true });
        if (hasTerminalWaitCondition()) {
          done();
          return;
        }
        timeoutId = setTimeout(done, ms);
      });
    };

    const findWorkerCompletedEntry =
      async (): Promise<WorkerCompletedEntry | null> => {
        try {
          const progressLog = await this.missionFileService.readProgressLog();
          return (
            progressLog.find(
              (entry): entry is WorkerCompletedEntry =>
                entry.type === ProgressLogEntryType.WorkerCompleted &&
                entry.workerSessionId === workerSessionId
            ) ?? null
          );
        } catch (error) {
          logWarn(
            '[MissionRunner] Failed to read progress log for worker completion',
            { workerSessionId, cause: error }
          );
          return null;
        }
      };

    const completeWorkerFromProgressLog = async (): Promise<boolean> => {
      if (workerCompletionHandled || daemonFailureResult) {
        return workerCompletionHandled;
      }

      const completed = await findWorkerCompletedEntry();
      if (!completed) {
        return false;
      }

      if (workerCompletionHandled || daemonFailureResult) {
        return workerCompletionHandled;
      }
      workerCompletionHandled = true;

      await this.recordWorkerCompletionMetrics(completed);

      // Close the worker session via daemon so the process is terminated
      // cleanly (isClosing=true prevents a spurious PROCESS_EXIT_ERROR).
      // Best-effort: don't await — the orchestrator should not block on this.
      void Promise.resolve(
        getTuiDaemonAdapter().closeSession(workerSessionId)
      ).catch((error) => {
        logWarn('[MissionRunner] Failed to close completed worker session', {
          workerSessionId,
          cause: error,
        });
      });

      agentEventBus.emit(AgentEvent.ProjectNotification, {
        notification: {
          type: SessionNotificationType.MISSION_WORKER_COMPLETED,
          workerSessionId,
          exitCode: completed.exitCode,
        },
      });

      workerCompletionResult = {
        success:
          completed.successState === 'success' &&
          completed.returnToOrchestrator === false,
        returnToOrchestrator:
          completed.returnToOrchestrator ||
          completed.successState === 'failure',
        featureId: completed.featureId,
      };
      wake();
      return true;
    };

    const progressLogContainsUnrecoverableUsage402 = (
      progressLog: ProgressLogEntry[]
    ): boolean =>
      progressLog.some(
        (entry) =>
          entry.type === ProgressLogEntryType.WorkerFailed &&
          entry.workerSessionId === workerSessionId &&
          entry.failureReason === WorkerFailureReason.UnrecoverableUsage402
      );

    /**
     * Auto-pause the mission when this worker has signalled an unrecoverable
     * 402. Idempotent: only writes the pause state + log entry once per
     * `waitForWorkerCompletion` call (guarded by `daemonFailureResult`).
     *
     * Note we run this from BOTH worker progress notifications and daemon
     * terminal notifications so the auto-pause fires when either signal wins.
     */
    const triggerUnrecoverableUsage402Pause = async (): Promise<void> => {
      if (daemonFailureResult || daemonFailureInFlight) {
        return;
      }
      daemonFailureInFlight = true;
      try {
        logInfo(
          '[MissionRunner] Worker hit unrecoverable 402; pausing mission',
          { workerSessionId, featureId }
        );

        try {
          await this.missionFileService.appendProgressLog({
            timestamp: new Date().toISOString(),
            type: ProgressLogEntryType.MissionPaused,
            pauseReason: MissionPauseReason.UnrecoverableUsage402,
          });
        } catch (error) {
          logWarn(
            '[MissionRunner] Failed to log MissionPaused after unrecoverable 402',
            { workerSessionId, cause: error }
          );
          return;
        }

        try {
          await this.missionFileService.updateState({
            state: MissionState.Paused,
          });
        } catch (error) {
          logWarn(
            '[MissionRunner] Failed to set state=Paused after unrecoverable 402',
            { workerSessionId, cause: error }
          );
        }

        // Best-effort: close the worker session so the daemon doesn't keep
        // a zombie session around after the worker signalled a terminal 402.
        void Promise.resolve(
          getTuiDaemonAdapter().closeSession(workerSessionId)
        ).catch(() => undefined);

        daemonFailureResult = {
          success: false,
          returnToOrchestrator: false,
          featureId,
          message: 'Mission paused: usage limit reached.',
          missionPaused: true,
        };
        wake();
      } finally {
        daemonFailureInFlight = false;
      }
    };

    /**
     * Returns true when this worker session has already appended a
     * WorkerFailed entry tagged with `UnrecoverableUsage402` to the mission
     * progress log (signalling that AgentLoop hit a 402 it could not
     * transparently recover from). When true, the MissionRunner must
     * auto-pause the mission instead of requeuing the feature.
     */
    const hasUnrecoverableUsage402Signal = async (): Promise<boolean> => {
      try {
        const log = await this.missionFileService.readProgressLog();
        return log.some(
          (entry) =>
            entry.type === ProgressLogEntryType.WorkerFailed &&
            entry.workerSessionId === workerSessionId &&
            entry.failureReason === WorkerFailureReason.UnrecoverableUsage402
        );
      } catch (error) {
        logWarn(
          '[MissionRunner] Failed to read progress log for 402 signal check',
          { workerSessionId, cause: error }
        );
        return false;
      }
    };

    const handleDaemonWorkerFailure = async (params: {
      reason: string;
      spawnId: string;
      notification: DaemonSessionNotification['params']['notification'];
    }): Promise<void> => {
      if (
        !isWaitingForWorker ||
        workerCompletionHandled ||
        daemonFailureResult ||
        daemonFailureInFlight
      ) {
        return;
      }

      if (await completeWorkerFromProgressLog()) {
        return;
      }

      // Auto-pause path: if the worker pre-flagged an unrecoverable 402,
      // skip the requeue + WorkerFailed-from-daemon + return-to-orchestrator
      // dance and put the mission into Paused so the orchestrator does not
      // immediately respawn another worker that would hit the same 402.
      // The worker has already written its own WorkerFailed entry tagged
      // with `failureReason: UnrecoverableUsage402`, so we don't double-log.
      if (await hasUnrecoverableUsage402Signal()) {
        await triggerUnrecoverableUsage402Pause();
        return;
      }

      daemonFailureInFlight = true;
      try {
        try {
          await this.missionFileService.appendProgressLog({
            timestamp: new Date().toISOString(),
            type: ProgressLogEntryType.WorkerFailed,
            workerSessionId,
            spawnId: params.spawnId,
            reason: params.reason,
          });
        } catch (error) {
          logWarn(
            '[MissionRunner] Failed to log WorkerFailed from daemon event',
            {
              workerSessionId,
              notificationType: params.notification.type,
              cause: error,
            }
          );
        }

        // Variant B (collapsed) handoff outcome: daemon-driven worker
        // termination (inactivity timeout, PROCESS_EXIT_ERROR) is a crash
        // branch — worker died without producing a WorkerCompleted entry.
        // VAL-M3A-005.
        emitHandoffOutcome(HandoffOutcome.Crash);

        try {
          await requeueFeatureIfInProgress({
            missionFileService: this.missionFileService,
            featureId,
            workerSessionId,
          });
        } catch (error) {
          logWarn(
            '[MissionRunner] Failed to requeue feature from daemon event',
            {
              featureId,
              workerSessionId,
              notificationType: params.notification.type,
              cause: error,
            }
          );
        }

        daemonFailureResult = {
          success: false,
          returnToOrchestrator: true,
          featureId,
          message: params.reason,
        };
        wake();
      } finally {
        daemonFailureInFlight = false;
      }
    };

    const unsubscribeFromWorkerSessionNotifications =
      getTuiDaemonAdapter().subscribeToSessionNotifications(
        workerSessionId,
        async (notification) => {
          switch (notification.type) {
            case SessionNotificationType.MISSION_WORKER_COMPLETED: {
              if (notification.workerSessionId !== workerSessionId) {
                return;
              }

              await completeWorkerFromProgressLog();
              return;
            }

            case SessionNotificationType.MISSION_STATE_CHANGED:
            case SessionNotificationType.MISSION_FEATURES_CHANGED: {
              agentEventBus.emit(AgentEvent.ProjectNotification, {
                notification,
              });
              return;
            }

            case SessionNotificationType.MISSION_PROGRESS_ENTRY: {
              agentEventBus.emit(AgentEvent.ProjectNotification, {
                notification,
              });

              if (
                progressLogContainsUnrecoverableUsage402(
                  notification.progressLog
                )
              ) {
                await triggerUnrecoverableUsage402Pause();
              }
              return;
            }

            default:
              break;
          }

          if (
            notification.type ===
            DaemonSpecificNotificationType.SESSION_INACTIVITY
          ) {
            const reason =
              'Worker session cleaned up by daemon after inactivity timeout.';
            await handleDaemonWorkerFailure({
              reason,
              spawnId: `daemon_inactivity_${workerSessionId}`,
              notification,
            });
            return;
          }

          if (
            notification.type === SessionNotificationType.ERROR &&
            notification.errorType === DroolErrorType.PROCESS_EXIT_ERROR
          ) {
            // The worker self-exits after completing its turn (process.exit(0)
            // in streamingJsonRpcExecRunner). If a WorkerCompleted entry
            // already exists in the progress log, this exit is expected and
            // should not be treated as a failure.
            if (await completeWorkerFromProgressLog()) {
              logInfo(
                '[MissionRunner] Ignoring PROCESS_EXIT_ERROR for already-completed worker',
                { workerSessionId }
              );
              return;
            }

            const reason = `Worker process exited unexpectedly: ${notification.message}`;
            await handleDaemonWorkerFailure({
              reason,
              spawnId: `daemon_process_exit_${workerSessionId}`,
              notification,
            });
          }
        }
      );

    try {
      if (initialUserMessage !== undefined) {
        await getTuiDaemonAdapter().addUserMessage({
          sessionId: workerSessionId,
          text: initialUserMessage,
        });
      }

      while (this.isRunning && !this.abortSignal?.aborted) {
        if (daemonFailureResult) {
          return daemonFailureResult;
        }

        if (workerCompletionResult) {
          return workerCompletionResult;
        }

        const now = Date.now();

        if (now - lastHeartbeatAt >= MISSION_HEARTBEAT_INTERVAL_MS) {
          lastHeartbeatAt = now;
          agentEventBus.emit(AgentEvent.ProjectNotification, {
            notification: {
              type: SessionNotificationType.MISSION_HEARTBEAT,
              timestamp: new Date(now).toISOString(),
            },
          });
          // Keep state.json updatedAt fresh so the mission is not
          // considered stale while a long-running worker is active.
          await this.missionFileService.updateState({});
        }

        const msUntilNextHeartbeat = Math.max(
          0,
          MISSION_HEARTBEAT_INTERVAL_MS - (Date.now() - lastHeartbeatAt)
        );
        await waitForWakeOrTimeout(msUntilNextHeartbeat);
      }
    } finally {
      isWaitingForWorker = false;
      if (this.wakeWorkerCompletionWaiter === wake) {
        this.wakeWorkerCompletionWaiter = null;
      }
      unsubscribeFromWorkerSessionNotifications();
    }

    // Best-effort: don't await; runner should be able to return promptly on abort.
    void Promise.resolve(
      getTuiDaemonAdapter().interruptSession(workerSessionId)
    ).catch((error) => {
      logWarn('[MissionRunner] Failed to interrupt worker session on abort', {
        workerSessionId,
        cause: error,
      });
    });

    return {
      success: false,
      returnToOrchestrator: true,
      message: 'Worker interrupted',
    };
  }

  private async recordWorkerCompletionMetrics(
    completed: WorkerCompletedEntry
  ): Promise<void> {
    // Emit the Variant B (collapsed) handoff-outcome signal first so the
    // metric fires even if any of the downstream metric writes throw.
    // `deriveCompletionOutcome` enforces the success → incomplete-handoff
    // collapse rules pinned in `library/architecture.md` and returns one of
    // 'success' | 'partial' | 'failure' | 'incomplete-handoff' (crash is
    // emitted from the WorkerFailed call sites only).
    emitHandoffOutcome(deriveCompletionOutcome(completed));

    try {
      const [feature, missionSettings] = await Promise.all([
        this.missionFileService.getFeature(completed.featureId),
        this.missionFileService.readEffectiveModelSettings(),
      ]);

      const role = getMissionRoleFromSkillName(feature?.skillName);
      const modelId =
        role === 'validation_worker'
          ? missionSettings.validationWorkerModel
          : missionSettings.workerModel;
      const reasoningEffort =
        role === 'validation_worker'
          ? missionSettings.validationWorkerReasoningEffort
          : missionSettings.workerReasoningEffort;

      Metrics.addToCounter(Metric.MISSION_WORKER_COMPLETED_COUNT, 1, {
        missionRole: role,
        missionWorkerSessionId: completed.workerSessionId,
        missionFeatureId: completed.featureId,
        ...(feature?.skillName ? { missionSkillName: feature.skillName } : {}),
        ...(feature?.milestone ? { missionMilestone: feature.milestone } : {}),
        missionSuccessState: completed.successState,
        ...(modelId ? { modelId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });

      const { derivedWorkerStates } =
        await this.missionFileService.readProgressLogWithDerivedWorkerStatesOrThrow();
      const startedAt =
        derivedWorkerStates[completed.workerSessionId]?.startedAt;
      if (!startedAt) {
        return;
      }

      const durationMs =
        new Date(completed.timestamp).getTime() - new Date(startedAt).getTime();
      if (durationMs < 0) {
        return;
      }

      Metrics.recordHistogram(Metric.MISSION_WORKER_DURATION_MS, durationMs, {
        missionRole: role,
        missionWorkerSessionId: completed.workerSessionId,
        missionFeatureId: completed.featureId,
        ...(modelId ? { modelId } : {}),
      });
    } catch (error) {
      logWarn('[MissionRunner] Failed to record worker completion metrics', {
        workerSessionId: completed.workerSessionId,
        featureId: completed.featureId,
        cause: error,
      });
    }
  }
}

export { MissionRunner };
