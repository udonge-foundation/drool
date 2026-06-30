/**
 * IndustrySettingsFolder - File I/O for a single .industry folder with optional file watching
 *
 * This class handles loading and persisting settings from/to disk.
 * It does NOT handle merging or hierarchy resolution - that's SettingsManager's job.
 *
 * When watching is enabled, emits 'change' events when relevant settings files are modified.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

import { writeFile as writeFileAtomic } from 'atomically';
import chokidar, { FSWatcher } from 'chokidar';
import * as yaml from 'js-yaml';
import {
  applyEdits,
  modify as modifyJsonc,
  parse as parseJsonc,
  type ParseError,
} from 'jsonc-parser';

import {
  CommandSource,
  type CustomCommand,
  type CustomCommandSettings,
  type CustomDrool,
  type CustomDroolSettings,
  type CustomModel,
  type CustomModelSettings,
  type DroolMetadata,
  type GeneralSettings,
  type HookSettings,
  HookSettingsSchema,
  type McpServerConfig,
  type McpSettings,
  type Settings,
  type Skill,
  type SkillSettings,
} from '@industry/common/settings';
import {
  DroolLocation,
  SkillLocation,
} from '@industry/drool-sdk-ext/protocol/settings';
import { logException, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  INSTALLED_PLUGINS_FILE,
  KNOWN_MARKETPLACES_FILE,
  PLUGINS_DIR,
} from '@industry/runtime/plugins/constants';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import {
  collectSkillFilesSync,
  directoryExists,
  fileExists,
  findCommandFiles,
  findSkillDirectories,
  loadCommandFile,
  loadDroolFile,
  loadSkillFile,
} from '@industry/utils/frontmatter';
import { parseReasoningEffort } from '@industry/utils/llm';
import {
  buildCustomModelId,
  computeStableIndices,
} from '@industry/utils/models';

import { SETTINGS_FILE_NAME, SETTINGS_LOCAL_FILE_NAME } from './constants';
import { isPathEqualOrDescendant } from './pathComparison';
import {
  customModelProviderSupportsImagesByDefault,
  isBedrockCustomModelConfig,
  normalizeGeneralSettings,
  parseCustomModelsFromSettings as parseCustomModelsFromGeneralSettings,
  parseCustomModelProvider,
  warnOnUnknownHookEventKeys,
} from './SettingsParsing';

const CONFIG_FILE_NAME = 'config.json';
const MCP_FILE_NAME = 'mcp.json';
const DROOLS_DIR_NAME = 'drools';
const SKILLS_DIR_NAME = 'skills';
const COMMANDS_DIR_NAME = 'commands';
const LEGACY_HOOKS_DIR_NAME = 'hooks';
const HOOKS_FILE_NAME = 'hooks.json';
const MIGRATED_HOOKS_FILE_NAME = 'hooks.migrated.json';
const SKILL_PROMPT_FILE = 'SKILL.md';

const DEBOUNCE_MS = 300;
const ATOMIC_TEMP_SUFFIX = /\.tmp-\d{10}[0-9a-f]{6}$/;

function stripAtomicTempSuffix(filePath: string): string {
  return filePath.replace(ATOMIC_TEMP_SUFFIX, '');
}

/**
 * IndustrySettingsFolder - File I/O operations for .industry folders
 *
 * Instance-based class that can optionally watch for file changes and emit events.
 */
export class IndustrySettingsFolder extends EventEmitter {
  private readonly folderPath: string;

  private watcher: FSWatcher | null = null;

  private rootWatcher: FSWatcher | null = null;

  // Single handle for the whole .industry tree (native recursive fs.watch).
  private nativeWatcher: fs.FSWatcher | null = null;

  private debounceTimer: NodeJS.Timeout | null = null;

  private isWatching = false;

  constructor(folderPath: string, watch = false) {
    super();
    this.folderPath = folderPath;
    if (watch) {
      this.startWatching();
    }
  }

  /**
   * Get the folder path this instance manages
   */
  getFolderPath(): string {
    return this.folderPath;
  }

  /**
   * Load all settings from this .industry folder
   */
  async load(): Promise<Settings> {
    const [general, mcp, drools, skills, hooks, commands, customModels] =
      await Promise.all([
        this.loadGeneral(),
        this.loadMcp(),
        this.loadDrools(),
        this.loadSkills(),
        this.loadHooks(),
        this.loadCommands(),
        this.loadCustomModels(),
      ]);

    // Merge customModels from both sources:
    // - settings.json (general.customModels) - primary source (camelCase)
    // - config.json (customModels from loadCustomModels) - legacy source (snake_case)
    // Models from settings.json come first, then config.json models are appended.
    // Deduplicate legacy config.json models by model name or generated id to
    // avoid showing the same model twice after migration to settings.json.
    const settingsModels = general?.customModels ?? [];
    const configModels = customModels ?? [];
    const settingsModelNames = new Set(settingsModels.map((m) => m.model));
    const settingsModelIds = new Set(settingsModels.map((m) => m.id));
    const uniqueConfigModels = configModels.filter(
      (m) => !settingsModelNames.has(m.model) && !settingsModelIds.has(m.id)
    );
    const mergedCustomModels =
      settingsModels.length > 0 || uniqueConfigModels.length > 0
        ? [...settingsModels, ...uniqueConfigModels]
        : undefined;

    const mergedGeneral =
      general || mergedCustomModels
        ? { ...general, customModels: mergedCustomModels }
        : undefined;

    return { general: mergedGeneral, mcp, drools, skills, hooks, commands };
  }

