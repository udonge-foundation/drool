import { IndustryTier } from '@industry/common/organization';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { SettingsManager } from '@industry/runtime/settings';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { getEnv } from '@/environment';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

// eslint-disable-next-line industry/constants-file-organization
export const limitsCommand: SlashCommand = {
  name: 'limits',
  description: 'Manage token usage limits and overage preferences',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage, showTokenLimitChoice } = context;

    // Enterprise orgs manage limits through the web dashboard
    const orgTier = SettingsManager.getInstance().getOrgTier();
    const isEnterprise =
      orgTier === IndustryTier.ENTERPRISE ||
      orgTier === IndustryTier.PAYG_ENTERPRISE;

    if (isEnterprise) {
      const settingsUrl = `${getEnv().appBaseUrl}/settings/usage`;
      addEphemeralSystemMessage(
        `Enterprise usage and limits are managed through your dashboard: ${settingsUrl}`,
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }

    if (!showTokenLimitChoice) {
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.limits.notAvailable'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }

    showTokenLimitChoice();
    return { handled: true };
  },
};
