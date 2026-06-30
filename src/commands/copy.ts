import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageRole, MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { copyToClipboard } from '@/utils/clipboard';
import {
  countLines,
  findLastTextByRole,
  getConversationHistoryForCopy,
} from '@/utils/conversationCopy';

// eslint-disable-next-line industry/constants-file-organization
export const copyCommand: SlashCommand = {
  name: 'copy',
  description:
    'Open a selector to copy prompts, responses, turn ranges, or the session ID',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage: addMessage, showCopySelector } = context;

    // Interactive TUI path: open the selector overlay.
    if (showCopySelector && showCopySelector()) {
      return { handled: true };
    }

    // Fallback: non-interactive path (no selector available). Copy the last
    // assistant response, preserving prior /copy behavior for exec/non-TUI.
    const history = getConversationHistoryForCopy();
    const textToCopy = findLastTextByRole(history, MessageRole.Assistant);

    if (!textToCopy) {
      addMessage(getI18n().t('commands:slashMessages.copy.noContent'), {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
      return { handled: true };
    }

    const copied = await copyToClipboard(textToCopy);
    if (!copied) {
      addMessage(getI18n().t('commands:slashMessages.copy.clipboardFailed'), {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
      return { handled: true };
    }

    const lineCount = countLines(textToCopy);
    addMessage(
      getI18n().t('commands:slashMessages.copy.copied', { count: lineCount }),
      {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      }
    );

    return { handled: true };
  },
};
