import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

interface HooksCommandContext extends CommandContext {
  showHooksManager?: () => void;
}

// eslint-disable-next-line industry/constants-file-organization
export const hooksCommand: SlashCommand = {
  name: 'hooks',
  description: 'Manage tool execution hooks',
  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage } = context;
    const hooksContext = context as HooksCommandContext;

    try {
      if (hooksContext.showHooksManager) {
        hooksContext.showHooksManager();
        return { handled: true, shouldRunAgent: false };
      }

      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.hooksNotAvailable'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      return { handled: true, shouldRunAgent: false };
    } catch (error) {
      logException(error, 'Error opening hooks manager');
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.errorOpeningHooks'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true, shouldRunAgent: false };
    }
  },
};
