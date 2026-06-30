import {
  ProgressLogEntryType,
  type ProgressLogEntry,
  type WorkerStateInfo,
} from '@industry/drool-sdk-ext/protocol/drool';

export function getMissionProgressLogEntryWorkerSessionId(
  entry: ProgressLogEntry
): string | null {
  switch (entry.type) {
    case ProgressLogEntryType.WorkerStarted:
    case ProgressLogEntryType.WorkerSelectedFeature:
    case ProgressLogEntryType.WorkerCompleted:
    case ProgressLogEntryType.WorkerPaused:
      return entry.workerSessionId;
    case ProgressLogEntryType.WorkerFailed:
      return entry.workerSessionId ?? null;
    case ProgressLogEntryType.MissionAccepted:
    case ProgressLogEntryType.MissionPaused:
    case ProgressLogEntryType.MissionResumed:
    case ProgressLogEntryType.MissionRunStarted:
    case ProgressLogEntryType.HandoffItemsDismissed:
    case ProgressLogEntryType.MilestoneValidationTriggered:
      return null;
    default: {
      const exhaustiveCheck: never = entry;
      return exhaustiveCheck;
    }
  }
}

export function getMissionProgressLogNotification(
  entry: ProgressLogEntry
): { key: string; workerSessionId: string } | null {
  switch (entry.type) {
    case ProgressLogEntryType.WorkerCompleted:
      return {
        key: `${entry.timestamp}-${entry.type}-${entry.workerSessionId}-${entry.featureId}`,
        workerSessionId: entry.workerSessionId,
      };
    case ProgressLogEntryType.WorkerFailed: {
      if (!entry.workerSessionId) {
        return null;
      }

      return {
        key: `${entry.timestamp}-${entry.type}-${entry.spawnId}-${entry.workerSessionId}`,
        workerSessionId: entry.workerSessionId,
      };
    }
    case ProgressLogEntryType.MissionAccepted:
    case ProgressLogEntryType.MissionPaused:
    case ProgressLogEntryType.MissionResumed:
    case ProgressLogEntryType.MissionRunStarted:
    case ProgressLogEntryType.WorkerStarted:
    case ProgressLogEntryType.WorkerSelectedFeature:
    case ProgressLogEntryType.WorkerPaused:
    case ProgressLogEntryType.HandoffItemsDismissed:
    case ProgressLogEntryType.MilestoneValidationTriggered:
      return null;
    default: {
      const exhaustiveCheck: never = entry;
      return exhaustiveCheck;
    }
  }
}

export function getMissionProgressLogPausedWorkerSessionIds(
  progressLog: ProgressLogEntry[]
): Set<string> {
  const pausedWorkerSessionIds = new Set<string>();

  for (const entry of progressLog) {
    switch (entry.type) {
      case ProgressLogEntryType.WorkerPaused:
        pausedWorkerSessionIds.add(entry.workerSessionId);
        break;
      case ProgressLogEntryType.WorkerStarted:
      case ProgressLogEntryType.WorkerSelectedFeature:
      case ProgressLogEntryType.WorkerCompleted:
        pausedWorkerSessionIds.delete(entry.workerSessionId);
        break;
      case ProgressLogEntryType.WorkerFailed:
        if (entry.workerSessionId) {
          pausedWorkerSessionIds.delete(entry.workerSessionId);
        }
        break;
      case ProgressLogEntryType.MissionResumed:
        if (entry.resumeWorkerSessionId) {
          pausedWorkerSessionIds.delete(entry.resumeWorkerSessionId);
        }
        break;
      case ProgressLogEntryType.MissionAccepted:
      case ProgressLogEntryType.MissionPaused:
      case ProgressLogEntryType.MissionRunStarted:
      case ProgressLogEntryType.HandoffItemsDismissed:
      case ProgressLogEntryType.MilestoneValidationTriggered:
        break;
      default: {
        const exhaustiveCheck: never = entry;
        return exhaustiveCheck;
      }
    }
  }

  return pausedWorkerSessionIds;
}

export function getMissionProgressLogCreatedWorkerSessionId(
  entry: ProgressLogEntry,
  {
    includeFailedProgressLogWorkerSessionIds = false,
  }: { includeFailedProgressLogWorkerSessionIds?: boolean } = {}
): string | null {
  if (
    entry.type === ProgressLogEntryType.WorkerFailed &&
    !includeFailedProgressLogWorkerSessionIds
  ) {
    return null;
  }

  return getMissionProgressLogEntryWorkerSessionId(entry);
}

export function getMissionProgressLogEntryFeatureId(
  entry: ProgressLogEntry
): string | null {
  switch (entry.type) {
    case ProgressLogEntryType.WorkerStarted:
    case ProgressLogEntryType.WorkerPaused:
      return entry.featureId ?? null;
    case ProgressLogEntryType.WorkerSelectedFeature:
    case ProgressLogEntryType.WorkerCompleted:
    case ProgressLogEntryType.MilestoneValidationTriggered:
      return entry.featureId;
    case ProgressLogEntryType.WorkerFailed:
    case ProgressLogEntryType.MissionAccepted:
    case ProgressLogEntryType.MissionPaused:
    case ProgressLogEntryType.MissionResumed:
    case ProgressLogEntryType.MissionRunStarted:
    case ProgressLogEntryType.HandoffItemsDismissed:
      return null;
    default: {
      const exhaustiveCheck: never = entry;
      return exhaustiveCheck;
    }
  }
}

export function getMissionProgressLogWorkerStateUpdate(
  entry: ProgressLogEntry,
  existing?: WorkerStateInfo
): { workerSessionId: string; workerState: WorkerStateInfo } | null {
  const workerSessionId = getMissionProgressLogEntryWorkerSessionId(entry);
  if (!workerSessionId) {
    return null;
  }

  switch (entry.type) {
    case ProgressLogEntryType.WorkerStarted:
    case ProgressLogEntryType.WorkerSelectedFeature:
    case ProgressLogEntryType.WorkerPaused:
      return {
        workerSessionId,
        workerState: {
          ...existing,
          startedAt: existing?.startedAt ?? entry.timestamp,
        },
      };
    case ProgressLogEntryType.WorkerCompleted:
      return {
        workerSessionId,
        workerState: {
          ...existing,
          completedAt: entry.timestamp,
          exitCode: entry.exitCode,
          startedAt: existing?.startedAt ?? entry.timestamp,
        },
      };
    case ProgressLogEntryType.WorkerFailed:
      return {
        workerSessionId,
        workerState: {
          ...existing,
          completedAt: entry.timestamp,
          ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
          startedAt: existing?.startedAt ?? entry.timestamp,
        },
      };
    case ProgressLogEntryType.MissionAccepted:
    case ProgressLogEntryType.MissionPaused:
    case ProgressLogEntryType.MissionResumed:
    case ProgressLogEntryType.MissionRunStarted:
    case ProgressLogEntryType.HandoffItemsDismissed:
    case ProgressLogEntryType.MilestoneValidationTriggered:
      return null;
    default: {
      const exhaustiveCheck: never = entry;
      return exhaustiveCheck;
    }
  }
}
