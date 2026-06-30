import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo } from '@industry/logging';
import { logout, getAuthedUser } from '@industry/runtime/auth';
import { clearFeatureFlagDiskCache } from '@industry/runtime/feature-flags';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { getRuntimeAuthConfig } from '@/environment';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getSessionService } from '@/services/SessionService';

// eslint-disable-next-line industry/constants-file-organization
export const logoutCommand: SlashCommand = {
  name: 'logout',
  description: 'Log out from Industry',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage } = context;

    try {
      // Check if user is logged in
      const user = await getAuthedUser(getRuntimeAuthConfig());

      if (!user) {
        addEphemeralSystemMessage(
          getI18n().t('commands:slashMessages.notLoggedIn'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return { handled: true };
      }

      // Execute SessionEnd hooks before logging out
      await getSessionService().executeSessionEndHooks('logout');

      // Clear the stored authentication and cached feature flags
      clearFeatureFlagDiskCache();
      await logout(getRuntimeAuthConfig());

      logInfo('User logged out successfully', { userId: user.userId });

      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.loggedOut'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      return { handled: true };
    } catch (error) {
      logInfo('Error during logout', { error });

      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.logoutError'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      return { handled: true };
    }
  },
};
