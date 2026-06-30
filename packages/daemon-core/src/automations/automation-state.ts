/**
 * Automation state management for persistent per-automation state.
 *
 * This module provides persistent state tracking for automations that
 * survives daemon restarts. State lives at `./memory/state.json` inside
 * each automation directory and is co-owned with the agent (see
 * AutomationStateSchema in ./schemas.ts for the shared shape).
 *
 * Writes are merge-read-modify-write so daemon-managed fields do not
 * clobber agent-managed fields (and vice versa).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  AUTOMATION_MEMORY_DIR,
  AUTOMATION_STATE_FILE,
} from '@industry/common/automations';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { AutomationStateSchema } from './schemas';

import type { AutomationState } from './schemas';

// =============================================================================
// Path Helper
// =============================================================================

function getStateFilePath(automationPath: string): string {
  return path.join(
    automationPath,
    AUTOMATION_MEMORY_DIR,
    AUTOMATION_STATE_FILE
  );
}

/**
 * Type guard that narrows an unknown caught value to `{ code: string }`
 * (Node's errno shape) without relying on `as` type assertions.
 */
function hasErrnoCode(err: unknown): err is { code: string } {
  if (err === null || typeof err !== 'object' || !('code' in err)) {
    return false;
  }
  const code: unknown = err.code;
  return typeof code === 'string';
}

function extractErrnoCode(err: unknown): string | undefined {
  return hasErrnoCode(err) ? err.code : undefined;
}

/**
 * Resolve `fs.constants.O_NOFOLLOW` without an `as` cast. The constant is
 * defined on POSIX platforms but missing on Windows; when absent we fall
 * back to 0 (a no-op in the bitmask).
 */
function getONoFollow(): number {
  const constants: Record<string, number> = fs.constants;
  const value = constants.O_NOFOLLOW;
  return typeof value === 'number' ? value : 0;
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Read automation state from disk.
 *
 * @param automationPath - Path to the automation directory
 * @returns Parsed automation state, or null if file is missing or unparseable
 */
export function readAutomationState(
  automationPath: string
): AutomationState | null {
  const stateFilePath = getStateFilePath(automationPath);

  try {
    if (!fs.existsSync(stateFilePath)) {
      return null;
    }

    const content = fs.readFileSync(stateFilePath, 'utf-8');
    const parsed = AutomationStateSchema.safeParse(JSON.parse(content));

    if (!parsed.success) {
      logWarn('[automation-state] Failed to parse state file', {
        path: stateFilePath,
        errorMessage: parsed.error.message,
      });
      return null;
    }

    return parsed.data;
  } catch (err) {
    logWarn('[automation-state] Failed to read state file', {
      path: stateFilePath,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Write automation state to disk atomically.
 *
 * Merges the provided partial state with any existing file contents so the
 * daemon poller (which seeds lastRunAt + lastRunId on dispatch) doesn't
 * clobber agent-written fields (runCount, lastRunStatus) written when the
 * run completes -- and vice versa.
 *
 * Uses a write-to-temp-then-rename strategy to avoid partial writes.
 *
 * @param automationPath - Path to the automation directory
 * @param state - Partial state to merge into the persisted file
 */
export function writeAutomationState(
  automationPath: string,
  state: AutomationState
): void {
  const stateFilePath = getStateFilePath(automationPath);
  const memoryDir = path.dirname(stateFilePath);

  // Ensure memory directory exists so the write does not fail on a fresh
  // automation that hasn't been scaffolded yet.
  fs.mkdirSync(memoryDir, { recursive: true });

  // Refuse to write through a symlinked memory/ directory: a malicious
  // automation directory could otherwise redirect the temp write and cause
  // arbitrary file overwrite with the daemon's privileges.
  try {
    const dirStat = fs.lstatSync(memoryDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new MetaError(
        'Refusing to write automation state through non-regular directory',
        { path: memoryDir }
      );
    }
  } catch (lstatError) {
    const code = extractErrnoCode(lstatError);
    if (code !== 'ENOENT') {
      logWarn('[automation-state] lstat on memory/ failed', {
        path: memoryDir,
        cause: lstatError,
      });
      throw lstatError;
    }
  }

  // Merge with existing state so concurrent writers (daemon vs. agent)
  // preserve each other's fields.
  const existing = readAutomationState(automationPath) ?? {};
  const merged: AutomationState = { ...existing, ...state };

  // UUID-suffixed temp name avoids concurrent-writer collisions; O_EXCL +
  // O_NOFOLLOW refuse pre-existing files / symlinks at the temp path.
  const tempPath = `${stateFilePath}.${crypto.randomUUID()}.tmp`;
  const O_NOFOLLOW = getONoFollow();
  /* eslint-disable no-bitwise */
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    O_NOFOLLOW;
  /* eslint-enable no-bitwise */

  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, flags, 0o644);
    fs.writeFileSync(fd, JSON.stringify(merged, null, 2), 'utf-8');
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, stateFilePath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (closeError) {
        logWarn('[automation-state] Failed to close temp fd during cleanup', {
          cause: closeError,
        });
      }
    }
    // Clean up temp file if exists
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      const code = extractErrnoCode(cleanupError);
      if (code !== 'ENOENT') {
        logWarn('Failed to clean up temp file', { cause: cleanupError });
      }
    }
    throw err;
  }
}
