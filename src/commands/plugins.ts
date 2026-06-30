import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';

// eslint-disable-next-line industry/constants-file-organization
export const pluginsCommand: SlashCommand = {
  name: 'plugins',
  description: 'Manage plugins and marketplaces',

  execute: (_args: string[], context: CommandContext): CommandResult => {
    context.showPluginMenu?.();
    return { handled: true, shouldRunAgent: false };
  },
};
