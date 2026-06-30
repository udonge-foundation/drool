import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { findGitRoot } from '../shell/node';
import { expandTilde } from '../shell/paths';

import type { CreateWorktreeResult, WorktreeInfo } from './types';

const execFileAsync = promisify(execFile);

async function executeGitCommand(
  args: string[],
  cwd?: string
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  } catch (error) {
    const rawStderr =
      error && typeof error === 'object' && 'stderr' in error
        ? (error as { stderr: unknown }).stderr
        : undefined;
    const stderr =
      typeof rawStderr === 'string' || rawStderr instanceof Buffer
        ? String(rawStderr).trim()
        : '';
    const errorMessage =
      stderr || (error instanceof Error ? error.message : String(error));
    throw new MetaError(`git ${args.join(' ')} failed: ${errorMessage}`, {
      args: args.join(' '),
      errorMessage,
      cause: error,
    });
  }
}

export function getWorktreePath(
  repoRoot: string,
  branch: string,
  baseDir?: string
): string {
  const repoBasename = path.basename(repoRoot);
  const safeBranch = branch.replace(/\//g, '-');
  const leafName = `${repoBasename}-wt-${safeBranch}`;

  if (baseDir) {
    const expanded = expandTilde(baseDir);
    const resolved = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(repoRoot, expanded);
    return path.join(resolved, leafName);
  }

  return path.resolve(repoRoot, '..', leafName);
}

export async function createWorktreeForBranch(
  repoRoot: string,
  branch: string,
  worktreePath: string
): Promise<CreateWorktreeResult> {
  await executeGitCommand(['worktree', 'add', worktreePath, branch], repoRoot);
  return { worktreePath, branchName: branch };
}

export async function createWorktreeWithNewBranch(
  repoRoot: string,
  branch: string,
  worktreePath: string
): Promise<CreateWorktreeResult> {
  await executeGitCommand(
    ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'],
    repoRoot
  );
  return { worktreePath, branchName: branch };
}

export async function removeWorktree(
  repoRoot: string,
  worktreePath: string
): Promise<void> {
  await executeGitCommand(['worktree', 'remove', worktreePath], repoRoot);
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const output = await executeGitCommand(
    ['worktree', 'list', '--porcelain'],
    repoRoot
  );

  if (!output) {
    return [];
  }

  const worktrees: WorktreeInfo[] = [];
  const blocks = output.split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    let wtPath = '';
    let branch = '';
    let head = '';

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length);
      }
    }

    if (wtPath) {
      worktrees.push({ path: wtPath, branch, head });
    }
  }

  return worktrees;
}

async function gitExitCode(args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: 'ignore' });
    child.once('close', (code) => resolve(code ?? -1));
    child.once('error', () => resolve(-1));
  });
}

export async function branchExists(
  repoRoot: string,
  branchName: string
): Promise<boolean> {
  // Use exit code rather than try/catch around `git rev-parse`: a non-zero
  // exit is the documented "branch does not exist" signal, not an error.
  const code = await gitExitCode(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
    repoRoot
  );
  return code === 0;
}

export async function getCurrentBranch(repoRoot?: string): Promise<string> {
  return executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
}

export async function hasUncommittedChanges(
  worktreePath: string
): Promise<boolean> {
  const output = await executeGitCommand([
    '-C',
    worktreePath,
    'status',
    '--porcelain',
  ]);
  return output.length > 0;
}

export function isInWorktree(dir?: string): boolean {
  const resolvedDir = dir ?? process.cwd();
  const gitPath = path.join(resolvedDir, '.git');
  const st = fs.statSync(gitPath, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return false;
  const content = fs.readFileSync(gitPath, 'utf8').trim();
  return content.includes('/worktrees/');
}

export function getMainRepoRoot(worktreePath: string): string {
  const gitPath = path.join(worktreePath, '.git');

  let content: string;
  try {
    content = fs.readFileSync(gitPath, 'utf8').trim();
  } catch (error) {
    throw new MetaError(
      `Failed to read .git file in worktree: ${worktreePath}`,
      { cause: error }
    );
  }

  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) {
    throw new MetaError('Invalid .git file format in worktree:', {
      path: worktreePath,
    });
  }

  const gitdir = match[1].trim();
  const resolvedGitdir = path.isAbsolute(gitdir)
    ? gitdir
    : path.resolve(worktreePath, gitdir);

  let current = resolvedGitdir;
  while (true) {
    const parent = path.dirname(current);
    if (path.basename(current) === '.git' && fs.existsSync(current)) {
      return parent;
    }
    if (parent === current) {
      throw new MetaError(
        `Could not resolve main repo root from worktree: ${worktreePath} (gitdir: ${gitdir})`,
        { path: worktreePath, directory: gitdir }
      );
    }
    current = parent;
  }
}

const repoRootCache = new Map<string, string | null>();

/**
 * Resolve the canonical repo root for `cwd`.
 *
 * - If `cwd` is inside a linked worktree, returns the **main** repo's working
 *   directory (so multiple worktree sessions group under their parent project).
 * - If `cwd` is inside a normal git repo, returns that repo's root.
 * - If `cwd` is not inside a git repo, returns `undefined`.
 *
 * Results are cached per `cwd` because repo roots don't change for the
 * lifetime of the daemon process; the cache turns this from a
 * filesystem-walk into a single Map lookup after the first resolution.
 */
export function resolveRepoRoot(cwd: string): string | undefined {
  const cached = repoRootCache.get(cwd);
  if (cached !== undefined) return cached ?? undefined;

  let resolved: string | null = null;
  try {
    const gitRoot = findGitRoot(cwd);
    if (gitRoot) {
      resolved = isInWorktree(gitRoot) ? getMainRepoRoot(gitRoot) : gitRoot;
    }
  } catch (error) {
    // Cache the failure so we log at most once per cwd; sidebar/registry
    // will treat this cwd as non-repo and group by cwd directly.
    logWarn('[resolveRepoRoot] failed to resolve repo root', {
      cwd,
      cause: error,
    });
    resolved = null;
  }

  repoRootCache.set(cwd, resolved);
  return resolved ?? undefined;
}
