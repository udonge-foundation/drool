import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logException, logInfo, logWarn } from '@industry/logging';
import { SettingsManager, SkillImportService } from '@industry/runtime/settings';

import { sanitizeSkillName } from '@/utils/skills/paths';
import type { SkillImportResult } from '@/utils/skills/types';

/**
 * Build list of .claude/skills directories to search, similar to .industry/skills
 */
function buildClaudeSearchDirs(): {
  projectDirs: string[];
  personalDir: string;
} {
  const startDir = path.resolve(process.cwd());
  const homeDir = path.resolve(os.homedir());
  const personalClaudeDir = path.join(homeDir, '.claude', 'skills');
  const visited = new Set<string>();
  const projectDirs: string[] = [];

  let dir = startDir;
  while (true) {
    // Check for .claude/skills in current directory
    const candidateClaudeDir = path.join(dir, '.claude', 'skills');

    // Don't include personal Claude dir in project dirs
    if (
      candidateClaudeDir !== personalClaudeDir &&
      !visited.has(candidateClaudeDir)
    ) {
      visited.add(candidateClaudeDir);
      if (fs.existsSync(candidateClaudeDir)) {
        projectDirs.push(candidateClaudeDir);
      }
    }

    // Check if we've hit the git root
    const gitDir = path.join(dir, '.git');
    try {
      const statGit = fs.statSync(gitDir);
      if (statGit.isDirectory()) {
        break; // Stop at git boundary
      }
    } catch {
      // No git directory, continue upward
    }

    const parent = path.dirname(dir);
    if (parent === dir) break; // Reached filesystem root
    dir = parent;
  }

  return { projectDirs, personalDir: personalClaudeDir };
}

/**
 * Import skills from Claude Code .claude/skills directories
 * @param selectedSkills - Optional array of specific skills to import. If not provided, imports all.
 */
