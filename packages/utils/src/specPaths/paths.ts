import * as fs from 'fs';
import * as path from 'path';

import { logWarn } from '@industry/logging';

import { getIndustryHome } from '../cli';
import { getIndustryDirName } from '../environment';
import { findGitRoot } from '../shell/node';

const EXPECTED_STAT_ERROR_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOTDIR',
  'ELOOP',
]);

/** Returns the user-level ~/.industry directory path for a given home (defaults to getIndustryHome()). */
export function getUserIndustryDir(homeDir?: string): string {
  const home = homeDir || getIndustryHome();
  return path.join(home, getIndustryDirName());
}

/**
 * Walk up from startPath to the first Git repo boundary. While traversing,
 * remember the nearest .industry (excluding ~/.industry). Returns both the
 * nearest .industry path (if any) and the git root (if found). Does not
 * cross the git root.
 */
export function findProjectIndustryWithinGit(startPath?: string): {
  industryDir: string | null;
  gitRootDir: string | null;
} {
  const startDir = path.resolve(startPath || process.cwd());
  const homeIndustry = path.join(getIndustryHome(), getIndustryDirName());
  let foundIndustry: string | null = null;

  const foundGitRoot = findGitRoot(startDir);

  let dir = startDir;
  while (true) {
    const candidateIndustry = path.join(dir, getIndustryDirName());
    if (candidateIndustry !== homeIndustry) {
      try {
        const stat = fs.statSync(candidateIndustry);
        if (stat.isDirectory() && !foundIndustry) {
          foundIndustry = candidateIndustry;
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (!code || !EXPECTED_STAT_ERROR_CODES.has(code)) {
          logWarn(
            '[specPaths] Unexpected error stat-ing candidate .industry dir',
            { cause: err, path: candidateIndustry }
          );
        }
      }
    }

    if (foundGitRoot && dir === foundGitRoot) {
      break;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { industryDir: foundIndustry, gitRootDir: foundGitRoot };
}

/** Convenience: return only the nearest .industry within the git boundary. */
export function findNearestProjectIndustryDir(
  startPath?: string
): string | null {
  return findProjectIndustryWithinGit(startPath).industryDir;
}

function stripLeadingSeparators(segment: string): string {
  return segment.replace(/^[/\\]+/, '');
}

/** Resolve the spec save directory setting to an absolute path, git-aware for project .industry. */
export function resolveSpecSaveDirectory(
  dirSetting: string,
  cwd?: string
): string {
  const trimmed = dirSetting.trim();
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    const home = getIndustryHome();
    return path.normalize(
      path.join(home, stripLeadingSeparators(trimmed.slice(2)))
    );
  }
  const industryDirName = getIndustryDirName();
  const industryShorthandPrefix = `${industryDirName}/`;
  if (
    trimmed === industryDirName ||
    trimmed.startsWith(industryShorthandPrefix)
  ) {
    const rawSuffix =
      trimmed === industryDirName
        ? ''
        : trimmed.slice(industryShorthandPrefix.length);
    const suffix = stripLeadingSeparators(rawSuffix);
    const { industryDir } = findProjectIndustryWithinGit(cwd || process.cwd());
    const root = industryDir ?? getUserIndustryDir();
    return path.normalize(path.join(root, suffix));
  }
  return path.normalize(path.join(cwd || process.cwd(), trimmed));
}
