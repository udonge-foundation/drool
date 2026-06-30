import {
  AutonomyMode,
  type AutonomyLevel,
} from '@industry/drool-sdk-ext/protocol/shared';
import {
  clampAutonomyModeToMax,
  filterAutonomyModesByMax,
  isAutonomyModeAllowed,
} from '@industry/utils/autonomy';

import { AUTONOMY_MODE_ORDER } from '@/acp/session/constants';
import { getSettingsService } from '@/services/SettingsService';

export function getAllowedAcpAutonomyModes(
  maxAutonomyLevel:
    | AutonomyLevel
    | undefined = getSettingsService().getMaxAutonomyLevel()
): AutonomyMode[] {
  return filterAutonomyModesByMax(AUTONOMY_MODE_ORDER, maxAutonomyLevel);
}

export function isAcpAutonomyModeAllowed(
  mode: AutonomyMode,
  maxAutonomyLevel:
    | AutonomyLevel
    | undefined = getSettingsService().getMaxAutonomyLevel()
): boolean {
  return isAutonomyModeAllowed(mode, maxAutonomyLevel);
}

export function resolveAllowedAcpAutonomyMode(
  mode: AutonomyMode,
  maxAutonomyLevel:
    | AutonomyLevel
    | undefined = getSettingsService().getMaxAutonomyLevel()
): AutonomyMode {
  return clampAutonomyModeToMax(mode, maxAutonomyLevel);
}
