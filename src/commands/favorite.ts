import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logInfo } from '@industry/logging';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getSessionService } from '@/services/SessionService';

const defineCommand = (command: SlashCommand): SlashCommand => command;

export const favoriteCommand: SlashCommand = defineCommand({
  name: 'favorite',
  description: 'Pin the current session for quick access (alias: pin)',
  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage } = context;

    try {
      const sessionService = getSessionService();
      const currentSessionId = sessionService.getCurrentSessionId();

      if (!currentSessionId) {
        addEphemeralSystemMessage(
          getI18n().t('commands:slashMessages.noActiveSessionToFavorite'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return { handled: true };
      }

      const isPinned = sessionService.togglePinSession(currentSessionId);
      const t = getI18n().t;
      const message = isPinned
        ? t('commands:slashMessages.sessionAddedToFavorites')
        : t('commands:slashMessages.sessionRemovedFromFavorites');

      logInfo('[Pin Command] Session pin state toggled', {
        sessionId: currentSessionId,
        isFavorite: isPinned,
      });

      addEphemeralSystemMessage(message, {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });

      return { handled: true };
    } catch (error) {
      logException(error, 'Error toggling session pin state');
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.errorUpdatingFavorite'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }
  },
});

export const pinCommand: SlashCommand = defineCommand({
  ...favoriteCommand,
  name: 'pin',
  description: 'Pin the current session for quick access (alias: favorite)',
});
