import {
  MissionState,
  ProgressLogEntryType,
} from '@industry/drool-sdk-ext/protocol/drool';

import { MISSION_ELAPSED_TIMER_INTERVAL_MS } from './constants';

import type {
  MissionElapsedProgressEntry,
  MissionElapsedSnapshot,
} from './types';

const ACTIVE_MISSION_STATES = new Set<MissionState>([
  MissionState.Initializing,
  MissionState.Running,
  MissionState.OrchestratorTurn,
]);

type MissionElapsedTimerListener = () => void;

const missionElapsedTimerListeners = new Set<MissionElapsedTimerListener>();
let missionElapsedTimerInterval: ReturnType<typeof setInterval> | null = null;

function getProgressEntryTimestampMs(
  entry: MissionElapsedProgressEntry
): number | null {
  const timestampMs = new Date(entry.timestamp).getTime();
  return Number.isNaN(timestampMs) ? null : timestampMs;
}

function getMissionElapsedTimerSnapshot(nowMs = Date.now()): number {
  return Math.floor(nowMs / MISSION_ELAPSED_TIMER_INTERVAL_MS);
}

export function getMissionElapsedTimerNowMs(nowMs = Date.now()): number {
  return (
    getMissionElapsedTimerSnapshot(nowMs) * MISSION_ELAPSED_TIMER_INTERVAL_MS
  );
}

function emitMissionElapsedTimerTick(): void {
  missionElapsedTimerListeners.forEach((listener) => listener());
}

export function subscribeMissionElapsedTimer(
  onStoreChange: MissionElapsedTimerListener
): () => void {
  missionElapsedTimerListeners.add(onStoreChange);

  if (missionElapsedTimerInterval === null) {
    missionElapsedTimerInterval = setInterval(
      emitMissionElapsedTimerTick,
      MISSION_ELAPSED_TIMER_INTERVAL_MS
    );
  }

  return () => {
    missionElapsedTimerListeners.delete(onStoreChange);

    if (
      missionElapsedTimerListeners.size === 0 &&
      missionElapsedTimerInterval !== null
    ) {
      clearInterval(missionElapsedTimerInterval);
      missionElapsedTimerInterval = null;
    }
  };
}

export function isMissionStateTimingActive(state: MissionState): boolean {
  return ACTIVE_MISSION_STATES.has(state);
}

export function formatMissionElapsedTime(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return '0s';
  }

  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}

export function formatMissionElapsedClockTime(elapsedMs: number): string {
  const safeElapsedMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const totalSeconds = Math.floor(safeElapsedMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function getMissionActiveElapsedMs(
  snapshot: MissionElapsedSnapshot,
  nowMs = Date.now()
): number | null {
  let totalActiveMs = 0;
  let activeIntervalStartMs: number | null = null;
  let lastValidEntryTimestampMs: number | null = null;
  let sawExplicitActiveStart = false;

  for (const entry of snapshot.progressLog) {
    const timestampMs = getProgressEntryTimestampMs(entry);
    if (timestampMs === null) {
      continue;
    }

    lastValidEntryTimestampMs = timestampMs;

    switch (entry.type) {
      case ProgressLogEntryType.MissionRunStarted:
      case ProgressLogEntryType.MissionResumed:
        sawExplicitActiveStart = true;
        activeIntervalStartMs ??= timestampMs;
        break;
      case ProgressLogEntryType.MissionPaused:
        if (activeIntervalStartMs !== null) {
          totalActiveMs += Math.max(0, timestampMs - activeIntervalStartMs);
          activeIntervalStartMs = null;
        }
        break;
      default:
        break;
    }
  }

  const isMissionActive = isMissionStateTimingActive(snapshot.state);

  if (activeIntervalStartMs !== null) {
    const intervalEndMs = isMissionActive ? nowMs : lastValidEntryTimestampMs;
    if (intervalEndMs !== null) {
      totalActiveMs += Math.max(0, intervalEndMs - activeIntervalStartMs);
    }
  }

  if (!sawExplicitActiveStart) {
    return null;
  }

  return Math.max(0, totalActiveMs);
}
