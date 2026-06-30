import { MAX_FEATURE_ATTEMPTS } from '@/services/mission/constants';
import type { Feature, MissionStateFile } from '@/services/mission/types';

export function getFeatureAttemptCount(
  feature: Pick<Feature, 'workerSessionIds'>
): number {
  return feature.workerSessionIds?.length ?? 0;
}

/**
 * Effective attempt cap for a feature: the default cap plus any bonus granted
 * (via `featureRetryBudgetBonus` in state.json) when the user resumed after a
 * retry-limit pause.
 */
export function getEffectiveMaxFeatureAttempts(
  featureId: string,
  state: MissionStateFile | null
): number {
  return (
    MAX_FEATURE_ATTEMPTS + (state?.featureRetryBudgetBonus?.[featureId] ?? 0)
  );
}
