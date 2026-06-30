import open from 'open';

import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { getEnv } from '@/environment';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

// eslint-disable-next-line industry/constants-file-organization
export const accountCommand: SlashCommand = {
  name: 'account',
  description: 'Open Industry account in your browser',
  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage: addMessage } = context;

    try {
      const accountUrl = `${getEnv().appBaseUrl}/settings`;

      addMessage(
        getI18n().t('commands:slashMessages.account.opening', {
          url: accountUrl,
        }),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      // Open the URL in the default browser
      await open(accountUrl);

      return { handled: true };
    } catch (error) {
      logException(error, 'Error opening account page');
      addMessage(getI18n().t('commands:slashMessages.account.failed'), {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
      return { handled: true };
    }
  },
};
