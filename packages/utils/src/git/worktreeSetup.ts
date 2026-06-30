import path from 'node:path';

import { z } from 'zod';

import { WorktreeSetupError } from './errors';
import {
  branchExists,
  createWorktreeForBranch,
  createWorktreeWithNewBranch,
  getCurrentBranch,
  getWorktreePath,
  listWorktrees,
} from './worktree';
import { findGitRoot } from '../shell/node';

import type { WorktreeSessionInfo, WorktreeSetupOptions } from './types';

/**
 * Options for setting up a git worktree. Type lives in `types.ts`
 * (inferred via `z.infer`); the runtime schema is co-located here with
 * the function that consumes it.
 */
export const WorktreeSetupOptionsSchema = z.object({
  /** Optional base directory where the worktree should be created. */
  worktreeDir: z.string().optional(),
  /**
   * Optional working directory to start git-root discovery from. When not
   * provided, falls back to `process.cwd()`. Used by the daemon to operate
   * on a specific repository without mutating the daemon process cwd.
   */
  cwd: z.string().optional(),
  /**
   * Optional unique suffix appended to the derived branch name when the
   * default branch (`<current>-wt`) collides with an existing checked-out
   * branch. The suffix is truncated to 8 characters. When omitted, the
   * legacy reuse-on-collision behaviour is preserved (CLI default).
   */
  uniqueSuffix: z.string().optional(),
});

const SUFFIX_LENGTH = 8;

function toWorktreeSetupError(error: unknown): WorktreeSetupError {
  if (error instanceof WorktreeSetupError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new WorktreeSetupError(message, { cause: error });
}

/**
 * Set up a git worktree for the current session.
 *
 * Bare `worktreeOption=true`:
 *   Derives the target branch as `<current-branch>-wt`.
 *   If that branch exists and is not checked out elsewhere, check it out in a new worktree.
 *   If it doesn't exist, create it from HEAD.
 *
 * `worktreeOption` as string:
 *   Uses the given name as the branch name directly. Same exists-or-create logic.
 *
 * When `options.uniqueSuffix` is provided AND the derived branch already
 * exists in another worktree, the branch name is suffixed with a short
 * slice of the unique value (e.g. `main-wt-7f3a1c2d`) so concurrent
 * sessions get isolated worktrees instead of silently sharing one.
 */
export async function setupWorktree(
  worktreeOption: string | true,
  options?: WorktreeSetupOptions
): Promise<WorktreeSessionInfo> {
  const parsedOptions = WorktreeSetupOptionsSchema.parse(options ?? {});
  const gitRoot = findGitRoot(parsedOptions.cwd);
  if (!gitRoot) {
    throw new WorktreeSetupError('Not inside a git repository');
  }

  try {
    let targetBranch: string;
    if (typeof worktreeOption === 'string') {
      targetBranch = worktreeOption;
    } else {
      const currentBranch = await getCurrentBranch(gitRoot);
      targetBranch = `${currentBranch}-wt`;
    }

    const existingWorktrees = await listWorktrees(gitRoot);

    // When a uniqueSuffix is supplied, treat any pre-existing checkout of
    // the derived branch as a collision and pick a fresh suffixed branch
    // name. This prevents two concurrent desktop sessions from silently
    // sharing the same worktree directory.
    if (parsedOptions.uniqueSuffix && typeof worktreeOption !== 'string') {
      const fullRef = `refs/heads/${targetBranch}`;
      const collides = existingWorktrees.some((wt) => wt.branch === fullRef);
      if (collides) {
        const suffix = parsedOptions.uniqueSuffix.slice(0, SUFFIX_LENGTH);
        targetBranch = `${targetBranch}-${suffix}`;
      }
    }

    // If the (possibly-suffixed) branch already lives in a worktree, reuse it.
    const fullRef = `refs/heads/${targetBranch}`;
    for (const wt of existingWorktrees) {
      if (wt.branch === fullRef) {
        return {
          name: targetBranch,
          path: wt.path,
          branch: targetBranch,
          repoRoot: gitRoot,
          isNewlyCreated: false,
        };
      }
    }

    const worktreePath = getWorktreePath(
      gitRoot,
      targetBranch,
      parsedOptions.worktreeDir
    );

    if (worktreePath.startsWith(gitRoot + path.sep)) {
      const rel = path
        .relative(gitRoot, path.dirname(worktreePath))
        .split(path.sep)
        .join('/');
      const gitignoreEntry = rel || path.basename(worktreePath);
      process.stderr.write(
        `Note: Worktree created inside repo. You may want to add '${gitignoreEntry}/' to .gitignore.\n`
      );
    }

    const branchAlreadyExists = await branchExists(gitRoot, targetBranch);

    let result;
    if (branchAlreadyExists) {
      result = await createWorktreeForBranch(
        gitRoot,
        targetBranch,
        worktreePath
      );
    } else {
      result = await createWorktreeWithNewBranch(
        gitRoot,
        targetBranch,
        worktreePath
      );
    }

    return {
      name: targetBranch,
      path: result.worktreePath,
      branch: result.branchName,
      repoRoot: gitRoot,
      isNewlyCreated: true,
    };
  } catch (error) {
    throw toWorktreeSetupError(error);
  }
}
