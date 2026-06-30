import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

// eslint-disable-next-line industry/constants-file-organization
export const rewindCommand: SlashCommand = {
  name: 'rewind-conversation',
  description: 'Rewind conversation to a previous message',
  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage, showRewindMenu } = context;

    // Check if rewind menu is available
    if (!showRewindMenu) {
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.rewind.notAvailable'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }

    // Show the rewind menu and let it handle the rest
    // Always return handled=true since the command was recognized,
    // even if the menu couldn't be shown (e.g., no messages available)
    await showRewindMenu();

    return { handled: true };
  },
};
