import {
  FeatureStatus,
  type MissionFeature,
} from '@industry/drool-sdk-ext/protocol/drool';

import { VALIDATION_SKILL_NAMES } from '@/skills/builtin/constants';

import type { MissionModelSettings } from '@industry/common/settings';

export function getMissionProgressCounts(params: {
  features: MissionFeature[];
  missionSettings?: MissionModelSettings | null;
}) {
  const validatorsPerMilestone =
    (params.missionSettings?.skipScrutiny ? 0 : 1) +
    (params.missionSettings?.skipUserTesting ? 0 : 1);
  const shouldEstimateValidation = validatorsPerMilestone > 0;
  const allMilestones = new Set<string>();
  const milestonesWithValidation = new Set<string>();
  let completed = 0;
  let cancelled = 0;

  for (const feature of params.features) {
    if (feature.status === FeatureStatus.Completed) {
      completed += 1;
    } else if (feature.status === FeatureStatus.Cancelled) {
      cancelled += 1;
    }

    if (!shouldEstimateValidation || !feature.milestone) {
      continue;
    }

    allMilestones.add(feature.milestone);
    if (
      feature.skillName &&
      VALIDATION_SKILL_NAMES.includes(feature.skillName)
    ) {
      milestonesWithValidation.add(feature.milestone);
    }
  }

  return {
    total: params.features.length,
    completed,
    cancelled,
    estimatedValidation: shouldEstimateValidation
      ? (allMilestones.size - milestonesWithValidation.size) *
        validatorsPerMilestone
      : 0,
  };
}
