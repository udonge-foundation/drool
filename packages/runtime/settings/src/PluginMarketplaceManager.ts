import * as path from 'path';

import {
  InstalledPluginEntry,
  MarketplaceSource,
  type MarketplaceEntry,
  type MarketplaceListItem,
  type UnregisteredMarketplace,
} from '@industry/common/settings';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logException, logInfo, logWarn, Metrics } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';
import { MarketplaceService } from '@industry/runtime/plugins/MarketplaceService';
import {
  formatPluginId,
  parsePluginId,
} from '@industry/runtime/plugins/pluginId';
import {
  getPluginVersion,
  PluginInstaller,
} from '@industry/runtime/plugins/PluginInstaller';
import { PluginRegistry } from '@industry/runtime/plugins/PluginRegistry';
import { expandTilde } from '@industry/utils/shell/node';

import {
  getEnabledPluginIds,
  PluginSettingsLoader,
} from './PluginSettingsLoader';
import { SettingsManager } from './SettingsManager';
import { SettingsPaths } from './SettingsPaths';

import type { PluginMarketplaceSettingsProvider } from './types';
import type {
  FailedMarketplaceInstall,
  FailedPluginInstall,
  MarketplaceOperationResult,
  ParsedPluginId,
  PluginInstallResult,
  PluginLoadWarning,
} from '@industry/runtime/plugins/types';

type InstalledPluginStatus = {
  id: string;
  entry: InstalledPluginEntry;
  active: boolean;
  reason: 'enabled' | 'not enabled';
};

const INSTALLED_PLUGIN_SCOPE_PRECEDENCE: Record<string, number> = {
  [SettingsLevel.Org]: 0,
  [SettingsLevel.Project]: 1,
  [SettingsLevel.User]: 2,
};

/**
 * Resolve a `local` marketplace `source.path` to an absolute path so that
 * committed project settings (e.g. `./.industry/industry-mono-plugins`) stay
 * portable and don't depend on the CLI's cwd. Tilde handling mirrors
 * `MarketplaceService.expandPath`; relative paths resolve against
 * `dirname(levelFolderPath)`. Missing `folderPath` (org/runtime), empty
 * paths, and non-local sources pass through unchanged.
 */
function resolveExtraMarketplaceSource(
  source: MarketplaceSource,
  levelFolderPath: string | undefined
): MarketplaceSource {
  if (source.source !== 'local') return source;

  const raw = source.path;
  if (typeof raw !== 'string' || raw.trim() === '') return source;

  const expanded = expandTilde(raw);
  if (expanded !== raw) {
    return { ...source, path: expanded };
  }

  if (path.isAbsolute(raw)) return source;

  if (!levelFolderPath) return source;

  const base = path.dirname(levelFolderPath);
  return { ...source, path: path.resolve(base, raw) };
}

export class PluginMarketplaceManager {
  // eslint-disable-next-line no-use-before-define
  private static instance: PluginMarketplaceManager | null = null;

  private paths = new SettingsPaths();

  private pluginSettingsLoader = new PluginSettingsLoader(this.paths);

  private failedPluginInstalls: Map<string, FailedPluginInstall> = new Map();

  private failedMarketplaceInstalls: Map<string, FailedMarketplaceInstall> =
    new Map();

  private pluginLoadWarnings: PluginLoadWarning[] = [];

  private settingsProvider: PluginMarketplaceSettingsProvider;

  constructor(settingsProvider: PluginMarketplaceSettingsProvider) {
    this.settingsProvider = settingsProvider;
  }

  static getInstance(): PluginMarketplaceManager {
    if (!PluginMarketplaceManager.instance) {
      PluginMarketplaceManager.instance = new PluginMarketplaceManager(
        SettingsManager.getInstance()
      );
    }
    return PluginMarketplaceManager.instance;
  }

  static resetInstance(): void {
    PluginMarketplaceManager.instance = null;
  }