  /**
   * Persist settings to this .industry folder
   * Note: Hooks are written to hooks.json (not settings.json)
   */
  async persist(data: Settings): Promise<void> {
    await fs.promises.mkdir(this.folderPath, { recursive: true });

    const promises: Promise<void>[] = [];

    // Write general settings to settings.json (without hooks)
    if (data.general != null) {
      promises.push(this.persistSettingsJson(data.general));
    }

    // Write hooks to hooks.json
    if (data.hooks != null) {
      promises.push(this.persistHooksJson(data.hooks));
    }

    if (data.mcp != null) {
      promises.push(this.persistMcp(data.mcp));
    }

    if (data.drools != null) {
      promises.push(this.persistDrools(data.drools));
    }

    await Promise.all(promises);
  }

  /**
   * Read settings.json and return both its raw text and parsed object.
   * Returns undefined when the file does not exist.
   * Throws when the file exists but contains invalid JSON/JSONC, or is not
   * an object, so callers don't silently treat a malformed file as empty.
   */
  private async readSettingsJsonRawWithContent(): Promise<
    { content: string; parsed: Record<string, unknown> } | undefined
  > {
    const filePath = path.join(this.folderPath, SETTINGS_FILE_NAME);
    let content: string;
    try {
      content = await fs.promises.readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }

    const errors: ParseError[] = [];
    const parsed = parseJsonc(content, errors) as unknown;
    if (errors.length > 0) {
      throw new MetaError('settings.json contains invalid JSON/JSONC', {
        path: filePath,
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new MetaError('settings.json must contain a JSON object', {
        path: filePath,
      });
    }
    return { content, parsed: parsed as Record<string, unknown> };
  }

  /**
   * Read the raw (unparsed, unnormalized) contents of settings.json.
   * Returns an empty object when the file does not exist.
   * Throws when the file exists but contains invalid JSON/JSONC, or is not
   * an object, so callers don't silently treat a malformed file as empty.
   */
  async readSettingsJsonRaw(): Promise<Record<string, unknown>> {
    const raw = await this.readSettingsJsonRawWithContent();
    return raw?.parsed ?? {};
  }

  /**
   * Shallow-merge the given top-level keys into settings.json via surgical
   * JSONC text edits: untouched keys, comments, and formatting are preserved
   * byte-for-byte, and no parse/serialize round trip occurs, so env var
   * references like `${VAR}` in custom model API keys are never expanded
   * onto disk. A key patched with `undefined` is removed.
   *
   * The file can hold BYOK API keys, so it is written with owner-only
   * permissions (0600 file / 0700 for a newly created folder).
   */
  async patchSettingsJsonRaw(patch: Record<string, unknown>): Promise<void> {
    const existing = await this.readSettingsJsonRawWithContent();
    let content = existing?.content ?? '{}';
    for (const [key, value] of Object.entries(patch)) {
      const edits = modifyJsonc(content, [key], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      content = applyEdits(content, edits);
    }

    await fs.promises.mkdir(this.folderPath, {
      recursive: true,
      mode: 0o700,
    });
    const filePath = path.join(this.folderPath, SETTINGS_FILE_NAME);
    await writeFileAtomic(filePath, content, { mode: 0o600 });
  }

  // ===========================================================================
  // File Watching
  // ===========================================================================

  /**
   * Start watching for changes to settings files using chokidar.
   *
   * Instead of watching the entire .industry folder recursively (which causes
   * Bun's kqueue-based fs.watch to open one FD per file in the tree, including
   * sessions, artifacts, snapshots, etc.), we watch only the specific paths
   * that contain settings-relevant files.
   *
   * When the folder doesn't exist yet, watches the parent directory for its
   * creation and then sets up detailed watchers.
   */
  startWatching(): void {
    if (this.isWatching) return;
    this.isWatching = true;

    if (!fs.existsSync(this.folderPath)) {
      this.watchForFolderCreation();
      return;
    }

    this.setupDetailedWatchers();
  }

  /**
   * Watch the parent directory for the creation of this .industry folder.
   * Once detected, sets up detailed watchers on the folder contents.
   */
  private watchForFolderCreation(): void {
    const parentDir = path.dirname(this.folderPath);
    const folderName = path.basename(this.folderPath);

    if (!fs.existsSync(parentDir)) {
      logWarn(
        'Cannot watch for .industry folder creation: parent directory does not exist',
        {
          parentDir,
        }
      );
      return;
    }

    this.watcher = chokidar.watch(parentDir, {
      ignoreInitial: true,
      depth: 0,
    });

    this.watcher.on('addDir', (dirPath) => {
      if (path.basename(dirPath) === folderName) {
        // Folder was created - close parent watcher and set up detailed watchers
        if (this.watcher) {
          this.watcher.close().catch((error) => {
            logWarn('Error closing parent directory watcher', { error });
          });
          this.watcher = null;
        }

        this.setupDetailedWatchers();

        // Emit change so settings are reloaded with the new folder contents
        this.scheduleChange();
      }
    });

    this.watcher.on('error', (error) => {
      logWarn('Parent directory watcher error', { error });
    });
  }

  /**
   * Set up file-change watchers on this .industry folder. Prefers a single
   * native recursive fs.watch; falls back to a scoped chokidar watcher
   * whenever that call fails. Both paths route through the active-source-aware
   * relevance filters.
   */
  private setupDetailedWatchers(): void {
    if (this.tryNativeRecursiveWatcher()) return;
    this.setupChokidarFallbackWatcher();
  }

  /** Returns true on success, false on any failure (caller falls back). */
  private tryNativeRecursiveWatcher(): boolean {
    try {
      const watcher = fs.watch(
        this.folderPath,
        { recursive: true, persistent: true },
        (_eventType, filename) => {
          if (!filename) {
            this.scheduleChange();
            return;
          }
          const relativePath =
            typeof filename === 'string'
              ? filename
              : (filename as Buffer).toString('utf8');
          if (this.isRelevantChange(relativePath)) {
            this.scheduleChange();
            return;
          }
          // Top-level entries (e.g. a newly-created drools/ or a
          // settings.json appearing after startup) fire as a file-level
          // event whose relative path has no separator.
          const topLevel = relativePath.split(path.sep)[0];
          if (
            topLevel &&
            topLevel === relativePath &&
            this.isRelevantRootEntry(topLevel)
          ) {
            this.scheduleChange();
          }
        }
      );
      watcher.on('error', (error) => {
        logWarn('Settings watcher error (native)', { error });
      });
      // Don't keep the event loop alive; other handles do.
      watcher.unref();
      this.nativeWatcher = watcher;
      return true;
    } catch (error) {
      // Any failure here routes through the chokidar fallback.
      logWarn(
        'Native recursive fs.watch unavailable, falling back to chokidar',
        { cause: error instanceof Error ? error.message : String(error) }
      );
      return false;
    }
  }

  /** Chokidar fallback used whenever the native recursive watch fails to start. */
  private setupChokidarFallbackWatcher(): void {
    const relevantTopLevelDirs = new Set([
      DROOLS_DIR_NAME,
      SKILLS_DIR_NAME,
      COMMANDS_DIR_NAME,
      LEGACY_HOOKS_DIR_NAME,
      PLUGINS_DIR,
    ]);

    this.watcher = chokidar.watch(this.folderPath, {
      ignoreInitial: true,
      persistent: true,
      atomic: true,
      ignored: (filePath: string, stats?: fs.Stats) => {
        // Let chokidar stat unknown entries before we filter them.
        if (!stats) return false;
        const relativePath = path.relative(this.folderPath, filePath);
        if (stats.isDirectory()) {
          // Always allow the root folder itself.
          if (!relativePath) return false;
          const parts = relativePath.split(path.sep);
          const top = parts[0];
          if (!relevantTopLevelDirs.has(top)) return true;
          // Allow full descent under relevant roots. File-level filter
          // (isRelevantChange) handles irrelevant files inside.
          return false;
        }
        // Files: only relevant settings files pass through.
        return !this.isRelevantChange(relativePath);
      },
    });

    this.watcher.on('all', (_event, filePath) => {
      const relativePath = path.relative(this.folderPath, filePath);
      if (this.isRelevantChange(relativePath)) {
        this.scheduleChange();
        return;
      }
      // Detect creation/removal of a top-level settings dir (e.g. drools/
      // appearing for the first time) so hierarchy is re-resolved.
      const topLevel = relativePath.split(path.sep)[0];
      if (
        topLevel &&
        topLevel === relativePath &&
        this.isRelevantRootEntry(topLevel)
      ) {
        this.scheduleChange();
      }
    });

    this.watcher.on('error', (error) => {
      logWarn('Settings watcher error', { error });
    });
  }

  /**
   * Stop watching for file changes
   */
  stopWatching(): void {
    if (!this.isWatching) return;
    this.isWatching = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.nativeWatcher) {
      try {
        this.nativeWatcher.close();
      } catch (error) {
        logWarn('Error closing native settings watcher', { error });
      }
      this.nativeWatcher = null;
    }

    if (this.watcher) {
      this.watcher.close().catch((error) => {
        logWarn('Error closing settings watcher', { error });
      });
      this.watcher = null;
    }

    if (this.rootWatcher) {
      this.rootWatcher.close().catch((error) => {
        logWarn('Error closing root settings watcher', { error });
      });
      this.rootWatcher = null;
    }
  }

  /**
   * Build the list of specific paths to watch for settings changes.
   *
   * Returns two kinds of targets:
   * 1. Directories (drools/, skills/, commands/, transitional hooks/) - watched at
   *    depth 0 to detect new entries (new files or subdirectories).
   *    On macOS/kqueue this costs 1 FD per directory, NOT per child.
   * 2. Individual settings files (SKILL.md, drool .md, hooks.json, etc.)
   *    - watched directly for content changes.
   *
   * When a new directory appears under skills/ (addDir event), a rebuild
   * is triggered which re-enumerates and watches the new SKILL.md file.
   */
  static getWatchTargets(folderPath: string): string[] {
    const targets: string[] = [];

    // Root-level config files
    for (const file of [
      SETTINGS_FILE_NAME,
      SETTINGS_LOCAL_FILE_NAME,
      MCP_FILE_NAME,
      CONFIG_FILE_NAME,
    ]) {
      const filePath = path.join(folderPath, file);
      if (fs.existsSync(filePath)) {
        targets.push(filePath);
      }
    }

    // Plugin files
    for (const file of [INSTALLED_PLUGINS_FILE, KNOWN_MARKETPLACES_FILE]) {
      const filePath = path.join(folderPath, PLUGINS_DIR, file);
      if (fs.existsSync(filePath)) {
        targets.push(filePath);
      }
    }

    // Settings directories - watched at depth 0 for new-entry detection.
    // Each costs only 1 FD (the directory inode itself).
    for (const dir of [DROOLS_DIR_NAME, SKILLS_DIR_NAME, COMMANDS_DIR_NAME]) {
      const dirPath = path.join(folderPath, dir);
      if (fs.existsSync(dirPath)) {
        targets.push(dirPath);
      }
    }

    // Canonical hooks file, or the active legacy source until it is persisted.
    const hooksFile = path.join(folderPath, HOOKS_FILE_NAME);
    if (fs.existsSync(hooksFile)) {
      targets.push(hooksFile);
    } else {
      const legacyHooksDir = path.join(folderPath, LEGACY_HOOKS_DIR_NAME);
      const legacyHooksFile = path.join(legacyHooksDir, HOOKS_FILE_NAME);
      if (fs.existsSync(legacyHooksDir)) {
        targets.push(legacyHooksDir);
      }
      if (fs.existsSync(legacyHooksFile)) {
        targets.push(legacyHooksFile);
      }
    }

    // Drool files: drools/*.md
    const droolsDir = path.join(folderPath, DROOLS_DIR_NAME);
    if (fs.existsSync(droolsDir)) {
      try {
        for (const file of fs.readdirSync(droolsDir)) {
          if (file.endsWith('.md')) {
            targets.push(path.join(droolsDir, file));
          }
        }
      } catch (err) {
        logWarn('Failed to read drools directory', { cause: err });
      }
    }

    // Skill files: skills/**/SKILL.md
    const skillsDir = path.join(folderPath, SKILLS_DIR_NAME);
    if (fs.existsSync(skillsDir)) {
      collectSkillFilesSync(skillsDir, targets);
    }

    // Command files: commands/*
    const commandsDir = path.join(folderPath, COMMANDS_DIR_NAME);
    if (fs.existsSync(commandsDir)) {
      try {
        for (const file of fs.readdirSync(commandsDir)) {
          targets.push(path.join(commandsDir, file));
        }
      } catch (err) {
        logWarn('Failed to read commands directory', { cause: err });
      }
    }

    return targets;
  }

  /**
   * Check if a file change is relevant to settings (should trigger reload).
   * Always normalizes to forward slashes so Windows-delivered filenames match.
   */
  static isRelevantChange(
    relativePath: string,
    legacyHooksSourceActive = false
  ): boolean {
    const normalized = stripAtomicTempSuffix(
      relativePath.replace(/[\\]/g, '/')
    );

    // Root-level config files
    if (
      [
        SETTINGS_FILE_NAME,
        SETTINGS_LOCAL_FILE_NAME,
        MCP_FILE_NAME,
        CONFIG_FILE_NAME,
      ].includes(normalized)
    ) {
      return true;
    }
    if (normalized === HOOKS_FILE_NAME) {
      return true;
    }
    if (
      legacyHooksSourceActive &&
      normalized === `${LEGACY_HOOKS_DIR_NAME}/${HOOKS_FILE_NAME}`
    ) {
      return true;
    }
    // Drool files: drools/*.md
    if (
      normalized.startsWith(`${DROOLS_DIR_NAME}/`) &&
      normalized.endsWith('.md')
    ) {
      return true;
    }
    // Skill files: skills/*/SKILL.md
    if (
      normalized.startsWith(`${SKILLS_DIR_NAME}/`) &&
      normalized.endsWith(SKILL_PROMPT_FILE)
    ) {
      return true;
    }
    // Command files: commands/*
    if (normalized.startsWith(`${COMMANDS_DIR_NAME}/`)) {
      return true;
    }
    // Plugin files
    if (
      normalized === `${PLUGINS_DIR}/${INSTALLED_PLUGINS_FILE}` ||
      normalized === `${PLUGINS_DIR}/${KNOWN_MARKETPLACES_FILE}`
    ) {
      return true;
    }
    return false;
  }

  /**
   * Check if a root-level entry (file or directory created directly under
   * .industry) is relevant enough to warrant rebuilding watchers.
   */
  static isRelevantRootEntry(
    relativePath: string,
    legacyHooksSourceActive = false
  ): boolean {
    const normalized = stripAtomicTempSuffix(
      relativePath.replace(/[\\]/g, '/')
    );
    // Ignore nested paths (depth 0 watcher should only fire for direct children)
    if (normalized.includes('/')) return false;

    const relevantNames = new Set([
      SETTINGS_FILE_NAME,
      SETTINGS_LOCAL_FILE_NAME,
      MCP_FILE_NAME,
      CONFIG_FILE_NAME,
      HOOKS_FILE_NAME,
      DROOLS_DIR_NAME,
      SKILLS_DIR_NAME,
      COMMANDS_DIR_NAME,
      PLUGINS_DIR,
    ]);
    if (legacyHooksSourceActive) {
      relevantNames.add(LEGACY_HOOKS_DIR_NAME);
    }
    return relevantNames.has(normalized);
  }

  private isLegacyHooksSourceActive(): boolean {
    return !fs.existsSync(path.join(this.folderPath, HOOKS_FILE_NAME));
  }

  private isRelevantChange(relativePath: string): boolean {
    return IndustrySettingsFolder.isRelevantChange(
      relativePath,
      this.isLegacyHooksSourceActive()
    );
  }

  private isRelevantRootEntry(relativePath: string): boolean {
    return IndustrySettingsFolder.isRelevantRootEntry(
      relativePath,
      this.isLegacyHooksSourceActive()
    );
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

  // ===========================================================================
  // General Settings (settings.json)
  // ===========================================================================

  private async loadGeneral(): Promise<GeneralSettings | undefined> {
    const [general, localGeneral] = await Promise.all([
      IndustrySettingsFolder.loadGeneralFromFile(
        path.join(this.folderPath, SETTINGS_FILE_NAME)
      ),
      IndustrySettingsFolder.loadGeneralFromFile(
        path.join(this.folderPath, SETTINGS_LOCAL_FILE_NAME)
      ),
    ]);

    if (!general && !localGeneral) return undefined;
    return { ...general, ...localGeneral };
  }

  private static async loadGeneralFromFile(
    filePath: string
  ): Promise<GeneralSettings | undefined> {
    try {
      const exists = await fileExists(filePath);
      if (!exists) return undefined;

      const content = await fs.promises.readFile(filePath, 'utf-8');
      const errors: ParseError[] = [];
      const parsed = parseJsonc(content, errors) as Record<string, unknown>;
      if (errors.length > 0) return undefined;

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return undefined;
      }

      return normalizeGeneralSettings(parsed) as GeneralSettings;
    } catch (error) {
      logWarn('Failed to load settings file', {
        path: filePath,
        error,
      });
      return undefined;
    }
  }

  /**
   * Persist general settings to settings.json (without hooks).
   * Hooks are now stored separately in hooks.json.
   */
  private async persistSettingsJson(
    general: GeneralSettings | undefined
  ): Promise<void> {
    const filePath = path.join(this.folderPath, SETTINGS_FILE_NAME);

    // Guard: refuse to overwrite a malformed settings.json.
    // If the file exists but contains invalid JSON, the user must fix it
    // manually (or delete it) so /diagnostics can report the issue.
    try {
      const existing = await fs.promises.readFile(filePath, 'utf-8');
      const errors: ParseError[] = [];
      parseJsonc(existing, errors);
      if (errors.length > 0) throw new MetaError('malformed');
    } catch (error) {
      // ENOENT means the file doesn't exist yet - safe to create.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logWarn(
          'Refusing to overwrite malformed settings.json - fix or delete the file manually',
          { path: filePath }
        );
        return;
      }
    }

    const settingsObj: Record<string, unknown> = {};

    if (general) {
      Object.assign(settingsObj, general);
    }

    const content = JSON.stringify(settingsObj, null, 2);
    try {
      await writeFileAtomic(filePath, content);
    } catch (error) {
      logException(error, 'Failed to write settings.json', { path: filePath });
    }
  }

