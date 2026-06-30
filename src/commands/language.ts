import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import { CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { SUPPORTED_LOCALES } from '@/i18n/constants';
import { SupportedLocale } from '@/i18n/enums';
import { getI18n } from '@/i18n/index';
import { getSettingsService } from '@/services/SettingsService';

/**
 * Resolve user input to a SupportedLocale, handling case-insensitive matching.
 * Returns the matched locale or null if not supported.
 */
function resolveLocale(input: string): SupportedLocale | null {
  const normalised = input.trim().toLowerCase();

  for (const locale of SUPPORTED_LOCALES) {
    if (locale.toLowerCase() === normalised) {
      return locale;
    }
  }

  return null;
}

// eslint-disable-next-line industry/constants-file-organization
export const languageCommand: SlashCommand = {
  name: 'language',
  description: 'Switch the TUI display language',
  execute: async (args, context): Promise<CommandResult> => {
    const { addEphemeralSystemMessage } = context;
    const i18n = getI18n();
    const supportedList = SUPPORTED_LOCALES.join(', ');

    // No args: show current locale and available options
    if (args.length === 0) {
      const currentLocale = i18n.language;
      const currentMsg = i18n.t('common:language.currentLanguage', {
        locale: currentLocale,
      });
      const supportedMsg = i18n.t('common:language.supported', {
        locales: supportedList,
      });
      addEphemeralSystemMessage(`${currentMsg}\n${supportedMsg}`, {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
      return { handled: true, shouldRunAgent: false };
    }

    const requestedLocale = args[0];
    const resolved = resolveLocale(requestedLocale);

    if (!resolved) {
      addEphemeralSystemMessage(
        i18n.t('common:language.unsupportedLocale', {
          locale: requestedLocale,
          supported: supportedList,
        }),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true, shouldRunAgent: false };
    }

    // Change i18next language immediately
    void i18n.changeLanguage(resolved);

    // Persist to settings
    getSettingsService().setLanguagePreference(resolved);

    addEphemeralSystemMessage(
      i18n.t('common:language.switched', { locale: resolved }),
      {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      }
    );

    return { handled: true, shouldRunAgent: false };
  },
};
