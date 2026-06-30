import {
  ProgressLogEntryType,
  WorkerFailureReason,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logInfo, logWarn } from '@industry/logging';

import { getMissionFileService } from '@/services/mission/MissionFileService';
import { isMissionWorkerSession } from '@/services/mission/sessionTags';
import { getSessionService } from '@/services/SessionService';

/**
 * Append a structured `WorkerFailed` progress-log entry to the mission so the
 * MissionRunner can detect that this worker just hit an unrecoverable 402 and
 * auto-pause the mission instead of requeuing the feature for another spawn.
 *
 * Called from AgentLoop's 402 catch path immediately before re-throwing, when
 * `attemptDroolCoreFallback402` returned `{ didSwap: false }`. No-op when the
 * current session is not a mission worker (orchestrator handles its own 402
 * via the same path; non-mission sessions have nothing to signal).
 *
 * Invariant: the entry is appended via `MissionFileService.appendProgressLog`,
 * which is the same write path the MissionRunner reads from in its
 * `PROCESS_EXIT_ERROR` handler — so the read-after-write on a subsequent
 * worker-process exit is well-ordered.
 */
export async function signalUnrecoverable402ToMission(args: {
  sessionService: ReturnType<typeof getSessionService>;
  reason: string;
}): Promise<void> {
  const { sessionService, reason } = args;

  const tags = sessionService.getCurrentSessionTags?.();
  if (!isMissionWorkerSession(tags)) {
    return;
  }

  const workerSessionId = sessionService.getCurrentSessionId();
  const missionId = sessionService.getDecompMissionId();
  if (!missionId) {
    logWarn(
      '[signalUnrecoverable402ToMission] Worker session has no missionId tag; skipping signal',
      { workerSessionId }
    );
    return;
  }

  try {
    const missionFileService = getMissionFileService(missionId);
    await missionFileService.appendProgressLog({
      timestamp: new Date().toISOString(),
      type: ProgressLogEntryType.WorkerFailed,
      workerSessionId: workerSessionId ?? undefined,
      spawnId: `unrecoverable_usage_402_${workerSessionId ?? 'unknown'}`,
      reason,
      failureReason: WorkerFailureReason.UnrecoverableUsage402,
    });
    logInfo(
      '[signalUnrecoverable402ToMission] Signalled unrecoverable 402 to mission',
      { workerSessionId }
    );
  } catch (error) {
    logWarn(
      '[signalUnrecoverable402ToMission] Failed to append WorkerFailed signal',
      { cause: error, workerSessionId }
    );
  }
}
