import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logException, logInfo } from '@industry/logging';
import { McpSettingsManager } from '@industry/runtime/settings';

import { McpCommandResult } from '@/commands/mcp/types';
import { getServerInfoFromAttribution } from '@/commands/mcp/utils';
import { getI18n } from '@/i18n';

export async function handleRemoveCommand(
  name: string
): Promise<McpCommandResult> {
  try {
    const t = getI18n().t;
    const settingsManager = McpSettingsManager.getInstance();
    const infoResult = await getServerInfoFromAttribution(name);
    if (!infoResult.ok) {
      return {
        success: false,
        error: t('commands:mcp.remove.serverNotFound', { name }),
      };
    }

    const { source, isManaged } = infoResult;

    if (source === SettingsLevel.Org) {
      return {
        success: false,
        error: t('commands:mcp.remove.cannotRemoveOrg', { name }),
      };
    }

    if (isManaged) {
      return {
        success: false,
        error: t('commands:mcp.remove.cannotRemoveManaged', { name }),
      };
    }

    const removed = await settingsManager.removeMcpServer(
      name,
      SettingsLevel.User
    );

    if (removed) {
      logInfo('Removed MCP server via CLI command', { name });
      return {
        success: true,
        message: t('commands:mcp.remove.removed', { name }),
      };
    }
    return {
      success: false,
      error: t('commands:mcp.remove.serverNotFound', { name }),
    };
  } catch (error) {
    logException(error, 'Error removing MCP server');
    return {
      success: false,
      error: getI18n().t('commands:mcp.remove.removeError', {
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}
