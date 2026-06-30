import {
  getMissionProgressLogCreatedWorkerSessionId,
  getMissionProgressLogEntryFeatureId,
  getMissionProgressLogEntryWorkerSessionId,
  getMissionProgressLogWorkerStateUpdate,
} from './progressLog';

import type {
  DeriveMissionWorkerSessionReferencesParams,
  MissionWorkerFeature,
  MissionWorkerSessionReference,
} from './types';
import type {
  ProgressLogEntry,
  WorkerStateInfo,
} from '@industry/drool-sdk-ext/protocol/drool';

interface SessionIdCollector {
  addSessionId: (workerSessionId: string | null | undefined) => void;
  sessionIds: Set<string>;
}

interface FeatureWorkerSessionIndex<TFeature extends MissionWorkerFeature> {
  attemptByWorkerSessionId: Map<
    string,
    { attemptNumber: number; totalAttempts: number }
  >;
  featureById: Map<string, TFeature>;
  featureByWorkerSessionId: Map<string, TFeature>;
  featureOrderById: Map<string, number>;
}

interface ProgressLogWorkerSessionIndex {
  featureIdByWorkerSessionId: Map<string, string>;
  orderByWorkerSessionId: Map<string, number>;
  progressWorkerStates: Record<string, WorkerStateInfo>;
}

function createSessionIdCollector(rootSessionId?: string): SessionIdCollector {
  const sessionIds = new Set<string>();

  const addSessionId = (workerSessionId: string | null | undefined) => {
    if (!workerSessionId || workerSessionId === rootSessionId) {
      return;
    }
    sessionIds.add(workerSessionId);
  };

  return { addSessionId, sessionIds };
}

function indexFeatureWorkerSessions<TFeature extends MissionWorkerFeature>(
  features: TFeature[],
  addSessionId: SessionIdCollector['addSessionId'],
  includeFeatureWorkerSessionIds: boolean
): FeatureWorkerSessionIndex<TFeature> {
  const featureById = new Map(features.map((feature) => [feature.id, feature]));
  const featureOrderById = new Map(
    features.map((feature, index) => [feature.id, index])
  );
  const featureByWorkerSessionId = new Map<string, TFeature>();
  const attemptByWorkerSessionId = new Map<
    string,
    { attemptNumber: number; totalAttempts: number }
  >();

  features.forEach((feature) => {
    const featureWorkerSessionIds = feature.workerSessionIds ?? [];
    featureWorkerSessionIds.forEach((workerSessionId, workerIndex) => {
      featureByWorkerSessionId.set(workerSessionId, feature);
      attemptByWorkerSessionId.set(workerSessionId, {
        attemptNumber: workerIndex + 1,
        totalAttempts: featureWorkerSessionIds.length,
      });

      if (includeFeatureWorkerSessionIds) {
        addSessionId(workerSessionId);
      }
    });
  });

  return {
    attemptByWorkerSessionId,
    featureById,
    featureByWorkerSessionId,
    featureOrderById,
  };
}

