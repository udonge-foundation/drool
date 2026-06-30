import { computeNextRun } from './schedule';

import type { AutomationSchedule } from '@industry/common/automations';

export function computeNextRunISO(
  schedule: AutomationSchedule,
  isPaused: boolean,
  fromDate: Date = new Date()
): string | undefined {
  if (isPaused) {
    return undefined;
  }

  const nextRun = computeNextRun(schedule, fromDate);
  return nextRun?.toISOString();
}
