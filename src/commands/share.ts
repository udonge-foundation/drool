import { SessionPrivacyLevel } from '@industry/common/session';
import { fetch } from '@industry/drool-core/api/fetch';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logInfo } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getIndustryAppBaseUrl } from '@industry/utils/environment';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { copyToClipboard } from '@/utils/clipboard';

// eslint-disable-next-line industry/constants-file-organization
export const shareCommand: SlashCommand = {
  name: 'share',
  description: 'Share this session with your organization',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage } = context;

    try {
      const sessionService = getSessionService();
      const currentSessionId = sessionService.getCurrentSessionId();

      if (!currentSessionId) {
        addEphemeralSystemMessage(
          getI18n().t('commands:slashMessages.noActiveSessionToShare'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return { handled: true };
      }

      // Check if cloud sync is enabled
      const cloudSyncEnabled =
        getSettingsService().getSettings().general?.cloudSessionSync ?? true;
      if (!cloudSyncEnabled) {
        addEphemeralSystemMessage(
          getI18n().t('commands:slashMessages.shareRequiresCloudSync'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return { handled: true };
      }

      // Set session privacy to organization (idempotent - safe to call multiple times)
      const response = await fetch(
        `/api/sessions/${currentSessionId}/privacy`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            privacyLevel: SessionPrivacyLevel.Organization,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new MetaError('Failed to share session', {
          errorMessage: errorText,
        });
      }

      const shareUrl = `${getIndustryAppBaseUrl()}/sessions/${currentSessionId}`;
      const copied = await copyToClipboard(shareUrl);

      logInfo('[Share Command] Session shared', {
        sessionId: currentSessionId,
      });

      const clipboardStatus = copied
        ? `\n${getI18n().t('commands:slashMessages.urlCopied')}`
        : '';
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.sessionShared', {
          url: shareUrl,
          clipboardStatus,
        }),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );

      return { handled: true };
    } catch (error) {
      logException(error, 'Error sharing session');
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.errorSharingSession', {
          message: errorMessage,
        }),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true };
    }
  },
};
