import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DroolLocation } from '@industry/drool-sdk-ext/protocol/settings';
import { logException } from '@industry/logging';
import { SettingsManager } from '@industry/runtime/settings';
import { promisePool } from '@industry/utils/promise';

import { DroolParser } from '@/services/drools/DroolParser';
import { DroolStorageService } from '@/services/drools/DroolStorageService';
import { parseClaudeCodeSubagent } from '@/utils/drools/parseClaudeCodeSubagent';
import type { ClaudeCodeSubagent, ImportResult } from '@/utils/drools/types';

const CONCURRENCY_LIMIT = 10;

/**
 * Detect subagents in a specific location
 */
async function detectSubagentsInLocation(
  location: DroolLocation
): Promise<ClaudeCodeSubagent[]> {
  let claudeAgentsDir: string;
  if (location === DroolLocation.Project) {
    // Only scan project subagents when we actually resolved a project root
    // (git-rooted .industry/). Without a project root, importing project
    // subagents would later fail in DroolStorageService.createDrool with
    // "Cannot determine target path for drool".
    const projectSettingsPath = SettingsManager.getInstance().getProjectPath();
    if (!projectSettingsPath) {
      return [];
    }

    const projectRoot = path.dirname(projectSettingsPath);
    claudeAgentsDir = path.join(projectRoot, '.claude', 'agents');
  } else {
    claudeAgentsDir = path.join(os.homedir(), '.claude', 'agents');
  }

  try {
    // Check if directory exists
    const stats = await fs.promises.stat(claudeAgentsDir);
    if (!stats.isDirectory()) {
      return [];
    }

    // Read all .md files
    const files = await fs.promises.readdir(claudeAgentsDir);
    const mdFiles = files.filter((f) => f.endsWith('.md'));

    const tasks = mdFiles.map(
      (file) => async (): Promise<ClaudeCodeSubagent | null> => {
        const filePath = path.join(claudeAgentsDir, file);
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const parsed = await parseClaudeCodeSubagent(content);

          const storage = new DroolStorageService();
          const exists = await storage.readDrool(
            parsed.metadata.name,
            location
          );

          return {
            name: parsed.metadata.name,
            location,
            filePath,
            metadata: parsed.metadata,
            systemPrompt: parsed.systemPrompt,
            exists: exists !== null,
          };
        } catch (error) {
          logException(error, 'Failed to parse Claude Code subagent', {
            fileName: file,
            filePath,
            location,
          });
          return null;
        }
      }
    );

    // Process files with concurrency limit
    const { results } = await promisePool(tasks, CONCURRENCY_LIMIT, {
      throwErrors: false,
    });
    const subagents: ClaudeCodeSubagent[] = results.filter(
      (s): s is ClaudeCodeSubagent => !!s
    );

    return subagents;
  } catch (error) {
    // Directory doesn't exist or can't be read
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logException(
        error,
        'Failed to detect Claude Code subagents from directory'
      );
    }
    return [];
  }
}

/**
 * Detect Claude Code subagents in the system
 */
export async function detectClaudeCodeSubagents(): Promise<{
  project: ClaudeCodeSubagent[];
  personal: ClaudeCodeSubagent[];
  totalCount: number;
}> {
  const [projectSubagents, personalSubagents] = await Promise.all([
    detectSubagentsInLocation(DroolLocation.Project),
    detectSubagentsInLocation(DroolLocation.Personal),
  ]);

  return {
    project: projectSubagents,
    personal: personalSubagents,
    totalCount: projectSubagents.length + personalSubagents.length,
  };
}

/**
 * Import selected Claude Code subagents
 */
export async function importClaudeCodeSubagents(
  subagents: ClaudeCodeSubagent[],
  options: {
    overwrite?: boolean;
    skipExisting?: boolean;
  } = {}
): Promise<ImportResult[]> {
  const storage = new DroolStorageService();

  // Create tasks for importing subagents
  const tasks = subagents.map((subagent) => async (): Promise<ImportResult> => {
    try {
      // Check if already exists
      const existing = await storage.readDrool(
        subagent.metadata.name,
        subagent.location
      );

      if (existing) {
        if (options.skipExisting) {
          return {
            name: subagent.metadata.name,
            success: false,
            message: 'Skipped (already exists)',
            location: subagent.location,
          };
        }
        if (!options.overwrite) {
          return {
            name: subagent.metadata.name,
            success: false,
            message: 'Already exists (use overwrite option)',
            location: subagent.location,
          };
        }
      }

      const content = DroolParser.stringify(
        subagent.systemPrompt,
        subagent.metadata
      );
      await storage.importDrool(content, subagent.location, options.overwrite);

      return {
        name: subagent.metadata.name,
        success: true,
        message: existing ? 'Overwritten' : 'Imported',
        location: subagent.location,
      };
    } catch (error) {
      logException(error, 'Failed to import subagent');

      return {
        name: subagent.metadata.name,
        success: false,
        message:
          error instanceof Error ? error.message : 'Unknown error occurred',
        location: subagent.location,
      };
    }
  });

  // Process imports with concurrency limit
  const { results } = await promisePool(tasks, CONCURRENCY_LIMIT, {
    throwErrors: false,
  });
  return results.filter((r): r is ImportResult => r !== undefined);
}
