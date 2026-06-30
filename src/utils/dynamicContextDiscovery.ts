import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

import {
  SkillFrontmatterSchema,
  type Skill,
  type SkillMetadata,
} from '@industry/common/settings';
import { AGENTS_MD_FILE_NAMES } from '@industry/drool-core/core/constants';
import {
  SYSTEM_REMINDER_END,
  SYSTEM_REMINDER_START,
} from '@industry/drool-sdk-ext/protocol/drool';
import { SkillLocation } from '@industry/drool-sdk-ext/protocol/settings';
import { logWarn } from '@industry/logging';
import { findGitRoot } from '@industry/utils/shell/node';

import {
  getAgentContextDirNames,
  readGuidelineFileContent,
} from '@/utils/industryPaths';

const MAX_DYNAMIC_GUIDELINES_SIZE = 40_000;
const SKILL_PROMPT_FILE = 'SKILL.md';

/**
 * Normalize a guideline path for dedup: directory + lowercased filename.
 * Handles case-insensitive filesystems where AGENTS.md and Agents.md are the same file.
 */
function normalizeGuidelinePath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    path.basename(filePath).toLowerCase()
  );
}

interface DiscoveredGuideline {
  filePath: string;
  content: string;
}

interface DynamicDiscoveryResult {
  guidelines: DiscoveredGuideline[];
  skills: Skill[];
}

// ── Local skill helpers (avoid cross-package imports from @industry/services) ──

