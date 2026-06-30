import {
  FeatureStatus,
  type MissionFeature,
} from '@industry/drool-sdk-ext/protocol/drool';

import type { FeatureDisplayResult } from '@/components/mission-control/types';

/**
 * Build the feature display list for the MainView features box.
 *
 * Display order (completed/cancelled at top):
 *   1. Completed and cancelled features (most recent, from bottom of features.json)
 *   2. In-progress feature(s)
 *   3. Pending features
 *
 * Completed/cancelled and pending get a roughly equal share of the available
 * slots (after accounting for in-progress). When the split is odd,
 * pending gets the extra slot.
 *
 * When pending features are hidden, 1 slot is reserved for a "+x more" line.
 */
export function buildFeatureDisplayList(
  features: MissionFeature[],
  maxVisible: number
): FeatureDisplayResult {
  const completed = features.filter(
    (f) =>
      f.status === FeatureStatus.Completed ||
      f.status === FeatureStatus.Cancelled
  );
  const inProgress = features.filter(
    (f) => f.status === FeatureStatus.InProgress
  );
  const pending = features.filter((f) => f.status === FeatureStatus.Pending);

  if (features.length <= maxVisible) {
    return {
      features: [...completed, ...inProgress, ...pending],
      hiddenPendingCount: 0,
    };
  }

  const fixedCount = inProgress.length;
  const sharedSlots = Math.max(0, maxVisible - fixedCount);

  // Split shared slots roughly equally, favoring pending, with spillover
  let pSlots = Math.min(pending.length, Math.ceil(sharedSlots / 2));
  let cSlots = Math.min(completed.length, sharedSlots - pSlots);
  const unused = sharedSlots - pSlots - cSlots;
  cSlots += Math.min(completed.length - cSlots, unused);
  pSlots += Math.min(pending.length - pSlots, sharedSlots - cSlots - pSlots);

  let hiddenPendingCount = pending.length - pSlots;

  // Reserve 1 slot for "+x more" line when pending features are hidden.
  // Don't reserve if it would leave 0 pending shown (pointless).
  if (hiddenPendingCount > 0 && pSlots >= 2) {
    pSlots -= 1;
    hiddenPendingCount = pending.length - pSlots;
  }

  const visibleCompleted =
    cSlots > 0 ? completed.slice(-cSlots) : ([] as MissionFeature[]);
  const visiblePending = pending.slice(0, pSlots);

  return {
    features: [...visibleCompleted, ...inProgress, ...visiblePending],
    hiddenPendingCount,
  };
}