  /**
   * Persist hooks to hooks.json.
   * Note: Does NOT remove hooks from settings.json - both sources are supported.
   */
  private async persistHooksJson(hooks: HookSettings): Promise<void> {
    const filePath = path.join(this.folderPath, HOOKS_FILE_NAME);

    const content = JSON.stringify(hooks, null, 2);
    try {
      await writeFileAtomic(filePath, content);
      await this.archiveLegacyHooksFile();
    } catch (error) {
      logException(error, 'Failed to write hooks.json', {
        path: filePath,
      });
    }
  }

  private async archiveLegacyHooksFile(): Promise<void> {
    const legacyPath = path.join(
      this.folderPath,
      LEGACY_HOOKS_DIR_NAME,
      HOOKS_FILE_NAME
    );
    const migratedPath = path.join(
      this.folderPath,
      LEGACY_HOOKS_DIR_NAME,
      MIGRATED_HOOKS_FILE_NAME
    );

    try {
      await fs.promises.rename(legacyPath, migratedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      logWarn('Failed to archive legacy hooks file after migration', {
        path: legacyPath,
        error,
      });
    }
  }

  // ===========================================================================
  // MCP Settings (mcp.json)
  // ===========================================================================

  private async loadMcp(): Promise<McpSettings | undefined> {
    const filePath = path.join(this.folderPath, MCP_FILE_NAME);

    try {
      const exists = await fileExists(filePath);
      if (!exists) return undefined;

      const content = await fs.promises.readFile(filePath, 'utf-8');
      const mcpErrors: ParseError[] = [];
      const parsed = parseJsonc(content, mcpErrors) as {
        mcpServers?: Record<string, McpServerConfig>;
        persistentPermissions?: McpSettings['persistentPermissions'];
      };
      if (mcpErrors.length > 0) return undefined;

      const mcpServers =
        parsed.mcpServers && typeof parsed.mcpServers === 'object'
          ? parsed.mcpServers
          : {};

      return {
        mcpServers,
        persistentPermissions: parsed.persistentPermissions,
      };
    } catch (error) {
      logWarn('Failed to load mcp.json', { path: filePath, error });
      return undefined;
    }
  }

  private async persistMcp(data: McpSettings): Promise<void> {
    const filePath = path.join(this.folderPath, MCP_FILE_NAME);
    const content = JSON.stringify(data, null, 2);
    try {
      await writeFileAtomic(filePath, content);
    } catch (error) {
      logException(error, 'Failed to write mcp.json', { path: filePath });
    }
  }

  // ===========================================================================
  // Drools (drools/*.md)
  // ===========================================================================

  private async loadDrools(): Promise<CustomDroolSettings | undefined> {
    const droolsDir = path.join(this.folderPath, DROOLS_DIR_NAME);

    try {
      const exists = await directoryExists(droolsDir);
      if (!exists) return undefined;

      const files = await fs.promises.readdir(droolsDir);
      const mdFiles = files.filter((f) => f.endsWith('.md'));

      if (mdFiles.length === 0) return undefined;

      const location = IndustrySettingsFolder.determineLocation(this.folderPath);

      const droolPromises = mdFiles.map((file) => {
        const filePath = path.join(droolsDir, file);
        return loadDroolFile(filePath, location);
      });

      const results = await Promise.all(droolPromises);
      const drools = results.filter((d): d is CustomDrool => d !== null);

      if (drools.length === 0) return undefined;

      return { customDrools: drools };
    } catch (error) {
      logWarn('Failed to load drools directory', { path: droolsDir, error });
      return undefined;
    }
  }

  private async persistDrools(data: CustomDroolSettings): Promise<void> {
    const droolsDir = path.join(this.folderPath, DROOLS_DIR_NAME);
    await fs.promises.mkdir(droolsDir, { recursive: true });

    const droolsToWrite = data.customDrools ?? [];

    const sanitizeFileName = (name: string): string =>
      name.replace(/[/\\]/g, '-').replace(/\.\./g, '').replace(/^\.+/, '');

    const expectedFiles = new Set(
      droolsToWrite.map((d) => `${sanitizeFileName(d.metadata.name)}.md`)
    );

    const resolvedDroolsDir = path.resolve(droolsDir);

    const writePromises = droolsToWrite.map(async (drool) => {
      const safeName = sanitizeFileName(drool.metadata.name);
      const fileName = `${safeName}.md`;
      const filePath = path.join(droolsDir, fileName);

      const resolvedPath = path.resolve(filePath);
      if (!resolvedPath.startsWith(resolvedDroolsDir + path.sep)) {
        throw new MetaError(
          'Invalid drool name contains path traversal characters'
        );
      }

      const newContent = IndustrySettingsFolder.stringifyDrool(
        drool.systemPrompt,
        drool.metadata
      );

      // Only write if content has changed to avoid unnecessary file modifications
      // This fixes the bug where drool files were modified on every load (Issue #547)
      const existingContent = await fs.promises
        .readFile(filePath, 'utf-8')
        .catch(() => null);

      if (existingContent !== newContent) {
        try {
          await writeFileAtomic(filePath, newContent);
        } catch (error) {
          logException(error, 'Failed to write drool file', { path: filePath });
        }
      }
    });

    const existingFiles = await fs.promises
      .readdir(droolsDir)
      .catch(() => [] as string[]);
    const deletePromises = existingFiles
      .filter((f) => f.endsWith('.md') && !expectedFiles.has(f))
      .map((f) =>
        fs.promises.unlink(path.join(droolsDir, f)).catch((error) => {
          logException(error, 'Failed to delete orphaned drool file', {
            path: path.join(droolsDir, f),
          });
        })
      );

    await Promise.all([...writePromises, ...deletePromises]);
  }

  // ===========================================================================
  // Skills (skills/{name}/SKILL.md)
  // ===========================================================================

  private async loadSkills(): Promise<SkillSettings | undefined> {
    const skillsDir = path.join(this.folderPath, SKILLS_DIR_NAME);

    try {
      const exists = await directoryExists(skillsDir);
      if (!exists) return undefined;

      const skillDirPaths = await findSkillDirectories(skillsDir);
      if (skillDirPaths.length === 0) return undefined;

      const droolLocation = IndustrySettingsFolder.determineLocation(
        this.folderPath
      );
      // DroolLocation and SkillLocation have identical values, cast is safe
      const location = droolLocation as unknown as SkillLocation;

      const skillPromises = skillDirPaths.map((dirPath) => {
        const promptFile = path.join(dirPath, SKILL_PROMPT_FILE);
        return loadSkillFile(promptFile, location);
      });

      const results = await Promise.all(skillPromises);
      const skills = results.filter((s): s is Skill => s !== null);

      return skills.length > 0 ? skills : undefined;
    } catch (error) {
      logWarn('Failed to load skills directory', { path: skillsDir, error });
      return undefined;
    }
  }

  // ===========================================================================
  // Hooks (canonical hooks.json, with transitional legacy fallback)
  // ===========================================================================

  /**
   * Load hooks from the canonical hooks.json file, or from the previous nested
   * path only while hooks.json is absent, then merge with settings.json.
   * The active hooks file takes precedence over settings.json per event type.
   */
  private async loadHooks(): Promise<HookSettings | undefined> {
    const [hooksJsonHooks, settingsJsonHooks] = await Promise.all([
      this.loadHooksFromHooksJson(),
      this.loadHooksFromSettingsJson(),
    ]);

    return IndustrySettingsFolder.mergeHookSettings(
      hooksJsonHooks,
      settingsJsonHooks
    );
  }

  /**
   * Merge hook settings from two sources.
   * Primary (the active hooks file) takes precedence over secondary
   * (settings.json) per event type.
   */
  private static mergeHookSettings(
    primary: HookSettings | undefined,
    secondary: HookSettings | undefined
  ): HookSettings | undefined {
    if (!primary && !secondary) return undefined;
    if (!primary) return secondary;
    if (!secondary) return primary;

    // The active hooks file overrides settings.json per event type.
    return {
      ...secondary,
      ...primary,
    };
  }

  private async loadHooksFromSettingsJson(): Promise<HookSettings | undefined> {
    const filePath = path.join(this.folderPath, SETTINGS_FILE_NAME);

    try {
      const exists = await fileExists(filePath);
      if (!exists) return undefined;

      const content = await fs.promises.readFile(filePath, 'utf-8');
      const hooksSettingsErrors: ParseError[] = [];
      const parsed = parseJsonc(content, hooksSettingsErrors) as {
        hooks?: unknown;
      };
      if (hooksSettingsErrors.length > 0) return undefined;

      if (parsed.hooks === undefined) return undefined;

      warnOnUnknownHookEventKeys(parsed.hooks, { path: filePath });
      const result = HookSettingsSchema.safeParse(parsed.hooks);
      if (!result.success) {
        logWarn('Invalid hooks in settings.json, ignoring', { path: filePath });
        return undefined;
      }

      return result.data;
    } catch (error) {
      logWarn('Failed to load hooks from settings.json', {
        path: filePath,
        error,
      });
      return undefined;
    }
  }

  private async loadHooksFromHooksJson(): Promise<HookSettings | undefined> {
    const canonicalPath = path.join(this.folderPath, HOOKS_FILE_NAME);
    if (await fileExists(canonicalPath)) {
      return this.loadHooksFromFile(canonicalPath, HOOKS_FILE_NAME);
    }

    const legacyPath = path.join(
      this.folderPath,
      LEGACY_HOOKS_DIR_NAME,
      HOOKS_FILE_NAME
    );
    return this.loadHooksFromFile(
      legacyPath,
      `${LEGACY_HOOKS_DIR_NAME}/${HOOKS_FILE_NAME}`
    );
  }

  private async loadHooksFromFile(
    filePath: string,
    sourceName: string
  ): Promise<HookSettings | undefined> {
    try {
      const exists = await fileExists(filePath);
      if (!exists) return undefined;

      const content = await fs.promises.readFile(filePath, 'utf-8');
      const hooksFileErrors: ParseError[] = [];
      const parsed = parseJsonc(content, hooksFileErrors);
      if (hooksFileErrors.length > 0) return undefined;

      warnOnUnknownHookEventKeys(parsed, { path: filePath, name: sourceName });
      const result = HookSettingsSchema.safeParse(parsed);
      if (!result.success) {
        logWarn('Invalid hooks file, ignoring', {
          path: filePath,
          name: sourceName,
        });
        return undefined;
      }

      return result.data;
    } catch (error) {
      logWarn('Failed to load hooks file', {
        path: filePath,
        name: sourceName,
        error,
      });
      return undefined;
    }
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

      const source = IndustrySettingsFolder.determineCommandSource(
        this.folderPath
      );

      const commandPromises = filePaths.map((fp) =>
        loadCommandFile(fp, source)
      );

      const results = await Promise.all(commandPromises);
      const commands = results.filter((c): c is CustomCommand => c !== null);

      return commands.length > 0 ? commands : undefined;
    } catch (error) {
      logWarn('Failed to load commands directory', {
        path: commandsDir,
        error,
      });
      return undefined;
    }
  }

