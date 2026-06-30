import { runMenuCommand } from '@/commands/_helpers/menuCommand';
import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';

interface DroolsCommandContext extends CommandContext {
  showDroolsMenu?: () => void;
}

// eslint-disable-next-line industry/constants-file-organization
export const droolsCommand: SlashCommand = {
  name: 'drools',
  description: 'Manage custom Drools (subagents)',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> =>
    runMenuCommand({
      addMessage: context.addEphemeralSystemMessage,
      openMenu: (context as DroolsCommandContext).showDroolsMenu,
      fallbackMessageKey: 'commands:slashMessages.droolsNotAvailable',
      commandName: 'drools',
      errorMessageKey: 'commands:slashMessages.errorOpeningDroolsMenu',
    }),
};
