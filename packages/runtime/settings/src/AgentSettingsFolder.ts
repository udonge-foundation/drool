import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

import chokidar, { FSWatcher } from 'chokidar';

import {
  CommandSource,
  type CustomCommand,
  type CustomCommandSettings,
  type Settings,
  type Skill,
  type SkillSettings,
} from '@industry/common/settings';
import { SkillLocation } from '@industry/drool-sdk-ext/protocol/settings';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getIndustryHome } from '@industry/utils/cli';
import {
  collectSkillFilesSync,
  directoryExists,
  findCommandFiles,
  findSkillDirectories,
  loadCommandFile,
  loadSkillFile,
} from '@industry/utils/frontmatter';

import { AGENT_DIR_NAME, AGENTS_DIR_NAME } from './constants';
import { isPathEqualOrDescendant } from './pathComparison';

const SKILLS_DIR_NAME = 'skills';
const COMMANDS_DIR_NAME = 'commands';
const SKILL_PROMPT_FILE = 'SKILL.md';

const DEBOUNCE_MS = 300;

export class AgentSettingsFolder extends EventEmitter {
  private readonly folderPath: string;

  private watcher: FSWatcher | null = null;

  private debounceTimer: NodeJS.Timeout | null = null;

  private rebuildDebounceTimer: NodeJS.Timeout | null = null;

  private isWatching = false;

  constructor(folderPath: string, watch = false) {
    super();
    this.folderPath = folderPath;
    if (watch) {
      this.startWatching();
    }
  }

  getFolderPath(): string {
    return this.folderPath;
  }

  async load(): Promise<Settings> {
    const [skills, commands] = await Promise.all([
      this.loadSkills(),
      this.loadCommands(),
    ]);
    return { skills, commands };
  }

  persist = async (_data: Settings): Promise<void> => {
    throw new MetaError('Persistence is not supported for .agent settings');
  };

  readSettingsJsonRaw = async (): Promise<Record<string, unknown>> => {
    throw new MetaError('settings.json is not supported for .agent settings');
  };

  patchSettingsJsonRaw = async (
    _patch: Record<string, unknown>
  ): Promise<void> => {
    throw new MetaError('settings.json is not supported for .agent settings');
  };

  /**
   * Start watching for changes to skill and command files.
   *
   * Always watches the base folder so that creation of skills/ or commands/
   * triggers a rebuild. Recursively seeds individual SKILL.md and command
   * files so edits at any depth are detected.
   */
  startWatching(): void {
    if (this.isWatching) return;
    this.isWatching = true;

    if (!fs.existsSync(this.folderPath)) return;

    this.createWatcher();
  }

  private scheduleRebuild(): void {
    if (this.rebuildDebounceTimer) {
      clearTimeout(this.rebuildDebounceTimer);
    }
    this.rebuildDebounceTimer = setTimeout(() => {
      this.rebuildDebounceTimer = null;
      this.rebuildWatcher();
    }, DEBOUNCE_MS);
  }

  private rebuildWatcher(): void {
    if (this.watcher) {
      this.watcher.close().catch((error) => {
        logWarn('Error closing agent settings watcher during rebuild', {
          error,
        });
      });
      this.watcher = null;
    }

    this.createWatcher();
    this.scheduleChange();
  }

  /**
   * Build watch targets and create a chokidar watcher.
   *
   * Always includes the base folder so new skills/ or commands/ directories
   * trigger a rebuild. Recursively collects command files to match the
   * depth of findCommandFiles().
   */
  private createWatcher(): void {
    // Always watch base folder so skills/ or commands/ creation is detected
    const watchTargets: string[] = [this.folderPath];

    const skillsDir = path.join(this.folderPath, SKILLS_DIR_NAME);
    if (fs.existsSync(skillsDir)) {
      watchTargets.push(skillsDir);
      collectSkillFilesSync(skillsDir, watchTargets);
    }

    const commandsDir = path.join(this.folderPath, COMMANDS_DIR_NAME);
    if (fs.existsSync(commandsDir)) {
      AgentSettingsFolder.collectCommandFilesSync(commandsDir, watchTargets);
    }

    const knownTargets = new Set(watchTargets);

    this.watcher = chokidar.watch(watchTargets, {
      ignoreInitial: true,
      depth: 0,
      atomic: true,
    });

    this.watcher.on('all', (event, filePath) => {
      if (event === 'addDir' || event === 'add') {
        if (!knownTargets.has(filePath)) {
          this.scheduleRebuild();
        }
        return;
      }
      this.scheduleChange();
    });

    this.watcher.on('error', (error) => {
      logWarn('Agent settings watcher error', { error });
    });
  }

