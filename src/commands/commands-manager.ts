import { SlashCommand } from '@/commands/types';

export function commandsManagerCommand(): SlashCommand {
  return {
    name: 'commands',
    description: 'Manage custom slash commands',
    execute: async (_args, context) => {
      if (context.showCommandsManager) {
        context.showCommandsManager();
        return { handled: true, shouldRunAgent: false };
      }
      return { handled: false, shouldRunAgent: false };
    },
  };
}
