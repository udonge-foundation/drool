import {
  createAutomationCliTool,
  deleteAutomationCliTool,
  editAutomationCliTool,
  listAutomationsCliTool,
  readAutomationCliTool,
} from '@industry/drool-core/tools/definitions';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { Metrics } from '@industry/logging';

import { isAutomationsFeatureEnabled } from '@/commands/automationsFeatureFlag';
import { AUTOMATIONS_COMMAND_METRIC } from '@/commands/constants';
import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getDeferredToolsService } from '@/services/deferredTools/DeferredToolsService';
import { getSessionService } from '@/services/SessionService';

const AUTOMATION_TOOLS = [
  createAutomationCliTool,
  listAutomationsCliTool,
  readAutomationCliTool,
  editAutomationCliTool,
  deleteAutomationCliTool,
];

function logAutomationsCommand(action: string): void {
  Metrics.addToCounter(AUTOMATIONS_COMMAND_METRIC, 1, { type: action });
}

function enableAndLoadAutomationToolsForSession(sessionId: string): void {
  const sessionService = getSessionService();
  const currentEnabled = sessionService.getEnabledToolIds();
  const nextEnabled = new Set(currentEnabled);
  for (const tool of AUTOMATION_TOOLS) {
    nextEnabled.add(tool.id);
  }
  if (AUTOMATION_TOOLS.some((tool) => !currentEnabled.includes(tool.id))) {
    sessionService.setEnabledToolIds([...nextEnabled]);
  }
  getDeferredToolsService().markLoadedBatch(
    sessionId,
    AUTOMATION_TOOLS.map((tool) => tool.llmId ?? tool.id)
  );
}

/** Creates the feature-gated `/automations` built-in slash command. */
export function automationsCommand(): SlashCommand {
  return {
    name: 'automations',
    description: 'Manage local scheduled automations',
    execute: async (
      _args: string[],
      context: CommandContext
    ): Promise<CommandResult> => {
      if (!isAutomationsFeatureEnabled()) {
        logAutomationsCommand('disabled');
        context.addEphemeralSystemMessage(
          getI18n().t('commands:automations.disabled'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return { handled: true };
      }
      const sessionId = getSessionService().getCurrentSessionId();
      if (sessionId) {
        enableAndLoadAutomationToolsForSession(sessionId);
      }
      if (context.showAutomationsModal) {
        context.showAutomationsModal();
        logAutomationsCommand('opened_modal');
      }
      return { handled: true };
    },
  };
}
