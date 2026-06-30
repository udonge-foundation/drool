import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import { SlashCommand, CommandContext, CommandResult } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getTuiModelConfig } from '@/models/config';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { isMissionOrchestratorSession } from '@/services/mission/sessionTags';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';

// eslint-disable-next-line industry/constants-file-organization
export const modelCommand: SlashCommand = {
  name: 'model',
  description: 'Open model selector',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const {
      addEphemeralSystemMessage,
      showModelSelector,
      showMissionModelSelector,
      showReasoningEffortSelector,
      showSettingsSelector,
      showSpecModeConfigurator,
    } = context;

    const tags = getSessionService().getCurrentSessionTags();
    const isMissionMode = isMissionOrchestratorSession(tags);

    if (isMissionMode && showMissionModelSelector) {
      showMissionModelSelector();
      return { handled: true };
    }

    // Show model selector with spec mode option if available
    if (showModelSelector) {
      showModelSelector(!isMissionMode);
      return { handled: true };
    }

    // Fallback to spec mode configurator if available (disabled in Mission mode)
    if (!isMissionMode && showSpecModeConfigurator) {
      showSpecModeConfigurator();
      return { handled: true };
    }

    // Fallback to reasoning effort selector if available for reasoning models
    if (showReasoningEffortSelector) {
      const sessionId = getSessionService().getCurrentSessionId();
      const adapter = getTuiDaemonAdapter();
      const ssm = adapter.getSessionStateManager();
      const defaultStore = ssm.getDefaultSettingsStore();
      const store = sessionId
        ? (ssm.getSessionManager(sessionId)?.getStore() ?? defaultStore)
        : defaultStore;
      const currentModel =
        store.getModelId() ?? getSettingsService().getModel();
      const { supportedReasoningEfforts } = getTuiModelConfig(currentModel);

      // Only show reasoning effort selector if the model supports multiple efforts
      if (supportedReasoningEfforts.length > 1) {
        showReasoningEffortSelector();
        return { handled: true };
      }
    }

    // Fallback to settings menu focused path
    if (showSettingsSelector) {
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.openingSettings'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      const settings = getSettingsService().getSettings();
      showSettingsSelector(settings);
      return { handled: true };
    }

    if (!showModelSelector && !showSettingsSelector) {
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.modelNotAvailable'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
    }

    return { handled: true };
  },
};
