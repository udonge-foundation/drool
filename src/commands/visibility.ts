import { isAutomationsFeatureEnabled } from '@/commands/automationsFeatureFlag';
import { isLoopFeatureEnabled } from '@/commands/loopFeatureFlag';
import type {
  SlashCommand,
  SlashCommandVisibilityOptions,
} from '@/commands/types';

export function isSlashCommandVisible(
  commandName: string,
  options: SlashCommandVisibilityOptions
): boolean {
  const { industryEnv } = options;

  switch (commandName) {
    case 'exit-mission':
      return options.isMissionActive;
    case 'git-ai':
      return options.isGitAiEnabled;
    case 'squad':
      return options.isSquadEnabled;
    case 'agent-effectiveness-report':
      return options.isAgentEffectivenessReportVisible;
    case 'loop':
      return isLoopFeatureEnabled({
        industryEnv,
        isLoopEnabled: options.isLoopEnabled,
      });
    case 'automations':
      return isAutomationsFeatureEnabled({
        isAutomationsEnabled: options.isAutomationsEnabled,
      });
    case 'settings-debug':
      return industryEnv !== 'production';
    case 'cost':
      return options.isTokenUsageVisible;
    default:
      return true;
  }
}

export function filterVisibleSlashCommands<
  T extends Pick<SlashCommand, 'name'>,
>(commands: T[], options: SlashCommandVisibilityOptions): T[] {
  return commands.filter((command) =>
    isSlashCommandVisible(command.name, options)
  );
}
