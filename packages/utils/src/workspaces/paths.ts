import { logWarn } from '@industry/logging';

// FIXME(fac-13139): this is duplicated in apps/backend/src/utils/sandbox/constants.ts
const SANDBOX_DEFAULT_DIRECTORY = '/project/workspace/';

/**
 * Extracts the repository directory name from a git remote URL
 * @param remoteUrl - The git remote URL
 * @returns The repository directory name with .git suffix removed, or 'repo' as fallback
 */
function getRepoDirNameFromUrl(remoteUrl: string): string {
  try {
    const pathname = new URL(remoteUrl).pathname;
    const lastSegment = pathname.split('/').pop() || '';
    return lastSegment.replace(/\.git$/, '') || 'repo';
  } catch (err) {
    logWarn('Failed to parse repository URL', { cause: err });
    return 'repo';
  }
}

/**
 * Gets the full repository root path for a workspace
 * @param repoUrl - The repository URL (empty/undefined for empty workspace)
 * @returns The full path where the repository should be located in the sandbox
 */
export function getRepoRootPath(repoUrl: string | undefined): string {
  if (!repoUrl) {
    return SANDBOX_DEFAULT_DIRECTORY;
  }
  const repoDirName = getRepoDirNameFromUrl(repoUrl);
  return `${SANDBOX_DEFAULT_DIRECTORY}${repoDirName}`;
}