  /**
   * Recursively collect all files and directories under a commands/ tree
   * so the watcher can observe changes at any depth.
   */
  private static collectCommandFilesSync(dir: string, targets: string[]): void {
    targets.push(dir);
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          AgentSettingsFolder.collectCommandFilesSync(fullPath, targets);
        } else {
          targets.push(fullPath);
        }
      }
    } catch (err) {
      logWarn('Failed to read commands directory entries', { cause: err });
    }
  }

  stopWatching(): void {
    if (!this.isWatching) return;
    this.isWatching = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.rebuildDebounceTimer) {
      clearTimeout(this.rebuildDebounceTimer);
      this.rebuildDebounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close().catch((error) => {
        logWarn('Error closing agent settings watcher', { error });
      });
      this.watcher = null;
    }
  }

  static isRelevantChange(relativePath: string): boolean {
    const normalized = relativePath.split(path.sep).join('/');
    if (
      normalized.startsWith(`${SKILLS_DIR_NAME}/`) &&
      normalized.endsWith(`/${SKILL_PROMPT_FILE}`)
    ) {
      return true;
    }
    if (normalized.startsWith(`${COMMANDS_DIR_NAME}/`)) {
      return true;
    }
    return false;
  }

  private scheduleChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.emit('change', { folderPath: this.folderPath });
    }, DEBOUNCE_MS);
  }

  private async loadSkills(): Promise<SkillSettings | undefined> {
    const skillsDir = path.join(this.folderPath, SKILLS_DIR_NAME);

    try {
      const exists = await directoryExists(skillsDir);
      if (!exists) return undefined;

      const skillDirPaths = await findSkillDirectories(skillsDir);
      if (skillDirPaths.length === 0) return undefined;

      const location = AgentSettingsFolder.determineLocation(this.folderPath);

      const skillPromises = skillDirPaths.map((dirPath) => {
        const promptFile = path.join(dirPath, SKILL_PROMPT_FILE);
        return loadSkillFile(promptFile, location);
      });

      const results = await Promise.all(skillPromises);
      const skills = results.filter((s): s is Skill => s !== null);

      return skills.length > 0 ? skills : undefined;
    } catch (error) {
      logWarn('Failed to load skills from .agent folder', {
        path: this.folderPath,
        directory: skillsDir,
        error,
      });
      return undefined;
    }
  }

  private static determineLocation(folderPath: string): SkillLocation {
    const homeAgentDir = path.join(getIndustryHome(), AGENT_DIR_NAME);
    const homeAgentsDir = path.join(getIndustryHome(), AGENTS_DIR_NAME);
    if (
      isPathEqualOrDescendant(folderPath, homeAgentDir) ||
      isPathEqualOrDescendant(folderPath, homeAgentsDir)
    ) {
      return SkillLocation.Personal;
    }
    return SkillLocation.Project;
  }

  // ===========================================================================
  // Commands (commands/*)
  // ===========================================================================

  private async loadCommands(): Promise<CustomCommandSettings | undefined> {
    const commandsDir = path.join(this.folderPath, COMMANDS_DIR_NAME);

    try {
      const exists = await directoryExists(commandsDir);
      if (!exists) return undefined;

      const filePaths = await findCommandFiles(commandsDir);
      if (filePaths.length === 0) return undefined;

      const source = AgentSettingsFolder.determineCommandSource(
        this.folderPath
      );

      const commandPromises = filePaths.map((fp) =>
        loadCommandFile(fp, source)
      );

      const results = await Promise.all(commandPromises);
      const commands = results.filter((c): c is CustomCommand => c !== null);

      return commands.length > 0 ? commands : undefined;
    } catch (error) {
      logWarn('Failed to load commands from .agent folder', {
        path: this.folderPath,
        directory: commandsDir,
        error,
      });
      return undefined;
    }
  }

  private static determineCommandSource(folderPath: string): CommandSource {
    const homeAgentDir = path.join(getIndustryHome(), AGENT_DIR_NAME);
    const homeAgentsDir = path.join(getIndustryHome(), AGENTS_DIR_NAME);
    if (
      isPathEqualOrDescendant(folderPath, homeAgentDir) ||
      isPathEqualOrDescendant(folderPath, homeAgentsDir)
    ) {
      return CommandSource.Global;
    }
    return CommandSource.Workspace;
  }
}
