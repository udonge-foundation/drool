import {
  ProgressLogEntryType,
  MissionState,
  SessionNotificationType,
  type ProgressLogEntry,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logInfo, logWarn } from '@industry/logging';

import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getMissionFileService } from '@/services/mission/MissionFileService';
import { MissionRunner } from '@/services/mission/MissionRunner';
import { requeueFeatureIfInProgress } from '@/services/mission/requeueFeatureIfInProgress';

// Runner instance cache
const runnerInstances = new Map<string, MissionRunner>();
const inFlightPauseOperations = new Map<string, Promise<void>>();

function getTimestampMs(timestamp: string | undefined): number | null {
  if (!timestamp) {
    return null;
  }

  const timestampMs = new Date(timestamp).getTime();
  return Number.isNaN(timestampMs) ? null : timestampMs;
}

function getStaleMissionPauseTimestampIso(params: {
  stateUpdatedAt?: string;
  progressLog: ProgressLogEntry[];
  nowMs?: number;
}): string {
  const nowMs = params.nowMs ?? Date.now();
  const progressTimestampMs = params.progressLog
    .map((entry) => getTimestampMs(entry.timestamp))
    .filter((timestampMs): timestampMs is number => timestampMs !== null);
  const activeStartTimestampMs = params.progressLog
    .filter(
      (entry) =>
        entry.type === ProgressLogEntryType.MissionRunStarted ||
        entry.type === ProgressLogEntryType.MissionResumed
    )
    .map((entry) => getTimestampMs(entry.timestamp))
    .filter((timestampMs): timestampMs is number => timestampMs !== null);
  const candidateTimestampMs = [
    getTimestampMs(params.stateUpdatedAt),
    ...progressTimestampMs,
  ].filter((timestampMs): timestampMs is number => timestampMs !== null);
  const latestKnownActivityMs =
    candidateTimestampMs.length > 0 ? Math.max(...candidateTimestampMs) : nowMs;
  const latestActiveStartMs =
    activeStartTimestampMs.length > 0
      ? Math.max(...activeStartTimestampMs)
      : latestKnownActivityMs;
  const pauseTimestampMs = Math.min(
    nowMs,
    Math.max(latestActiveStartMs, latestKnownActivityMs)
  );

  return new Date(pauseTimestampMs).toISOString();
}

/**
 * Get or create a MissionRunner for a session
 */
function getMissionRunner(baseSessionId: string): MissionRunner {
  let runner = runnerInstances.get(baseSessionId);
  if (!runner) {
    runner = new MissionRunner(baseSessionId);
    runnerInstances.set(baseSessionId, runner);
  }
  return runner;
}

export function isMissionRunnerActive(baseSessionId: string): boolean {
  return runnerInstances.get(baseSessionId)?.isActive() ?? false;
}

/**
 * Start the mission runner for a session and wait for completion
 * Called by start_mission_run executor
 * @param baseSessionId The session ID to run the mission for
 * @param abortSignal Abort signal to enable cancellation from tool execution
 * @param resumeWorkerSessionId Optional paused worker session to resume
 */
export async function startMissionRunner(
  baseSessionId: string,
  abortSignal: AbortSignal,
  resumeWorkerSessionId?: string
): Promise<void> {
  const runner = getMissionRunner(baseSessionId);
  // Wait for runner to complete (blocking for prototype)
  await runner.start(abortSignal, resumeWorkerSessionId);
}

/**
 * Pause the mission runner for a session (graceful stop with state preservation)
 * @internal
 */
export async function pauseMissionRunner(baseSessionId: string): Promise<void> {
  const existingPauseOperation = inFlightPauseOperations.get(baseSessionId);
  if (existingPauseOperation) {
    return existingPauseOperation;
  }

  const pauseOperation = (async () => {
    const missionFileService = getMissionFileService(baseSessionId);

    const runner = runnerInstances.get(baseSessionId);
    if (runner) {
      // Runner's pause() method handles state update and log entry
      await runner.pause();

      // If the runner was not actively running, pause() is a no-op.
      // Fall through to the file-based fallback so between-worker states
      // (e.g. OrchestratorTurn) can still be paused.
      const stateAfterRunnerPause = await missionFileService.readState();
      if (stateAfterRunnerPause?.state === MissionState.Paused) {
        return;
      }
    }

    // Fallback: if the runner isn't started (or has already exited), we still want
    // interrupt_session to reliably transition a running mission into a paused
    // state so the UI can re-enable chat.
    const exists = await missionFileService.missionExists();
    if (!exists) {
      return;
    }

    const state = await missionFileService.readState();
    if (!state) {
      return;
    }

    // Only pause mission states that can transition into a user-paused state.
    if (
      state.state !== MissionState.Initializing &&
      state.state !== MissionState.Running &&
      state.state !== MissionState.OrchestratorTurn
    ) {
      return;
    }

    const inProgressFeature = await missionFileService.getInProgressFeature();
    const currentFeatureId = inProgressFeature?.id ?? null;
    const currentWorkerSessionId =
      inProgressFeature?.workerSessionIds?.at(-1) ?? null;

    if (currentWorkerSessionId) {
      try {
        // Best-effort: do not await daemon RPC here. If the daemon is wedged,
        // awaiting can hang the CLI and prevent the mission from being marked Paused.
        void Promise.resolve(
          getTuiDaemonAdapter().interruptSession(currentWorkerSessionId)
        ).catch((error) => {
          logWarn(
            '[pauseMissionRunner] Failed to interrupt worker session (async)',
            {
              workerSessionId: currentWorkerSessionId,
              cause: error,
            }
          );
        });
      } catch (error) {
        logWarn(
          '[pauseMissionRunner] Failed to interrupt worker session (sync)',
          {
            workerSessionId: currentWorkerSessionId,
            cause: error,
          }
        );
      }

      try {
        await missionFileService.appendProgressLog({
          timestamp: new Date().toISOString(),
          type: ProgressLogEntryType.WorkerPaused,
          workerSessionId: currentWorkerSessionId,
          featureId: currentFeatureId ?? undefined,
        });
      } catch (error) {
        logWarn('[pauseMissionRunner] Failed to log WorkerPaused', {
          workerSessionId: currentWorkerSessionId,
          cause: error,
        });
      }
    }

    try {
      await missionFileService.appendProgressLog({
        timestamp: new Date().toISOString(),
        type: ProgressLogEntryType.MissionPaused,
      });
    } catch (error) {
      logWarn('[pauseMissionRunner] Failed to log MissionPaused', {
        cause: error,
      });
      throw error;
    }

    // Set state to paused — feature/worker tracking lives in features.json
    await missionFileService.updateState({
      state: MissionState.Paused,
    });
  })();

  inFlightPauseOperations.set(baseSessionId, pauseOperation);
  try {
    await pauseOperation;
  } finally {
    if (inFlightPauseOperations.get(baseSessionId) === pauseOperation) {
      inFlightPauseOperations.delete(baseSessionId);
    }
  }
}

