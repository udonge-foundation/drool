/**
 * Constants for Mission Control components
 */

import type { McColorPalette } from '@/components/mission-control/types';
// eslint-disable-next-line industry/constants-file-organization
import { getThemeEngine } from '@/theme/ThemeEngine';

export const MISSION_CONTROL_HEADER_HEIGHT = 3;

/** Footer height: footer divider (├─┤) + footer hints row + bottom border (└─┘) */
export const MISSION_CONTROL_FOOTER_HEIGHT = 3;

export const MISSION_CONTROL_SCROLL_INPUT_STALE_AFTER_MS = 100;

/**
 * Mission Control color palette – always sourced from the ThemeEngine.
 */
export const MC_COLORS: McColorPalette = new Proxy({} as McColorPalette, {
  get(_target, prop: string) {
    return getThemeEngine().getMcColors()[prop as keyof McColorPalette];
  },
});
