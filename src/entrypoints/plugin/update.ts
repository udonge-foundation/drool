import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { PluginInstallResult } from '@industry/runtime/plugins';
import { PluginMarketplaceManager } from '@industry/runtime/settings';

import {
  PluginCommandOptions,
  PluginCommandResult,
} from '@/entrypoints/plugin/types';
import { getI18n } from '@/i18n';

export async function handleUpdateCommand(
  pluginId?: string,
  options?: PluginCommandOptions
): Promise<PluginCommandResult> {
  try {
    const t = getI18n().t;
    const settingsManager = PluginMarketplaceManager.getInstance();
    const scope: SettingsLevel | undefined = options?.scope;

    const results = await settingsManager.updatePlugin(pluginId, scope);

    if (results.length === 0) {
      return {
        success: true,
        message: pluginId
          ? t('commands:plugin.pluginNotInstalledForUpdate', { id: pluginId })
          : t('commands:plugin.noPluginsToUpdate'),
      };
    }

    const successes = results.filter((r: PluginInstallResult) => r.success);
    const failures = results.filter((r: PluginInstallResult) => !r.success);

    const messages: string[] = [];

    if (successes.length > 0) {
      for (const result of successes) {
        const version = result.entry?.version
          ? ` (${result.entry.version.substring(0, 7)})`
          : '';
        messages.push(
          `${t('commands:plugin.updateSuccess', { id: result.pluginId })}${version}`
        );
      }
    }

    if (failures.length > 0) {
      for (const result of failures) {
        messages.push(
          t('commands:plugin.updateFailed', {
            id: result.pluginId,
            error: result.error,
          })
        );
      }
    }

    return {
      success: failures.length === 0,
      message: messages.join('\n'),
      error:
        failures.length > 0
          ? t('commands:plugin.somePluginsFailed')
          : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: getI18n().t('commands:plugin.updateError', {
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
