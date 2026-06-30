import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';

import type {
  SlashCommand,
  CommandContext,
  CommandResult,
} from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getDiagnosticsService } from '@/services/diagnostics/DiagnosticsService';

// eslint-disable-next-line industry/constants-file-organization
export const diagnosticsCommand: SlashCommand = {
  name: 'diagnostics',
  description: 'Show settings configuration errors',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    try {
      const service = getDiagnosticsService();
      await service.refresh();

      if (context.showDiagnosticsMenu) {
        context.showDiagnosticsMenu();
        return { handled: true, shouldRunAgent: false };
      }

      // Fallback when menu UI is not available
      const { failures } = service.getState();
      const text =
        failures.length === 0
          ? getI18n().t('commands:slashMessages.diagnostics.noFailures')
          : getI18n().t('commands:slashMessages.diagnostics.issuesDetected', {
              count: failures.length,
            });

      context.addEphemeralSystemMessage(text, {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });

      return { handled: true, shouldRunAgent: false };
    } catch (error) {
      logException(error, 'Error executing diagnostics command');
      context.addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.diagnostics.failed'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true, shouldRunAgent: false };
    }
  },
};
