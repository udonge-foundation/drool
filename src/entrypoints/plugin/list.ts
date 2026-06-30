import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { PluginMarketplaceManager } from '@industry/runtime/settings';

import {
  PluginCommandOptions,
  PluginCommandResult,
} from '@/entrypoints/plugin/types';
import { getI18n } from '@/i18n';

export async function handleListCommand(
  options?: PluginCommandOptions
): Promise<PluginCommandResult> {
  try {
    const t = getI18n().t;
    const settingsManager = PluginMarketplaceManager.getInstance();
    const scope: SettingsLevel | undefined = options?.scope;

    const plugins = await settingsManager.listInstalledPluginStatuses(scope);

    if (plugins.length === 0) {
      const scopeMsg = scope ? ` in ${scope} scope` : '';
      return {
        success: true,
        message: t('commands:plugin.noPluginsInstalled', { scope: scopeMsg }),
      };
    }

    const active = plugins.filter((plugin) => plugin.active);
    const inactive = plugins.filter((plugin) => !plugin.active);
    const lines = [t('commands:plugin.installedPlugins')];

    if (active.length > 0) {
      lines.push('Active:');
    }
    for (const { id, entry } of active) {
      const version = entry.version ? entry.version.substring(0, 7) : 'unknown';
      const scopeTag = `[${entry.scope}]`;
      lines.push(`  ${id}  ${scopeTag}  ${version}`);
    }
    if (inactive.length > 0) {
      lines.push('Inactive:');
    }
    for (const { id, entry, reason } of inactive) {
      const version = entry.version ? entry.version.substring(0, 7) : 'unknown';
      const scopeTag = `[${entry.scope}]`;
      lines.push(`  ${id}  ${scopeTag}  ${version}  ${reason}`);
    }

    return {
      success: true,
      message: lines.join('\n'),
    };
  } catch (error) {
    return {
      success: false,
      error: getI18n().t('commands:plugin.listError', {
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
