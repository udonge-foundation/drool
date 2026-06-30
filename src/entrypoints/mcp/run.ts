import { McpSettingsManager } from '@industry/runtime/settings';

import { handleAddCommand } from '@/commands/mcp/add';
import {
  handleClearPermissionsCommand,
  handleListPermissionsCommand,
  handleRevokePermissionCommand,
} from '@/commands/mcp/permissions';
import { handleRemoveCommand } from '@/commands/mcp/remove';
import { AddCommandOptions } from '@/commands/mcp/types';
import { handleListCommand } from '@/commands/mcp/utils';
import { getI18n } from '@/i18n';
import { exitWithCode } from '@/utils/exitWithCode';
import { promptLine } from '@/utils/prompt';

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

function printError(message: string, detail?: unknown): void {
  process.stderr.write(`${message}\n`);
  if (detail) {
    process.stderr.write(`${String(detail)}\n`);
  }
}

export async function runAdd(
  name: string,
  urlOrCommandParts: string[],
  options: AddCommandOptions
): Promise<void> {
  try {
    const urlOrCommand = urlOrCommandParts.join(' ');
    const result = await handleAddCommand(name, urlOrCommand, options);

    if (result.success) {
      if (result.message) {
        print(result.message);
      }
      return;
    }
    printError(
      getI18n().t('commands:mcp.errorPrefix', {
        message: result.error,
      })
    );
    await exitWithCode(1);
  } catch (error) {
    printError(getI18n().t('commands:mcp.unexpectedAddError'), error);
    await exitWithCode(1);
  }
}

export async function runRemove(name: string | undefined): Promise<void> {
  try {
    const t = getI18n().t;
    let selectedName = name;

    if (!selectedName) {
      const removableServers =
        await McpSettingsManager.getInstance().getRemovableMcpServerNames();
      if (removableServers.length === 0) {
        print(t('commands:mcp.remove.noRemovableServers'));
        return;
      }

      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        printError(t('commands:mcp.remove.interactiveTerminalRequired'));
        await exitWithCode(1);
        return;
      }

      print(t('commands:mcp.remove.selectHeading'));
      for (const [index, serverName] of removableServers.entries()) {
        print(`  ${index + 1}. ${serverName}`);
      }

      while (!selectedName) {
        const answer = await promptLine(
          t('commands:mcp.remove.selectionPrompt')
        );
        if (answer === '' || answer.toLowerCase() === 'q') {
          print(t('commands:mcp.remove.cancelled'));
          return;
        }

        const selectedIndex = Number.parseInt(answer, 10) - 1;
        if (!/^\d+$/u.test(answer) || !removableServers[selectedIndex]) {
          printError(t('commands:mcp.remove.invalidSelection'));
          continue;
        }

        selectedName = removableServers[selectedIndex];
      }
    }

    const result = await handleRemoveCommand(selectedName);

    if (result.success) {
      if (result.message) {
        print(result.message);
      }
      return;
    }
    printError(
      getI18n().t('commands:mcp.errorPrefix', { message: result.error })
    );
    await exitWithCode(1);
  } catch (error) {
    printError(getI18n().t('commands:mcp.unexpectedRemoveError'), error);
    await exitWithCode(1);
  }
}

/**
 * Connects to configured MCP servers and prints their connection and
 * authentication status.
 */
export async function runList(): Promise<void> {
  try {
    const result = await handleListCommand();

    if (result.success) {
      if (result.message) {
        print(result.message);
      }
      // Listing starts MCP connections (stdio child processes, sockets), so
      // exit explicitly instead of waiting for lingering handles to drain.
      await exitWithCode(0);
      return;
    }
    printError(
      getI18n().t('commands:mcp.errorPrefix', { message: result.error })
    );
    await exitWithCode(1);
  } catch (error) {
    printError(getI18n().t('commands:mcp.unexpectedError'), error);
    await exitWithCode(1);
  }
}

export async function runListPermissions(): Promise<void> {
  try {
    const result = await handleListPermissionsCommand();

    if (result.success) {
      if (result.message) {
        print(result.message);
      }
      return;
    }
    printError(
      getI18n().t('commands:mcp.errorPrefix', { message: result.error })
    );
    await exitWithCode(1);
  } catch (error) {
    printError(getI18n().t('commands:mcp.unexpectedError'), error);
    await exitWithCode(1);
  }
}

export async function runRevokePermission(
  server: string,
  tool?: string
): Promise<void> {
  try {
    const result = await handleRevokePermissionCommand(server, tool);

    if (result.success) {
      if (result.message) {
        print(result.message);
      }
      return;
    }
    printError(
      getI18n().t('commands:mcp.errorPrefix', { message: result.error })
    );
    await exitWithCode(1);
  } catch (error) {
    printError(getI18n().t('commands:mcp.unexpectedError'), error);
    await exitWithCode(1);
  }
}

export async function runClearPermissions(confirm: boolean): Promise<void> {
  try {
    const result = await handleClearPermissionsCommand(confirm);

    if (result.success) {
      if (result.message) {
        print(result.message);
      }
      return;
    }
    printError(result.error);
    await exitWithCode(1);
  } catch (error) {
    printError(getI18n().t('commands:mcp.unexpectedError'), error);
    await exitWithCode(1);
  }
}
