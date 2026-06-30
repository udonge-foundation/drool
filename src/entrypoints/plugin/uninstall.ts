import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { PluginMarketplaceManager } from '@industry/runtime/settings';

import {
  PluginCommandOptions,
  PluginCommandResult,
} from '@/entrypoints/plugin/types';
import { getI18n } from '@/i18n';

export async function handleUninstallCommand(
  pluginId: string,
  options: PluginCommandOptions
): Promise<PluginCommandResult> {
  try {
    const t = getI18n().t;
    const settingsManager = PluginMarketplaceManager.getInstance();

    // Determine scope - if not specified, try to find where the plugin is installed
    let scope: SettingsLevel = options.scope || SettingsLevel.User;

    if (!options.scope) {
      // Check if plugin exists in user scope first, then project
      const userPlugin = await settingsManager.getInstalledPlugin(
        pluginId,
        SettingsLevel.User
      );
      const projectPlugin = await settingsManager.getInstalledPlugin(
        pluginId,
        SettingsLevel.Project
      );

      if (userPlugin) {
        scope = SettingsLevel.User;
      } else if (projectPlugin) {
        scope = SettingsLevel.Project;
      } else {
        return {
          success: false,
          error: t('commands:plugin.pluginNotInstalled', { id: pluginId }),
        };
      }
    }

    const success = await settingsManager.uninstallPlugin(pluginId, scope);

    if (success) {
      return {
        success: true,
        message: t('commands:plugin.uninstallSuccess', { id: pluginId }),
      };
    }
    return {
      success: false,
      error: t('commands:plugin.uninstallFailed', { id: pluginId }),
    };
  } catch (error) {
    return {
      success: false,
      error: getI18n().t('commands:plugin.uninstallError', {
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
