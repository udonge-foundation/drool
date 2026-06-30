import { logException } from '@industry/logging';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';

interface SkillsCommandContext extends CommandContext {
  showSkillsMenu?: () => void;
}

// eslint-disable-next-line industry/constants-file-organization
export const skillsCommand: SlashCommand = {
  name: 'skills',
  description: 'Manage prompt-based skills',
  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const skillsContext = context as SkillsCommandContext;

    try {
      // Check if we have a showSkillsMenu function in context
      if (skillsContext.showSkillsMenu) {
        skillsContext.showSkillsMenu();
        return { handled: true, shouldRunAgent: false };
      }

      return { handled: true, shouldRunAgent: false };
    } catch (error) {
      logException(error, 'Error in skills command');
      return { handled: true, shouldRunAgent: false };
    }
  },
};
