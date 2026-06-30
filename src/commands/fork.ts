import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

// eslint-disable-next-line industry/constants-file-organization
export const forkCommand: SlashCommand = {
  name: 'fork',
  description: 'Fork the current session',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage, forkSession } = context;

    if (!forkSession) {
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.forkNotAvailable'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }

    try {
      const newSessionId = await forkSession();
      if (!newSessionId) {
        return { handled: true };
      }
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.sessionForked'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    } catch (error) {
      logException(error, 'Error forking session');
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.errorForking'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }
  },
};
