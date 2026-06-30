import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo } from '@industry/logging';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

// eslint-disable-next-line industry/constants-file-organization
export const providerCommand: SlashCommand = {
  name: 'provider',
  description: 'Configure BYOK or coding subscription providers',
  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage, showLoginSelector } = context;

    logInfo('Provider command initiated');

    if (showLoginSelector) {
      showLoginSelector();
      return { handled: true };
    }

    addEphemeralSystemMessage(
      getI18n().t('commands:slashMessages.login.notAvailable'),
      {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      }
    );

    return { handled: true };
  },
};
