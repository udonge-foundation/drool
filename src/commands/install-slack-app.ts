import chalk from 'chalk';
import open from 'open';

import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logInfo } from '@industry/logging';

import { ConnectionStatus } from '@/commands/enums';
import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { getEnv } from '@/environment';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import {
  checkSlackConnection,
  getSlackOAuthStartUrl,
  pollForSlackConnection,
} from '@/services/slack/connection';

function getConfigureUrl(): string {
  return `${getEnv().appBaseUrl}/settings/organization`;
}

function displaySlackStatus(
  addMessage: CommandContext['addEphemeralSystemMessage'],
  headerMessage: string,
  options: { workspace?: string; isActive: boolean; errorMessage?: string }
) {
  const t = getI18n().t;
  const sanitize = (value: string) =>
    value
      // eslint-disable-next-line no-control-regex
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B-\x1A\x1C-\x1F\x7F]/g, '');
  const lines: string[] = [headerMessage];

  if (options.workspace) {
    lines.push(
      `\t${t('commands:slashMessages.installSlackApp.workspace', { name: sanitize(options.workspace) })}`
    );
  }

  if (options.isActive) {
    lines.push(
      `\t${t('commands:slashMessages.installSlackApp.connectionActive')} ${chalk.green('\u25cf')}`
    );
  } else if (options.errorMessage) {
    lines.push(
      `\t${t('commands:slashMessages.installSlackApp.connectionFailed', { message: sanitize(options.errorMessage) })} ${chalk.red('\u25cf')}`
    );
  }

  lines.push(
    `\t${t('commands:slashMessages.installSlackApp.configure', { url: getConfigureUrl() })}`
  );

  addMessage(lines.join('\n'), {
    messageType: MessageType.SystemNotification,
    visibility: MessageVisibility.UserOnly,
  });
}

// eslint-disable-next-line industry/constants-file-organization
export const installSlackAppCommand: SlashCommand = {
  name: 'install-slack-app',
  description: 'Connect Slack to your Industry organization',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage: addMessage } = context;
    const t = getI18n().t;

    const { status, workspace, errorMessage } = await checkSlackConnection();

    if (status === ConnectionStatus.Connected) {
      logInfo('[InstallSlackApp] Slack integration already connected');
      displaySlackStatus(
        addMessage,
        t('commands:slashMessages.installSlackApp.alreadyConnected'),
        { workspace: workspace || 'Unknown', isActive: true }
      );
      return { handled: true };
    }

    if (status === ConnectionStatus.Error) {
      logInfo('[InstallSlackApp] Error checking Slack connection');
      displaySlackStatus(
        addMessage,
        t('commands:slashMessages.installSlackApp.error'),
        { isActive: false, errorMessage }
      );
      return { handled: true };
    }

    // Not connected -- open browser for OAuth

    try {
      addMessage(t('commands:slashMessages.installSlackApp.opening'), {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });

      await open(getSlackOAuthStartUrl());
    } catch (error) {
      logException(error, 'Error opening Slack integration page');
      addMessage(
        t('commands:slashMessages.installSlackApp.failed', {
          url: getConfigureUrl(),
        }),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }

    // Poll for connection completion
    const {
      status: pollStatus,
      workspace: pollWorkspace,
      errorMessage: pollErrorMessage,
    } = await pollForSlackConnection();

    if (pollStatus === ConnectionStatus.Connected) {
      logInfo('[InstallSlackApp] Slack integration connected after OAuth');
      displaySlackStatus(
        addMessage,
        t('commands:slashMessages.installSlackApp.connected'),
        { workspace: pollWorkspace || 'Unknown', isActive: true }
      );
    } else if (pollStatus === ConnectionStatus.Error) {
      displaySlackStatus(
        addMessage,
        t('commands:slashMessages.installSlackApp.error'),
        { isActive: false, errorMessage: pollErrorMessage }
      );
    } else {
      addMessage(t('commands:slashMessages.installSlackApp.timeout'), {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
    }

    return { handled: true };
  },
};
