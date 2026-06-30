import { getThemeEngine } from '@/theme/ThemeEngine';
import { TerminalTheme } from '@/utils/terminalTheme/enums';

/**
 * Get the terminal theme based on the active Drool theme.
 */
export function getTerminalTheme(): TerminalTheme {
  return getThemeEngine().getActiveThemeAppearance() === 'light'
    ? TerminalTheme.Light
    : TerminalTheme.Dark;
}
