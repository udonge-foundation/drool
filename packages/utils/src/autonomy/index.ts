import { ToolConfirmationOutcome } from '@industry/drool-sdk-ext/protocol/drool';
import {
  AutonomyLevel,
  AutonomyMode,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';

import { clampAutonomyLevelToMax, isAutonomyLevelAllowed } from './helpers';

export { getNextAutonomyLevelInCycle } from './cycleAutonomyLevel';
export {
  autonomyLevelToNumber,
  clampAutonomyLevelToMax,
  getAllowedAutonomyLevels,
  isAutonomyLevelAllowed,
} from './helpers';

export function autonomyLevelToModeForSelector(
  level: AutonomyLevel
): AutonomyMode {
  switch (level) {
    case AutonomyLevel.Low:
      return AutonomyMode.AutoLow;
    case AutonomyLevel.Medium:
      return AutonomyMode.AutoMedium;
    case AutonomyLevel.High:
      return AutonomyMode.AutoHigh;
    case AutonomyLevel.Off:
    default:
      return AutonomyMode.Normal;
  }
}

/**
 * Auto-approval semantics:
 * - Fallback mode/level are treated as Low
 * - Off maps to AutoLow
 */
export function autonomyModeToLevelForAutoApproval(
  mode: AutonomyMode
): AutonomyLevel {
  switch (mode) {
    case AutonomyMode.AutoMedium:
      return AutonomyLevel.Medium;
    case AutonomyMode.AutoHigh:
      return AutonomyLevel.High;
    case AutonomyMode.AutoLow:
    default:
      return AutonomyLevel.Low;
  }
}

export function autonomyLevelToModeForAutoApproval(
  level: AutonomyLevel
): AutonomyMode {
  switch (level) {
    case AutonomyLevel.Medium:
      return AutonomyMode.AutoMedium;
    case AutonomyLevel.High:
      return AutonomyMode.AutoHigh;
    case AutonomyLevel.Off:
    case AutonomyLevel.Low:
    default:
      return AutonomyMode.AutoLow;
  }
}

/**
 * Derive AutonomyMode from DroolInteractionMode and AutonomyLevel
 */
export function deriveAutonomyMode(
  mode: DroolInteractionMode,
  level: AutonomyLevel
): AutonomyMode {
  if (mode === DroolInteractionMode.Spec) {
    return AutonomyMode.Spec;
  }
  switch (level) {
    case AutonomyLevel.Off:
      return AutonomyMode.Normal;
    case AutonomyLevel.Low:
      return AutonomyMode.AutoLow;
    case AutonomyLevel.Medium:
      return AutonomyMode.AutoMedium;
    case AutonomyLevel.High:
      return AutonomyMode.AutoHigh;
    default:
      return AutonomyMode.Normal;
  }
}

/**
 * Extract DroolInteractionMode and AutonomyLevel from legacy AutonomyMode
 */
export function parseAutonomyMode(autonomyMode: AutonomyMode): {
  mode: DroolInteractionMode;
  level: AutonomyLevel;
} {
  switch (autonomyMode) {
    case AutonomyMode.Spec:
      return { mode: DroolInteractionMode.Spec, level: AutonomyLevel.Off };
    case AutonomyMode.AutoLow:
      return { mode: DroolInteractionMode.Auto, level: AutonomyLevel.Low };
    case AutonomyMode.AutoMedium:
      return { mode: DroolInteractionMode.Auto, level: AutonomyLevel.Medium };
    case AutonomyMode.AutoHigh:
      return { mode: DroolInteractionMode.Auto, level: AutonomyLevel.High };
    case AutonomyMode.Normal:
    default:
      return { mode: DroolInteractionMode.Auto, level: AutonomyLevel.Off };
  }
}

export function isAutonomyModeAllowed(
  autonomyMode: AutonomyMode,
  maxAutonomyLevel?: AutonomyLevel
): boolean {
  const { level } = parseAutonomyMode(autonomyMode);
  return isAutonomyLevelAllowed(level, maxAutonomyLevel);
}

export function clampAutonomyModeToMax(
  autonomyMode: AutonomyMode,
  maxAutonomyLevel?: AutonomyLevel
): AutonomyMode {
  if (isAutonomyModeAllowed(autonomyMode, maxAutonomyLevel)) {
    return autonomyMode;
  }

  const parsed = parseAutonomyMode(autonomyMode);
  const clampedLevel = clampAutonomyLevelToMax(parsed.level, maxAutonomyLevel);
  return deriveAutonomyMode(parsed.mode, clampedLevel);
}

export function filterAutonomyModesByMax(
  modes: readonly AutonomyMode[],
  maxAutonomyLevel?: AutonomyLevel
): AutonomyMode[] {
  return modes.filter((mode) => isAutonomyModeAllowed(mode, maxAutonomyLevel));
}

export function hasDecoupledInteractionSettings(settings: {
  interactionMode?: DroolInteractionMode;
  autonomyLevel?: AutonomyLevel;
}): boolean {
  return (
    settings.interactionMode !== undefined ||
    settings.autonomyLevel !== undefined
  );
}

export function resolveInteractionSettingsWithLegacyFallback(settings: {
  interactionMode?: DroolInteractionMode;
  autonomyLevel?: AutonomyLevel;
  autonomyMode?: AutonomyMode;
}): {
  interactionMode?: DroolInteractionMode;
  autonomyLevel?: AutonomyLevel;
} {
  const { interactionMode, autonomyLevel, autonomyMode } = settings;

  if (hasDecoupledInteractionSettings({ interactionMode, autonomyLevel })) {
    const parsedLegacy = autonomyMode ? parseAutonomyMode(autonomyMode) : null;
    return {
      interactionMode: interactionMode ?? parsedLegacy?.mode,
      autonomyLevel: autonomyLevel ?? parsedLegacy?.level,
    };
  }

  if (!autonomyMode) {
    return {};
  }

  const parsed = parseAutonomyMode(autonomyMode);
  return {
    interactionMode: parsed.mode,
    autonomyLevel: parsed.level,
  };
}

export function resolveLegacyCompatibleAutonomyMode(settings: {
  interactionMode?: DroolInteractionMode;
  autonomyLevel?: AutonomyLevel;
  autonomyMode?: AutonomyMode;
}): AutonomyMode | undefined {
  if (settings.autonomyMode !== undefined) {
    return settings.autonomyMode;
  }

  if (
    settings.interactionMode === undefined ||
    settings.autonomyLevel === undefined
  ) {
    return undefined;
  }

  return deriveAutonomyMode(settings.interactionMode, settings.autonomyLevel);
}

/** Check whether an outcome is any new-session handoff variant. */
export function isNewSessionOutcome(outcome: ToolConfirmationOutcome): boolean {
  return (
    outcome === ToolConfirmationOutcome.ProceedNewSession ||
    outcome === ToolConfirmationOutcome.ProceedNewSessionLow ||
    outcome === ToolConfirmationOutcome.ProceedNewSessionMedium ||
    outcome === ToolConfirmationOutcome.ProceedNewSessionHigh
  );
}

/** Map a new-session outcome to its autonomy level (Off for the base variant). */
export function newSessionOutcomeToAutonomyLevel(
  outcome: ToolConfirmationOutcome
): AutonomyLevel {
  switch (outcome) {
    case ToolConfirmationOutcome.ProceedNewSessionLow:
      return AutonomyLevel.Low;
    case ToolConfirmationOutcome.ProceedNewSessionMedium:
      return AutonomyLevel.Medium;
    case ToolConfirmationOutcome.ProceedNewSessionHigh:
      return AutonomyLevel.High;
    default:
      return AutonomyLevel.Off;
  }
}
