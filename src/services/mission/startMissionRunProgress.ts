import {
  FeatureStatus,
  MissionState,
  type MissionFeature,
  type ProgressLogEntry,
  type ToolStreamingUpdate,
} from '@industry/drool-sdk-ext/protocol/drool';

import { getMissionActiveElapsedMs } from '@/components/mission-control/utils/missionElapsedTime';
import { START_MISSION_RUN_PROGRESS_KIND } from '@/services/mission/constants';
import { getMissionProgressCounts } from '@/services/mission/missionProgressCounts';
import type {
  StartMissionRunFeaturePreview,
  StartMissionRunProgressDetails,
} from '@/services/mission/types';

import type { MissionModelSettings } from '@industry/common/settings';

export function getWorkerSessionIdForFeature(
  feature: MissionFeature | null | undefined
): string | null {
  return (
    feature?.currentWorkerSessionId ?? feature?.workerSessionIds?.at(-1) ?? null
  );
}

function toFeaturePreview(
  feature: MissionFeature | undefined
): StartMissionRunFeaturePreview | undefined {
  if (!feature) {
    return undefined;
  }

  return {
    id: feature.id,
    status: feature.status,
    ...(feature.milestone ? { milestone: feature.milestone } : {}),
    ...(feature.description ? { description: feature.description } : {}),
  };
}

function buildFeatureWindow(
  features: MissionFeature[]
): StartMissionRunProgressDetails['featureWindow'] {
  if (features.length === 0) {
    return { focus: null };
  }

  const inProgressIndex = features.findIndex(
    (feature) => feature.status === FeatureStatus.InProgress
  );
  const pendingIndex = features.findIndex(
    (feature) => feature.status === FeatureStatus.Pending
  );
  const focusIndex =
    inProgressIndex !== -1
      ? inProgressIndex
      : pendingIndex !== -1
        ? pendingIndex
        : features.length - 1;
  const previous = toFeaturePreview(features[focusIndex - 1]);
  const focus = toFeaturePreview(features[focusIndex]) ?? null;
  const next = toFeaturePreview(features[focusIndex + 1]);

  return {
    ...(previous ? { previous } : {}),
    focus,
    ...(next ? { next } : {}),
  };
}

export function buildStartMissionRunProgressSnapshot(params: {
  state: MissionState;
  updatedAt?: string;
  features: MissionFeature[];
  progressLog: ProgressLogEntry[];
  missionSettings?: MissionModelSettings | null;
  now?: number;
}): StartMissionRunProgressDetails {
  const now = params.now ?? Date.now();
  const inProgressFeature =
    params.features.find(
      (feature) => feature.status === FeatureStatus.InProgress
    ) ?? null;
  const currentWorkerSessionId =
    getWorkerSessionIdForFeature(inProgressFeature);
  const counts = getMissionProgressCounts({
    features: params.features,
    missionSettings: params.missionSettings,
  });
  const elapsedMs = getMissionActiveElapsedMs(
    {
      state: params.state,
      progressLog: params.progressLog,
    },
    now
  );
  return {
    kind: START_MISSION_RUN_PROGRESS_KIND,
    state: params.state,
    ...(params.updatedAt ? { updatedAt: params.updatedAt } : {}),
    ...(elapsedMs !== null
      ? {
          activeTime: {
            elapsedMs,
            measuredAtMs: now,
          },
        }
      : {}),
    counts,
    featureWindow: buildFeatureWindow(params.features),
    currentWorkerId: currentWorkerSessionId,
  };
}

export function createStartMissionRunProgressUpdate(
  snapshot: StartMissionRunProgressDetails
): ToolStreamingUpdate {
  return {
    type: 'status',
    toolName: 'StartMissionRun',
    details: JSON.stringify(snapshot),
    timestamp: Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isStartMissionRunProgressSnapshot(
  value: unknown
): value is StartMissionRunProgressDetails {
  return (
    isRecord(value) &&
    value.kind === START_MISSION_RUN_PROGRESS_KIND &&
    typeof value.state === 'string' &&
    isRecord(value.counts) &&
    isRecord(value.featureWindow) &&
    (typeof value.currentWorkerId === 'string' ||
      value.currentWorkerId === null)
  );
}

export function getLatestStartMissionRunProgressSnapshot(
  progressUpdates: ToolStreamingUpdate[] | undefined
): StartMissionRunProgressDetails | null {
  for (let index = (progressUpdates?.length ?? 0) - 1; index >= 0; index--) {
    const details = progressUpdates?.[index]?.details;
    if (!details) {
      continue;
    }

    try {
      const parsed = JSON.parse(details) as unknown;
      if (isStartMissionRunProgressSnapshot(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}