function indexProgressLogWorkerSessions({
  addSessionId,
  includeFailedProgressLogWorkerSessionIds,
  includeProgressLogWorkerSessionIds,
  progressLog,
}: {
  addSessionId: SessionIdCollector['addSessionId'];
  includeFailedProgressLogWorkerSessionIds: boolean;
  includeProgressLogWorkerSessionIds: boolean;
  progressLog: ProgressLogEntry[];
}): ProgressLogWorkerSessionIndex {
  const featureIdByWorkerSessionId = new Map<string, string>();
  const orderByWorkerSessionId = new Map<string, number>();
  const progressWorkerStates: Record<string, WorkerStateInfo> = {};

  progressLog.forEach((entry) => {
    const workerSessionId = getMissionProgressLogEntryWorkerSessionId(entry);
    const workerStateUpdate = getMissionProgressLogWorkerStateUpdate(
      entry,
      workerSessionId ? progressWorkerStates[workerSessionId] : undefined
    );

    if (workerStateUpdate) {
      progressWorkerStates[workerStateUpdate.workerSessionId] =
        workerStateUpdate.workerState;
    }

    if (workerSessionId && !orderByWorkerSessionId.has(workerSessionId)) {
      orderByWorkerSessionId.set(workerSessionId, orderByWorkerSessionId.size);
    }

    const featureId = getMissionProgressLogEntryFeatureId(entry);
    if (workerSessionId && featureId) {
      featureIdByWorkerSessionId.set(workerSessionId, featureId);
    }

    if (includeProgressLogWorkerSessionIds) {
      addSessionId(
        getMissionProgressLogCreatedWorkerSessionId(entry, {
          includeFailedProgressLogWorkerSessionIds,
        })
      );
    }
  });

  return {
    featureIdByWorkerSessionId,
    orderByWorkerSessionId,
    progressWorkerStates,
  };
}

function createWorkerSessionReference<TFeature extends MissionWorkerFeature>({
  featureIndex,
  progressIndex,
  sessionId,
  workerIndex,
  workerStates,
}: {
  featureIndex: FeatureWorkerSessionIndex<TFeature>;
  progressIndex: ProgressLogWorkerSessionIndex;
  sessionId: string;
  workerIndex: number;
  workerStates: Record<string, WorkerStateInfo>;
}): MissionWorkerSessionReference<TFeature> {
  const progressFeatureId =
    progressIndex.featureIdByWorkerSessionId.get(sessionId);
  const feature =
    featureIndex.featureByWorkerSessionId.get(sessionId) ??
    (progressFeatureId
      ? featureIndex.featureById.get(progressFeatureId)
      : undefined);
  const featureId = feature?.id ?? progressFeatureId;
  const attempt = featureIndex.attemptByWorkerSessionId.get(sessionId);
  const workerState =
    workerStates[sessionId] ?? progressIndex.progressWorkerStates[sessionId];

  return {
    sessionId,
    workerNumber: workerIndex + 1,
    ...(featureId ? { featureId } : {}),
    ...(feature ? { feature } : {}),
    ...(workerState ? { workerState } : {}),
    featureOrder: feature
      ? (featureIndex.featureOrderById.get(feature.id) ??
        Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER,
    sessionOrder:
      progressIndex.orderByWorkerSessionId.get(sessionId) ??
      Number.MAX_SAFE_INTEGER,
    attemptNumber: attempt?.attemptNumber ?? 1,
    totalAttempts: attempt?.totalAttempts ?? 1,
  };
}

export function deriveMissionWorkerSessionReferences<
  TFeature extends MissionWorkerFeature,
>({
  features,
  progressLog,
  workerSessionIds = [],
  workerStates = {},
  rootSessionId,
  includeFeatureWorkerSessionIds = true,
  includeProgressLogWorkerSessionIds = true,
  includeFailedProgressLogWorkerSessionIds = false,
}: DeriveMissionWorkerSessionReferencesParams<TFeature>): Array<
  MissionWorkerSessionReference<TFeature>
> {
  const { addSessionId, sessionIds } = createSessionIdCollector(rootSessionId);

  workerSessionIds.forEach(addSessionId);
  Object.keys(workerStates).forEach(addSessionId);

  const featureIndex = indexFeatureWorkerSessions(
    features,
    addSessionId,
    includeFeatureWorkerSessionIds
  );
  const progressIndex = indexProgressLogWorkerSessions({
    addSessionId,
    includeFailedProgressLogWorkerSessionIds,
    includeProgressLogWorkerSessionIds,
    progressLog,
  });

  return Array.from(sessionIds).map((sessionId, workerIndex) =>
    createWorkerSessionReference({
      featureIndex,
      progressIndex,
      sessionId,
      workerIndex,
      workerStates,
    })
  );
}
