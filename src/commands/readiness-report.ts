import { buildAgentReadinessPrompt } from '@industry/drool-core/prompts';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import { resolveGitRepoUrlOrNotify } from '@/commands/_helpers/resolveGitRepoUrl';
import { READINESS_REPORT_COMMAND_NAME } from '@/commands/constants';
import { enableAndLoadReadinessToolsForCurrentSession } from '@/commands/readinessTools';
import { SlashCommand, CommandContext, CommandResult } from '@/commands/types';
import { getEnv } from '@/environment';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { escapeUserMessageSystemTags } from '@/utils/escapeUserMessageSystemTags';

// eslint-disable-next-line industry/constants-file-organization
export const readinessReportCommand: SlashCommand = {
  name: READINESS_REPORT_COMMAND_NAME,
  description:
    'Evaluate the current repository for agent readiness and generate a report',

  execute: async (
    args: string[],
    context: CommandContext,
    rawArgs?: string
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage } = context;

    const repoUrl = await resolveGitRepoUrlOrNotify(addEphemeralSystemMessage);
    if (!repoUrl) {
      return { handled: true };
    }

    const t = getI18n().t;

    addEphemeralSystemMessage(
      t('commands:readiness.startingEvaluation', { url: repoUrl }),
      {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      }
    );

    enableAndLoadReadinessToolsForCurrentSession();

    const customInstructions = escapeUserMessageSystemTags(
      (rawArgs ?? args.join(' ')).trim()
    );
    const prompt = await buildAgentReadinessPrompt({
      repoUrl,
      appBaseUrl: getEnv().appBaseUrl,
      customInstructions: customInstructions || undefined,
    });

    return {
      handled: true,
      shouldRunAgent: true,
      messageText: prompt,
    };
  },
};
