import { runStartNewSessionCommand } from '@/commands/_helpers/startNewSession';
import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { getI18n } from '@/i18n';

// eslint-disable-next-line industry/constants-file-organization
export const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'Start a new session (clears context)',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> =>
    runStartNewSessionCommand({
      context,
      commandName: 'clear',
      scheduledTaskLeaveRepeatInstruction: getI18n().t(
        'commands:loop.leaveWarning.repeat.clear'
      ),
    }),
};
