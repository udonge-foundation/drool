import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

// eslint-disable-next-line industry/constants-file-organization
export const compactCommand: SlashCommand = {
  name: 'compress',
  description:
    'Compress the current session. Add instructions after slash command for customization (alias: handoff, compact)',
  execute: async (
    args: string[],
    context: CommandContext,
    rawArgs?: string
  ): Promise<CommandResult> => {
    if (context.showCompactConfirmation) {
      // Prefer rawArgs to avoid shell-quote operator stringification
      const joined = (rawArgs ?? args.join(' ')).trim();
      const instructions = joined.length > 0 ? joined : undefined;
      context.showCompactConfirmation(instructions);
      return { handled: true };
    }
    context.addEphemeralSystemMessage(
      getI18n().t('commands:slashMessages.compact.notAvailable'),
      {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      }
    );
    return { handled: true };
  },
};
