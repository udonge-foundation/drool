import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

import { getIndustryHomeOverride } from './environment';

import type { DroolCommand } from './types';

export { getIndustryHomeOverride } from './environment';

/**
 * Returns INDUSTRY_DROOL_BINARY if it is set and points at an existing file.
 * Falls back to returning `undefined` when the env var is unset, empty, or
 * refers to a path that no longer exists (e.g. a preserved-binary tmp dir
 * that was cleaned up or swept by the OS). Callers should then fall back to
 * their default resolution logic.
 */
function getExistingIndustryDroolBinary(): string | undefined {
  // eslint-disable-next-line industry/no-direct-process-env -- PLT-76: migrated from file-level disable
  const binary = process.env.INDUSTRY_DROOL_BINARY;
  if (!binary) {
    return undefined;
  }
  if (!existsSync(binary)) {
    return undefined;
  }
  return binary;
}

/**
 * Get the industry home directory, respecting the INDUSTRY_HOME_OVERRIDE environment variable.
 * This is useful for testing and running cli in isolated environments.
 */
export function getIndustryHome(): string {
  return getIndustryHomeOverride() || homedir();
}

export type { DroolCommand } from './types';

/**
 * Resolves the drool binary path for spawning subprocesses that need a single
 * executable name (e.g. daemon spawning, SSH proxy commands).
 *
 * Priority:
 * 1. INDUSTRY_DROOL_BINARY env var (set by wrapper scripts), if the referenced
 *    file still exists. A preserved-binary tmp path can disappear mid-session
 *    (e.g. OS tmp sweeper, manual cleanup) so we fall through if missing.
 * 2. If running as a drool binary (name includes 'drool'), use that same binary.
 * 3. Otherwise, fall back to drool-dev in development mode, drool in production.
 */
export function resolveDroolBinary(isDevelopment: boolean): string {
  const overrideBinary = getExistingIndustryDroolBinary();
  if (overrideBinary) {
    return overrideBinary;
  }

  const execName = path.basename(process.execPath);

  if (execName.includes('drool')) {
    return process.execPath;
  }

  return isDevelopment ? 'drool-dev' : 'drool';
}

/**
 * Resolves the full command needed to spawn a drool child process (exec runner).
 *
 * When running from source via a JS runtime (bun/node), returns the runtime
 * executable with the source entry point as a prefix arg. This ensures the child
 * process runs from the same source tree as the parent, avoiding worktree
 * mismatches and allowing env vars to propagate without wrapper scrubbing.
 *
 * In production or when running via a drool wrapper script, falls back to the
 * single binary path with no prefix args.
 */
export function resolveDroolCommand(isDevelopment: boolean): DroolCommand {
  const overrideBinary = getExistingIndustryDroolBinary();
  if (overrideBinary) {
    return { execPath: overrideBinary, prefixArgs: [] };
  }

  const execName = path.basename(process.execPath);

  if (execName.includes('drool')) {
    return { execPath: process.execPath, prefixArgs: [] };
  }

  // Running from source via bun -- resolve the entry point from the current
  // checkout so child processes use the same source tree as the parent.
  if (isDevelopment && process.argv[1]) {
    return {
      execPath: process.execPath,
      prefixArgs: [process.argv[1]],
    };
  }

  return {
    execPath: isDevelopment ? 'drool-dev' : 'drool',
    prefixArgs: [],
  };
}
