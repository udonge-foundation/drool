/**
 * WSL (Windows Subsystem for Linux) detection utility.
 *
 * In WSL, process.platform returns 'linux' even though the host is Windows.
 * This utility detects WSL to enable Windows-like behavior (e.g., Ctrl+V paste)
 * when running inside WSL.
 */

import * as fs from 'fs';

// Cache the result since it won't change during runtime
let cachedIsWsl: boolean | null = null;
let cachedWslVariant: 'WSL1' | 'WSL2' | null | undefined;

/**
 * Synchronously checks if the current process is running inside WSL.
 *
 * Detection methods (in order of reliability):
 * 1. WSL_DISTRO_NAME environment variable (set by WSL)
 * 2. /proc/version containing "microsoft" or "WSL" (kernel identifier)
 *
 * @returns true if running in WSL, false otherwise
 */
export function isWsl(): boolean {
  if (cachedIsWsl !== null) {
    return cachedIsWsl;
  }

  // Only check on Linux - WSL reports as Linux
  if (process.platform !== 'linux') {
    cachedIsWsl = false;
    return false;
  }

  // Check WSL_DISTRO_NAME env var (most reliable, always set in WSL)
  if (process.env.WSL_DISTRO_NAME) {
    cachedIsWsl = true;
    return true;
  }

  // Fall back to /proc/version check
  try {
    const version = fs.readFileSync('/proc/version', 'utf8');
    cachedIsWsl = /microsoft|wsl/i.test(version);
  } catch {
    cachedIsWsl = false;
  }

  return cachedIsWsl;
}

/**
 * Returns true if the platform behaves like Windows for keyboard handling.
 * This includes native Windows and WSL (which uses Windows clipboard and terminal).
 */
export function isWindowsLike(): boolean {
  return process.platform === 'win32' || isWsl();
}

/**
 * Determine WSL major version. Returns null when not running inside WSL.
 *
 * Detection order:
 * 1. WSL_INTEROP env var — set on WSL2 only.
 * 2. /proc/version contents — "WSL2" literal indicates WSL2; capital-M
 *    "Microsoft" is the historical WSL1 marker (WSL2 uses lowercase
 *    "microsoft" via the upstream kernel patch).
 * 3. Default to WSL2 — today's dominant install — when uncertain.
 */
export function getWslVariant(): 'WSL1' | 'WSL2' | null {
  if (cachedWslVariant !== undefined) {
    return cachedWslVariant;
  }

  if (!isWsl()) {
    cachedWslVariant = null;
    return null;
  }

  if (process.env.WSL_INTEROP) {
    cachedWslVariant = 'WSL2';
    return cachedWslVariant;
  }

  try {
    const version = fs.readFileSync('/proc/version', 'utf8');
    if (/WSL2/i.test(version)) {
      cachedWslVariant = 'WSL2';
    } else if (/\bMicrosoft\b/.test(version)) {
      // Capital-M is the WSL1 marker. WSL2's upstream kernel uses
      // lowercase "microsoft" or "WSL2" verbatim.
      cachedWslVariant = 'WSL1';
    } else {
      cachedWslVariant = 'WSL2';
    }
  } catch {
    cachedWslVariant = 'WSL2';
  }

  return cachedWslVariant;
}
