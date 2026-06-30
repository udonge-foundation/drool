/**
 * SettingsManager - Main API for hierarchical settings
 *
 * Singleton that manages settings across multiple hierarchy levels:
 * - user: ~/.industry/
 * - project: <git-root>/.industry/
 * - folder: intermediate .industry/ folders between git root and cwd
 *
 * Provides:
 * - getResolvedSettings(): Merged settings from all levels
 * - getLevelSettings(): Settings from a specific level
 * - updateLevelSettings(): Update and persist settings at a specific level
 * - enableWatching(): Start watching for file changes
 * - disableWatching(): Stop watching for file changes
 *
 * Emits 'settings-changed' event when watched files change.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

import { CLI_DEFAULT_SETTINGS } from '@industry/common/feature-flags';
import { IndustryTier } from '@industry/common/organization';
import {
  type GeneralSettings,
  ManagedSettingsSchema,
  type Settings,
  type SettingsResolutionEvent,
} from '@industry/common/settings';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logException, logInfo, logWarn, Metrics } from '@industry/logging';
import { isFetchErrorWithStatus, MetaError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';
import { fetchDynamicConfigs } from '@industry/runtime/feature-flags';
import { getIndustryApiConfig } from '@industry/utils/api';
import { getProcessEnvironmentVariable } from '@industry/utils/environment';
import { getSystemManagedSettingsPath } from '@industry/utils/managedSettings';

import { AgentSettingsFolder } from './AgentSettingsFolder';
import { AgentSettingsPaths } from './AgentSettingsPaths';
import { AGENT_DIR_NAME, AGENTS_DIR_NAME } from './constants';
import { FolderSettingsSource } from './FolderSettingsSource';
import { getManagedSettings } from './getManagedSettings';
import { mergeCommands } from './mergeCommands';
import {
  getEnabledPluginIds,
  PluginSettingsLoader,
} from './PluginSettingsLoader';
import {
  getRuntimeSettingsPathFromEnv,
  loadRuntimeSettingsOverlay,
} from './RuntimeSettingsOverlay';
import { SettingsPaths } from './SettingsPaths';
import {
  defaultSettings,
  mergeHierarchyWithChain,
  mergeHierarchyWithSessionDefaults,
  mergeSkills,
  mergeUpdates,
  transformManagedSettingsToSettings,
} from './SettingsResolver';

import type { SettingsChangedEvent, SettingsUpdate } from './types';

// =============================================================================
// Types
// =============================================================================

/**
 * Settings loaded from a specific hierarchy level with attribution.
 */
interface LevelSettings {
  level: SettingsLevel;
  settings: Settings;
  folderPath?: string;
  /** Human-readable label for resolution chain output (e.g. "org plugins", "project .agent") */
  label?: string;
}

interface RawSettingsJsonMutationResult<T> {
  patch: Record<string, unknown>;
  result: T;
}

// =============================================================================
// SettingsManager Class
// =============================================================================

/**
 * SettingsManager - Singleton for hierarchical settings management
 *
 * Extends EventEmitter to emit 'settings-changed' events when file watching is enabled.
 */
export class SettingsManager extends EventEmitter {
  // eslint-disable-next-line no-use-before-define
  private static instance: SettingsManager | null = null;

  private paths = new SettingsPaths();

  private agentPaths = new AgentSettingsPaths();

  // user level ~/.industry sources
  private userFolderSource: FolderSettingsSource | null = null;

  // user level ~/.agent and ~/.agents folder sources
  private userAgentFolderSources: Map<string, FolderSettingsSource> = new Map();

  // project level .industry folder sources
  private projectFolderSource: FolderSettingsSource | null = null;

  // project level .agent and .agents folder sources
  private projectAgentFolderSources: Map<string, FolderSettingsSource> =
    new Map();

  private folderSources: Map<string, FolderSettingsSource> = new Map();

  private agentFolderSources: Map<string, FolderSettingsSource> = new Map();

  private resolvedCache: Settings | null = null;

  // Org settings cache (loaded from server via getManagedSettings)
  private orgSettingsCache: Settings | null = null;

  // In-flight org settings load shared by concurrent settings hierarchy reads
  private orgSettingsInflight: Promise<Settings> | null = null;

  // Sticky flag set when the managed-settings API rejects with 401/403.
  // While set, loadOrgLevel skips the API and resolves to {} until an explicit
  // auth-success signal (notifyAuthRefreshed) clears it. Prevents the
  // org-settings 401 retry storm tracked in FAC-20543. Not cleared by
  // refresh() / invalidateCache(Org) — those reset the value cache only.
  private orgSettingsAuthFailed = false;

  private orgSettingsAuthGeneration = 0;

  // Org tier (loaded from server via getManagedSettings)
  private orgTier: IndustryTier | null = null;

  // Dynamic config cache (loaded from Statsig via feature-flags API)
  private dynamicConfigCache: Settings | null = null;

