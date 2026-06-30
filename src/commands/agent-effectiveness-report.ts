import { buildAgentEffectivenessReportPrompt } from '@industry/drool-core/prompts';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import { getAgentEffectivenessReportEntitlement } from '@/commands/agentEffectivenessReportEntitlement';
import { enableAndLoadAgentEffectivenessToolsForCurrentSession } from '@/commands/agentEffectivenessTools';
import { getAuthErrorMessage } from '@/commands/authHelpers';
import { AGENT_EFFECTIVENESS_REPORT_COMMAND_NAME } from '@/commands/constants';
import { SlashCommand, CommandContext, CommandResult } from '@/commands/types';
import { getEnv } from '@/environment';
import { MessageType } from '@/hooks/enums';
import { escapeUserMessageSystemTags } from '@/utils/escapeUserMessageSystemTags';

function getEscapedTimeframe(rawArgs?: string): string | undefined {
  const timeframe = rawArgs
    ? escapeUserMessageSystemTags(rawArgs).trim()
    : undefined;

  return timeframe || undefined;
}

// eslint-disable-next-line industry/constants-file-organization
export const agentEffectivenessReportCommand: SlashCommand = {
  name: AGENT_EFFECTIVENESS_REPORT_COMMAND_NAME,
  description:
    'Generate an org-level agent effectiveness report from Industry usage, PRs, and work items',

  execute: async (
    _args: string[],
    context: CommandContext,
    rawArgs?: string
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage } = context;

    try {
      const entitlement = await getAgentEffectivenessReportEntitlement();
      const organizationLabel =
        entitlement.organizationName || entitlement.organizationId;
      addEphemeralSystemMessage(
        `Starting agent effectiveness report for: ${organizationLabel}`,
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      enableAndLoadAgentEffectivenessToolsForCurrentSession();

      return {
        handled: true,
        shouldRunAgent: true,
        messageText: buildAgentEffectivenessReportPrompt({
          entitlement,
          apiBaseUrl: getEnv().apiBaseUrl,
          timeframe: getEscapedTimeframe(rawArgs),
        }),
      };
    } catch (error) {
      const message =
        error instanceof Error && error.message === 'AUTH_REQUIRED'
          ? getAuthErrorMessage()
          : 'Agent Effectiveness Report is only available for enabled organizations and org owners/managers.';
      addEphemeralSystemMessage(message, {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
      return { handled: true, shouldRunAgent: false };
    }
  },
};
