import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

// eslint-disable-next-line industry/constants-file-organization
export const btwCommand: SlashCommand = {
  name: 'btw',
  description: 'Ask a side question without polluting the main transcript',
  execute: async (
    args: string[],
    context: CommandContext,
    rawArgs?: string
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage, submitBtwQuestion, showBtwScrollView } =
      context;

    // Prefer the raw argument text — shell-quote turns chars like `?` into
    // operator objects that otherwise surface as "[object Object]".
    const question = (rawArgs ?? args.join(' ')).trim();

    if (!showBtwScrollView || !submitBtwQuestion) {
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.btwNotAvailable'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }

    // Always open the scroll view so the user can track questions/answers,
    // regardless of whether a question was supplied on this invocation.
    showBtwScrollView();

    // No args → the scroll view shows prior history (or a hint when empty).
    if (question.length === 0) {
      return { handled: true };
    }

    try {
      await submitBtwQuestion(question);
      return { handled: true };
    } catch (error) {
      logException(error, 'Error submitting /btw question');
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.btwError'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }
  },
};