  async addMarketplace(
    source: MarketplaceSource,
    options: { persistToUserSettings?: boolean } = {}
  ): Promise<MarketplaceOperationResult> {
    const startTime = performance.now();
    logInfo('[PluginMarketplaceManager] addMarketplace start', {
      sourceType: source.source,
    });
    const registry = this.getUserPluginRegistry();
    const strictMarketplaces = await this.getStrictMarketplaces();
    const service = new MarketplaceService(registry, strictMarketplaces);
    const result = await service.addMarketplace(source);
    logInfo('[PluginMarketplaceManager] addMarketplace service result', {
      success: result.success,
      name: result.name,
      errorMessage: result.error,
    });

    const latencyMs = performance.now() - startTime;
    Metrics.addToCounter(Metric.MARKETPLACE_OPERATION_COUNT, 1, {
      operation: 'add',
      status: result.success ? 'success' : 'failure',
      name: result.name ?? source.source,
      ...(result.error && { errorMessage: result.error }),
    });
    Metrics.recordHistogram(Metric.MARKETPLACE_ADD_LATENCY_MS, latencyMs, {
      status: result.success ? 'success' : 'failure',
      name: result.name ?? source.source,
    });

    if (
      result.success &&
      result.name &&
      options.persistToUserSettings !== false
    ) {
      try {
        await this.addMarketplaceToUserSettings(result.name, source);
        this.settingsProvider.refresh();
      } catch (error) {
        logException(
          error,
          '[PluginMarketplaceManager] Failed to persist marketplace setting',
          { name: result.name }
        );
        await service.removeMarketplace(result.name);
        return {
          success: false,
          name: result.name,
          error: 'Could not save marketplace setting.',
        };
      }
    }

    return result;
  }

  async removeMarketplace(name: string): Promise<MarketplaceOperationResult> {
    const registry = this.getUserPluginRegistry();
    const service = new MarketplaceService(registry);
    const result = await service.removeMarketplace(name);

    if (result.success) {
      try {
        await this.removeMarketplaceFromUserSettings(name);
        this.settingsProvider.refresh();
      } catch (error) {
        logException(
          error,
          '[PluginMarketplaceManager] Failed to remove marketplace setting',
          { name }
        );
      }
    }

    Metrics.addToCounter(Metric.MARKETPLACE_OPERATION_COUNT, 1, {
      operation: 'remove',
      status: result.success ? 'success' : 'failure',
      name,
      ...(result.error && { errorMessage: result.error }),
    });

    return result;
  }

  async updateMarketplace(
    name?: string
  ): Promise<MarketplaceOperationResult[]> {
    const registry = this.getUserPluginRegistry();
    const resolved = await this.settingsProvider.getResolvedSettings();
    const strictMarketplaces = resolved?.general?.strictKnownMarketplaces;
    const service = new MarketplaceService(registry, strictMarketplaces);
    const results = await service.updateMarketplace(name);

    for (const result of results) {
      Metrics.addToCounter(Metric.MARKETPLACE_OPERATION_COUNT, 1, {
        operation: 'update',
        status: result.success ? 'success' : 'failure',
        name: result.name ?? name ?? 'all',
        ...(result.error && { errorMessage: result.error }),
      });
    }

    return results;
  }

  async setMarketplaceAutoUpdate(
    name: string,
    enabled: boolean
  ): Promise<MarketplaceOperationResult> {
    const registry = this.getUserPluginRegistry();
    const service = new MarketplaceService(registry);
    return service.setAutoUpdate(name, enabled);
  }

  async autoUpdateMarketplaces(): Promise<void> {
    const registry = this.getUserPluginRegistry();
    const resolved = await this.settingsProvider.getResolvedSettings();
    const strictMarketplaces = resolved?.general?.strictKnownMarketplaces;
    const service = new MarketplaceService(registry, strictMarketplaces);

    let marketplacesToUpdate: Array<{ name: string; entry: MarketplaceEntry }>;
    try {
      marketplacesToUpdate = await this.filterActiveMarketplaces(
        await service.getMarketplacesWithAutoUpdate()
      );
    } catch (error) {
      logException(
        error,
        '[PluginMarketplaceManager] Failed to get marketplaces for auto-update'
      );
      return;
    }

    if (marketplacesToUpdate.length === 0) return;

    logInfo('[PluginMarketplaceManager] Auto-updating marketplaces', {
      count: marketplacesToUpdate.length,
    });

    for (const { name } of marketplacesToUpdate) {
      try {
        const results = await service.updateMarketplace(name);
        const result = results[0];
        if (result && !result.success) {
          logWarn(
            '[PluginMarketplaceManager] Failed to auto-update marketplace',
            {
              name,
              error: result.error,
            }
          );
        }
      } catch (error) {
        logException(
          error,
          '[PluginMarketplaceManager] Error auto-updating marketplace',
          { name }
        );
      }
    }
  }

