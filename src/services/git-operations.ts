import { exec } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { logError, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import type { BranchInfo, CommitInfo } from '@/components/review/types';

const execAsync = promisify(exec);

/**
 * Execute a git command and return the output
 */
async function executeGitCommand(command: string): Promise<string> {
  try {
    const { stdout } = await execAsync(command, {
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
    });
    return stdout.trim();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new MetaError('Git command failed:', {
      command,
      errorMessage,
      cause: error,
    });
  }
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(): Promise<string> {
  return executeGitCommand('git rev-parse --abbrev-ref HEAD');
}

/**
 * Get the HEAD commit SHA
 */
export async function getHeadSha(): Promise<string> {
  return executeGitCommand('git rev-parse HEAD');
}

/**
 * Get the absolute path to the .git directory
 */
export async function getGitDir(): Promise<string> {
  return executeGitCommand('git rev-parse --absolute-git-dir');
}

/**
 * Get the absolute path to the shared git directory.
 */
export async function getGitCommonDir(): Promise<string> {
  try {
    return await executeGitCommand(
      'git rev-parse --path-format=absolute --git-common-dir'
    );
  } catch (error) {
    logWarn('Falling back to legacy git common-dir resolution', {
      cause: error,
    });
    const gitCommonDir = await executeGitCommand(
      'git rev-parse --git-common-dir'
    );
    return path.resolve(gitCommonDir);
  }
}

/**
 * Get the remote origin URL
 */
export async function getRemoteUrl(): Promise<string> {
  return executeGitCommand('git remote get-url origin');
}

/**
 * Check whether the given branch matches the remote default branch
 */
export async function checkIsDefaultBranch(branch: string): Promise<boolean> {
  const output = await executeGitCommand(
    'git symbolic-ref refs/remotes/origin/HEAD'
  );
  const defaultBranch = output.replace('refs/remotes/origin/', '');
  return branch === defaultBranch;
}

/**
 * Get all local branches
 */
export async function getAllBranches(): Promise<BranchInfo[]> {
  const branches: BranchInfo[] = [];

  // Get current branch
  const currentBranch = await getCurrentBranch();

  // Get local branches only
  try {
    const localOutput = await executeGitCommand(
      'git branch --format="%(refname:short)"'
    );
    const localBranches = localOutput
      .split('\n')
      .filter(Boolean)
      .map((name) => ({
        name: name.trim(),
        isRemote: false,
        isCurrent: name.trim() === currentBranch,
      }));
    branches.push(...localBranches);
  } catch (error) {
    logError('Failed to get local branches', { error });
  }

  return branches;
}

/**
 * Get recent commits with pagination
 */
export async function getRecentCommits(
  limit: number = 50,
  skip: number = 0
): Promise<CommitInfo[]> {
  const format = [
    '%H', // Full hash
    '%h', // Short hash
    '%s', // Subject
    '%an', // Author name
    '%ad', // Author date (respects --date format)
  ].join('%x00'); // Use null character as delimiter

  const command = `git log --format="${format}" --date=relative --skip=${skip} -n ${limit}`;
  const output = await executeGitCommand(command);

  if (!output) {
    return [];
  }

  return output.split('\n').map((line) => {
    const [hash, shortHash, message, author, date] = line.split('\x00');
    return {
      hash,
      shortHash,
      message,
      author,
      date,
    };
  });
}

/**
 * Get the default base branch by first checking the remote's HEAD,
 * then falling back to common branch names (main, master, develop, dev)
 */
export async function getDefaultBaseBranch(): Promise<string | null> {
  // First, try to get the actual default branch from remote
  try {
    const output = await executeGitCommand(
      'git symbolic-ref refs/remotes/origin/HEAD'
    );
    const match = output.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) {
      // Verify branch exists locally before returning
      try {
        await executeGitCommand(
          `git rev-parse --verify refs/heads/${match[1]}`
        );
        return match[1];
      } catch {
        // Branch doesn't exist locally, fall through to heuristic
      }
    }
  } catch {
    // Remote HEAD not configured, fall back to heuristic
  }

  // Fallback: check for common base branch names locally
  const commonBaseBranches = ['main', 'master', 'develop', 'dev'];
  const branches = await getAllBranches();

  for (const baseName of commonBaseBranches) {
    const localBranch = branches.find((b) => b.name === baseName);
    if (localBranch) {
      return localBranch.name;
    }
  }

  return null;
}
