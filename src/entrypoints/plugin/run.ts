import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';

import { handleInstallCommand } from '@/entrypoints/plugin/install';
import { handleListCommand } from '@/entrypoints/plugin/list';
import { PluginCommandOptions } from '@/entrypoints/plugin/types';
import { handleUninstallCommand } from '@/entrypoints/plugin/uninstall';
import { handleUpdateCommand } from '@/entrypoints/plugin/update';
import { getI18n } from '@/i18n';
import { exitWithCode } from '@/utils/exitWithCode';

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

function printError(message: string): void {
  process.stderr.write(`${message}\n`);
}

export async function runInstall(
  plugin: string,
  options: { scope?: SettingsLevel }
): Promise<void> {
  const t = getI18n().t;
  const cmdOptions: PluginCommandOptions = { scope: options.scope };
  const result = await handleInstallCommand(plugin, cmdOptions);

  if (result.success) {
    if (result.message) {
      print(result.message);
    }
    return;
  }
  printError(t('commands:plugin.errorPrefix', { message: result.error }));
  await exitWithCode(1);
}

export async function runUninstall(
  plugin: string,
  options: { scope?: SettingsLevel }
): Promise<void> {
  const t = getI18n().t;
  const cmdOptions: PluginCommandOptions = { scope: options.scope };
  const result = await handleUninstallCommand(plugin, cmdOptions);

  if (result.success) {
    if (result.message) {
      print(result.message);
    }
    return;
  }
  printError(t('commands:plugin.errorPrefix', { message: result.error }));
  await exitWithCode(1);
}

export async function runUpdate(
  plugin: string | undefined,
  options: { scope?: SettingsLevel }
): Promise<void> {
  const t = getI18n().t;
  const cmdOptions: PluginCommandOptions = { scope: options.scope };
  const result = await handleUpdateCommand(plugin, cmdOptions);

  if (result.success) {
    if (result.message) {
      print(result.message);
    }
    return;
  }
  if (result.message) {
    print(result.message);
  }
  printError(t('commands:plugin.errorPrefix', { message: result.error }));
  await exitWithCode(1);
}

export async function runList(options: {
  scope?: SettingsLevel;
}): Promise<void> {
  const t = getI18n().t;
  const cmdOptions: PluginCommandOptions = { scope: options.scope };
  const result = await handleListCommand(cmdOptions);

  if (result.success) {
    if (result.message) {
      print(result.message);
    }
    return;
  }
  printError(t('commands:plugin.errorPrefix', { message: result.error }));
  await exitWithCode(1);
}
