import open from 'open';

import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo } from '@industry/logging';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import {
  ensureSlackConnected,
  getSlackOAuthStartUrl,
} from '@/services/slack/connection';
import { SlackConnectionMessageKey } from '@/services/slack/enums';

const SLACK_CONNECTION_I18N_KEY: Record<SlackConnectionMessageKey, string> = {
  [SlackConnectionMessageKey.Opening]:
    'commands:slashMessages.setupIncidentResponse.connection.opening',
  [SlackConnectionMessageKey.Connected]:
    'commands:slashMessages.setupIncidentResponse.connection.connected',
  [SlackConnectionMessageKey.AlreadyConnected]:
    'commands:slashMessages.setupIncidentResponse.connection.alreadyConnected',
  [SlackConnectionMessageKey.Timeout]:
    'commands:slashMessages.setupIncidentResponse.connection.timeout',
  [SlackConnectionMessageKey.Error]:
    'commands:slashMessages.setupIncidentResponse.connection.error',
  [SlackConnectionMessageKey.BrowserFailed]:
    'commands:slashMessages.setupIncidentResponse.connection.browserFailed',
};

// eslint-disable-next-line industry/constants-file-organization
export const setupIncidentResponseCommand: SlashCommand = {
  name: 'setup-incident-response',
  description: 'Set up Slack auto-run for an incident-response channel',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage: addMessage } = context;
    const t = getI18n().t;

    const emit = (msg: string) =>
      addMessage(msg, {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });

    // Fail fast in headless contexts BEFORE running the Slack precondition,
    // which would otherwise launch the user's browser + poll OAuth for a
    // wizard that can never render here.
    if (!context.showSetupIncidentResponseFlow) {
      emit(t('commands:slashMessages.setupIncidentResponse.tuiOnly'));
      return { handled: true };
    }

    const result = await ensureSlackConnected({
      onMessage: (key, vars) => emit(t(SLACK_CONNECTION_I18N_KEY[key], vars)),
      onOpenBrowser: async () => {
        await open(getSlackOAuthStartUrl());
      },
    });

    if (!result.ok) {
      logInfo('[SetupIncidentResponse] Slack precondition failed', {
        reason: result.reason,
      });
      emit(
        t('commands:slashMessages.setupIncidentResponse.slackRequired', {
          reason: result.reason,
        })
      );
      return { handled: true };
    }

    context.showSetupIncidentResponseFlow();
    return { handled: true };
  },
};