  async autoUpdateInstalledPlugins(): Promise<void> {
    const installedPlugins = await this.listInstalledPlugins();
    if (installedPlugins.length === 0) return;

    const userRegistry = this.getUserPluginRegistry();
    const pluginsToUpdate: Array<{
      id: string;
      entry: InstalledPluginEntry;
      currentVersion: string;
    }> = [];

    for (const { id, entry } of installedPlugins) {
      try {
        const parsed = parsePluginId(id);
        if (!parsed) continue;

        const marketplaceName = parsed.marketplace;
        const marketplace = await userRegistry.getMarketplace(marketplaceName);
        if (!marketplace) continue;

        if (marketplace.autoUpdate === false) continue;

        const currentVersion = await getPluginVersion(
          marketplace.installLocation
        );
        if (!currentVersion || currentVersion === entry.version) continue;

        pluginsToUpdate.push({ id, entry, currentVersion });
      } catch (error) {
        logException(
          error,
          '[PluginMarketplaceManager] Error checking plugin version',
          { name: id }
        );
      }
    }

    if (pluginsToUpdate.length === 0) return;

    logInfo('[PluginMarketplaceManager] Auto-updating installed plugins', {
      count: pluginsToUpdate.length,
    });

    const installer = await this.getPluginInstaller();

    for (const { id, entry, currentVersion } of pluginsToUpdate) {
      try {
        logInfo('[PluginMarketplaceManager] Auto-updating plugin', {
          name: id,
          previousState: entry.version,
          version: currentVersion,
        });

        const result = await installer.update(id, entry.scope);
        if (!result.success) {
          logWarn('[PluginMarketplaceManager] Failed to auto-update plugin', {
            name: id,
            error: result.error,
          });
        }
      } catch (error) {
        logException(
          error,
          '[PluginMarketplaceManager] Error auto-updating plugin',
          { name: id }
        );
      }
    }

    this.settingsProvider.refresh();
  }

  async syncConfiguredPlugins(): Promise<void> {
    await this.autoUpdateMarketplaces();
    await this.autoUpdateInstalledPlugins();
    await this.autoInstallMissingMarketplaces();
    await this.autoInstallMissingPlugins();
  }

  async listMarketplaces(): Promise<MarketplaceListItem[]> {
    const registry = this.getUserPluginRegistry();
    const service = new MarketplaceService(registry);
    const marketplaces = await this.filterActiveMarketplaces(
      await registry.listMarketplaces()
    );

    const results = await Promise.all(
      marketplaces.map(async ({ name, entry }) => {
        const manifest = await service.getMarketplaceManifest(name);
        return {
          name,
          entry,
          pluginCount: manifest?.plugins.length ?? 0,
        };
      })
    );

    return results;
  }

  // Undefined allowlist is allow all and empty allowlist is deny all.
  async isMarketplaceAllowed(source: MarketplaceSource): Promise<boolean> {
    const registry = this.getUserPluginRegistry();
    const resolved = await this.settingsProvider.getResolvedSettings();
    const strictMarketplaces = resolved.general?.strictKnownMarketplaces;
    const service = new MarketplaceService(registry, strictMarketplaces);
    return service.isMarketplaceAllowed(source);
  }

  async installPlugin(
    marketplaceName: string,
    pluginName: string,
    scope: SettingsLevel = SettingsLevel.User,
    installType: 'manual' | 'auto' = 'manual'
  ): Promise<PluginInstallResult> {
    const fullPluginId = formatPluginId(pluginName, marketplaceName);

    const userRegistry = this.getUserPluginRegistry();
    const marketplace = await userRegistry.getMarketplace(marketplaceName);

    if (!marketplace) {
      const error = `Marketplace "${marketplaceName}" not found. Run /marketplace add first.`;
      Metrics.addToCounter(Metric.PLUGIN_OPERATION_COUNT, 1, {
        operation: 'install',
        status: 'failure',
        name: fullPluginId,
        settingsScope: scope,
        installType,
        errorMessage: error,
      });
      return { success: false, error };
    }

    if (!(await this.isMarketplaceAllowed(marketplace.source))) {
      const error = `Installing plugins from "${marketplaceName}" is not allowed by organization policy`;
      Metrics.addToCounter(Metric.PLUGIN_OPERATION_COUNT, 1, {
        operation: 'install',
        status: 'failure',
        name: fullPluginId,
        settingsScope: scope,
        installType,
        errorMessage: error,
      });
      return { success: false, error };
    }

    const installer = await this.getPluginInstaller();
    const result = await installer.install(marketplaceName, pluginName, scope);

    Metrics.addToCounter(Metric.PLUGIN_OPERATION_COUNT, 1, {
      operation: 'install',
      status: result.success ? 'success' : 'failure',
      name: fullPluginId,
      settingsScope: scope,
      installType,
      ...(result.error && { errorMessage: result.error }),
    });

    if (result.success) {
      this.settingsProvider.refresh();
    }

    return result;
  }