  // ===========================================================================
  // Custom Models (config.json) - Legacy fallback
  // Primary source is now settings.json, config.json is for backwards compatibility
  // ===========================================================================

  private async loadCustomModels(): Promise<CustomModelSettings | undefined> {
    const filePath = path.join(this.folderPath, CONFIG_FILE_NAME);

    try {
      const exists = await fileExists(filePath);
      if (!exists) return undefined;

      const content = await fs.promises.readFile(filePath, 'utf-8');
      const configErrors: ParseError[] = [];
      const json = parseJsonc(content, configErrors) as {
        custom_models?: Array<{
          model: string;
          base_url?: string;
          api_key?: string;
          provider: string;
          model_display_name?: string;
          max_context_limit?: number;
          enable_thinking?: boolean;
          thinking_max_tokens?: number;
          max_tokens?: number;
          reasoning_effort?: string;
          extra_headers?: Record<string, string>;
          extra_args?: Record<string, unknown>;
          supports_images?: boolean;
          bedrock?: CustomModel['bedrock'];
        }>;
      };

      if (configErrors.length > 0) return undefined;
      const list = Array.isArray(json.custom_models) ? json.custom_models : [];
      if (list.length === 0) return undefined;

      const filtered = list
        .filter((m) => {
          if (typeof m?.model !== 'string' || typeof m?.provider !== 'string') {
            return false;
          }
          const hasHttpConfig =
            typeof m.base_url === 'string' && typeof m.api_key === 'string';
          return hasHttpConfig || isBedrockCustomModelConfig(m.bedrock);
        })
        .filter((m) => {
          if (
            m.api_key === 'YOUR_OPENAI_API_KEY' ||
            m.api_key === 'YOUR_API_KEY'
          ) {
            return false;
          }
          return true;
        });

      // Compute stable per-display-name indices so IDs don't shift when
      // unrelated models are added/removed from the config.
      const displayNames = filtered.map((m) => m.model_display_name || m.model);
      const stableIndices = computeStableIndices(displayNames);

      const validModels = filtered.map<CustomModel>((m, arrayIndex) => {
        const displayName = displayNames[arrayIndex];
        const id = buildCustomModelId(displayName, stableIndices[arrayIndex]);

        return {
          model: m.model,
          id,
          index: arrayIndex,
          baseUrl: m.base_url,
          apiKey: m.api_key,
          displayName,
          maxContextLimit: m.max_context_limit,
          enableThinking: m.enable_thinking,
          thinkingMaxTokens: m.thinking_max_tokens,
          maxOutputTokens: m.max_tokens,
          reasoningEffort: parseReasoningEffort(m.reasoning_effort),
          extraHeaders: m.extra_headers,
          extraArgs: m.extra_args,
          bedrock: isBedrockCustomModelConfig(m.bedrock)
            ? m.bedrock
            : undefined,
          noImageSupport:
            m.supports_images === false ||
            (m.supports_images === undefined &&
              !customModelProviderSupportsImagesByDefault(m.provider)),
          provider: parseCustomModelProvider(m.provider),
        };
      });

      return validModels.length > 0 ? validModels : undefined;
    } catch (error) {
      logWarn('Failed to load custom models from config.json', {
        path: filePath,
        error,
      });
      return undefined;
    }
  }

