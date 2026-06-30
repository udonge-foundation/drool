import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logInfo } from '@industry/logging';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';

// eslint-disable-next-line industry/constants-file-organization
export const renameCommand: SlashCommand = {
  name: 'rename',
  description: 'Rename the current session',
  execute: async (
    args: string[],
    context: CommandContext,
    rawArgs?: string
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage, forceUIRefresh } = context;

    const title = (rawArgs ?? args.join(' ')).trim();
    if (!title) {
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.renameUsage'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }

    const sessionId = getSessionService().getCurrentSessionId();
    if (!sessionId) {
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.noActiveSessionToRename'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }

    try {
      await getTuiDaemonAdapter().renameSession(sessionId, title);

      logInfo('[Rename Command] Session renamed', {
        sessionId,
        length: title.length,
      });

      forceUIRefresh?.();

      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.sessionRenamed'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      return { handled: true };
    } catch (error) {
      logException(error, 'Error renaming session');
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.errorRenamingSession'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }
  },
};
