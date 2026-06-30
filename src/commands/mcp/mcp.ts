import { McpServerStatus } from '@industry/drool-sdk-ext/protocol/drool';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logException } from '@industry/logging';

import { runMenuCommand } from '@/commands/_helpers/menuCommand';
import type {
  CommandContext,
  CommandResult,
  SlashCommand,
} from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';

function addMcpMessage(context: CommandContext, content: string): void {
  context.addEphemeralSystemMessage(content, {
    messageType: MessageType.SystemNotification,
    visibility: MessageVisibility.UserOnly,
  });
}

async function disableConfigurableServers(
  context: CommandContext
): Promise<void> {
  const sessionId = getSessionService().getCurrentSessionId();
  if (!sessionId) {
    addMcpMessage(
      context,
      getI18n().t('commands:slashMessages.noActiveSession')
    );
    return;
  }

  try {
    const adapter = getTuiDaemonAdapter();
    const { servers } = await adapter.listMcpServers(sessionId);
    const enabledConfigurableServers = servers.filter(
      (server) =>
        server.source !== SettingsLevel.Org &&
        server.status !== McpServerStatus.Disabled
    );

    if (enabledConfigurableServers.length === 0) {
      addMcpMessage(context, getI18n().t('commands:mcp.offAlreadyDisabled'));
      return;
    }

    for (const server of enabledConfigurableServers) {
      const result = await adapter.toggleMcpServer(
        sessionId,
        server.name,
        false
      );
      if (!result.success) {
        throw new Error(getI18n().t('commands:mcp.unexpectedError'));
      }
    }

    addMcpMessage(
      context,
      getI18n().t('commands:mcp.offSuccess', {
        count: enabledConfigurableServers.length,
      })
    );
  } catch (error) {
    logException(error, 'Failed to disable configurable MCP servers');
    addMcpMessage(
      context,
      getI18n().t('commands:mcp.offError', {
        message:
          error instanceof Error
            ? error.message
            : getI18n().t('commands:mcp.unexpectedError'),
      })
    );
  }
}

// eslint-disable-next-line industry/constants-file-organization
export const mcpCommand: SlashCommand = {
  name: 'mcp',
  description: 'Manage MCP servers (/mcp off disables configurable servers)',

  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    if (args.length === 1 && args[0]?.toLowerCase() === 'off') {
      await disableConfigurableServers(context);
      return { handled: true, shouldRunAgent: false };
    }

    return runMenuCommand({
      addMessage: context.addEphemeralSystemMessage,
      openMenu: args.length === 0 ? context.showMcpManager : undefined,
      fallbackMessageKey:
        args.length === 0
          ? 'commands:mcp.uiNotAvailable'
          : 'commands:mcp.useInteractiveManager',
      commandName: 'mcp',
      errorMessageKey: 'commands:mcp.openError',
    });
  },
};
