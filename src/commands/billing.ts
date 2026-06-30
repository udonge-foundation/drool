import open from 'open';

import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { getEnv } from '@/environment';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

// eslint-disable-next-line industry/constants-file-organization
export const billingCommand: SlashCommand = {
  name: 'billing',
  description: 'Open Industry billing in your browser',
  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage: addMessage } = context;

    try {
      const billingUrl = `${getEnv().appBaseUrl}/settings/billing`;

      addMessage(
        getI18n().t('commands:slashMessages.billing.opening', {
          url: billingUrl,
        }),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      // Open the URL in the default browser
      await open(billingUrl);

      return { handled: true };
    } catch (error) {
      logException(error, 'Error opening billing page');
      addMessage(getI18n().t('commands:slashMessages.billing.failed'), {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
      return { handled: true };
    }
  },
};
