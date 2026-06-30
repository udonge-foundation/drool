import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { DecompSessionType } from '@industry/drool-sdk-ext/protocol/drool';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { fetchFeatureFlags } from '@industry/runtime/feature-flags';

import { getAgentEffectivenessReportVisibility } from '@/commands/agentEffectivenessReportVisibility';
import { getLocalizedCommandDescription } from '@/commands/commandDescriptions';
import { commandRegistry } from '@/commands/registry';
import { SlashCommand, CommandContext, CommandResult } from '@/commands/types';
import { filterVisibleSlashCommands } from '@/commands/visibility';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n/index';
import { getSessionService } from '@/services/SessionService';
import { canViewTokenUsage } from '@/utils/tokenUsageVisibility';

// eslint-disable-next-line industry/constants-file-organization
export const helpCommand: SlashCommand = {
  name: 'help',
  description: 'Show available slash commands',

  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage } = context;
    const t = getI18n().t.bind(getI18n());

    const featureFlags = await fetchFeatureFlags();
    const isGitAiEnabled =
      featureFlags[IndustryFeatureFlags.GitAi.statsigName] ??
      IndustryFeatureFlags.GitAi.defaultValue;
    const isSquadEnabled =
      featureFlags[IndustryFeatureFlags.Squad.statsigName] ??
      IndustryFeatureFlags.Squad.defaultValue;
    const isLoopEnabled =
      featureFlags[IndustryFeatureFlags.LoopCommand.statsigName] ??
      IndustryFeatureFlags.LoopCommand.defaultValue;
    const isAutomationsEnabled =
      featureFlags[IndustryFeatureFlags.SoftwareIndustry.statsigName] ??
      IndustryFeatureFlags.SoftwareIndustry.defaultValue;
    const isAgentEffectivenessReportFeatureEnabled =
      featureFlags[IndustryFeatureFlags.AgentEffectivenessReport.statsigName] ??
      IndustryFeatureFlags.AgentEffectivenessReport.defaultValue;
    const isAgentEffectivenessReportVisible =
      isAgentEffectivenessReportFeatureEnabled
        ? await getAgentEffectivenessReportVisibility()
        : false;
    const isMissionActive =
      getSessionService().getDecompSessionType() ===
      DecompSessionType.Orchestrator;

    // Get all registered commands, filter by feature flags, and sort alphabetically
    const commands = filterVisibleSlashCommands(commandRegistry.getCommands(), {
      industryEnv: process.env.INDUSTRY_ENV,
      isGitAiEnabled,
      isSquadEnabled,
      isLoopEnabled,
      isAutomationsEnabled,
      isAgentEffectivenessReportVisible,
      isMissionActive,
      isTokenUsageVisible: canViewTokenUsage(),
    }).sort((a, b) => a.name.localeCompare(b.name));

    // Find the longest command name for alignment
    // Handle edge case where commands array might be empty during initialization
    const maxLength =
      commands.length > 0
        ? Math.max(...commands.map((cmd) => cmd.name.length))
        : 0;

    // Build the help message dynamically with aligned descriptions
    const commandsList = commands
      .map((cmd) => {
        const padding = ' '.repeat(maxLength - cmd.name.length);
        const description = getLocalizedCommandDescription(
          cmd.name,
          cmd.description
        );
        return `/${cmd.name}${padding} - ${description}`;
      })
      .join('\n');

    const helpMessage = `${t('commands:help.availableCommands')}

${commandsList}

${t('commands:help.otherCommands')}`;

    addEphemeralSystemMessage(helpMessage, {
      messageType: MessageType.SystemNotification,
      visibility: MessageVisibility.UserOnly,
    });

    return { handled: true };
  },
};
