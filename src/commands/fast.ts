import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { getBaseVariant, getFastVariant } from '@industry/utils/llm';

import { SlashCommand, CommandContext, CommandResult } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import {
  isModelAllowed,
  isModelFeatureFlagEnabled,
} from '@/models/availability';
import { getTuiModelConfig } from '@/models/config';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';

function notify(
  addMessage: CommandContext['addEphemeralSystemMessage'],
  message: string
): void {
  addMessage(message, {
    messageType: MessageType.SystemNotification,
    visibility: MessageVisibility.UserOnly,
  });
}

// eslint-disable-next-line industry/constants-file-organization
export const fastCommand: SlashCommand = {
  name: 'fast',
  description: 'Enable fast mode for the current model (/fast off to disable)',
  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage } = context;
    const arg = args[0]?.toLowerCase();

    if (arg && arg !== 'on' && arg !== 'off') {
      notify(
        addEphemeralSystemMessage,
        `Invalid argument "${args[0]}". Usage: /fast, /fast on, or /fast off`
      );
      return { handled: true };
    }

    // Read current model from SSM/SessionStore (source of truth in daemon mode)
    const sessionService = getSessionService();
    const sessionId = sessionService.getCurrentSessionId();
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();
    const defaultStore = ssm.getDefaultSettingsStore();
    const store = sessionId
      ? (ssm.getSessionManager(sessionId)?.getStore() ?? defaultStore)
      : defaultStore;
    const currentModel = store.getModelId() ?? getSettingsService().getModel();

    if (!currentModel) {
      notify(
        addEphemeralSystemMessage,
        'No model is currently set for this session'
      );
      return { handled: true };
    }

    const isOn = !arg || arg === 'on';
    const isCurrentlyFast = !!getBaseVariant(currentModel);

    if (isOn && isCurrentlyFast) {
      const config = getTuiModelConfig(currentModel);
      notify(
        addEphemeralSystemMessage,
        `⚡ Already in fast mode (${config.shortDisplayName || currentModel})`
      );
      return { handled: true };
    }

    if (!isOn && !isCurrentlyFast) {
      const config = getTuiModelConfig(currentModel);
      notify(
        addEphemeralSystemMessage,
        `Already using base model (${config.shortDisplayName || currentModel})`
      );
      return { handled: true };
    }

    const targetModel = isOn
      ? getFastVariant(currentModel)
      : getBaseVariant(currentModel);

    if (!targetModel) {
      const config = getTuiModelConfig(currentModel);
      const errorMsg = `No fast mode available for ${config.shortDisplayName || currentModel}`;
      notify(addEphemeralSystemMessage, errorMsg);
      return { handled: true };
    }

    if (isOn && !(await isModelFeatureFlagEnabled(targetModel))) {
      const config = getTuiModelConfig(currentModel);
      notify(
        addEphemeralSystemMessage,
        `Fast mode is not available for ${config.shortDisplayName || currentModel}`
      );
      return { handled: true };
    }

    if (!isModelAllowed(targetModel)) {
      const currentConfig = getTuiModelConfig(currentModel);
      const targetConfig = getTuiModelConfig(targetModel);
      notify(
        addEphemeralSystemMessage,
        isOn
          ? `Fast mode for ${currentConfig.shortDisplayName || currentModel} is disabled by your organization's model policy`
          : `Cannot switch back to base model (${targetConfig.shortDisplayName || targetModel}) because it is disabled by your organization's model policy`
      );
      return { handled: true };
    }

    try {
      // Propagate model change to daemon and await completion
      // This updates SSM/SessionStore, which is the source of truth
      await context.updateSettings?.({ modelId: targetModel });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to switch model';
      notify(addEphemeralSystemMessage, message);
      return { handled: true };
    }

    const config = getTuiModelConfig(targetModel);
    const isSwitchingToFast = !!getBaseVariant(targetModel);
    notify(
      addEphemeralSystemMessage,
      `${isSwitchingToFast ? '⚡ ' : ''}Switched to ${config.shortDisplayName || targetModel}`
    );
    return { handled: true };
  },
};
