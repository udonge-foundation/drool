/**
 * System-wide managed settings deployment paths.
 *
 * Hardcoded so IT/MDM administrators can rely on a stable, well-known
 * location for `settings.json`. Do not introduce env-var overrides — tests
 * should mock `getSystemManagedSettingsPath` instead.
 */

export const SYSTEM_MANAGED_DIR_DARWIN = '/Library/Application Support/Industry';
export const SYSTEM_MANAGED_DIR_LINUX = '/etc/industry';
export const SYSTEM_MANAGED_DIR_WIN32 = 'C:\\Program Files\\Industry';

export const SYSTEM_MANAGED_SETTINGS_FILENAME = 'settings.json';
