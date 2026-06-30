import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { calculateIndustryTokenUsage } from '@industry/utils/usage';

import { SlashCommand, CommandContext, CommandResult } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getTuiModelConfig } from '@/models/config';
import { getSessionService } from '@/services/SessionService';
import { getSessionTokenUsage } from '@/utils/getSessionTokenUsage';
import { formatCompactNumber } from '@/utils/tokenFormatting';
import { canViewTokenUsage } from '@/utils/tokenUsageVisibility';

const formatGrey = (text: string): string => `\u001b[90m${text}\u001b[39m`;

const formatBold = (text: string): string => `\u001b[1m${text}\u001b[22m`;

// eslint-disable-next-line industry/constants-file-organization
export const costCommand: SlashCommand = {
  name: 'cost',
  description: 'Show usage statistics for the current session',

  execute: (args: string[], context: CommandContext): CommandResult => {
    const { addEphemeralSystemMessage } = context;
    const t = getI18n().t;

    if (!canViewTokenUsage()) {
      addEphemeralSystemMessage(formatGrey(t('common:cost.billingNote')), {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
      return { handled: true };
    }

    // Get token usage from SSM (daemon flow) with SessionService fallback
    const tokenUsage = getSessionTokenUsage();

    const modelConfig = getTuiModelConfig(getSessionService().getModel());
    const industryCreditUsageEstimate =
      tokenUsage.industryCredits && tokenUsage.industryCredits > 0
        ? tokenUsage.industryCredits
        : modelConfig.modelId
          ? calculateIndustryTokenUsage({
              model: modelConfig.modelId,
              inputTokens: tokenUsage.inputTokens,
              cacheCreationInputTokens: tokenUsage.cacheCreationTokens,
              cacheReadInputTokens: tokenUsage.cacheReadTokens,
              outputTokens: tokenUsage.outputTokens,
            })
          : 0;

    const estimateTokens = formatCompactNumber(industryCreditUsageEstimate);

    const costMessage = `${formatBold(t('common:cost.title'))}

${formatBold(t('common:cost.industryCreditsLabel'))} ${estimateTokens} ${t('common:cost.approxSuffix')}

${formatGrey(t('common:cost.billingNote'))}`;

    addEphemeralSystemMessage(costMessage, {
      messageType: MessageType.SystemNotification,
      visibility: MessageVisibility.UserOnly,
    });

    return { handled: true };
  },
};
