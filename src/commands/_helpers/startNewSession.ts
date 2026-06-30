import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';

import { StartNewSessionOptions } from '@/commands/_helpers/types';
import { CommandResult } from '@/commands/types';
import { resetHeaderShown } from '@/components/StaticMessageList';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getPrService } from '@/services/PrService';
import { getSessionService } from '@/services/SessionService';
import { clearTerminal } from '@/utils/clearTerminal';

export async function runStartNewSessionCommand({
  context,
  commandName,
  scheduledTaskLeaveRepeatInstruction,
  preCreate,
}: StartNewSessionOptions): Promise<CommandResult> {
  const {
    addEphemeralSystemMessage,
    clearHistory,
    clearSummary,
    clearTerminal: clearInkTerminal,
    forceUIRefresh,
    confirmScheduledTaskLeave,
    createSession,
  } = context;

  try {
    const scheduledTaskLeaveWarning = {
      actionKey: commandName,
      repeatInstruction: scheduledTaskLeaveRepeatInstruction,
    };
    if (
      confirmScheduledTaskLeave &&
      !confirmScheduledTaskLeave(scheduledTaskLeaveWarning)
    ) {
      return { handled: true };
    }

    if (preCreate) {
      await preCreate();
    }

    await getSessionService().executeSessionEndHooks('clear');

    if (createSession) {
      const newSessionId = await createSession({
        skipScheduledTaskLeaveWarning: Boolean(confirmScheduledTaskLeave),
        scheduledTaskLeaveWarning,
      });
      if (!newSessionId) {
        return { handled: true };
      }
    }

    void getPrService().refresh();

    if (clearHistory) {
      clearHistory();
      resetHeaderShown();
    }

    if (clearSummary) {
      clearSummary();
    }

    addEphemeralSystemMessage(
      getI18n().t('commands:slashMessages.newSessionCreated'),
      {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      }
    );

    setTimeout(() => {
      // Prefer the Ink-aware clear from the command context so Ink's
      // incremental-rendering cache is invalidated before the terminal clear.
      (clearInkTerminal ?? clearTerminal)();
      if (forceUIRefresh) {
        forceUIRefresh();
      }
    }, 50);

    return { handled: true };
  } catch (error) {
    logException(error, 'Failed to start new session command', {
      command: commandName,
    });
    addEphemeralSystemMessage(
      getI18n().t('commands:slashMessages.errorCreatingSession'),
      {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      }
    );
    return { handled: true };
  }
}
