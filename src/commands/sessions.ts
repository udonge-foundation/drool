import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logInfo } from '@industry/logging';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getSessionService } from '@/services/SessionService';
import { SESSION_SELECTOR_MAX_OTHER_SESSIONS } from '@/session-selector/constants';

// eslint-disable-next-line industry/constants-file-organization
export const sessionsCommand: SlashCommand = {
  name: 'sessions',
  description: 'List and select previous sessions to resume',
  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage, showSessionSelector } = context;

    try {
      // Get current working directory for project-aware session listing
      const currentCwd = process.cwd();
      const sessionService = getSessionService();
      const selectorOptions = {
        currentCwd,
        fetchOutsideCWD: true,
        maxOtherSessions: SESSION_SELECTOR_MAX_OTHER_SESSIONS,
      } as const;

      // Sync pinned state from the backend API (also migrates legacy .favorites)
      await sessionService.syncPinnedSessions();

      // Open from warm cached index data when available. If the cache is empty,
      // fall back to a catch-up read before deciding that no sessions exist.
      let sessions =
        await sessionService.getCachedNonEmptySessions(selectorOptions);
      if (sessions.length === 0) {
        sessions = await sessionService.getAllNonEmptySessions(selectorOptions);
      }

      if (sessions.length === 0) {
        addEphemeralSystemMessage(
          getI18n().t('commands:slashMessages.noSessionsFound'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return { handled: true };
      }

      // Log session counts for debugging
      const currentFolderCount = sessions.filter(
        (s) => s.isCurrentProject
      ).length;
      const favoritesCount = sessions.filter((s) => s.isFavorite).length;
      logInfo('Sessions retrieved', {
        totalCount: sessions.length,
        count: currentFolderCount,
        currentCount: favoritesCount,
        cwd: currentCwd,
      });

      // Show the session selector UI
      if (showSessionSelector) {
        // For now, show all sessions together. The UI can be enhanced later
        // to show them in groups
        showSessionSelector(sessions);
        return { handled: true };
      }

      // Fallback if showSessionSelector is not available
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.sessionSelectorNotAvailable'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      return { handled: true };
    } catch (error) {
      logException(error, 'Error loading sessions');
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.errorLoadingSessions'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }
  },
};
