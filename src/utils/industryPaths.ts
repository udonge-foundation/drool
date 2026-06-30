import * as fs from 'fs';
import * as path from 'path';

import {
  AGENTS_MD_FILE_NAMES,
  DESIGN_MD_FILE_NAMES,
} from '@industry/drool-core/core/constants';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { findGitRoot } from '@industry/utils/shell/node';
import {
  findNearestProjectIndustryDir as sharedFindNearestProjectIndustryDir,
  findProjectIndustryWithinGit as sharedFindProjectIndustryWithinGit,
  getUserIndustryDir as sharedGetUserIndustryDir,
  resolveSpecSaveDirectory as sharedResolveSpecSaveDirectory,
} from '@industry/utils/specPaths';

import { AgentContextDirName } from '@/utils/enums';

/** Sanitize a name into a filesystem-safe slug */
function sanitizeSlug(name: string): string {
  const base = name.toLowerCase().replace(/\.[a-z0-9]+$/, '');
  return (
    base
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/--+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'spec'
  );
}

/** Derive a slug from the first line of content */
function deriveSlugFromContent(content: string): string {
  const firstLine =
    content.split(/\r?\n/).find((l) => l.trim().length > 0) || 'spec';
  // Strip leading markdown heading markers
  const normalized = firstLine.replace(/^\s*#+\s*/, '');
  return normalized;
}

/** Ensure a file path doesn't collide with existing files by appending -N suffix */
async function ensureNoCollision(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, '.md');
  let candidate = filePath;
  let counter = 1;
  const MAX_ATTEMPTS = 100;

  // Verify directory exists and is accessible before checking for collisions
  try {
    await fs.promises.access(dir, fs.constants.W_OK);
  } catch {
    // Directory doesn't exist or isn't writable - return original path
    // Caller is responsible for creating directory if needed
    return filePath;
  }

  while (counter <= MAX_ATTEMPTS) {
    try {
      await fs.promises.access(candidate);
      candidate = path.join(dir, `${base}-${counter}.md`);
      counter += 1;
    } catch {
      return candidate;
    }
  }

  // Safety fallback: if we somehow exhaust MAX_ATTEMPTS, append timestamp
  const timestamp = Date.now();
  return path.join(dir, `${base}-${timestamp}.md`);
}

/** Returns the user-level ~/.industry directory path for a given home (defaults to getIndustryHome()). */
export function getUserIndustryDir(homeDir?: string): string {
  return sharedGetUserIndustryDir(homeDir);
}

export function findProjectIndustryWithinGit(startPath?: string): {
  industryDir: string | null;
  gitRootDir: string | null;
} {
  return sharedFindProjectIndustryWithinGit(startPath);
}

export function findNearestProjectIndustryDir(
  startPath?: string
): string | null {
  return sharedFindNearestProjectIndustryDir(startPath);
}

export function resolveSpecSaveDirectory(
  dirSetting: string,
  cwd?: string
): string {
  return sharedResolveSpecSaveDirectory(dirSetting, cwd);
}

/**
 * Calculate the final spec file path that will be used, including collision detection.
 * This ensures the preview path matches what will actually be saved.
 */
export async function calculateSpecFilePath(
  specSaveDirSetting: string,
  title: string | undefined,
  planContent: string
): Promise<string> {
  const resolvedDir = resolveSpecSaveDirectory(specSaveDirSetting);

  // Determine filename
  const titleOrContent =
    title?.trim() || (planContent ? deriveSlugFromContent(planContent) : '');
  const slug = titleOrContent ? sanitizeSlug(titleOrContent) : 'spec';
  const datePrefix = new Date().toISOString().slice(0, 10);
  const initialPath = path.join(resolvedDir, `${datePrefix}-${slug}.md`);

  // Check for collisions and return the actual path that will be used
  return ensureNoCollision(initialPath);
}

/**
 * Save a spec plan to an already-calculated target path.
 *
 * Callers that must policy-check the effective target immediately before the
 * write should calculate/check the path first, then call this helper so the
 * write cannot recalculate a different slug/path.
 */
