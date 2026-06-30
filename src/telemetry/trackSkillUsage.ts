import { Metrics } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';

import type { TrackSkillUsageInput } from '@/telemetry/types';

export function trackSkillUsage({
  skillName,
  location,
  activationSource,
}: TrackSkillUsageInput): void {
  Metrics.addToCounter(Metric.SKILL_INVOKED_COUNT, 1, {
    skillName,
    location: location ?? 'unknown',
    activationSource,
  });
}
