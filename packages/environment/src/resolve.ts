// Node.js-only resolution helpers. Uses process.cwd() and process.platform
// which are NOT available in Edge Runtime. For Edge-safe helpers, use
// resolve-universal.ts instead.

import { EnvironmentVariable } from './constants';
import { EnvironmentError } from './errors';

/**
 * Default shell by platform when no environment variable is set.
 */
const DEFAULT_SHELL_BY_PLATFORM: Record<string, string> = {
  darwin: '/bin/zsh',
  linux: '/bin/bash',
  win32: 'cmd.exe',
};

/**
 * Resolve the shell executable based on platform.
 *
 * Priority:
 * 1. TERMINAL_SHELL (Industry override for custom shells)
 * 2. SHELL (Unix standard)
 * 3. COMSPEC (Windows standard)
 * 4. Platform default (/bin/zsh on macOS, /bin/bash on Linux, cmd.exe on Windows)
 * 5. /bin/sh as final fallback
 */
export function resolveShell(): string {
  const result =
    process.env[EnvironmentVariable.TERMINAL_SHELL] ??
    process.env[EnvironmentVariable.SHELL] ??
    process.env[EnvironmentVariable.COMSPEC] ??
    DEFAULT_SHELL_BY_PLATFORM[process.platform];

  if (!result) {
    throw new EnvironmentError('Failed to resolve shell executable');
  }
  return result;
}

/**
 * Resolve the home directory based on platform.
 *
 * Priority:
 * 1. HOME (Unix standard)
 * 2. USERPROFILE (Windows standard)
 * 3. process.cwd() as fallback
 *
 * FIXME: This fallback to process.cwd() is not ideal since it's obscured in the naming of homedir, but this was the
 * original behavior as of commit 9ed802. We should improve this in the future.
 */
export function resolveHomeDir(): string {
  return (
    process.env[EnvironmentVariable.HOME] ??
    process.env[EnvironmentVariable.USERPROFILE] ??
    process.cwd()
  );
}