  async uninstallPlugin(
    pluginId: string,
    scope: SettingsLevel
  ): Promise<boolean> {
    const installer = await this.getPluginInstaller();
    const success = await installer.uninstall(pluginId, scope);

    Metrics.addToCounter(Metric.PLUGIN_OPERATION_COUNT, 1, {
      operation: 'uninstall',
      status: success ? 'success' : 'failure',
      name: pluginId,
      settingsScope: scope,
      installType: 'manual',
      ...(!success && { errorMessage: 'Plugin not found or uninstall failed' }),
    });

    if (success) {
      this.settingsProvider.refresh();
    }

    return success;
  }

  async setPluginEnabled(
    pluginId: string,
    scope: SettingsLevel,
    enabled: boolean
  ): Promise<{ success: boolean; error?: string }> {
    if (scope !== SettingsLevel.User && scope !== SettingsLevel.Project) {
      const error = `Cannot change the enabled state of ${scope}-scoped plugins`;
      Metrics.addToCounter(Metric.PLUGIN_OPERATION_COUNT, 1, {
        operation: enabled ? 'enable' : 'disable',
        status: 'failure',
        name: pluginId,
        settingsScope: scope,
        installType: 'manual',
        errorMessage: error,
      });
      return { success: false, error };
    }

    await this.writeEnabledPluginSetting(pluginId, enabled, scope);
    this.settingsProvider.refresh();

    Metrics.addToCounter(Metric.PLUGIN_OPERATION_COUNT, 1, {
      operation: enabled ? 'enable' : 'disable',
      status: 'success',
      name: pluginId,
      settingsScope: scope,
      installType: 'manual',
    });

    return { success: true };
  }

