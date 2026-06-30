import * as fs from 'fs';
import * as path from 'path';

import { logWarn } from '@industry/logging';

import { fileExists } from './frontmatter';

const SKILL_PROMPT_FILE = 'SKILL.md';

/**
 * Resolve the real path of a directory, returning null if it has already been
 * visited (symlink cycle protection).
 */
async function resolveIfNotVisited(
  dirPath: string,
  visited: Set<string>
): Promise<string | null> {
  const realPath = await fs.promises.realpath(dirPath);
  if (visited.has(realPath)) return null;
  visited.add(realPath);
  return realPath;
}

/**
 * Recursively find all directories containing SKILL.md under a base skills directory.
 * If a directory has SKILL.md, it's treated as a skill directory.
 * If not, its subdirectories are searched recursively.
 * Tracks visited real paths to avoid infinite loops from symlink cycles.
 */
export async function findSkillDirectories(
  baseDir: string,
  visited: Set<string> = new Set()
): Promise<string[]> {
  const resolved = await resolveIfNotVisited(baseDir, visited);
  if (resolved == null) return [];

  const entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name));
  const nested: string[][] = [];
  for (const dir of dirs) {
    const dirPath = path.join(baseDir, dir.name);
    const promptFile = path.join(dirPath, SKILL_PROMPT_FILE);
    if (await fileExists(promptFile)) {
      nested.push([dirPath]);
    } else {
      nested.push(await findSkillDirectories(dirPath, visited));
    }
  }

  return nested.flat();
}

/**
 * Synchronously collect SKILL.md file paths from a skills directory tree.
 * Used by file watchers to enumerate individual skill files for targeted
 * watching without opening FDs for non-settings files.
 * Limited to maxDepth 3 (skills/group/nested-skill/SKILL.md).
 */
export function collectSkillFilesSync(
  dir: string,
  targets: string[],
  depth = 0
): void {
  if (depth > 3) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectSkillFilesSync(fullPath, targets, depth + 1);
      } else if (entry.name === SKILL_PROMPT_FILE) {
        targets.push(fullPath);
      }
    }
  } catch (err) {
    logWarn('Failed to read skill files directory', { cause: err });
  }
}

/**
 * Recursively find all command files under a base commands directory.
 * Descends into subdirectories to discover nested command files.
 * Tracks visited real paths to avoid infinite loops from symlink cycles.
 */
export async function findCommandFiles(
  baseDir: string,
  visited: Set<string> = new Set()
): Promise<string[]> {
  const resolved = await resolveIfNotVisited(baseDir, visited);
  if (resolved == null) return [];

  const entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(baseDir, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        return findCommandFiles(fullPath, visited);
      }
      return [fullPath];
    })
  );

  return nested.flat();
}
