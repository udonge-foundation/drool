import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { logException, logInfo, logWarn } from '@industry/logging';

import { hasUncommittedChanges } from './worktree';

import type { CleanupWorktreeOptions, WorktreeSessionInfo } from './types';

const execFileAsync = promisify(execFile);

/**
 * Clean up a worktree directory after a session ends.
 * Only removes the worktree directory -- never deletes the branch.
 *
 * Behavior:
 * - If clean (no uncommitted changes): auto-remove worktree directory.
 * - If dirty: preserve and print message.
 * - If removal fails: print a warning with manual cleanup instructions.
 */
export async function cleanupWorktree(
  worktreeInfo: WorktreeSessionInfo,
  options: CleanupWorktreeOptions
): Promise<void> {
  const { name, path: worktreePath, repoRoot } = worktreeInfo;
  const print = options.print ?? (() => {});

  // Best-effort: chdir out of the worktree before removal.
  if (
    process.cwd() === worktreePath ||
    process.cwd().startsWith(worktreePath + path.sep)
  ) {
    try {
      process.chdir(repoRoot);
    } catch (error) {
      logWarn('[WorktreeCleanup] Failed to chdir out of worktree', {
        path: worktreePath,
        cwd: repoRoot,
        cause: error,
      });
    }
  }

  if (!fs.existsSync(worktreePath)) {
    logWarn('[WorktreeCleanup] Worktree directory does not exist', {
      name,
      path: worktreePath,
    });
    return;
  }

  let dirty = false;
  try {
    dirty = await hasUncommittedChanges(worktreePath);
  } catch (error) {
    logException(error, '[WorktreeCleanup] Failed to check worktree status');
    dirty = true;
  }

  if (dirty) {
    logInfo('[WorktreeCleanup] Worktree preserved (has uncommitted changes)', {
      name,
    });
    print(`Worktree preserved at ${worktreePath} (has uncommitted changes).`);
    return;
  }

  try {
    await execFileAsync('git', ['worktree', 'remove', worktreePath], {
      cwd: repoRoot,
    });
    logInfo('[WorktreeCleanup] Worktree directory removed (clean)', { name });
    print(`Worktree directory removed (clean). Branch preserved.`);
  } catch (error) {
    logException(
      error,
      '[WorktreeCleanup] Failed to remove worktree directory'
    );
    print(
      `Failed to clean up worktree. Clean up manually: git worktree remove ${worktreePath}`
    );
  }
}
