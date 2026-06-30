import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { PluginLoader } from '@industry/runtime/plugins/PluginLoader';
import { PluginRegistry } from '@industry/runtime/plugins/PluginRegistry';

import { SettingsPaths } from './SettingsPaths';

import type { PluginSettingsLoadResult } from './types';
import type {
  InstalledPluginsRegistry,
  Settings,
} from '@industry/common/settings';

function filterInstalledPlugins(
  installed: InstalledPluginsRegistry,
  enabledPluginIds: ReadonlySet<string>
): InstalledPluginsRegistry {
  if (enabledPluginIds.size === 0) {
    return { ...installed, plugins: {} };
  }

  const plugins: InstalledPluginsRegistry['plugins'] = {};
  for (const [pluginId, entries] of Object.entries(installed.plugins)) {
    if (enabledPluginIds.has(pluginId)) {
      plugins[pluginId] = entries;
    }
  }

  return { ...installed, plugins };
}

export class PluginSettingsLoader {
  private paths: SettingsPaths;

  constructor(paths: SettingsPaths = new SettingsPaths()) {
    this.paths = paths;
  }

  async load(
    scope: SettingsLevel,
    enabledPluginIds: ReadonlySet<string>
  ): Promise<PluginSettingsLoadResult> {
    const registry = this.getUserPluginRegistry();
    const installed = await registry.loadInstalledPlugins();
    const loader = new PluginLoader();
    const result = await loader.loadAllInstalledPlugins(
      filterInstalledPlugins(installed, enabledPluginIds),
      scope
    );

    return {
      settings: result.settings,
      warnings: result.warnings,
    };
  }

  private getUserPluginRegistry(): PluginRegistry {
    const { userPath } = this.paths.getPathsSync();
    return new PluginRegistry(SettingsLevel.User, userPath);
  }
}

export function getEnabledPluginIds(settings: Settings): Set<string> {
  const enabledPlugins = settings.general?.enabledPlugins;
  if (!enabledPlugins) return new Set();

  return new Set(
    Object.entries(enabledPlugins)
      .filter(([, enabled]) => enabled)
      .map(([pluginId]) => pluginId)
  );
}
