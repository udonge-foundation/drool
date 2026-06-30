import {
  FeatureSuccessState,
  ProgressLogEntryType,
  type ProgressLogEntry,
  type WorkerStateInfo,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  deriveMissionWorkerSessionReferences,
  formatMissionIndustryStandardCredits,
  type MissionWorkerFeature,
} from '@industry/utils/mission';

import type {
  WorkerDisplayStatus,
  WorkerSessionDisplay,
} from '@/components/mission-control/types';
import { formatStartTime } from '@/components/mission-control/utils/text';
import { formatDurationCompact } from '@/utils/format';

type WorkerTerminalStatus = Extract<
  WorkerDisplayStatus,
  'success' | 'partial' | 'failed'
>;
type WorkerLifecycleStatus = Extract<WorkerDisplayStatus, 'running' | 'paused'>;
type WorkerLifecycleState = WorkerLifecycleStatus | 'terminal' | null;

interface WorkerTimingInfo {
  startedAtMs: number | null;
  totalPausedMs: number;
  activePauseStartedAtMs: number | null;
  terminalAtMs: number | null;
  lifecycleState: WorkerLifecycleState;
}

function parseTimestamp(timestamp?: string): number | null {
  if (!timestamp) {
    return null;
  }

  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) ? value : null;
}

function getWorkerTerminalStatus(
  successState: FeatureSuccessState | undefined
): WorkerTerminalStatus {
  switch (successState) {
    case FeatureSuccessState.Success:
      return 'success';
    case FeatureSuccessState.Partial:
      return 'partial';
    case FeatureSuccessState.Failure:
    default:
      return 'failed';
  }
}

function isWorkerTerminal(
  sessionId: string,
  workerState: WorkerStateInfo | undefined,
  terminalStatusBySessionId: Map<string, WorkerTerminalStatus>
): boolean {
  return (
    Boolean(workerState?.completedAt) ||
    terminalStatusBySessionId.has(sessionId)
  );
}

function buildWorkerTimingInfo(
  progressLog: ProgressLogEntry[],
  workerStates: Record<string, WorkerStateInfo> | undefined
): {
  timingBySessionId: Map<string, WorkerTimingInfo>;
  terminalStatusBySessionId: Map<string, WorkerTerminalStatus>;
} {
  const timingBySessionId = new Map<string, WorkerTimingInfo>();
  const terminalStatusBySessionId = new Map<string, WorkerTerminalStatus>();
  let currentRunningSessionId: string | null = null;

  const getTimingInfo = (sessionId: string): WorkerTimingInfo => {
    const existing = timingBySessionId.get(sessionId);
    if (existing) {
      return existing;
    }

    const created: WorkerTimingInfo = {
      startedAtMs: parseTimestamp(workerStates?.[sessionId]?.startedAt),
      totalPausedMs: 0,
      activePauseStartedAtMs: null,
      terminalAtMs: parseTimestamp(workerStates?.[sessionId]?.completedAt),
      lifecycleState: null,
    };
    timingBySessionId.set(sessionId, created);
    return created;
  };

  for (const entry of progressLog) {
    switch (entry.type) {
      case ProgressLogEntryType.WorkerStarted: {
        if (!entry.workerSessionId) {
          break;
        }
        const timingInfo = getTimingInfo(entry.workerSessionId);
        timingInfo.startedAtMs ??= parseTimestamp(entry.timestamp);
        timingInfo.lifecycleState = 'running';
        currentRunningSessionId = entry.workerSessionId;
        break;
      }
      case ProgressLogEntryType.WorkerPaused: {
        if (
          !entry.workerSessionId ||
          isWorkerTerminal(
            entry.workerSessionId,
            workerStates?.[entry.workerSessionId],
            terminalStatusBySessionId
          )
        ) {
          break;
        }

        const timingInfo = getTimingInfo(entry.workerSessionId);
        currentRunningSessionId = null;
        timingInfo.activePauseStartedAtMs ??= parseTimestamp(entry.timestamp);
        timingInfo.lifecycleState = 'paused';
        break;
      }
      case ProgressLogEntryType.MissionPaused: {
        if (!currentRunningSessionId) {
          break;
        }

        const timingInfo = getTimingInfo(currentRunningSessionId);
        currentRunningSessionId = null;
        timingInfo.activePauseStartedAtMs ??= parseTimestamp(entry.timestamp);
        timingInfo.lifecycleState = 'paused';
        break;
      }
      case ProgressLogEntryType.MissionResumed: {
        const resumedAtMs = parseTimestamp(entry.timestamp);
        const resumedSessionId = entry.resumeWorkerSessionId ?? null;
        if (!resumedSessionId) {
          currentRunningSessionId = null;
          break;
        }

        const timingInfo = getTimingInfo(resumedSessionId);
        const pausedAtMs = timingInfo.activePauseStartedAtMs;
        if (pausedAtMs !== null && resumedAtMs !== null) {
          timingInfo.totalPausedMs += Math.max(0, resumedAtMs - pausedAtMs);
        }
        timingInfo.activePauseStartedAtMs = null;
        timingInfo.lifecycleState = 'running';
        currentRunningSessionId = resumedSessionId;
        break;
      }
      case ProgressLogEntryType.WorkerCompleted: {
        if (!entry.workerSessionId) {
          break;
        }

        terminalStatusBySessionId.set(
          entry.workerSessionId,
          getWorkerTerminalStatus(entry.successState)
        );

        if (currentRunningSessionId === entry.workerSessionId) {
          currentRunningSessionId = null;
        }

        const timingInfo = getTimingInfo(entry.workerSessionId);
        timingInfo.activePauseStartedAtMs = null;
        timingInfo.terminalAtMs ??= parseTimestamp(entry.timestamp);
        timingInfo.lifecycleState = 'terminal';
        break;
      }
      case ProgressLogEntryType.WorkerFailed: {
        if (!entry.workerSessionId) {
          break;
        }
        terminalStatusBySessionId.set(entry.workerSessionId, 'failed');
        if (currentRunningSessionId === entry.workerSessionId) {
          currentRunningSessionId = null;
        }

        const timingInfo = getTimingInfo(entry.workerSessionId);
        timingInfo.activePauseStartedAtMs = null;
        timingInfo.terminalAtMs ??= parseTimestamp(entry.timestamp);
        timingInfo.lifecycleState = 'terminal';
        break;
      }
      default:
        break;
    }
  }

  return {
    timingBySessionId,
    terminalStatusBySessionId,
  };
}