/**
 * Recover a mission that was persisted as running/initializing even though the
 * controlling TUI process has been reloaded.
 *
 * This preserves worker/feature tracking so a subsequent start_mission_run can
 * auto-resume the worker if it is still available.
 */
export async function reconcileMissionStateAfterSessionLoad(
  baseSessionId: string
): Promise<boolean> {
  const missionFileService = getMissionFileService(baseSessionId);

  const exists = await missionFileService.missionExists();
  if (!exists) {
    return false;
  }

  const state = await missionFileService.readState();
  if (!state) {
    return false;
  }

  if (
    state.state !== MissionState.Running &&
    state.state !== MissionState.Initializing &&
    state.state !== MissionState.OrchestratorTurn
  ) {
    return false;
  }

  const progressLog = await missionFileService.readProgressLog();
  const pausedAtIso = getStaleMissionPauseTimestampIso({
    stateUpdatedAt: state.updatedAt,
    progressLog,
  });

  try {
    await missionFileService.appendProgressLog({
      timestamp: pausedAtIso,
      type: ProgressLogEntryType.MissionPaused,
    });
  } catch (error) {
    logWarn(
      '[reconcileMissionStateAfterSessionLoad] Failed to log MissionPaused',
      {
        baseSessionId,
        cause: error,
      }
    );
    return false;
  }

  await missionFileService.updateState({
    state: MissionState.Paused,
  });

  const reconciledFeature = await missionFileService.getInProgressFeature();
  const reconciledFeatureId = reconciledFeature?.id ?? null;
  const reconciledWorkerSessionId =
    reconciledFeature?.workerSessionIds?.at(-1) ?? null;

  logInfo(
    '[reconcileMissionStateAfterSessionLoad] Reconciled stale mission state on session load',
    {
      baseSessionId,
      previousState: state.state,
      ...(reconciledWorkerSessionId
        ? { workerSessionId: reconciledWorkerSessionId }
        : {}),
      ...(reconciledFeatureId ? { featureId: reconciledFeatureId } : {}),
    }
  );

  return true;
}

/**
 * Kill a worker session (different from pause - the feature is requeued, not preserved for resume).
 * Called when user explicitly kills a worker from the UI.
 */
export async function killWorkerSession({
  missionId,
  workerSessionId,
}: {
  missionId: string;
  workerSessionId: string;
}): Promise<void> {
  const missionFileService = getMissionFileService(missionId);

  const exists = await missionFileService.missionExists();
  if (!exists) {
    return;
  }

  const state = await missionFileService.readState();
  if (!state) {
    return;
  }

  // Log WorkerFailed with "killed by user" reason
  await missionFileService.appendProgressLog({
    timestamp: new Date().toISOString(),
    type: ProgressLogEntryType.WorkerFailed,
    workerSessionId,
    spawnId: `killed_${workerSessionId}`,
    reason: 'Killed by user',
  });

  // Notify frontend that worker is completed (so it can update the workers list)
  agentEventBus.emit(AgentEvent.ProjectNotification, {
    notification: {
      type: SessionNotificationType.MISSION_WORKER_COMPLETED,
      workerSessionId,
      exitCode: 1, // Non-zero exit code to indicate killed
    },
  });

  // Derive current feature from features.json
  const killFeatureId =
    (await missionFileService.getInProgressFeature())?.id ?? null;

  // Requeue the feature to Pending so orchestrator can assign a new worker
  if (killFeatureId) {
    await requeueFeatureIfInProgress({
      missionFileService,
      featureId: killFeatureId,
      workerSessionId,
    });
  }

  // Set state to OrchestratorTurn
  await missionFileService.updateState({
    state: MissionState.OrchestratorTurn,
  });

  // Interrupt the worker session
  // Note: The orchestrator is interrupted directly by the handler (handleKillWorkerSession)
  // since it's in the same process and going through daemon RPC causes issues
  try {
    // Best-effort: do not await daemon RPC. If the daemon is wedged,
    // awaiting can hang the UI action.
    void Promise.resolve(
      getTuiDaemonAdapter().closeSession(workerSessionId)
    ).catch((error) => {
      logWarn('[killWorkerSession] Failed to close worker session (async)', {
        workerSessionId,
        cause: error,
      });
    });
  } catch (error) {
    logWarn('[killWorkerSession] Failed to close worker session (sync)', {
      workerSessionId,
      cause: error,
    });
  }

  logInfo('[killWorkerSession] Worker killed and feature requeued', {
    workerSessionId,
    featureId: killFeatureId ?? undefined,
  });
}