  // Runtime settings overlay cache (loaded from --settings path)
  private runtimeSettingsCache: Settings | null = null;

  // When true, skip fetching Statsig dynamic config entirely
  dynamicConfigDisabled = false;

  // File watching
  private watchingEnabled = false;

  private pluginSettingsLoader = new PluginSettingsLoader(this.paths);

  /**
   * Get the singleton instance
   */
  static getInstance(): SettingsManager {
    if (!SettingsManager.instance) {
      SettingsManager.instance = new SettingsManager();
    }
    return SettingsManager.instance;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  static resetInstance(): void {
    if (SettingsManager.instance) {
      SettingsManager.instance.disableWatching();
    }
    SettingsManager.instance = null;
  }

  // ===========================================================================
  // File Watching
  // ===========================================================================

  /**
   * Enable file watching for all settings folders.
   * Emits 'settings-changed' event when files change.
   */
  enableWatching(): void {
    if (this.watchingEnabled) return;
    this.watchingEnabled = true;

    // Enable watching on existing instances
    this.userFolderSource?.startWatching();
    this.userAgentFolderSources.forEach((source) => source.startWatching());
    this.projectFolderSource?.startWatching();
    this.projectAgentFolderSources.forEach((source) => source.startWatching());
    this.folderSources.forEach((source) => source.startWatching());
    this.agentFolderSources.forEach((source) => source.startWatching());
  }

  /**
   * Disable file watching for all settings folders.
   */
  disableWatching(): void {
    if (!this.watchingEnabled) return;
    this.watchingEnabled = false;

    // Disable watching on all instances
    this.userFolderSource?.stopWatching();
    this.userAgentFolderSources.forEach((source) => source.stopWatching());
    this.projectFolderSource?.stopWatching();
    this.projectAgentFolderSources.forEach((source) => source.stopWatching());
    this.folderSources.forEach((source) => source.stopWatching());
    this.agentFolderSources.forEach((source) => source.stopWatching());
  }

  /**
   * Check if file watching is currently enabled
   */
  isWatchingEnabled(): boolean {
    return this.watchingEnabled;
  }

  // ===========================================================================
  // Reading
  // ===========================================================================

  /**
   * Get fully resolved settings (merged from all levels).
   * Returns cached value if available, otherwise loads from disk.
   */
  async getResolvedSettings(): Promise<Settings> {
    if (this.resolvedCache) return this.resolvedCache;
    const levels = await this.getSettingsHierarchyWithAttribution();

    this.resolvedCache = mergeHierarchyWithSessionDefaults(levels);

    return this.resolvedCache;
  }

  /**
   * Get fully resolved settings with a resolution chain tracking how
   * session default settings were resolved from each hierarchy level.
   */
  async getResolvedSettingsWithChain(): Promise<{
    settings: Settings;
    resolutionChain: SettingsResolutionEvent[];
  }> {
    const levels = await this.getSettingsHierarchyWithAttribution();
    const result = mergeHierarchyWithChain(levels);
    this.resolvedCache = result.settings;
    return result;
  }

  /**
   * Get settings from a specific level
   */
  async getLevelSettings(
    level: SettingsLevel,
    folderPath?: string
  ): Promise<Settings> {
    await this.discoverPaths();

    switch (level) {
      case SettingsLevel.Org:
        return this.loadOrgLevel();
      case SettingsLevel.User:
        return this.loadUserLevelSettings();
      case SettingsLevel.Project:
        return this.loadProjectLevelSettings();
      case SettingsLevel.Folder:
        if (!folderPath) {
          throw new MetaError('folderPath is required for folder level');
        }
        return this.loadFolderLevelByPath(folderPath);
      default:
        throw new MetaError('Unknown settings level');
    }
  }

  // ===========================================================================
  // Writing
  // ===========================================================================

  // Per-target write locks keyed by "level:folderPath" to serialize concurrent
  // settings writes (e.g. back-to-back sandbox approvals).
  private _writeLocks = new Map<string, Promise<unknown>>();

  private _withWriteLock<T>(
    level: SettingsLevel,
    folderPath: string | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = `${level}:${folderPath ?? ''}`;
    const prev = this._writeLocks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this._writeLocks.set(key, next);
    return next;
  }

  /**
   * Update settings at a specific level and persist to disk.
   * Serialized per (level, folderPath) to prevent concurrent writes from
   * clobbering each other.
   */
  async updateLevelSettings(
    level: SettingsLevel,
    updates: SettingsUpdate,
    folderPath?: string
  ): Promise<void> {
    return this._withWriteLock(level, folderPath, async () => {
      // Fail fast for unsupported sections (file-based settings require complex persistence)
      const unsupportedFields = (['skills', 'commands'] as const).filter(
        (field) => updates[field] !== undefined
      );

      if (unsupportedFields.length > 0) {
        throw new MetaError(
          'Persistence not yet supported for: skills, commands'
        );
      }

      await this.discoverPaths();

      let folderSource: FolderSettingsSource;
      let currentData: Settings;

      switch (level) {
        case SettingsLevel.Org:
          throw new MetaError(
            'Org settings cannot be updated locally - they are managed via the server'
          );
        case SettingsLevel.User:
          folderSource = this.getOrCreateUserSource();
          currentData = await this.loadUserFolder();
          break;
        case SettingsLevel.Project:
          if (!this.paths.getPathsSync().projectPath) {
            throw new MetaError(
              'Cannot update project settings: no project directory found'
            );
          }
          folderSource = this.getOrCreateProjectSource();
          currentData = await this.loadProjectFolder();
          break;
        case SettingsLevel.Folder:
          if (!folderPath) {
            throw new MetaError('folderPath is required for folder level');
          }
          folderSource = this.getOrCreateFolderSource(folderPath);
          currentData = await this.loadFolderLevel(folderPath);
          break;
        default:
          throw new MetaError('Unknown settings level');
      }

      const merged = mergeUpdates(currentData, updates);
      await folderSource.persist(merged);

      this.invalidateCache(level, folderPath);
    });
  }

  /**
   * Read the raw (unparsed) user-level settings.json contents.
   * Unlike getLevelSettings, this preserves the file exactly as written
   * (no normalization, no custom-model env var expansion).
   */
  async readUserSettingsJsonRaw(): Promise<Record<string, unknown>> {
    await this.discoverPaths();
    return this.getOrCreateUserSource().readSettingsJsonRaw();
  }

  /**
   * Shallow-merge top-level keys into the raw user-level settings.json,
   * preserving all other file content byte-for-byte semantics (no parsed
   * round trip). Use this for sections like `customModels` where the parsed
   * representation is lossy (env var references in API keys get expanded).
   */
  async patchUserSettingsJsonRaw(
    patch: Record<string, unknown>
  ): Promise<void> {
    return this._withWriteLock(SettingsLevel.User, undefined, async () => {
      await this.discoverPaths();
      await this.getOrCreateUserSource().patchSettingsJsonRaw(patch);
      this.invalidateCache(SettingsLevel.User);
    });
  }

  /**
   * Atomically read and patch the raw user-level settings.json under the same
   * user write lock. Use this when the patch depends on current raw file state.
   */
  async mutateUserSettingsJsonRaw<T>(
    mutate: (
      raw: Record<string, unknown>
    ) =>
      | RawSettingsJsonMutationResult<T>
      | Promise<RawSettingsJsonMutationResult<T>>
  ): Promise<T> {
    return this._withWriteLock(SettingsLevel.User, undefined, async () => {
      await this.discoverPaths();
      const source = this.getOrCreateUserSource();
      const raw = await source.readSettingsJsonRaw();
      const { patch, result } = await mutate(raw);
      await source.patchSettingsJsonRaw(patch);
      this.invalidateCache(SettingsLevel.User);
      return result;
    });
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Invalidate all caches, forcing re-load on next access.
   * Emits 'settings-changed' event to notify consumers (e.g., after plugin install/uninstall).
   */
  refresh(): void {
    // Stop watching on all instances
    this.userFolderSource?.reset();
    this.userAgentFolderSources.forEach((source) => source.reset());
    this.projectFolderSource?.reset();
    this.projectAgentFolderSources.forEach((source) => source.reset());
    this.folderSources.forEach((source) => source.reset());
    this.agentFolderSources.forEach((source) => source.reset());

    // Clear instances
    this.userFolderSource = null;
    this.userAgentFolderSources.clear();
    this.projectFolderSource = null;
    this.projectAgentFolderSources.clear();
    this.folderSources.clear();
    this.agentFolderSources.clear();

    // Clear caches
    this.orgSettingsCache = null;
    this.orgSettingsInflight = null;
    this.orgTier = null;
    this.resolvedCache = null;
    this.dynamicConfigCache = null;
    this.runtimeSettingsCache = null;

    // Reset path discovery
    this.paths.reset();
    this.agentPaths.reset();

    // Note: watchingEnabled remains unchanged - watching will resume on next access

    // Emit settings-changed event to notify consumers that all caches were cleared.
    // This is critical after plugin install/uninstall - without it, the CLI's
    // SettingsService won't know to reload hooks and other plugin-provided settings.
    // Uses User level as a general signal that settings have changed.
    const event: SettingsChangedEvent = { level: SettingsLevel.User };
    this.emit('settings-changed', event);
  }

  /**
   * Signal that authentication state has changed (e.g. user re-authenticated)
   * and the org-managed-settings endpoint should be retried. Clears the sticky
   * 401/403 flag set by loadOrgLevel and invalidates the org cache so the
   * next resolution re-fetches. See FAC-20543.
   */
  notifyAuthRefreshed(): void {
    this.orgSettingsAuthGeneration += 1;
    this.orgSettingsAuthFailed = false;
    this.orgSettingsCache = null;
    this.orgSettingsInflight = null;
    this.orgTier = null;
    this.resolvedCache = null;
  }

  // ===========================================================================
  // Path Accessors
  // ===========================================================================

  /**
   * Get the user settings path (~/.industry/)
   */
  getUserPath(): string {
    return this.paths.getPathsSync().userPath;
  }

  /**
   * Get the project settings path (<git-root>/.industry/) or null
   */
  getProjectPath(): string | null {
    return this.paths.getPathsSync().projectPath;
  }

  /**
   * Get the organization's Industry tier (e.g., 'team', 'enterprise').
   * Returns null if org settings haven't been loaded yet or tier is unknown.
   */
  getOrgTier(): IndustryTier | null {
    return this.orgTier;
  }

  // ===========================================================================
  // Private: Path Discovery
  // ===========================================================================

  private async discoverPaths(): Promise<void> {
    await Promise.all([this.paths.getPaths(), this.agentPaths.getAllPaths()]);
  }

  private async loadRuntimeSettingsLevel(): Promise<Settings | null> {
    const runtimeSettingsPath = getRuntimeSettingsPathFromEnv();
    if (!runtimeSettingsPath) {
      this.runtimeSettingsCache = null;
      return null;
    }

    if (this.runtimeSettingsCache) {
      return this.runtimeSettingsCache;
    }

    try {
      this.runtimeSettingsCache =
        await loadRuntimeSettingsOverlay(runtimeSettingsPath);
      return this.runtimeSettingsCache;
    } catch (error) {
      logWarn('[SettingsManager] Failed to load runtime settings overlay', {
        path: runtimeSettingsPath,
        cause: error,
      });
      this.runtimeSettingsCache = null;
      return null;
    }
  }

  // ===========================================================================
  // Private: Folder Instance Management
  // ===========================================================================

  private getOrCreateUserSource(): FolderSettingsSource {
    if (!this.userFolderSource) {
      const { userPath } = this.paths.getPathsSync();
      this.userFolderSource = new FolderSettingsSource(
        userPath,
        this.watchingEnabled
      );
      this.setupFolderListener(this.userFolderSource, SettingsLevel.User);
    }
    return this.userFolderSource;
  }

  private getOrCreateAgentSources(
    paths: string[],
    cache: Map<string, FolderSettingsSource>,
    level: SettingsLevel
  ): FolderSettingsSource[] {
    return paths.map((folderPath) => {
      let source = cache.get(folderPath);
      if (!source) {
        source = new FolderSettingsSource(
          folderPath,
          this.watchingEnabled,
          (p, w) => new AgentSettingsFolder(p, w)
        );
        cache.set(folderPath, source);
        this.setupFolderListener(
          source,
          level,
          level === SettingsLevel.Folder ? folderPath : undefined
        );
      }
      return source;
    });
  }

  private getOrCreateProjectSource(): FolderSettingsSource {
    if (!this.projectFolderSource) {
      const { projectPath } = this.paths.getPathsSync();
      if (!projectPath) {
        throw new MetaError('Project settings path not found');
      }
      this.projectFolderSource = new FolderSettingsSource(
        projectPath,
        this.watchingEnabled
      );
      this.setupFolderListener(this.projectFolderSource, SettingsLevel.Project);
    }
    return this.projectFolderSource;
  }

  private getOrCreateFolderSource(folderPath: string): FolderSettingsSource {
    let source = this.folderSources.get(folderPath);
    if (!source) {
      source = new FolderSettingsSource(folderPath, this.watchingEnabled);
      this.folderSources.set(folderPath, source);
      this.setupFolderListener(source, SettingsLevel.Folder, folderPath);
    }
    return source;
  }

  private async loadAgentSettingsForPaths(
    paths: string[],
    cache: Map<string, FolderSettingsSource>,
    level: SettingsLevel
  ): Promise<Settings> {
    if (paths.length === 0) return {};

    const sources = this.getOrCreateAgentSources(paths, cache, level);
    const settingsList = await Promise.all(
      sources.map((source) => source.load())
    );

    return SettingsManager.mergeAgentSettings(settingsList);
  }

  private setupFolderListener(
    source: FolderSettingsSource,
    level: SettingsLevel,
    folderPath?: string
  ): void {
    source.on('change', () => {
      this.handleFolderChange(level, folderPath);
    });
  }

  private handleFolderChange(level: SettingsLevel, folderPath?: string): void {
    // Invalidate appropriate cache
    this.invalidateCache(level, folderPath);

    // Emit event for consumers
    const event: SettingsChangedEvent = { level, folderPath };
    this.emit('settings-changed', event);
  }

  // ===========================================================================
  // Private: Loading
  // ===========================================================================

  /**
   * Load org settings from server via getManagedSettings().
   * On failure, logs a warning and returns empty settings (to avoid blocking
   * users when network is unavailable).
   */
  private async loadOrgLevel(): Promise<Settings> {
    if (this.orgSettingsCache) {
      return this.orgSettingsCache;
    }

    // FAC-20543: if the managed-settings endpoint already rejected with 401/403
    // for this credential, skip the network call entirely. The flag is cleared
    // only by notifyAuthRefreshed() (e.g. after re-authentication).
    if (this.orgSettingsAuthFailed) {
      this.orgSettingsCache = {};
      return this.orgSettingsCache;
    }

    if (!this.orgSettingsInflight) {
      const loadPromise = this.loadOrgLevelUncached().finally(() => {
        if (this.orgSettingsInflight === loadPromise) {
          this.orgSettingsInflight = null;
        }
      });
      this.orgSettingsInflight = loadPromise;
    }

    return this.orgSettingsInflight;
  }

  /**
   * Try to load org settings from the system-managed file deployed by IT/MDM
   * at a hardcoded platform path (see `@industry/utils/managedSettings`).
   *
   * Returns:
   * - `null` if the platform is unsupported or the file is not present
   *   (caller should fall through to env-var / API sources).
   * - A populated `Settings` object on success.
   * - An empty `{}` if the file exists but cannot be read/parsed/validated.
   *   In that case we still treat the org as system-provisioned to prevent a
   *   broken admin deployment from being silently bypassed.
   */
  private async loadSystemManagedLevel(): Promise<Settings | null> {
    const systemPath = getSystemManagedSettingsPath();
    if (!systemPath) return null;

    let content: string;
    try {
      content = await fs.promises.readFile(systemPath, 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        return null;
      }
      logException(
        error,
        '[SettingsManager] Failed to read system-managed settings file'
      );
      return {};
    }

    const parseErrors: ParseError[] = [];
    const parsed = parseJsonc(content, parseErrors);
    if (parseErrors.length > 0) {
      logWarn('[SettingsManager] Malformed system-managed settings file', {
        path: systemPath,
      });
      return {};
    }

    const validated = ManagedSettingsSchema.safeParse(parsed);
    if (!validated.success) {
      logWarn('[SettingsManager] Invalid system-managed settings file', {
        path: systemPath,
      });
      return {};
    }

    logInfo('[SettingsManager] Loaded org settings from system-managed file', {
      path: systemPath,
    });
    return transformManagedSettingsToSettings(validated.data);
  }

  /**
   * Best-effort tier fetch used when the system-managed file is authoritative
   * for org settings. Populates `this.orgTier` so enterprise-gated behaviors
   * keep working for IT/MDM deployments. Failures (offline, no API config,
   * auth errors) are non-fatal — the tier simply stays `null`.
   */
  private async refreshOrgTierFromApi(): Promise<void> {
    if (getProcessEnvironmentVariable('E2E_MOCK_LLM') === 'true') return;
    const apiConfig = getIndustryApiConfig();
    if (!apiConfig?.baseUrl) return;
    if (this.orgSettingsAuthFailed) return;

    const authGeneration = this.orgSettingsAuthGeneration;
    try {
      const response = await getManagedSettings();
      if (authGeneration !== this.orgSettingsAuthGeneration) return;
      if (response.success) {
        this.orgTier = response.industryTier ?? null;
      }
    } catch (error) {
      if (authGeneration !== this.orgSettingsAuthGeneration) return;
      if (isFetchErrorWithStatus(error, [401, 403])) {
        this.orgSettingsAuthFailed = true;
      }
      logException(
        error,
        '[SettingsManager] Failed to fetch org tier for system-managed deployment'
      );
    }
  }

  private async loadOrgLevelUncached(): Promise<Settings> {
    if (this.orgSettingsCache) {
      return this.orgSettingsCache;
    }

    // System-managed file (deployed by IT/MDM at a hardcoded platform path).
    // When present it is the authoritative source for org settings and
    // short-circuits the env-var / API chain below. We still consult the API
    // for the org tier so enterprise-gated behaviors keep working for managed
    // deployments; settings from the API response are intentionally ignored.
    const systemManaged = await this.loadSystemManagedLevel();
    if (systemManaged !== null) {
      this.orgSettingsCache = systemManaged;
      await this.refreshOrgTierFromApi();
      return this.orgSettingsCache;
    }

    // Check for local file override
    const localPath = getProcessEnvironmentVariable(
      'INDUSTRY_ORG_MANAGED_SETTINGS_LOCAL_PATH'
    );
    if (localPath) {
      try {
        const content = await fs.promises.readFile(localPath, 'utf-8');
        const parseErrors: ParseError[] = [];
        const parsed = parseJsonc(content, parseErrors);
        if (parseErrors.length > 0) {
          logWarn('[SettingsManager] Malformed org settings local file');
          this.orgSettingsCache = {};
          return this.orgSettingsCache;
        }
        const validated = ManagedSettingsSchema.safeParse(parsed);
        if (validated.success) {
          this.orgSettingsCache = transformManagedSettingsToSettings(
            validated.data
          );
          logInfo('[SettingsManager] Loaded org settings from local file');
          return this.orgSettingsCache;
        }
        logWarn('[SettingsManager] Invalid org settings local file');
      } catch (error) {
        logException(
          error,
          '[SettingsManager] Failed to load org settings from local file'
        );
      }
      this.orgSettingsCache = {};
      return this.orgSettingsCache;
    }

    // Check for custom URL override
    const customUrl = getProcessEnvironmentVariable(
      'INDUSTRY_ORG_MANAGED_SETTINGS_URL'
    );
    if (customUrl) {
      try {
        const response = await fetch(customUrl);
        if (!response.ok) {
          throw new MetaError('HTTP request failed', {
            statusCode: response.status,
          });
        }
        const parsed = await response.json();
        const validated = ManagedSettingsSchema.safeParse(parsed);
        if (validated.success) {
          this.orgSettingsCache = transformManagedSettingsToSettings(
            validated.data
          );
          logInfo('[SettingsManager] Loaded org settings from custom URL');
          return this.orgSettingsCache;
        }
        logWarn('[SettingsManager] Invalid org settings from custom URL');
      } catch (error) {
        logException(
          error,
          '[SettingsManager] Failed to load org settings from custom URL'
        );
      }
      this.orgSettingsCache = {};
      return this.orgSettingsCache;
    }

    // Skip org settings fetch in e2e test mode to avoid network calls that can be slow
    // E2E_MOCK_LLM is set by the daemon when running e2e tests
    if (getProcessEnvironmentVariable('E2E_MOCK_LLM') === 'true') {
      logInfo('[SettingsManager] Skipping org settings in e2e test mode');
      this.orgSettingsCache = {};
      return this.orgSettingsCache;
    }

    // Check if API is configured - skip org settings if not
    const apiConfig = getIndustryApiConfig();
    if (!apiConfig?.baseUrl) {
      logWarn(
        'Failed to load organization settings, apiConfig.baseUrl not set'
      );
      this.orgSettingsCache = {};
      return this.orgSettingsCache;
    }

    const authGeneration = this.orgSettingsAuthGeneration;
    const isStaleAuthGeneration = () =>
      authGeneration !== this.orgSettingsAuthGeneration;

    try {
      const response = await getManagedSettings();

      if (isStaleAuthGeneration()) {
        return this.orgSettingsCache ?? {};
      }

      if (response.success) {
        // Store org tier from response
        this.orgTier = response.industryTier ?? null;

        if (response.settings) {
          this.orgSettingsCache = transformManagedSettingsToSettings(
            response.settings
          );
        } else {
          // No org settings configured - this is valid (org hasn't set any policies)
          this.orgSettingsCache = {};
          logInfo('[SettingsManager] No org settings configured');
        }
      } else {
        // Response was not successful - log and continue with empty settings
        const errorDetails = response.errors
          ?.map((e) => `${e.path}: ${e.message}`)
          .join('; ');
        logException(
          new MetaError('Invalid response from managed-settings API', {
            reason: errorDetails || 'unknown',
          }),
          'Failed to load organization settings: invalid response'
        );
        this.orgSettingsCache = {};
      }
    } catch (error) {
      if (isStaleAuthGeneration()) {
        return this.orgSettingsCache ?? {};
      }

      // Failed to load org settings - log and continue with empty settings.
      // FAC-20543: classify 401/403 as a permanent (sticky) failure so we do
      // not re-issue the API call on every refresh()/resolve cycle. The flag
      // is cleared by notifyAuthRefreshed() after a real re-auth.
      if (isFetchErrorWithStatus(error, [401, 403])) {
        this.orgSettingsAuthFailed = true;
      }
      logException(error, 'Failed to load organization settings');
      this.orgSettingsCache = {};
    }

    return this.orgSettingsCache;
  }

  private async loadUserFolder(): Promise<Settings> {
    const source = this.getOrCreateUserSource();
    return source.load();
  }

  private async loadUserAgentFolder(): Promise<Settings> {
    const { userPaths } = this.agentPaths.getAllPathsSync();
    return this.loadAgentSettingsForPaths(
      userPaths,
      this.userAgentFolderSources,
      SettingsLevel.User
    );
  }

  private async loadUserLevelSettings(): Promise<Settings> {
    const [industrySettings, agentSettings] = await Promise.all([
      this.loadUserFolder(),
      this.loadUserAgentFolder(),
    ]);

    return {
      ...industrySettings,
      // Priority at the same level: .industry > .agents > .agent
      skills: mergeSkills(industrySettings.skills, agentSettings.skills),
      commands: mergeCommands(industrySettings.commands, agentSettings.commands),
    };
  }

  private async loadProjectFolder(): Promise<Settings> {
    const { projectPath } = this.paths.getPathsSync();
    if (!projectPath) return {};
    const source = this.getOrCreateProjectSource();
    return source.load();
  }

  private async loadProjectAgentFolder(): Promise<Settings> {
    const { projectPaths } = this.agentPaths.getAllPathsSync();
    return this.loadAgentSettingsForPaths(
      projectPaths,
      this.projectAgentFolderSources,
      SettingsLevel.Project
    );
  }

  private static mergeAgentSettings(settingsList: Settings[]): Settings {
    let mergedSkills: Settings['skills'];
    let mergedCommands: Settings['commands'];

    for (const settings of settingsList) {
      // Order matters: earlier entries win, so .agents (primary) beats .agent (legacy).
      mergedSkills = mergeSkills(mergedSkills, settings.skills);
      mergedCommands = mergeCommands(mergedCommands, settings.commands);
    }

    const result: Settings = {};
    if (mergedSkills) result.skills = mergedSkills;
    if (mergedCommands) result.commands = mergedCommands;
    return result;
  }

  private async loadProjectLevelSettings(): Promise<Settings> {
    const [industrySettings, agentSettings] = await Promise.all([
      this.loadProjectFolder(),
      this.loadProjectAgentFolder(),
    ]);

    return {
      ...industrySettings,
      // Priority at the same level: .industry > .agents > .agent
      skills: mergeSkills(industrySettings.skills, agentSettings.skills),
      commands: mergeCommands(industrySettings.commands, agentSettings.commands),
    };
  }

  private async loadFolderLevel(folderPath: string): Promise<Settings> {
    const source = this.getOrCreateFolderSource(folderPath);
    return source.load();
  }

  private async loadAgentFolderLevel(folderPath: string): Promise<Settings> {
    return this.loadAgentSettingsForPaths(
      [folderPath],
      this.agentFolderSources,
      SettingsLevel.Folder
    );
  }

  private async loadFolderLevelByPath(folderPath: string): Promise<Settings> {
    const baseName = path.basename(folderPath);
    if (baseName === AGENT_DIR_NAME || baseName === AGENTS_DIR_NAME) {
      return this.loadAgentFolderLevel(folderPath);
    }
    return this.loadFolderLevel(folderPath);
  }

  /**
   * Load dynamic config settings from Statsig.
   * These are fetched via the feature-flags API and cached.
   */
  private async loadDynamicConfigLevel(): Promise<Settings> {
    if (this.dynamicConfigCache) return this.dynamicConfigCache;

    // Skip dynamic config fetch in e2e test mode to avoid network calls
    if (
      this.dynamicConfigDisabled ||
      getProcessEnvironmentVariable('E2E_MOCK_LLM') === 'true'
    ) {
      this.dynamicConfigCache = {};
      return this.dynamicConfigCache;
    }

    try {
      const configs = await fetchDynamicConfigs();
      const rawConfig = configs[CLI_DEFAULT_SETTINGS];

      if (rawConfig && typeof rawConfig === 'object') {
        const parsed = ManagedSettingsSchema.safeParse(rawConfig);
        if (parsed.success) {
          if (Object.keys(parsed.data).length > 0) {
            this.dynamicConfigCache = {
              general: parsed.data as GeneralSettings,
            };
          } else {
            this.dynamicConfigCache = {};
          }
        } else {
          logWarn('[SettingsManager] Failed to parse dynamic config', {
            cause: parsed.error.format(),
          });
          this.dynamicConfigCache = {};
        }
      } else {
        this.dynamicConfigCache = {};
      }
    } catch (error) {
      logWarn('[SettingsManager] Failed to load dynamic config', {
        cause: error,
      });
      this.dynamicConfigCache = {};
    }

    return this.dynamicConfigCache!;
  }

  /**
   * Load all settings levels with attribution for source tracking.
   * Order: org -> org plugins -> runtime -> folders -> project(.industry) -> project(.agent skills) -> project plugins -> user(.industry) -> user(.agent skills) -> user plugins -> dynamicConfig -> defaults
   */
  async getSettingsHierarchyWithAttribution(): Promise<LevelSettings[]> {
    await this.discoverPaths();

    const cwd = process.cwd();

    const [
      { folderPaths: industryFolderPaths },
      { folderPaths: agentFolderPaths },
    ] = await Promise.all([
      this.paths.getPaths(),
      this.agentPaths.getAllPaths(),
    ]);

    const ancestorDepthFromCwd = (dotFolderPath: string): number => {
      const ancestor = path.dirname(dotFolderPath);
      const rel = path.relative(cwd, ancestor);
      if (!rel || rel === '.') return 0;
      return rel.split(path.sep).filter((p) => p === '..').length;
    };

    const agentPriorityForPath = (folderPath: string): number => {
      const baseName = path.basename(folderPath);
      if (baseName === AGENTS_DIR_NAME) return 1;
      if (baseName === AGENT_DIR_NAME) return 2;
      logWarn('[SettingsManager] Unexpected agent folder name', {
        path: folderPath,
        name: baseName,
      });
      return 3;
    };

    const folderEntries = [
      ...industryFolderPaths.map((p) => ({
        type: 'industry' as const,
        path: p,
        depth: ancestorDepthFromCwd(p),
        priority: 0,
      })),
      ...agentFolderPaths.map((p) => ({
        type: 'agent' as const,
        path: p,
        depth: ancestorDepthFromCwd(p),
        priority: agentPriorityForPath(p),
      })),
    ].sort((a, b) => a.depth - b.depth || a.priority - b.priority);

    // Load folder levels with attribution
    const foldersPromise = Promise.all(
      folderEntries.map(async (entry) => ({
        path: entry.path,
        settings:
          entry.type === 'industry'
            ? await this.loadFolderLevel(entry.path)
            : await this.loadAgentFolderLevel(entry.path),
      }))
    );

    // Load all levels in parallel, with timing for network-bound calls
    const levelsStart = performance.now();
    const [
      org,
      runtime,
      user,
      userAgent,
      folders,
      project,
      projectAgent,
      dynamicConfig,
    ] = await Promise.all([
      this.loadOrgLevel().then((r) => {
        Metrics.addToCounter(
          Metric.CLI_STARTUP_SETTINGS_ORG_LATENCY,
          performance.now() - levelsStart
        );
        return r;
      }),
      this.loadRuntimeSettingsLevel(),
      this.loadUserFolder(),
      this.loadUserAgentFolder(),
      foldersPromise,
      this.loadProjectFolder(),
      this.loadProjectAgentFolder(),
      this.loadDynamicConfigLevel().then((r) => {
        Metrics.addToCounter(
          Metric.CLI_STARTUP_SETTINGS_DYNAMIC_CONFIG_LATENCY,
          performance.now() - levelsStart
        );
        return r;
      }),
    ]);

    const [orgPlugin, userPlugin, projectPlugin] = await Promise.all([
      this.loadPluginSettings(SettingsLevel.Org, org),
      this.loadPluginSettings(SettingsLevel.User, user),
      this.loadPluginSettings(SettingsLevel.Project, project),
    ]);

    const { userPath, projectPath } = this.paths.getPathsSync();

    return [
      {
        level: SettingsLevel.Org,
        settings: org,
        label: 'org settings (remote)',
      },
      {
        level: SettingsLevel.Org,
        settings: orgPlugin,
        label: 'org plugins (remote)',
      },
      ...(runtime
        ? [
            {
              level: SettingsLevel.Runtime as const,
              settings: runtime,
              label: 'runtime --settings overlay',
            },
          ]
        : []),
      ...folders.map((f) => ({
        level: SettingsLevel.Folder as const,
        settings: f.settings,
        folderPath: f.path,
        label: `folder ${f.path}/settings.json`,
      })),
      {
        level: SettingsLevel.Project,
        settings: project,
        folderPath: projectPath ?? undefined,
        label: `project ${projectPath ?? '<none>'}/settings.json`,
      },
      {
        level: SettingsLevel.Project,
        settings: projectAgent,
        label: `project ${projectPath ? path.dirname(projectPath) : '<none>'}/.agent/`,
      },
      {
        level: SettingsLevel.Project,
        settings: projectPlugin,
        label: 'project plugins',
      },
      {
        level: SettingsLevel.User,
        settings: user,
        folderPath: userPath,
        label: `user ${userPath}/settings.json`,
      },
      {
        level: SettingsLevel.User,
        settings: userAgent,
        label: `user ${path.dirname(userPath)}/.agent/`,
      },
      {
        level: SettingsLevel.User,
        settings: userPlugin,
        label: 'user plugins',
      },
      {
        level: SettingsLevel.Dynamic,
        settings: dynamicConfig,
        label: 'dynamic config (remote)',
      },
      {
        level: SettingsLevel.BuiltIn,
        settings: defaultSettings(),
        label: 'builtin defaults (hardcoded)',
      },
    ];
  }

  private async loadPluginSettings(
    scope: SettingsLevel,
    settings: Settings
  ): Promise<Settings> {
    try {
      const result = await this.pluginSettingsLoader.load(
        scope,
        getEnabledPluginIds(settings)
      );
      return result.settings;
    } catch (error) {
      logException(error, 'Failed to load plugin settings (settings manager)', {
        name: scope,
      });
      return {};
    }
  }

  // ===========================================================================
  // Private: Cache Management
  // ===========================================================================

  private invalidateCache(level: SettingsLevel, folderPath?: string): void {
    this.resolvedCache = null;

    switch (level) {
      case SettingsLevel.Org:
        this.orgSettingsCache = null;
        break;
      case SettingsLevel.User:
        this.userFolderSource?.invalidate();
        this.userAgentFolderSources.forEach((source) => source.invalidate());
        break;
      case SettingsLevel.Project:
        this.projectFolderSource?.invalidate();
        this.projectAgentFolderSources.forEach((source) => source.invalidate());
        break;
      case SettingsLevel.Folder:
        if (folderPath) {
          this.folderSources.get(folderPath)?.invalidate();
          this.agentFolderSources.get(folderPath)?.invalidate();
        }
        break;
      default:
        break;
    }
  }
}
