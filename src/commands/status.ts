import * as path from 'path';

import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { AutonomyMode } from '@industry/drool-sdk-ext/protocol/shared';
import { logException } from '@industry/logging';
import {
  getActiveOrganizationId,
  getAuthToken,
  getValidAuthedUser,
} from '@industry/runtime/auth';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { SlashCommand, CommandContext, CommandResult } from '@/commands/types';
import { getRuntimeAuthConfig } from '@/environment';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getTuiModelConfig } from '@/models/config';
import { getSessionService } from '@/services/SessionService';
import { calculateSessionMetrics } from '@/utils/messageUtils';

function formatStatusValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed || '—';
}

// eslint-disable-next-line industry/constants-file-organization
export const statusCommand: SlashCommand = {
  name: 'status',
  description: 'Show current CLI status and configuration',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    try {
      const t = getI18n().t;

      // Get version
      const version = process.env.CLI_VERSION || 'unknown';

      // Get session info
      const sessionService = getSessionService();
      const currentSessionId = sessionService.getCurrentSessionId();
      const parentSessionId = sessionService.getParentSessionId(
        currentSessionId || undefined
      );

      // Get working directory
      const workingDirectory = process.cwd();

      // Get IDE integration status
      const ideConnected = !!process.env.INDUSTRY_VSCODE_MCP_PORT;
      const ideStatus = ideConnected
        ? t('common:statusCommand.ideConnected', {
            port: process.env.INDUSTRY_VSCODE_MCP_PORT,
          })
        : t('common:statusCommand.ideNotConnected');

      // Get auth info
      const runtimeAuthConfig = getRuntimeAuthConfig();
      const user = await getValidAuthedUser(runtimeAuthConfig);
      const activeOrganizationId = user
        ? await getActiveOrganizationId(runtimeAuthConfig)
        : null;

      // Show the user's choice ("Auto Model"), not the routed concrete pick.
      const modelName = getTuiModelConfig(
        sessionService.getDisplayModel()
      ).displayName;

      // Get current mode
      const isAGI = sessionService.isMissionMode();
      const currentMode = sessionService.getCurrentAutonomyMode();
      const modeDisplay = isAGI
        ? t('common:statusCommand.missionPreview')
        : currentMode === AutonomyMode.Spec
          ? t('common:statusCommand.specMode')
          : currentMode === AutonomyMode.AutoLow
            ? t('common:statusCommand.autoModeLow')
            : currentMode === AutonomyMode.AutoMedium
              ? t('common:statusCommand.autoModeMedium')
              : currentMode === AutonomyMode.AutoHigh
                ? t('common:statusCommand.autoModeHigh')
                : t('common:statusCommand.normalMode');

      // Pre-calculate development metrics if needed (do async work early)
      let staticBoundaryIndex: number | null = null;
      let totalMessages: number | null = null;
      if (process.env.INDUSTRY_ENV !== 'production' && currentSessionId) {
        try {
          const messageEvents = await sessionService.getAllMessageEvents();
          const metrics = calculateSessionMetrics(messageEvents);
          if (metrics) {
            staticBoundaryIndex = metrics.staticBoundaryIndex;
            totalMessages = metrics.totalMessages;
          }
        } catch (error) {
          logException(error, 'Failed to calculate development metrics');
        }
      }

      // Format status message
      const statusLines = [
        '╭─────────────────────────────────────────╮',
        `│            ${t('common:statusCommand.title')}                 │`,
        '╰─────────────────────────────────────────╯',
        '',
        `${t('common:statusCommand.versionLabel')}     v${version}`,
        `   • ${t('common:statusCommand.modeLabel')}            ${modeDisplay}`,
        '',
        `${t('common:statusCommand.sessionHeader')}`,
        `   • ${t('common:statusCommand.idLabel')}              ${currentSessionId || t('common:statusCommand.noActiveSession')}`,
        ...(parentSessionId
          ? [
              `   • ${t('common:statusCommand.parentIdLabel')}       ${parentSessionId}`,
            ]
          : []),
        `   • ${t('common:statusCommand.workingDirLabel')}     ${workingDirectory}`,
        '',
        `${t('common:statusCommand.ideHeader')}`,
        `   • ${t('common:statusCommand.statusLabel')}          ${ideStatus}`,
        '',
        `${t('common:statusCommand.authHeader')}`,
      ];

      if (runtimeAuthConfig.airgapEnabled) {
        statusLines.push(
          `   • ${t('common:statusCommand.statusLabel')}          Airgap`
        );
      } else if (user) {
        statusLines.push(
          `   • ${t('common:statusCommand.statusLabel')}          ${t('common:statusCommand.authenticated')}`,
          `   • ${t('common:statusCommand.emailLabel')}           ${user.email || '(API key auth)'}`,
          `   • ${t('common:statusCommand.orgIdLabel')}          ${formatStatusValue(activeOrganizationId ?? user.orgId)}`
        );
      } else if (await getAuthToken(runtimeAuthConfig)) {
        // TODO change this so we detect if the user came from whoami or workos
        // Have a token but couldn't get user info (likely API key)
        statusLines.push(
          `   • ${t('common:statusCommand.statusLabel')}          ${t('common:statusCommand.authenticatedViaKey')}`
        );
      } else {
        statusLines.push(
          `   • ${t('common:statusCommand.statusLabel')}          ${t('common:statusCommand.notAuthenticated')}`
        );
      }

      statusLines.push(
        '',
        `${t('common:statusCommand.modelHeader')}`,
        `   • ${t('common:statusCommand.selectedLabel')}        ${modelName}`,
        '',
        `${t('common:statusCommand.dataHeader')}`,
        `   • ${t('common:statusCommand.sessionsDirLabel')}    ${path.join(getIndustryHome(), getIndustryDirName(), 'sessions')}`
      );

      // Add development metrics section at the bottom (only in dev mode)
      if (
        process.env.INDUSTRY_ENV !== 'production' &&
        staticBoundaryIndex !== null &&
        totalMessages !== null
      ) {
        statusLines.push(
          '',
          `${t('common:statusCommand.devMetricsHeader')}`,
          `   • ${t('common:statusCommand.staticBoundaryLabel')} ${staticBoundaryIndex}`,
          `   • ${t('common:statusCommand.totalMessagesLabel')}  ${totalMessages}`
        );
      }

      context.addEphemeralSystemMessage(statusLines.join('\n'), {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });

      return { handled: true, shouldRunAgent: false };
    } catch (error) {
      logException(error, 'Error executing status command');
      return { handled: true, shouldRunAgent: false };
    }
  },
};
