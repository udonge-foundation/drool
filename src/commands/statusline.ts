import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import { SlashCommand, CommandContext, CommandResult } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { buildStatusLineSetupPrompt } from '@/prompts/statusline-setup';
import { getSettingsService } from '@/services/SettingsService';
import { escapeUserMessageSystemTags } from '@/utils/escapeUserMessageSystemTags';

// eslint-disable-next-line industry/constants-file-organization
export const statuslineCommand: SlashCommand = {
  name: 'statusline',
  description: 'Configure a custom status line for Drool',
  execute: async (
    args: string[],
    context: CommandContext,
    rawArgs?: string
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage: addMessage } = context;
    const userInstructions = (rawArgs ?? args.join(' ')).trim();

    // Get the actual settings file path (handles dev vs prod)
    const settingsFilePath = getSettingsService().getSettingsFilePath();

    // Build the prompt with injected settings path
    const setupPrompt = buildStatusLineSetupPrompt(settingsFilePath);

    // Build the message to send to the agent, wrapped in system-reminder
    let agentMessage: string;

    if (userInstructions) {
      const escapedUserInstructions =
        escapeUserMessageSystemTags(userInstructions);
      // User provided specific instructions
      agentMessage = `<system-reminder>
${setupPrompt}
</system-reminder>

User instructions: ${escapedUserInstructions}

Please configure the status line according to the user's instructions above.`;
    } else {
      // Default behavior: try to import PS1
      agentMessage = `<system-reminder>
${setupPrompt}
</system-reminder>

The user wants to configure a custom status line. Please:
1. First, read their shell configuration files (.zshrc, .bashrc, etc.) to see if they have a PS1 prompt configured
2. If found, convert their PS1 to a status line command
3. If not found, ask them what they'd like to display in their status line

Common options include:
- Model name and current directory
- Git branch information
- Context window percentage
- Session duration or cost`;
    }

    // Show a notification that we're starting status line setup
    addMessage(getI18n().t('commands:slashMessages.startingStatusLine'), {
      messageType: MessageType.SystemNotification,
      visibility: MessageVisibility.UserOnly,
    });

    return {
      handled: true,
      shouldRunAgent: true,
      messageText: agentMessage,
    };
  },
};