  // ===========================================================================
  // Static Utility Methods
  // ===========================================================================

  private static determineLocation(folderPath: string): DroolLocation {
    const homeIndustryDir = path.join(getIndustryHome(), getIndustryDirName());
    if (isPathEqualOrDescendant(folderPath, homeIndustryDir)) {
      return DroolLocation.Personal;
    }
    return DroolLocation.Project;
  }

  private static determineCommandSource(folderPath: string): CommandSource {
    const homeIndustryDir = path.join(getIndustryHome(), '.industry');
    if (isPathEqualOrDescendant(folderPath, homeIndustryDir)) {
      return CommandSource.Global;
    }
    return CommandSource.Workspace;
  }

  private static stringifyDrool(
    systemPrompt: string,
    metadata: DroolMetadata
  ): string {
    const yamlMetadata: Record<string, unknown> = {};

    if (metadata.name) yamlMetadata.name = metadata.name;
    if (metadata.description) yamlMetadata.description = metadata.description;
    if (metadata.model) yamlMetadata.model = metadata.model;
    if (metadata.reasoningEffort)
      yamlMetadata.reasoningEffort = metadata.reasoningEffort;

    if (metadata.tools) {
      if (Array.isArray(metadata.tools)) {
        yamlMetadata.tools = metadata.tools.join(', ');
      } else if (typeof metadata.tools === 'string') {
        yamlMetadata.tools = metadata.tools;
      }
    }

    if (metadata.mcpServers !== undefined) {
      yamlMetadata.mcpServers = metadata.mcpServers;
    }

    if (metadata.version) yamlMetadata.version = metadata.version;

    const yamlContent = yaml.dump(yamlMetadata, {
      lineWidth: -1,
      quotingType: '"',
      forceQuotes: false,
    });

    // Use single newline after frontmatter to match standard format
    // and ensure idempotent output on repeated persist cycles
    return `---\n${yamlContent}---\n${systemPrompt.trimStart()}`;
  }

