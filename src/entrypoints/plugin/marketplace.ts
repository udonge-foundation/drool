import {
  MarketplaceOperationResult,
  parseMarketplaceSource,
} from '@industry/runtime/plugins';
import { PluginMarketplaceManager } from '@industry/runtime/settings';

import { PluginCommandResult } from '@/entrypoints/plugin/types';
import { getI18n } from '@/i18n';
import { exitWithCode } from '@/utils/exitWithCode';

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

function printError(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function handleMarketplaceAddCommand(
  url: string
): Promise<PluginCommandResult> {
  try {
    const t = getI18n().t;
    const settingsManager = PluginMarketplaceManager.getInstance();
    const source = parseMarketplaceSource(url);
    const result = await settingsManager.addMarketplace(source);

    if (result.success) {
      return {
        success: true,
        message: t('commands:marketplace.addSuccess', { name: result.name }),
      };
    }
    return {
      success: false,
      error: result.error || t('commands:marketplace.addFailed'),
    };
  } catch (error) {
    return {
      success: false,
      error: getI18n().t('commands:marketplace.addError', {
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

async function handleMarketplaceRemoveCommand(
  name: string
): Promise<PluginCommandResult> {
  try {
    const t = getI18n().t;
    const settingsManager = PluginMarketplaceManager.getInstance();
    const result = await settingsManager.removeMarketplace(name);

    if (result.success) {
      return {
        success: true,
        message: t('commands:marketplace.removeSuccess', { name }),
      };
    }
    return {
      success: false,
      error: result.error || t('commands:marketplace.removeFailed'),
    };
  } catch (error) {
    return {
      success: false,
      error: getI18n().t('commands:marketplace.removeError', {
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

async function handleMarketplaceListCommand(): Promise<PluginCommandResult> {
  try {
    const t = getI18n().t;
    const settingsManager = PluginMarketplaceManager.getInstance();
    const marketplaces = await settingsManager.listMarketplaces();

    if (marketplaces.length === 0) {
      return {
        success: true,
        message: t('commands:marketplace.noMarketplaces'),
      };
    }

    const lines = [t('commands:marketplace.registeredMarketplaces')];
    for (const mp of marketplaces) {
      const pluginCount =
        mp.pluginCount > 0 ? `(${mp.pluginCount} plugins)` : '';
      let source: string;
      if (mp.entry.source.source === 'github') {
        source = `github:${mp.entry.source.repo}`;
      } else if (mp.entry.source.source === 'local') {
        source = `local:${mp.entry.source.path}`;
      } else {
        source = mp.entry.source.url;
      }
      if (mp.entry.source.source !== 'local') {
        if (mp.entry.source.sha) {
          source = `${source}@${mp.entry.source.sha}`;
        } else if (mp.entry.source.ref) {
          source = `${source}#${mp.entry.source.ref}`;
        }
      }
      lines.push(`  ${mp.name}  ${pluginCount}  ${source}`);
    }

    return {
      success: true,
      message: lines.join('\n'),
    };
  } catch (error) {
    return {
      success: false,
      error: getI18n().t('commands:marketplace.listError', {
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

async function handleMarketplaceUpdateCommand(
  name?: string
): Promise<PluginCommandResult> {
  try {
    const t = getI18n().t;
    const settingsManager = PluginMarketplaceManager.getInstance();
    const results = await settingsManager.updateMarketplace(name);

    const successes = results.filter(
      (r: MarketplaceOperationResult) => r.success
    );
    const failures = results.filter(
      (r: MarketplaceOperationResult) => !r.success
    );

    if (results.length === 0) {
      return {
        success: true,
        message: name
          ? t('commands:marketplace.marketplaceNotFound', { name })
          : t('commands:marketplace.noMarketplacesToUpdate'),
      };
    }

    const messages: string[] = [];
    if (successes.length > 0) {
      messages.push(
        t('commands:marketplace.updateSuccess', {
          names: successes
            .map((r: MarketplaceOperationResult) => r.name)
            .join(', '),
        })
      );
    }
    if (failures.length > 0) {
      messages.push(
        t('commands:marketplace.updateFailed', {
          details: failures
            .map((r: MarketplaceOperationResult) => `${r.name} (${r.error})`)
            .join(', '),
        })
      );
    }

    return {
      success: failures.length === 0,
      message: messages.join('\n'),
      error:
        failures.length > 0
          ? t('commands:marketplace.someMarketplacesFailed')
          : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: getI18n().t('commands:marketplace.updateError', {
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

export async function runMarketplaceAdd(url: string): Promise<void> {
  const result = await handleMarketplaceAddCommand(url);
  if (result.success) {
    if (result.message) print(result.message);
    return;
  }
  printError(
    getI18n().t('commands:marketplace.errorPrefix', { message: result.error })
  );
  await exitWithCode(1);
}

export async function runMarketplaceRemove(name: string): Promise<void> {
  const result = await handleMarketplaceRemoveCommand(name);
  if (result.success) {
    if (result.message) print(result.message);
    return;
  }
  printError(
    getI18n().t('commands:marketplace.errorPrefix', { message: result.error })
  );
  await exitWithCode(1);
}

export async function runMarketplaceList(): Promise<void> {
  const result = await handleMarketplaceListCommand();
  if (result.success) {
    if (result.message) print(result.message);
    return;
  }
  printError(
    getI18n().t('commands:marketplace.errorPrefix', { message: result.error })
  );
  await exitWithCode(1);
}

export async function runMarketplaceUpdate(name?: string): Promise<void> {
  const result = await handleMarketplaceUpdateCommand(name);
  if (result.success) {
    if (result.message) print(result.message);
    return;
  }
  if (result.message) print(result.message);
  printError(
    getI18n().t('commands:marketplace.errorPrefix', { message: result.error })
  );
  await exitWithCode(1);
}
