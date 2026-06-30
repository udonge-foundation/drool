import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

interface ReviewCommandContext extends CommandContext {
  showReviewFlow?: () => void;
}

// eslint-disable-next-line industry/constants-file-organization
export const reviewCommand: SlashCommand = {
  name: 'review',
  description: 'Review code changes and find issues',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const reviewContext = context as ReviewCommandContext;

    try {
      if (reviewContext.showReviewFlow) {
        reviewContext.showReviewFlow();
      }
    } catch (error) {
      logException(error, 'Error opening review flow');
      context.addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.errorOpeningReview'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
    }
    return { handled: true, shouldRunAgent: false };
  },
};
