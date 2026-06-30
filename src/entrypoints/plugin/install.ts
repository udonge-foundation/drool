import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { parsePluginId } from '@industry/runtime/plugins';
import { PluginMarketplaceManager } from '@industry/runtime/settings';

import {
  PluginCommandOptions,
  PluginCommandResult,
} from '@/entrypoints/plugin/types';
import { getI18n } from '@/i18n';

export async function handleInstallCommand(
  pluginSpec: string,
  options: PluginCommandOptions
): Promise<PluginCommandResult> {
  try {
    const t = getI18n().t;
    // Parse plugin@marketplace format. The marketplace component is everything
    // after the first `@` and may itself contain `@` (ref/sha pins).
    const parsed = parsePluginId(pluginSpec);
    if (!parsed) {
      return {
        success: false,
        error: t('commands:plugin.invalidFormat', { spec: pluginSpec }),
      };
    }

    const { pluginName, marketplace: marketplaceName } = parsed;

    const scope: SettingsLevel = options.scope || SettingsLevel.User;
    const settingsManager = PluginMarketplaceManager.getInstance();
    const result = await settingsManager.installPlugin(
      marketplaceName,
      pluginName,
      scope
    );

    if (result.success) {
      const version = result.entry?.version
        ? ` (${result.entry.version.substring(0, 7)})`
        : '';
      return {
        success: true,
        message: `${t('commands:plugin.installSuccess', { id: result.pluginId })}${version}`,
      };
    }
    return {
      success: false,
      error: result.error || t('commands:plugin.installFailed'),
    };
  } catch (error) {
    return {
      success: false,
      error: getI18n().t('commands:plugin.installError', {
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
