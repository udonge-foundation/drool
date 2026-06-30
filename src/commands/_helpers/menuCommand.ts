import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';

import { MenuCommandOptions } from '@/commands/_helpers/types';
import { CommandResult } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

export function runMenuCommand({
  addMessage,
  openMenu,
  fallbackMessageKey,
  commandName,
  errorMessageKey,
}: MenuCommandOptions): CommandResult {
  const notify = (key: string) => {
    addMessage(getI18n().t(key), {
      messageType: MessageType.SystemNotification,
      visibility: MessageVisibility.UserOnly,
    });
  };

  try {
    if (openMenu) {
      openMenu();
      return { handled: true, shouldRunAgent: false };
    }

    notify(fallbackMessageKey);
    return { handled: true, shouldRunAgent: false };
  } catch (error) {
    logException(error, 'Failed to run menu command', {
      command: commandName,
    });
    notify(errorMessageKey);
    return { handled: true, shouldRunAgent: false };
  }
}