  /**
   * Parse customModels from settings.json (camelCase format).
   * Auto-generates id, index, displayName, noImageSupport when missing.
   */
  static parseCustomModelsFromSettings(
    models: unknown[]
  ): CustomModelSettings | undefined {
    return parseCustomModelsFromGeneralSettings(models);
  }

  private static validateSkill(
    metadata: Skill['metadata'],
    systemPrompt: string
  ): Skill['validationResult'] {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!metadata.name) {
      errors.push('Skill must have a name');
    } else if (!/^[a-z0-9-]+$/.test(metadata.name)) {
      errors.push(
        'Skill name must contain only lowercase letters, numbers, and hyphens'
      );
    }

    if (!systemPrompt) {
      errors.push('Skill must have a system prompt');
    }

    if (metadata.description && metadata.description.length > 200) {
      warnings.push('Skill description is very long (>200 chars)');
    }

    if (metadata.tools) {
      const tools = Array.isArray(metadata.tools)
        ? metadata.tools
        : [metadata.tools];

      for (const tool of tools) {
        if (typeof tool !== 'string' || !tool.trim()) {
          warnings.push('Invalid tool specification');
          break;
        }
      }
    }

    if (metadata.version) {
      if (!/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/i.test(metadata.version)) {
        warnings.push(
          'Version should follow semantic versioning (e.g., 1.0.0)'
        );
      }
    }

    if (systemPrompt.length < 50) {
      warnings.push('System prompt is very short (<50 chars)');
    } else if (systemPrompt.length > 10000) {
      warnings.push('System prompt is very long (>10000 chars)');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