async function fileExistsAsync(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findSkillDirectoriesLocal(baseDir: string): Promise<string[]> {
  async function search(dir: string, visited: Set<string>): Promise<string[]> {
    let realPath: string;
    try {
      realPath = await fs.promises.realpath(dir);
    } catch {
      return [];
    }
    if (visited.has(realPath)) return [];
    visited.add(realPath);

    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const subdirs = entries.filter(
      (e) => e.isDirectory() || e.isSymbolicLink()
    );
    const nested = await Promise.all(
      subdirs.map(async (d) => {
        const dirPath = path.join(dir, d.name);
        const promptFile = path.join(dirPath, SKILL_PROMPT_FILE);
        if (await fileExistsAsync(promptFile)) {
          return [dirPath];
        }
        return search(dirPath, visited);
      })
    );

    return nested.flat();
  }

  return search(baseDir, new Set());
}

function parseFrontmatterLocal(content: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const match = frontmatterRegex.exec(content);
  if (!match) return { metadata: {}, body: content };

  const frontmatterContent = match[1];
  const body = content.substring(match[0].length);

  try {
    const parsed = yaml.load(frontmatterContent);
    if (typeof parsed === 'object' && parsed !== null) {
      return { metadata: parsed as Record<string, unknown>, body };
    }
  } catch (error) {
    void error;
    // YAML parsing failed
  }

  return { metadata: {}, body: content };
}

async function loadSkillFileLocal(
  filePath: string,
  location: SkillLocation
): Promise<Skill | null> {
  try {
    if (!(await fileExistsAsync(filePath))) return null;

    const content = await fs.promises.readFile(filePath, 'utf-8');
    const stats = await fs.promises.stat(filePath);
    const { metadata: rawMetadata, body } = parseFrontmatterLocal(content);

    const validated = SkillFrontmatterSchema.safeParse(rawMetadata);

    let metadata: SkillMetadata;
    let validationResult: Skill['validationResult'];

    if (validated.success) {
      const fm = validated.data;
      metadata = {
        name: fm.name,
        description: fm.description,
        enabled: fm.enabled,
        userInvocable: fm['user-invocable'],
        disableModelInvocation: fm['disable-model-invocation'],
        tools: fm['allowed-tools'] ?? fm.tools,
        license: fm.license,
        compatibility: fm.compatibility,
        metadata: fm.metadata,
      };
      validationResult = { valid: true, errors: [], warnings: [] };
    } else {
      const skillName =
        typeof rawMetadata.name === 'string'
          ? rawMetadata.name
          : path.basename(path.dirname(filePath));
      metadata = {
        name: skillName,
        description: '',
        enabled: false,
      };
      validationResult = {
        valid: false,
        errors: [validated.error.message],
        warnings: [],
      };
    }

    return {
      metadata,
      systemPrompt: body.trim(),
      location,
      filePath,
      lastModified: stats.mtimeMs,
      validationResult,
    };
  } catch {
    return null;
  }
}

/**
 * Singleton service that discovers AGENTS.md files and skills along the path
 * to files accessed by the Read tool. Injects new content as system reminders
 * in tool results to avoid prompt cache invalidation.
 */
export class DynamicContextDiscovery {
  // eslint-disable-next-line no-use-before-define
  private static instance: DynamicContextDiscovery | null = null;

  private loadedGuidelinePaths = new Set<string>();

  private loadedSkillDirPaths = new Set<string>();

  private dynamicSkills: Skill[] = [];

  private gitRoot: string | null;

  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
    this.gitRoot = findGitRoot(this.cwd);
  }

  static getInstance(): DynamicContextDiscovery {
    if (!DynamicContextDiscovery.instance) {
      DynamicContextDiscovery.instance = new DynamicContextDiscovery();
    }
    return DynamicContextDiscovery.instance;
  }

  static resetInstance(): void {
    DynamicContextDiscovery.instance = null;
  }

  seedLoadedGuidelines(filePaths: string[]): void {
    for (const fp of filePaths) {
      this.loadedGuidelinePaths.add(normalizeGuidelinePath(fp));
    }
  }

  seedLoadedSkillDirs(dirPaths: string[]): void {
    for (const dp of dirPaths) {
      this.loadedSkillDirPaths.add(dp);
    }
  }

  getDynamicSkills(): Skill[] {
    return this.dynamicSkills;
  }

  async discoverAlongPath(filePath: string): Promise<DynamicDiscoveryResult> {
    const fileDir = path.dirname(path.resolve(filePath));
    const dirsToCheck = this.getIntermediateDirectories(fileDir);

    if (dirsToCheck.length === 0) {
      return { guidelines: [], skills: [] };
    }

    const [guidelines, skills] = await Promise.all([
      this.discoverGuidelines(dirsToCheck),
      this.discoverSkills(dirsToCheck),
    ]);

    return { guidelines, skills };
  }

  private getIntermediateDirectories(targetDir: string): string[] {
    const boundary = this.gitRoot ?? this.cwd;

    const relative = path.relative(boundary, targetDir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return [];
    }

    const segments = relative.split(path.sep).filter(Boolean);
    if (segments.length === 0) {
      return [];
    }

    const dirs: string[] = [];
    let current = boundary;
    for (const segment of segments) {
      current = path.join(current, segment);
      dirs.push(current);
    }

    return dirs;
  }

  private async discoverGuidelines(
    dirs: string[]
  ): Promise<DiscoveredGuideline[]> {
    const results: DiscoveredGuideline[] = [];
    let totalSize = 0;

    for (const dir of dirs) {
      const found = await this.checkDirForGuidelines(dir);
      for (const g of found) {
        if (totalSize + g.content.length > MAX_DYNAMIC_GUIDELINES_SIZE) break;
        results.push(g);
        totalSize += g.content.length;
      }

      for (const contextDirName of getAgentContextDirNames()) {
        const contextDir = path.join(dir, contextDirName);
        const contextFound = await this.checkDirForGuidelines(contextDir);
        for (const g of contextFound) {
          if (totalSize + g.content.length > MAX_DYNAMIC_GUIDELINES_SIZE) break;
          results.push(g);
          totalSize += g.content.length;
        }
      }
    }

    return results;
  }

  private async checkDirForGuidelines(
    dir: string
  ): Promise<DiscoveredGuideline[]> {
    const found: DiscoveredGuideline[] = [];
    const seenBasenames = new Set<string>();

    for (const fileName of AGENTS_MD_FILE_NAMES) {
      const candidate = path.join(dir, fileName);
      const normalizedBasename = fileName.toLowerCase();

      if (seenBasenames.has(normalizedBasename)) continue;
      if (this.loadedGuidelinePaths.has(normalizeGuidelinePath(candidate)))
        continue;

      const content = await readGuidelineFileContent(candidate, dir);
      if (content === undefined) continue;

      found.push({ filePath: candidate, content });
      this.loadedGuidelinePaths.add(normalizeGuidelinePath(candidate));
      seenBasenames.add(normalizedBasename);
    }

    return found;
  }

  private async discoverSkills(dirs: string[]): Promise<Skill[]> {
    const newSkills: Skill[] = [];

    for (const dir of dirs) {
      for (const dotDir of getAgentContextDirNames()) {
        const skillsDir = path.join(dir, dotDir, 'skills');

        if (this.loadedSkillDirPaths.has(skillsDir)) continue;

        try {
          const stat = await fs.promises.stat(skillsDir);
          if (!stat.isDirectory()) continue;
        } catch {
          continue;
        }

        this.loadedSkillDirPaths.add(skillsDir);

        try {
          const skillDirPaths = await findSkillDirectoriesLocal(skillsDir);
          for (const skillDirPath of skillDirPaths) {
            const promptFile = path.join(skillDirPath, SKILL_PROMPT_FILE);
            const skill = await loadSkillFileLocal(
              promptFile,
              SkillLocation.Project
            );
            if (skill) {
              newSkills.push(skill);
              this.dynamicSkills.push(skill);
            }
          }
        } catch (error) {
          logWarn('[DynamicContextDiscovery] Failed to load skills', {
            path: skillsDir,
            error,
          });
        }
      }
    }

    return newSkills;
  }
}

/**
 * Format discovered guidelines and skills into a system reminder string
 * to append to the Read tool result.
 */
export function formatDynamicDiscoveryReminder(
  result: DynamicDiscoveryResult
): string {
  const parts: string[] = [];

  if (result.guidelines.length > 0) {
    parts.push(
      'Additional project instructions discovered along the path to this file:'
    );
    for (const g of result.guidelines) {
      parts.push(
        `## ${g.filePath}\n<coding_guidelines>\n${g.content.trimEnd()}\n</coding_guidelines>`
      );
    }
  }

  if (result.skills.length > 0) {
    parts.push(
      'New skills discovered along the path to this file and now available via the Skill tool:'
    );
    for (const s of result.skills) {
      const desc = s.metadata.description || 'No description';
      parts.push(`- ${s.metadata.name}: ${desc} (${s.location})`);
    }
  }

  if (parts.length === 0) return '';

  return `${SYSTEM_REMINDER_START}\n${parts.join('\n\n')}\n${SYSTEM_REMINDER_END}`;
}
