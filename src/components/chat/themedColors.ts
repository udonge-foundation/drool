import type { ColorPalette } from '@/components/chat/types';
import { getThemeEngine } from '@/theme/ThemeEngine';

/**
 * Get the color palette for the current terminal theme.
 * Colors always come from the ThemeEngine (including the built-in
 * industry-dark / industry-light themes).
 */
export function getThemedColors(): ColorPalette {
  return getThemeEngine().getColors();
}

// Re-export for backwards compatibility - uses themed colors at runtime
export const COLORS = new Proxy({} as ColorPalette, {
  get(_target, prop) {
    return getThemedColors()[prop as keyof ColorPalette];
  },
});