export async function saveSpecFileAtPath(
  plan: string,
  filePath: string
): Promise<string> {
  const normalizedPath = path.normalize(filePath);
  await fs.promises.mkdir(path.dirname(normalizedPath), { recursive: true });
  await fs.promises.writeFile(normalizedPath, plan, 'utf-8');
  return normalizedPath;
}

/**
 * Save a spec plan to disk, creating the directory if needed.
 * Returns the absolute path of the saved file.
 */
export async function saveSpecFile(
  plan: string,
  title?: string
): Promise<string> {
  // Dynamic import to avoid circular dependency (industryPaths → SettingsService → ... → industryPaths)
  const { getSettingsService } = await import('@/services/SettingsService');
  const specDirSetting = getSettingsService().getSpecSaveDir();
  const filePath = await calculateSpecFilePath(specDirSetting, title, plan);
  return saveSpecFileAtPath(plan, filePath);
}

type GuidelineResult<T extends readonly string[]> = {
  filePath: string;
  fileName: T[number];
  content: string;
  isPersonal: boolean;
};

type GuidelineSearchOptions = {
  startPath?: string;
  homeDir?: string;
};

type GuidelineSearchDir = {
  dir: string;
  isPersonal: boolean;
};

/**
 * Agent context directory names supported by guideline, skill, and command
 * discovery.
 */
const AGENT_CONTEXT_DIR_NAMES = [
  AgentContextDirName.Industry,
  AgentContextDirName.IndustryDev,
  AgentContextDirName.Agents,
  AgentContextDirName.Agent,
] as const satisfies readonly AgentContextDirName[];

const SECONDARY_AGENT_CONTEXT_DIR_NAMES = [
  AgentContextDirName.Agents,
  AgentContextDirName.Agent,
] as const satisfies readonly AgentContextDirName[];

const AGENT_CONTEXT_DIR_NAME_SET = new Set<string>(AGENT_CONTEXT_DIR_NAMES);

/**
 * Returns the supported agent context directory names in lookup order.
 *
 * Use when scanning for Industry/agent project or personal surfaces. The active
 * Industry directory is first, followed by the cross-agent compatibility dirs.
 */
export function getAgentContextDirNames(): readonly AgentContextDirName[] {
  const primaryContextDirName = getIndustryDirName();
  if (!AGENT_CONTEXT_DIR_NAME_SET.has(primaryContextDirName)) {
    throw new MetaError('Unexpected Industry context directory name', {
      reason: 'unexpected_industry_context_directory_name',
      path: primaryContextDirName,
    });
  }

  return [
    primaryContextDirName as AgentContextDirName,
    ...SECONDARY_AGENT_CONTEXT_DIR_NAMES,
  ];
}

function isPathWithinDir(filePath: string, dirPath: string): boolean {
  const relativePath = path.relative(path.resolve(dirPath), filePath);
  return (
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  );
}

async function getSafeGuidelineRealPath(
  filePath: string,
  expectedDir: string
): Promise<string | undefined> {
  try {
    const expectedDirStat = await fs.promises.lstat(expectedDir);
    if (!expectedDirStat.isDirectory()) return undefined;

    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile()) return undefined;

    const realExpectedDir = await fs.promises.realpath(expectedDir);
    const realFilePath = await fs.promises.realpath(filePath);
    if (!isPathWithinDir(realFilePath, realExpectedDir)) return undefined;

    return realFilePath;
  } catch {
    return undefined;
  }
}

function getSafeGuidelineRealPathSync(
  filePath: string,
  expectedDir: string
): string | undefined {
  try {
    const expectedDirStat = fs.lstatSync(expectedDir);
    if (!expectedDirStat.isDirectory()) return undefined;

    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) return undefined;

    const realExpectedDir = fs.realpathSync(expectedDir);
    const realFilePath = fs.realpathSync(filePath);
    if (!isPathWithinDir(realFilePath, realExpectedDir)) return undefined;

    return realFilePath;
  } catch {
    return undefined;
  }
}

/**
 * Reads a guideline file only when the candidate is a regular file contained
 * within the directory being scanned.
 *
 * Use for any model-bound guideline content so symlinked or out-of-tree files
 * cannot be injected into prompts.
 */
