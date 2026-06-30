import {
  formatMissionElapsedTime as formatSharedMissionElapsedTime,
  getMissionActiveElapsedMs as getSharedMissionActiveElapsedMs,
  getMissionElapsedTimerNowMs as getSharedMissionElapsedTimerNowMs,
  isMissionStateTimingActive as isSharedMissionStateTimingActive,
  subscribeMissionElapsedTimer as subscribeSharedMissionElapsedTimer,
} from '@industry/utils/mission';

import type {
  MissionState,
  MissionSnapshot,
} from '@industry/drool-sdk-ext/protocol/drool';

export function getMissionActiveElapsedMs(
  snapshot: Pick<MissionSnapshot, 'state' | 'progressLog'>,
  nowMs?: number
): number | null {
  return getSharedMissionActiveElapsedMs(snapshot, nowMs);
}

export function isMissionStateTimingActive(state: MissionState): boolean {
  return isSharedMissionStateTimingActive(state);
}

export function formatMissionElapsedTime(elapsedMs: number): string {
  return formatSharedMissionElapsedTime(elapsedMs);
}

export function getMissionElapsedTimerNowMs(): number {
  return getSharedMissionElapsedTimerNowMs();
}

export function subscribeMissionElapsedTimer(
  onStoreChange: () => void
): () => void {
  return subscribeSharedMissionElapsedTimer(onStoreChange);
}
