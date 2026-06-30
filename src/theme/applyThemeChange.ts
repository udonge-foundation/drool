import { getSettingsService } from '@/services/SettingsService';
import { getThemeEngine } from '@/theme/ThemeEngine';

function applyTerminalColorOverride(enabled: boolean): void {
  const engine = getThemeEngine();
  engine.setOverrideTerminalColors(enabled);
  if (enabled) {
    engine.applyTheme();
  } else {
    engine.resetTerminalColors();
  }
}

export function applyThemeSelection(themeName: string): boolean {
  const engine = getThemeEngine();
  if (!engine.loadTheme(themeName)) return false;

  const settingsService = getSettingsService();
  applyTerminalColorOverride(settingsService.getOverrideTerminalColors());
  settingsService.updateSettings({ general: { theme: themeName } });
  return true;
}

export function applyOverrideTerminalColors(enabled: boolean): void {
  const settingsService = getSettingsService();

  settingsService.setOverrideTerminalColors(enabled);
  applyTerminalColorOverride(enabled);
}
