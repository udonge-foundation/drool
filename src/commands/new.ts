import { DecompSessionType } from '@industry/drool-sdk-ext/protocol/drool';
import { DroolInteractionMode } from '@industry/drool-sdk-ext/protocol/shared';

import { runStartNewSessionCommand } from '@/commands/_helpers/startNewSession';
import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { getI18n } from '@/i18n';
import { getSessionService } from '@/services/SessionService';

// eslint-disable-next-line industry/constants-file-organization
export const newCommand: SlashCommand = {
  name: 'new',
  description: 'Start a new session (clears context)',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> =>
    runStartNewSessionCommand({
      context,
      commandName: 'new',
      scheduledTaskLeaveRepeatInstruction: getI18n().t(
        'commands:loop.leaveWarning.repeat.new'
      ),
      preCreate: async () => {
        const sessionService = getSessionService();
        if (
          sessionService.getDecompSessionType() ===
          DecompSessionType.Orchestrator
        ) {
          await sessionService.downgradeFromOrchestratorSession();
          sessionService.setInteractionMode(DroolInteractionMode.Auto);
        }
      },
    }),
};