export async function importClaudeCodeSkills(
  selectedSkills?: Array<{ name: string; location: 'project' | 'personal' }>
): Promise<SkillImportResult> {
  const results: SkillImportResult = {
    imported: [],
    skipped: [],
    failed: [],
  };

  const manager = SettingsManager.getInstance();
  const skillImporter = SkillImportService.getInstance();

  // Search for .claude/skills directories using the same traversal as .industry
  const { projectDirs, personalDir } = buildClaudeSearchDirs();

  // Get target directories to check for existing skills
  const projectSkillsDir = path.join(
    manager.getProjectPath() ?? process.cwd(),
    'skills'
  );
  const personalSkillsDir = path.join(manager.getUserPath(), 'skills');

  // Collect all Claude paths with their appropriate targets
  const claudePaths: Array<{
    source: string;
    target: 'project' | 'personal';
    targetDir: string;
    level: SettingsLevel;
  }> = [];

  // Add all project Claude directories
  for (const dir of projectDirs) {
    claudePaths.push({
      source: dir,
      target: 'project',
      targetDir: projectSkillsDir,
      level: SettingsLevel.Project,
    });
  }

  // Add personal Claude directory if it exists
  if (fs.existsSync(personalDir)) {
    claudePaths.push({
      source: personalDir,
      target: 'personal',
      targetDir: personalSkillsDir,
      level: SettingsLevel.User,
    });
  }

  // Process all paths in parallel
  const importPromises = claudePaths.map(
    async ({
      source: claudePath,
      target: targetLocation,
      targetDir,
      level,
    }) => {
      logInfo('[ClaudeCodeImport] Scanning Claude skills at', {
        path: claudePath,
      });

      let skillDirs: fs.Dirent[];
      try {
        skillDirs = await fs.promises.readdir(claudePath, {
          withFileTypes: true,
        });
      } catch {
        // Directory doesn't exist or can't be read, skip silently
        return;
      }

      // Collect all skill import operations
      const skillImportPromises = skillDirs
        .filter((dir) => dir.isDirectory() || dir.isSymbolicLink())
        .map(async (dir) => {
          const skillName = dir.name;
          const skillMdPath = path.join(claudePath, skillName, 'SKILL.md');

          // Check if SKILL.md exists
          if (!fs.existsSync(skillMdPath)) {
            logWarn('[ClaudeCodeImport] No SKILL.md found for skill:', {
              name: skillName,
            });
            return;
          }

          // If specific skills are requested, check if this one is selected
          if (selectedSkills && selectedSkills.length > 0) {
            const isSelected = selectedSkills.some(
              (s) => s.name === skillName && s.location === targetLocation
            );
            if (!isSelected) {
              return; // Skip skills not selected by user
            }
          }

          try {
            const sanitizedName = sanitizeSkillName(skillName);
            const targetSkillDir = path.join(targetDir, sanitizedName);

            // Check if already exists
            if (fs.existsSync(targetSkillDir)) {
              results.skipped.push({
                name: skillName,
                reason: 'Already exists in target location',
              });
              logInfo('[ClaudeCodeImport] Skipped  - already exists', {
                name: skillName,
              });
              return;
            }

            const sourceSkillDir = path.join(claudePath, skillName);

            // Use SkillImportService to import the skill directory
            await skillImporter.importSkillDirectory(
              sourceSkillDir,
              sanitizedName,
              level
            );

            results.imported.push({
              name: skillName,
              source: sourceSkillDir,
              target: targetSkillDir,
            });

            logInfo('[ClaudeCodeImport] Imported  to ', {
              name: skillName,
              targetPath: targetSkillDir,
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            results.failed.push({
              name: skillName,
              error: errorMessage,
            });
            logException(error, 'Failed to import skill', {
              name: skillName,
            });
          }
        });

      await Promise.all(skillImportPromises);
    }
  );

  await Promise.all(importPromises);

  return results;
}

/**
 * Find available Claude Code skills without importing them
 */
export async function findAvailableClaudeCodeSkills(): Promise<{
  project: Array<{
    name: string;
    source: string;
    description?: string;
    exists: boolean;
  }>;
  personal: Array<{
    name: string;
    source: string;
    description?: string;
    exists: boolean;
  }>;
}> {
  const result = {
    project: [] as Array<{
      name: string;
      source: string;
      description?: string;
      exists: boolean;
    }>,
    personal: [] as Array<{
      name: string;
      source: string;
      description?: string;
      exists: boolean;
    }>,
  };

  // Use the same directory traversal as imports
  const { projectDirs, personalDir } = buildClaudeSearchDirs();

  // Get existing skills from SettingsManager
  const manager = SettingsManager.getInstance();
  const settings = await manager.getResolvedSettings();
  const existingSkills = new Set<string>(
    (settings.skills ?? []).map((s) => s.metadata.name.toLowerCase())
  );

  // Check all project Claude directories
  const projectSkillPromises = projectDirs.map(async (projectPath) => {
    if (!fs.existsSync(projectPath)) {
      return [];
    }

    try {
      const dirs = await fs.promises.readdir(projectPath, {
        withFileTypes: true,
      });

      return dirs
        .filter((dir) => dir.isDirectory())
        .filter((dir) => {
          const skillMdPath = path.join(projectPath, dir.name, 'SKILL.md');
          return fs.existsSync(skillMdPath);
        })
        .map((dir) => ({
          name: dir.name,
          source: projectPath,
          exists: existingSkills.has(dir.name.toLowerCase()),
        }));
    } catch {
      // Skip directories that can't be read
      return [];
    }
  });

  const projectSkillArrays = await Promise.all(projectSkillPromises);
  projectSkillArrays.flat().forEach((skill) => result.project.push(skill));

  // Check personal Claude directory
  if (fs.existsSync(personalDir)) {
    try {
      const dirs = await fs.promises.readdir(personalDir, {
        withFileTypes: true,
      });
      for (const dir of dirs) {
        if (dir.isDirectory()) {
          const skillMdPath = path.join(personalDir, dir.name, 'SKILL.md');
          if (fs.existsSync(skillMdPath)) {
            result.personal.push({
              name: dir.name,
              source: personalDir,
              exists: existingSkills.has(dir.name.toLowerCase()),
            });
          }
        }
      }
    } catch (error) {
      logException(error, 'Failed to scan personal Claude skills');
    }
  }

  return result;
}
