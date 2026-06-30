import { AutonomyLevel } from '@industry/drool-sdk-ext/protocol/shared';

import { clampAutonomyLevelToMax, getAllowedAutonomyLevels } from './helpers';

export function getNextAutonomyLevelInCycle(
  current: AutonomyLevel,
  maxAutonomyLevel?: AutonomyLevel
): AutonomyLevel {
  const cycleLevels = getAllowedAutonomyLevels(maxAutonomyLevel);
  const clamped = clampAutonomyLevelToMax(current, maxAutonomyLevel);
  const currentIndex = cycleLevels.indexOf(clamped);
  if (currentIndex === -1 || cycleLevels.length === 0) {
    return AutonomyLevel.Off;
  }
  return cycleLevels[(currentIndex + 1) % cycleLevels.length];
}