export function buildWorkerSessions(
  workerSessionIds: string[],
  workerStates: Record<string, WorkerStateInfo> | undefined,
  progressLog: ProgressLogEntry[],
  features: Array<MissionWorkerFeature>,
  tokenUsageBySessionId?: Record<
    string,
    import('@industry/common/session/settings').TokenUsage
  >,
  nowMs: number = Date.now()
): WorkerSessionDisplay[] {
  const sessions: WorkerSessionDisplay[] = [];
  const workerReferences = deriveMissionWorkerSessionReferences({
    features,
    includeFeatureWorkerSessionIds: false,
    includeProgressLogWorkerSessionIds: false,
    progressLog,
    workerSessionIds,
    workerStates,
  });
  const { timingBySessionId, terminalStatusBySessionId } =
    buildWorkerTimingInfo(progressLog, workerStates);

  for (let i = 0; i < workerReferences.length; i++) {
    const workerReference = workerReferences[i];
    if (!workerReference) {
      continue;
    }

    const sessionId = workerReference.sessionId;
    const state = workerStates?.[sessionId];
    const featureId = workerReference.featureId;
    const featureDescription = workerReference.feature?.description;

    const timingInfo = timingBySessionId.get(sessionId);
    const terminalStatus = terminalStatusBySessionId.get(sessionId);

    let status: WorkerDisplayStatus;
    if (terminalStatus) {
      status = terminalStatus;
    } else if (timingInfo?.lifecycleState === 'paused') {
      status = 'paused';
    } else if (state?.completedAt) {
      if (state.exitCode === 0) {
        status = 'success';
      } else if (state.exitCode === undefined) {
        status = 'partial';
      } else {
        status = 'failed';
      }
    } else {
      status = 'running';
    }

    const pausedAtMs =
      status === 'paused' ? (timingInfo?.activePauseStartedAtMs ?? null) : null;
    const startedAtMs =
      parseTimestamp(state?.startedAt) ?? timingInfo?.startedAtMs ?? null;
    const completedAtMs =
      parseTimestamp(state?.completedAt) ?? timingInfo?.terminalAtMs ?? null;
    const endedAtMs =
      completedAtMs ?? (status === 'paused' ? (pausedAtMs ?? nowMs) : null);
    const totalPausedMs = timingInfo?.totalPausedMs ?? 0;
    const durationMs =
      startedAtMs === null
        ? null
        : Math.max(0, (endedAtMs ?? nowMs) - startedAtMs - totalPausedMs);
    const duration =
      durationMs === null ? '-' : formatDurationCompact(durationMs);
    const activeDurationAnchorMs =
      startedAtMs === null ? null : startedAtMs + totalPausedMs;

    const usage = tokenUsageBySessionId?.[sessionId];
    const industryCreditDisplay =
      usage && (usage.industryCredits ?? 0) > 0
        ? formatMissionIndustryStandardCredits(usage)
        : '-';

    sessions.push({
      sessionId,
      shortId: sessionId.slice(0, 8),
      featureId,
      featureDescription,
      workerNumber: workerReference.workerNumber,
      startTime: formatStartTime(state?.startedAt),
      duration,
      status,
      industryCreditDisplay,
      startedAtMs,
      endedAtMs,
      activeDurationAnchorMs,
    });
  }

  return sessions;
}

export function orderWorkerSessionsForDisplay(
  sessions: WorkerSessionDisplay[]
): WorkerSessionDisplay[] {
  return [...sessions].sort((left, right) => {
    const leftIsActive =
      left.status === 'running' || left.status === 'paused' ? 1 : 0;
    const rightIsActive =
      right.status === 'running' || right.status === 'paused' ? 1 : 0;

    if (leftIsActive !== rightIsActive) {
      return rightIsActive - leftIsActive;
    }

    const leftStartedAtMs = left.startedAtMs ?? Number.NEGATIVE_INFINITY;
    const rightStartedAtMs = right.startedAtMs ?? Number.NEGATIVE_INFINITY;
    if (leftStartedAtMs !== rightStartedAtMs) {
      return rightStartedAtMs - leftStartedAtMs;
    }

    return right.workerNumber - left.workerNumber;
  });
}

export function findLatestActiveWorkerSession(
  sessions: WorkerSessionDisplay[]
): WorkerSessionDisplay | null {
  return (
    sessions.find(
      (session) => session.status === 'running' || session.status === 'paused'
    ) ?? null
  );
}
