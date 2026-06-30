import { fetchPreviousReadinessReport } from '@industry/drool-core/api/readiness';
import { buildReadinessFixPrompt } from '@industry/drool-core/prompts';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import { resolveGitRepoUrlOrNotify } from '@/commands/_helpers/resolveGitRepoUrl';
import { READINESS_FIX_COMMAND_NAME } from '@/commands/constants';
import { enableAndLoadReadinessToolsForCurrentSession } from '@/commands/readinessTools';
import { SlashCommand, CommandContext, CommandResult } from '@/commands/types';
import { getEnv } from '@/environment';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { escapeUserMessageSystemTags } from '@/utils/escapeUserMessageSystemTags';

// eslint-disable-next-line industry/constants-file-organization
export const readinessFixCommand: SlashCommand = {
  name: READINESS_FIX_COMMAND_NAME,
  description: 'Fix failing agent readiness signals from the latest report',

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
      t('commands:slashMessages.fetchingReadinessReport'),
      {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      }
    );

    const report = await fetchPreviousReadinessReport(repoUrl);

    if (report) {
      addEphemeralSystemMessage(
        t('commands:slashMessages.readinessReportFetched'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      addEphemeralSystemMessage(
        t('commands:readiness.startingFix', { url: repoUrl }),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
    } else {
      addEphemeralSystemMessage(t('commands:readiness.noReportFound'), {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
    }

    enableAndLoadReadinessToolsForCurrentSession();

    const prompt = await buildReadinessFixPrompt({
      repoUrl,
      appBaseUrl: getEnv().appBaseUrl,
      report,
      userArgs: escapeUserMessageSystemTags(rawArgs ?? args.join(' ')),
    });

    return {
      handled: true,
      shouldRunAgent: true,
      messageText: prompt,
    };
  },
};
