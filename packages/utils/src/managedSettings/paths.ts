/**
 * System-wide managed settings paths.
 *
 * These directories are reserved for IT/MDM-deployed Industry configuration.
 * The locations are intentionally hardcoded so administrators can rely on a
 * stable, well-known location for `settings.json`. Do not introduce env-var
 * overrides here — tests should mock this module instead.
 *
 * Deployment locations:
 * - macOS:        /Library/Application Support/Industry/
 * - Linux + WSL:  /etc/industry/
 * - Windows:      C:\Program Files\Industry\
 */
import * as path from 'path';

import {
  SYSTEM_MANAGED_DIR_DARWIN,
  SYSTEM_MANAGED_DIR_LINUX,
  SYSTEM_MANAGED_DIR_WIN32,
  SYSTEM_MANAGED_SETTINGS_FILENAME,
} from './constants';

function getSystemManagedDir(platform: NodeJS.Platform): string | null {
  switch (platform) {
    case 'darwin':
      return SYSTEM_MANAGED_DIR_DARWIN;
    case 'linux':
      return SYSTEM_MANAGED_DIR_LINUX;
    case 'win32':
      return SYSTEM_MANAGED_DIR_WIN32;
    default:
      return null;
  }
}

/**
 * Returns the absolute path to the system-managed `settings.json`, or `null`
 * if the platform is unsupported.
 */
export function getSystemManagedSettingsPath(
  platform: NodeJS.Platform = process.platform
): string | null {
  const dir = getSystemManagedDir(platform);
  if (!dir) return null;
  if (platform === 'win32') {
    return path.win32.join(dir, SYSTEM_MANAGED_SETTINGS_FILENAME);
  }
  return path.posix.join(dir, SYSTEM_MANAGED_SETTINGS_FILENAME);
}
