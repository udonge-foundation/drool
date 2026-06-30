import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { terminalSetup } from '@/utils/terminalSetup';

// eslint-disable-next-line industry/constants-file-organization
export const terminalSetupCommand: SlashCommand = {
  name: 'terminal-setup',
  description:
    'Configure keybindings for multiline input (tmux, VS Code, Cursor, Windsurf, Windows Terminal)',

  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    try {
      const result = await terminalSetup();

      context.addEphemeralSystemMessage(result.message, {
        messageType: MessageType.Text,
        visibility: MessageVisibility.UserOnly,
      });
      return { handled: true };
    } catch (error) {
      context.addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.terminalSetup.failed', {
          error: String(error),
        }),
        {
          messageType: MessageType.Text,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }
  },
};
