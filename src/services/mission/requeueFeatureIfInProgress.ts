import { FeatureStatus } from '@industry/drool-sdk-ext/protocol/drool';

import type { MissionFileService } from '@/services/mission/MissionFileService';

export async function requeueFeatureIfInProgress(params: {
  missionFileService: MissionFileService;
  featureId: string | null | undefined;
  workerSessionId?: string | null;
}): Promise<void> {
  const { missionFileService, featureId, workerSessionId } = params;
  const requeueFeature = async (
    candidateFeatureId: string | null | undefined
  ): Promise<boolean> => {
    if (!candidateFeatureId) {
      return false;
    }

    const feature = await missionFileService.getFeature(candidateFeatureId);
    if (!feature || feature.status !== FeatureStatus.InProgress) {
      return false;
    }

    const featureLastWorker = feature.workerSessionIds?.at(-1) ?? null;
    const featureCurrentWorker =
      feature.currentWorkerSessionId ?? featureLastWorker;
    if (workerSessionId && featureCurrentWorker !== workerSessionId) {
      return false;
    }

    await missionFileService.updateFeature(candidateFeatureId, {
      status: FeatureStatus.Pending,
      currentWorkerSessionId: null,
    });
    return true;
  };

  if (await requeueFeature(featureId)) {
    return;
  }

  if (!workerSessionId) {
    return;
  }

  const featuresFile = await missionFileService.readFeatures();
  const matchingFeature = featuresFile?.features.find(
    (feature) =>
      feature.status === FeatureStatus.InProgress &&
      (feature.currentWorkerSessionId ?? feature.workerSessionIds?.at(-1)) ===
        workerSessionId
  );

  if (!matchingFeature) {
    return;
  }

  await requeueFeature(matchingFeature.id);
}
