import * as fs from 'fs';
import * as path from 'path';

import { writeFile as writeFileAtomic } from 'atomically';

import {
  InstalledPluginEntry,
  InstalledPluginsRegistry,
  InstalledPluginsRegistrySchema,
  KnownMarketplacesRegistry,
  KnownMarketplacesRegistrySchema,
  MarketplaceEntry,
} from '@industry/common/settings';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logWarn } from '@industry/logging';

import {
  INSTALLED_PLUGINS_FILE,
  KNOWN_MARKETPLACES_FILE,
  PLUGINS_DIR,
} from './constants';

const MARKETPLACES_DIR = 'marketplaces';
const CACHE_DIR = 'cache';
const INSTALLED_PLUGINS_SCHEMA_VERSION = 1;

export class PluginRegistry {
  private basePath: string;

  private scope: SettingsLevel;

  constructor(scope: SettingsLevel, basePath: string) {
    this.scope = scope;
    this.basePath = basePath;
  }

  getScope(): SettingsLevel {
    return this.scope;
  }

  getPluginsBasePath(): string {
    return path.join(this.basePath, PLUGINS_DIR);
  }

  getMarketplacesPath(): string {
    return path.join(this.getPluginsBasePath(), MARKETPLACES_DIR);
  }

  getKnownMarketplacesPath(): string {
    return path.join(this.getPluginsBasePath(), KNOWN_MARKETPLACES_FILE);
  }

  async loadKnownMarketplaces(): Promise<KnownMarketplacesRegistry> {
    const filePath = this.getKnownMarketplacesPath();

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      const validated = KnownMarketplacesRegistrySchema.safeParse(parsed);

      if (!validated.success) {
        return {};
      }

      return validated.data;
    } catch (err) {
      logWarn('Failed to load known marketplaces registry', { cause: err });
      return {};
    }
  }

  async saveKnownMarketplaces(
    registry: KnownMarketplacesRegistry
  ): Promise<void> {
    const filePath = this.getKnownMarketplacesPath();
    const dirPath = path.dirname(filePath);

    await fs.promises.mkdir(dirPath, { recursive: true });
    await writeFileAtomic(filePath, JSON.stringify(registry, null, 2));
  }

  async addMarketplace(name: string, entry: MarketplaceEntry): Promise<void> {
    const registry = await this.loadKnownMarketplaces();
    registry[name] = entry;
    await this.saveKnownMarketplaces(registry);
  }

  async removeMarketplace(name: string): Promise<boolean> {
    const registry = await this.loadKnownMarketplaces();

    if (!(name in registry)) {
      return false;
    }

    delete registry[name];
    await this.saveKnownMarketplaces(registry);
    return true;
  }

  async getMarketplace(name: string): Promise<MarketplaceEntry | null> {
    const registry = await this.loadKnownMarketplaces();
    return registry[name] ?? null;
  }

  async listMarketplaces(): Promise<
    Array<{ name: string; entry: MarketplaceEntry }>
  > {
    const registry = await this.loadKnownMarketplaces();
    return Object.entries(registry).map(([name, entry]) => ({ name, entry }));
  }

  async marketplaceExists(name: string): Promise<boolean> {
    const registry = await this.loadKnownMarketplaces();
    return name in registry;
  }

  // ===========================================================================
  // Installed Plugins Registry
  // ===========================================================================

  getInstalledPluginsPath(): string {
    return path.join(this.getPluginsBasePath(), INSTALLED_PLUGINS_FILE);
  }

  getPluginsCachePath(): string {
    return path.join(this.getPluginsBasePath(), CACHE_DIR);
  }

  async loadInstalledPlugins(): Promise<InstalledPluginsRegistry> {
    const filePath = this.getInstalledPluginsPath();

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      const validated = InstalledPluginsRegistrySchema.safeParse(parsed);

      if (!validated.success) {
        return { schemaVersion: INSTALLED_PLUGINS_SCHEMA_VERSION, plugins: {} };
      }

      // Cast to InstalledPluginsRegistry since Zod schema uses z.enum with string literals
      // but the type expects SettingsLevel enum values (which are the same strings at runtime)
      return validated.data as InstalledPluginsRegistry;
    } catch (err) {
      logWarn('Failed to load installed plugins registry', { cause: err });
      return { schemaVersion: INSTALLED_PLUGINS_SCHEMA_VERSION, plugins: {} };
    }
  }

  async saveInstalledPlugins(
    registry: InstalledPluginsRegistry
  ): Promise<void> {
    const filePath = this.getInstalledPluginsPath();
    const dirPath = path.dirname(filePath);

    await fs.promises.mkdir(dirPath, { recursive: true });
    await writeFileAtomic(filePath, JSON.stringify(registry, null, 2));
  }

  async addInstalledPlugin(
    pluginId: string,
    entry: InstalledPluginEntry
  ): Promise<void> {
    const registry = await this.loadInstalledPlugins();

    if (!registry.plugins[pluginId]) {
      registry.plugins[pluginId] = [];
    }

    // Remove existing entry for same scope if exists
    registry.plugins[pluginId] = registry.plugins[pluginId].filter(
      (e) => e.scope !== entry.scope
    );

    registry.plugins[pluginId].push(entry);
    await this.saveInstalledPlugins(registry);
  }

  async removeInstalledPlugin(
    pluginId: string,
    scope: SettingsLevel
  ): Promise<boolean> {
    const registry = await this.loadInstalledPlugins();

    if (!registry.plugins[pluginId]) {
      return false;
    }

    const originalLength = registry.plugins[pluginId].length;
    registry.plugins[pluginId] = registry.plugins[pluginId].filter(
      (e) => e.scope !== scope
    );

    if (registry.plugins[pluginId].length === originalLength) {
      return false;
    }

    // Remove plugin key if no entries left
    if (registry.plugins[pluginId].length === 0) {
      delete registry.plugins[pluginId];
    }

    await this.saveInstalledPlugins(registry);
    return true;
  }

  async getInstalledPlugin(
    pluginId: string,
    scope?: SettingsLevel
  ): Promise<InstalledPluginEntry | null> {
    const registry = await this.loadInstalledPlugins();
    const entries = registry.plugins[pluginId];

    if (!entries || entries.length === 0) {
      return null;
    }

    if (scope) {
      return entries.find((e) => e.scope === scope) ?? null;
    }

    // Return first entry if no scope specified
    return entries[0];
  }

  async listInstalledPlugins(): Promise<
    Array<{ id: string; entry: InstalledPluginEntry }>
  > {
    const registry = await this.loadInstalledPlugins();
    const result: Array<{ id: string; entry: InstalledPluginEntry }> = [];

    for (const [id, entries] of Object.entries(registry.plugins)) {
      for (const entry of entries) {
        if (entry.scope === this.scope) {
          result.push({ id, entry });
        }
      }
    }

    return result;
  }

  async pluginExists(
    pluginId: string,
    scope?: SettingsLevel
  ): Promise<boolean> {
    const entry = await this.getInstalledPlugin(pluginId, scope);
    return entry !== null;
  }
}
