import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import type {
  CommandContext,
  CommandResult,
  SlashCommand,
} from '@/commands/types';
import { MessageType } from '@/hooks/enums';

// eslint-disable-next-line industry/constants-file-organization
export const themeCommand: SlashCommand = {
  name: 'themes',
  description: 'Choose a color theme',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage, showThemeSelector } = context;

    if (showThemeSelector) {
      showThemeSelector();
      return { handled: true };
    }

    addEphemeralSystemMessage(
      'Theme selector is not available in this context.',
      {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      }
    );

    return { handled: true };
  },
};
