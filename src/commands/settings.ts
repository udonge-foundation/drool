import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getSettingsService } from '@/services/SettingsService';

// eslint-disable-next-line industry/constants-file-organization
export const settingsCommand: SlashCommand = {
  name: 'settings',
  description: 'Configure application settings',
  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage, showSettingsSelector } = context;

    try {
      const settings = getSettingsService().getSettings();

      if (showSettingsSelector) {
        showSettingsSelector(settings);
        return { handled: true };
      }

      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.settingsNotAvailable'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      return { handled: true };
    } catch (error) {
      logException(error, 'Error loading settings');
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.errorLoadingSettings'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }
  },
};
