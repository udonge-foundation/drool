import { AutonomyLevel } from '@industry/drool-sdk-ext/protocol/shared';

const AUTONOMY_LEVEL_ORDER: readonly AutonomyLevel[] = [
  AutonomyLevel.Off,
  AutonomyLevel.Low,
  AutonomyLevel.Medium,
  AutonomyLevel.High,
];

export function autonomyLevelToNumber(
  level: AutonomyLevel | null | undefined
): number {
  switch (level) {
    case AutonomyLevel.Off:
    case null:
    case undefined:
      return 0;
    case AutonomyLevel.Low:
      return 1;
    case AutonomyLevel.Medium:
      return 2;
    case AutonomyLevel.High:
      return 3;
    default:
      return 0;
  }
}

export function isAutonomyLevelAllowed(
  level: AutonomyLevel,
  maxAutonomyLevel?: AutonomyLevel
): boolean {
  if (!maxAutonomyLevel) {
    return true;
  }

  return (
    autonomyLevelToNumber(level) <= autonomyLevelToNumber(maxAutonomyLevel)
  );
}

export function clampAutonomyLevelToMax(
  level: AutonomyLevel,
  maxAutonomyLevel?: AutonomyLevel
): AutonomyLevel {
  if (isAutonomyLevelAllowed(level, maxAutonomyLevel)) {
    return level;
  }

  return maxAutonomyLevel ?? level;
}

export function getAllowedAutonomyLevels(
  maxAutonomyLevel?: AutonomyLevel
): AutonomyLevel[] {
  if (!maxAutonomyLevel) {
    return [...AUTONOMY_LEVEL_ORDER];
  }

  return AUTONOMY_LEVEL_ORDER.filter((level) =>
    isAutonomyLevelAllowed(level, maxAutonomyLevel)
  );
}
