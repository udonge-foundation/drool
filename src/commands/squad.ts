import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { fetchFeatureFlags } from '@industry/runtime/feature-flags';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

// eslint-disable-next-line industry/constants-file-organization
export const squadCommand: SlashCommand = {
  name: 'squad',
  description: 'Open Squad Mode for persistent multi-agent coordination.',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const featureFlags = await fetchFeatureFlags();
    const isSquadEnabled =
      featureFlags[IndustryFeatureFlags.Squad.statsigName] ??
      IndustryFeatureFlags.Squad.defaultValue;

    if (!isSquadEnabled) {
      context.addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.squad.disabled'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      return { handled: true, shouldRunAgent: false };
    }

    if (context.showSquadMode) {
      context.showSquadMode();
    } else {
      context.addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.squad.notAvailable'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
    }

    return { handled: true, shouldRunAgent: false };
  },
};