export async function readGuidelineFileContent(
  filePath: string,
  expectedDir: string
): Promise<string | undefined> {
  try {
    const realFilePath = await getSafeGuidelineRealPath(filePath, expectedDir);
    if (realFilePath === undefined) return undefined;
    return await fs.promises.readFile(realFilePath, 'utf8');
  } catch {
    return undefined;
  }
}

function getGuidelineSearchDirs(
  options: GuidelineSearchOptions
): GuidelineSearchDir[] {
  const startDir = path.resolve(options.startPath || process.cwd());
  const homeDir = path.resolve(options.homeDir || getIndustryHome());
  const contextDirNames = getAgentContextDirNames();
  const personalContextDirs = new Set(
    contextDirNames.map((dirName) => path.join(homeDir, dirName))
  );

  const dirsToCheck: GuidelineSearchDir[] = [];
  const visited = new Set<string>();

  const gitRoot = findGitRoot(startDir);

  let dir = startDir;
  while (true) {
    if (dir !== homeDir && !visited.has(dir)) {
      visited.add(dir);
      dirsToCheck.push({ dir, isPersonal: personalContextDirs.has(dir) });
    }

    for (const contextDirName of contextDirNames) {
      const candidateContextDir = path.join(dir, contextDirName);
      if (
        !personalContextDirs.has(candidateContextDir) &&
        !visited.has(candidateContextDir)
      ) {
        visited.add(candidateContextDir);
        dirsToCheck.push({ dir: candidateContextDir, isPersonal: false });
      }
    }

    if (!gitRoot || dir === gitRoot) {
      break;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const personalContextDir of personalContextDirs) {
    if (!visited.has(personalContextDir)) {
      visited.add(personalContextDir);
      dirsToCheck.push({ dir: personalContextDir, isPersonal: true });
    }
  }

  return dirsToCheck;
}

async function findAllGuidelinesOfType<T extends readonly string[]>(
  fileNames: T,
  options: GuidelineSearchOptions,
  logLabel: string
): Promise<GuidelineResult<T>[]> {
  try {
    const dirsToCheck = getGuidelineSearchDirs(options);

    const readPromises = dirsToCheck.map(
      async ({ dir: dirPath, isPersonal }) => {
        const foundInDir: GuidelineResult<T>[] = [];
        const seenBasenames = new Set<string>();

        for (const fileName of fileNames) {
          const candidate = path.join(dirPath, fileName);
          const normalizedBasename = fileName.toLowerCase();

          if (seenBasenames.has(normalizedBasename)) {
            continue;
          }

          const content = await readGuidelineFileContent(candidate, dirPath);
          if (content === undefined) continue;

          foundInDir.push({
            filePath: candidate,
            fileName,
            content,
            isPersonal,
          });
          seenBasenames.add(normalizedBasename);
        }
        return foundInDir;
      }
    );

    const allResults = await Promise.all(readPromises);
    return allResults.flat();
  } catch (error) {
    logWarn('[industryPaths] Failed to locate all guidelines', {
      name: logLabel,
      error,
      ...(options.startPath ? { cwd: options.startPath } : {}),
      ...(options.homeDir ? { targetPath: options.homeDir } : {}),
    });
    return [];
  }
}

export function hasAgentsMdGuidelines(
  options: GuidelineSearchOptions = {}
): boolean {
  try {
    return getGuidelineSearchDirs(options).some(({ dir }) =>
      AGENTS_MD_FILE_NAMES.some(
        (fileName) =>
          getSafeGuidelineRealPathSync(path.join(dir, fileName), dir) !==
          undefined
      )
    );
  } catch (error) {
    logWarn('[industryPaths] Failed to check for guidelines', { error });
    return false;
  }
}

export async function findAllAgentsMdGuidelines(
  options: GuidelineSearchOptions = {}
): Promise<GuidelineResult<typeof AGENTS_MD_FILE_NAMES>[]> {
  return findAllGuidelinesOfType(AGENTS_MD_FILE_NAMES, options, 'Agents.md');
}

export async function findAllDesignMdGuidelines(
  options: GuidelineSearchOptions = {}
): Promise<GuidelineResult<typeof DESIGN_MD_FILE_NAMES>[]> {
  return findAllGuidelinesOfType(DESIGN_MD_FILE_NAMES, options, 'design.md');
}