  async updatePlugin(
    pluginId?: string,
    scope?: SettingsLevel
  ): Promise<PluginInstallResult[]> {
    const installer = await this.getPluginInstaller();
    const results: PluginInstallResult[] = [];

    if (pluginId) {
      const result = await installer.update(pluginId, scope);
      Metrics.addToCounter(Metric.PLUGIN_OPERATION_COUNT, 1, {
        operation: 'update',
        status: result.success ? 'success' : 'failure',
        name: pluginId,
        settingsScope: scope ?? 'unknown',
        installType: 'manual',
        ...(result.error && { errorMessage: result.error }),
      });
      results.push(result);
    } else {
      const userPlugins = await this.listInstalledPlugins(SettingsLevel.User);
      const projectPlugins = await this.listInstalledPlugins(
        SettingsLevel.Project
      );

      const seen = new Set<string>();
      const uniquePlugins: Array<{ id: string; scope: SettingsLevel }> = [];

      for (const { id, entry } of [...userPlugins, ...projectPlugins]) {
        const key = `${id}:${entry.scope}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniquePlugins.push({ id, scope: entry.scope });
        }
      }

      const updateResults = await Promise.all(
        uniquePlugins.map(async ({ id, scope: pluginScope }) => {
          const result = await installer.update(id, pluginScope);
          Metrics.addToCounter(Metric.PLUGIN_OPERATION_COUNT, 1, {
            operation: 'update',
            status: result.success ? 'success' : 'failure',
            name: id,
            settingsScope: pluginScope,
            installType: 'manual',
            ...(result.error && { errorMessage: result.error }),
          });
          return result;
        })
      );
      results.push(...updateResults);
    }

    this.settingsProvider.refresh();
    return results;
  }

  async listInstalledPlugins(
    scope?: SettingsLevel
  ): Promise<Array<{ id: string; entry: InstalledPluginEntry }>> {
    const statuses = await this.listInstalledPluginStatuses(scope);
    return statuses
      .filter((plugin) => plugin.active)
      .map(({ id, entry }) => ({ id, entry }));
  }

  async listInstalledPluginStatuses(
    scope?: SettingsLevel
  ): Promise<InstalledPluginStatus[]> {
    await this.refreshPluginLoadWarnings();
    const userRegistry = this.getUserPluginRegistry();
    const allPlugins = await userRegistry.loadInstalledPlugins();
    const enabledPluginIdsByScope =
      await this.getEnabledPluginIdsByScopeBestEffort();

    const results: InstalledPluginStatus[] = [];
    for (const [id, entries] of Object.entries(allPlugins.plugins)) {
      for (const entry of entries) {
        if (scope && entry.scope !== scope) continue;
        const active = this.isInstalledPluginActive(
          id,
          entry,
          enabledPluginIdsByScope
        );
        results.push({
          id,
          entry,
          active,
          reason: active ? 'enabled' : 'not enabled',
        });
      }
    }
    return scope ? results : this.deduplicateInstalledPluginStatuses(results);
  }

  async getInstalledPlugin(
    pluginId: string,
    scope?: SettingsLevel
  ): Promise<InstalledPluginEntry | null> {
    const userRegistry = this.getUserPluginRegistry();
    return userRegistry.getInstalledPlugin(pluginId, scope);
  }

  async isPluginInstallAllowed(marketplaceName: string): Promise<boolean> {
    const userRegistry = this.getUserPluginRegistry();
    const marketplace = await userRegistry.getMarketplace(marketplaceName);

    if (!marketplace) {
      return false;
    }

    return this.isMarketplaceAllowed(marketplace.source);
  }

  async listAvailablePlugins(): Promise<
    Array<{
      name: string;
      marketplace: string;
      description?: string;
    }>
  > {
    const registry = this.getUserPluginRegistry();
    const service = new MarketplaceService(registry);
    const [marketplaces, installedPlugins] = await Promise.all([
      this.listMarketplaces(),
      this.listInstalledPluginStatuses(),
    ]);
    const pluginLists = await Promise.all(
      marketplaces.map(async ({ name }) => {
        const manifest = await service.getMarketplaceManifest(name);
        if (!manifest?.plugins) return [];
        return manifest.plugins.map((plugin) => ({
          ...plugin,
          marketplace: name,
        }));
      })
    );

    const installedIds = new Set(installedPlugins.map((p) => p.id));

    return pluginLists
      .flat()
      .filter((plugin) => {
        const pluginId = `${plugin.name}@${plugin.marketplace}`;
        return !installedIds.has(pluginId);
      })
      .map((plugin) => ({
        name: plugin.name,
        marketplace: plugin.marketplace,
        description: plugin.description,
      }));
  }

  async getMissingExtraMarketplaces(): Promise<UnregisteredMarketplace[]> {
    const allLevels =
      await this.settingsProvider.getSettingsHierarchyWithAttribution();
    const registry = this.getUserPluginRegistry();

    const missing: UnregisteredMarketplace[] = [];
    const seenNames = new Set<string>();

    for (const { level, settings, folderPath } of allLevels) {
      if (level === SettingsLevel.Folder) continue;

      for (const [name, config] of Object.entries(
        settings.general?.extraKnownMarketplaces ?? {}
      )) {
        if (seenNames.has(name)) continue;
        const existing = await registry.getMarketplace(name);
        if (!existing && config.source) {
          const source = resolveExtraMarketplaceSource(
            config.source,
            folderPath
          );
          missing.push({ name, source, scope: level });
          seenNames.add(name);
        }
      }
    }

    return missing;
  }

  async getMissingEnabledPlugins(): Promise<
    Array<ParsedPluginId & { scope: SettingsLevel }>
  > {
    const allLevels =
      await this.settingsProvider.getSettingsHierarchyWithAttribution();
    const installedPlugins =
      await this.getUserPluginRegistry().loadInstalledPlugins();

    const installedPluginIds = new Set(
      Object.entries(installedPlugins.plugins)
        .filter(([, entries]) =>
          entries.some((entry) => typeof entry.scope === 'string')
        )
        .map(([pluginId]) => pluginId)
    );

    const missing: Array<ParsedPluginId & { scope: SettingsLevel }> = [];
    const seenPluginIds = new Set<string>();

    for (const { level, settings } of allLevels) {
      if (level === SettingsLevel.Folder) continue;

      for (const [pluginId, enabled] of Object.entries(
        settings.general?.enabledPlugins ?? {}
      )) {
        if (!enabled) continue;
        // Dedup across the settings hierarchy: a plugin enabled at multiple
        // levels is reported once at its highest-precedence scope
        // (org > project > user), and is considered satisfied if it is
        // installed at any scope.
        if (installedPluginIds.has(pluginId)) continue;
        if (seenPluginIds.has(pluginId)) continue;

        const parsed = parsePluginId(pluginId);
        if (parsed) {
          missing.push({ ...parsed, scope: level });
          seenPluginIds.add(pluginId);
        }
      }
    }

    return missing;
  }

  async autoInstallMissingMarketplaces(): Promise<void> {
    let missing: UnregisteredMarketplace[];
    try {
      missing = await this.getMissingExtraMarketplaces();
    } catch (error) {
      logException(
        error,
        '[PluginMarketplaceManager] Failed to get missing marketplaces'
      );
      return;
    }

    logInfo('[PluginMarketplaceManager] Missing marketplaces', {
      count: missing.length,
    });
    if (missing.length === 0) return;

    for (const { name, source, scope } of missing) {
      try {
        const result = await this.addMarketplace(source, {
          persistToUserSettings: false,
        });
        if (result.success) {
          logInfo('[PluginMarketplaceManager] Auto-installed marketplace', {
            name,
          });
          this.clearFailedMarketplaceInstall(name);
        } else {
          logWarn(
            '[PluginMarketplaceManager] Failed to auto-install marketplace',
            {
              name,
              error: result.error,
            }
          );
          this.addFailedMarketplaceInstall({
            name,
            source,
            scope,
            error: result.error ?? 'Could not install marketplace.',
            timestamp: new Date().toISOString(),
          });
        }
      } catch (error) {
        logException(
          error,
          '[PluginMarketplaceManager] Error auto-installing marketplace',
          { name }
        );
        this.addFailedMarketplaceInstall({
          name,
          source,
          scope,
          error: 'Could not install marketplace. Please try again.',
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  async autoInstallMissingPlugins(): Promise<void> {
    let missing: Array<ParsedPluginId & { scope: SettingsLevel }>;
    try {
      missing = await this.getMissingEnabledPlugins();
    } catch (error) {
      logException(
        error,
        '[PluginMarketplaceManager] Failed to get missing plugins'
      );
      return;
    }

    if (missing.length === 0) return;

    const userRegistry = this.getUserPluginRegistry();

    for (const { pluginId, pluginName, marketplace, scope } of missing) {
      const marketplaceEntry = await userRegistry.getMarketplace(marketplace);

      if (!marketplaceEntry) {
        logWarn(
          '[PluginMarketplaceManager] Skipping plugin auto-install: marketplace not registered',
          { name: pluginId, source: marketplace }
        );
        continue;
      }

      const installedEntry = await userRegistry.getInstalledPlugin(
        pluginId,
        scope
      );
      if (installedEntry) {
        this.failedPluginInstalls.delete(pluginId);
        continue;
      }

      try {
        const result = await this.installPlugin(
          marketplace,
          pluginName,
          scope,
          'auto'
        );
        if (result.success) {
          logInfo('[PluginMarketplaceManager] Auto-installed plugin', {
            name: pluginId,
            state: scope,
          });
          this.failedPluginInstalls.delete(pluginId);
        } else if (
          PluginMarketplaceManager.isAlreadyInstalledError(result.error)
        ) {
          this.failedPluginInstalls.delete(pluginId);
        } else {
          logWarn('[PluginMarketplaceManager] Failed to auto-install plugin', {
            name: pluginId,
            error: result.error,
          });
          this.failedPluginInstalls.set(pluginId, {
            pluginId,
            scope,
            error: result.error ?? 'Could not install plugin.',
            timestamp: new Date().toISOString(),
          });
        }
      } catch (error) {
        logException(
          error,
          '[PluginMarketplaceManager] Error auto-installing plugin',
          {
            name: pluginId,
          }
        );
        this.failedPluginInstalls.set(pluginId, {
          pluginId,
          scope,
          error: 'Could not install plugin. Please try again.',
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  getFailedPluginInstalls(): FailedPluginInstall[] {
    return Array.from(this.failedPluginInstalls.values());
  }

  dismissFailedPluginInstall(pluginId: string): void {
    this.failedPluginInstalls.delete(pluginId);
  }

  async retryFailedPluginInstall(
    pluginId: string
  ): Promise<PluginInstallResult> {
    const failed = this.failedPluginInstalls.get(pluginId);
    if (!failed) {
      return { success: false, error: 'Plugin not found in failed list.' };
    }

    const parsed = parsePluginId(pluginId);
    if (!parsed) {
      return { success: false, error: 'Invalid plugin ID.' };
    }

    const result = await this.installPlugin(
      parsed.marketplace,
      parsed.pluginName,
      failed.scope
    );
    if (result.success) {
      this.failedPluginInstalls.delete(pluginId);
    }
    return result;
  }

  getPluginLoadWarnings(): PluginLoadWarning[] {
    return [...this.pluginLoadWarnings];
  }

  getPluginLoadWarningsByPlugin(): Map<string, PluginLoadWarning[]> {
    const byPlugin = new Map<string, PluginLoadWarning[]>();
    for (const warning of this.pluginLoadWarnings) {
      const existing = byPlugin.get(warning.pluginId) ?? [];
      existing.push(warning);
      byPlugin.set(warning.pluginId, existing);
    }
    return byPlugin;
  }

  getFailedMarketplaceInstalls(): FailedMarketplaceInstall[] {
    return Array.from(this.failedMarketplaceInstalls.values());
  }

  addFailedMarketplaceInstall(failed: FailedMarketplaceInstall): void {
    this.failedMarketplaceInstalls.set(failed.name, failed);
  }

  dismissFailedMarketplaceInstall(name: string): void {
    this.failedMarketplaceInstalls.delete(name);
  }

  clearFailedMarketplaceInstall(name: string): void {
    this.failedMarketplaceInstalls.delete(name);
  }

  private static isAlreadyInstalledError(error?: string): boolean {
    return (
      typeof error === 'string' &&
      error.includes('is already installed at') &&
      error.includes('scope')
    );
  }

  private getUserPluginRegistry(): PluginRegistry {
    const { userPath } = this.paths.getPathsSync();
    return new PluginRegistry(SettingsLevel.User, userPath);
  }

  private getProjectPluginRegistry(): PluginRegistry | null {
    const { projectPath } = this.paths.getPathsSync();
    if (!projectPath) return null;
    return new PluginRegistry(SettingsLevel.Project, projectPath);
  }

  private async getStrictMarketplaces(): Promise<
    MarketplaceSource[] | undefined
  > {
    const settings = await this.settingsProvider.getResolvedSettings();
    return settings.general?.strictKnownMarketplaces;
  }

  private async addMarketplaceToUserSettings(
    name: string,
    source: MarketplaceSource
  ): Promise<void> {
    const settings = await this.settingsProvider.getLevelSettings(
      SettingsLevel.User
    );
    const extraKnownMarketplaces = {
      ...(settings.general?.extraKnownMarketplaces ?? {}),
      [name]: { source },
    };

    await this.settingsProvider.updateLevelSettings(SettingsLevel.User, {
      general: { extraKnownMarketplaces },
    });
  }

  private async removeMarketplaceFromUserSettings(name: string): Promise<void> {
    const settings = await this.settingsProvider.getLevelSettings(
      SettingsLevel.User
    );
    const extraKnownMarketplaces = {
      ...(settings.general?.extraKnownMarketplaces ?? {}),
    };

    if (!(name in extraKnownMarketplaces)) return;

    delete extraKnownMarketplaces[name];
    await this.settingsProvider.updateLevelSettings(SettingsLevel.User, {
      general: { extraKnownMarketplaces },
    });
  }

  private async filterActiveMarketplaces(
    marketplaces: Array<{ name: string; entry: MarketplaceEntry }>
  ): Promise<Array<{ name: string; entry: MarketplaceEntry }>> {
    const activeMarketplaceNames =
      await this.getActiveMarketplaceNamesBestEffort();
    if (!activeMarketplaceNames) return marketplaces;

    return marketplaces.filter(({ name }) => activeMarketplaceNames.has(name));
  }

  private async getActiveMarketplaceNamesBestEffort(): Promise<Set<string> | null> {
    try {
      return await this.getActiveMarketplaceNames();
    } catch (error) {
      logException(
        error,
        '[PluginMarketplaceManager] Failed to compute active marketplace names'
      );
      return null;
    }
  }

  private async getActiveMarketplaceNames(): Promise<Set<string>> {
    const allLevels =
      await this.settingsProvider.getSettingsHierarchyWithAttribution();
    const activeMarketplaceNames = new Set<string>();

    for (const { level, settings } of allLevels) {
      if (level === SettingsLevel.Folder) continue;

      for (const name of Object.keys(
        settings.general?.extraKnownMarketplaces ?? {}
      )) {
        activeMarketplaceNames.add(name);
      }
    }

    return activeMarketplaceNames;
  }

  private async getEnabledPluginIdsByScopeBestEffort(): Promise<Map<
    SettingsLevel,
    Set<string>
  > | null> {
    try {
      return await this.getEnabledPluginIdsByScope();
    } catch (error) {
      logException(
        error,
        'Failed to compute enabled plugin IDs for installed plugin listing'
      );
      return null;
    }
  }

  private isInstalledPluginActive(
    pluginId: string,
    entry: InstalledPluginEntry,
    enabledPluginIdsByScope: Map<SettingsLevel, Set<string>> | null
  ): boolean {
    if (!enabledPluginIdsByScope) return true;
    return enabledPluginIdsByScope.get(entry.scope)?.has(pluginId) ?? false;
  }

  private deduplicateInstalledPluginStatuses(
    statuses: InstalledPluginStatus[]
  ): InstalledPluginStatus[] {
    const byPluginId = new Map<string, InstalledPluginStatus>();

    for (const status of statuses) {
      const existing = byPluginId.get(status.id);
      if (
        !existing ||
        this.compareInstalledPluginStatus(status, existing) < 0
      ) {
        byPluginId.set(status.id, status);
      }
    }

    return [...byPluginId.values()];
  }

  private compareInstalledPluginStatus(
    a: InstalledPluginStatus,
    b: InstalledPluginStatus
  ): number {
    if (a.active !== b.active) {
      return a.active ? -1 : 1;
    }

    return (
      (INSTALLED_PLUGIN_SCOPE_PRECEDENCE[a.entry.scope] ??
        Number.MAX_SAFE_INTEGER) -
      (INSTALLED_PLUGIN_SCOPE_PRECEDENCE[b.entry.scope] ??
        Number.MAX_SAFE_INTEGER)
    );
  }

  private async writeEnabledPluginSetting(
    pluginId: string,
    enabled: boolean,
    level: SettingsLevel.User | SettingsLevel.Project
  ): Promise<void> {
    const levelSettings = await this.settingsProvider.getLevelSettings(level);
    const enabledPlugins = {
      ...(levelSettings.general?.enabledPlugins ?? {}),
    };
    const hasPluginSetting = pluginId in enabledPlugins;
    const isCurrentlyEnabled = enabledPlugins[pluginId] === true;

    if ((enabled && isCurrentlyEnabled) || (!enabled && !hasPluginSetting)) {
      return;
    }

    if (enabled) {
      enabledPlugins[pluginId] = true;
    } else {
      delete enabledPlugins[pluginId];
    }

    await this.settingsProvider.updateLevelSettings(level, {
      general: { enabledPlugins },
    });
  }

  private async getPluginInstaller(): Promise<PluginInstaller> {
    const userRegistry = this.getUserPluginRegistry();
    const projectRegistry = this.getProjectPluginRegistry();
    const resolved = await this.settingsProvider.getResolvedSettings();
    const strictMarketplaces = resolved?.general?.strictKnownMarketplaces;
    const marketplaceService = new MarketplaceService(
      userRegistry,
      strictMarketplaces
    );

    const onPluginEnabled = async (
      pluginId: string,
      enabled: boolean,
      scope: SettingsLevel
    ): Promise<void> => {
      const level =
        scope === SettingsLevel.Project
          ? SettingsLevel.Project
          : SettingsLevel.User;
      await this.writeEnabledPluginSetting(pluginId, enabled, level);
    };

    return new PluginInstaller(
      userRegistry,
      projectRegistry,
      marketplaceService,
      onPluginEnabled
    );
  }

  private async refreshPluginLoadWarnings(): Promise<void> {
    this.pluginLoadWarnings = [];

    let enabledPluginIdsByScope = new Map<SettingsLevel, Set<string>>();
    try {
      enabledPluginIdsByScope = await this.getEnabledPluginIdsByScope();
    } catch (error) {
      logException(
        error,
        'Failed to compute enabled plugin IDs for plugin load warnings'
      );
    }

    const scopes: SettingsLevel[] = [
      SettingsLevel.Org,
      SettingsLevel.User,
      SettingsLevel.Project,
    ];

    for (const scope of scopes) {
      try {
        const result = await this.pluginSettingsLoader.load(
          scope,
          enabledPluginIdsByScope.get(scope) ?? new Set<string>()
        );
        this.pluginLoadWarnings.push(...result.warnings);
      } catch (error) {
        logException(
          error,
          'Failed to load plugin settings (marketplace manager)',
          { name: scope }
        );
      }
    }
  }

  private async getEnabledPluginIdsByScope(): Promise<
    Map<SettingsLevel, Set<string>>
  > {
    const allLevels =
      await this.settingsProvider.getSettingsHierarchyWithAttribution();
    const byScope = new Map<SettingsLevel, Set<string>>();

    for (const { level, settings } of allLevels) {
      if (
        level !== SettingsLevel.Org &&
        level !== SettingsLevel.User &&
        level !== SettingsLevel.Project
      ) {
        continue;
      }

      const enabledPluginIds = getEnabledPluginIds(settings);
      if (enabledPluginIds.size === 0) continue;

      const existing = byScope.get(level) ?? new Set<string>();
      for (const pluginId of enabledPluginIds) {
        existing.add(pluginId);
      }
      byScope.set(level, existing);
    }

    return byScope;
  }
}
