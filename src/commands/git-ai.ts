import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { fetchFeatureFlags } from '@industry/runtime/feature-flags';
import { findGitRoot } from '@industry/utils/shell/node';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import {
  DROOL_GIT_AI_CHECKPOINT_MATCHER,
  GIT_AI_VERSION,
} from '@/services/constants';
import {
  configureGitAiHooks,
  disableAutoUpdates,
  disableVersionChecks,
  getDaemonStatus,
  getDroolCheckpointHookCommand,
  getExpectedBinaryPath,
  getGitAiBinaryPath,
  getGitAiVersion,
  getInstallCommand,
  isDroolGitAiCheckpointHookCommand,
  installGitAi,
  installGitAiGithubCi,
  parseVersion,
  runGitAiInstall,
} from '@/services/GitAiInstaller';
import { getSettingsService } from '@/services/SettingsService';

function notify(
  context: CommandContext,
  message: string,
  type: MessageType = MessageType.SystemNotification
): void {
  context.addEphemeralSystemMessage(message, {
    messageType: type,
    visibility: MessageVisibility.UserOnly,
  });
}

// eslint-disable-next-line industry/constants-file-organization
export const gitAiCommand: SlashCommand = {
  name: 'git-ai',
  description:
    'Install and set up Git AI for tracking AI-generated code attribution',

  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const featureFlags = await fetchFeatureFlags();
    const isFeatureEnabled =
      featureFlags[IndustryFeatureFlags.GitAi.statsigName] ??
      IndustryFeatureFlags.GitAi.defaultValue;

    if (!isFeatureEnabled) {
      notify(context, getI18n().t('commands:slashMessages.gitAi.notAvailable'));
      return { handled: true };
    }

    const versionOutput = await getGitAiVersion();
    const currentVersion = versionOutput ? parseVersion(versionOutput) : null;

    if (!currentVersion) {
      notify(
        context,
        getI18n().t('commands:slashMessages.gitAi.installing', {
          version: GIT_AI_VERSION,
        })
      );
      const installResult = await installGitAi();
      if (!installResult.success) {
        notify(
          context,
          getI18n().t('commands:slashMessages.gitAi.installFailed', {
            error: installResult.error,
            command: getInstallCommand(),
          })
        );
        return { handled: true };
      }

      const expectedPath = getExpectedBinaryPath();
      if (!(await getGitAiBinaryPath())) {
        notify(
          context,
          getI18n().t('commands:slashMessages.gitAi.binaryNotFound', {
            path: expectedPath,
            command: getInstallCommand(),
          })
        );
        return { handled: true };
      }
    } else if (currentVersion !== GIT_AI_VERSION) {
      notify(
        context,
        getI18n().t('commands:slashMessages.gitAi.updating', {
          current: currentVersion,
          target: GIT_AI_VERSION,
        })
      );
      const installResult = await installGitAi();
      if (!installResult.success) {
        notify(
          context,
          getI18n().t('commands:slashMessages.gitAi.updateFailed', {
            error: installResult.error,
          })
        );
        return { handled: true };
      }
    }

    const gitRoot = findGitRoot() ?? undefined;

    const [autoUpdateResult, versionChecksResult] = await Promise.all([
      disableAutoUpdates(gitRoot),
      disableVersionChecks(gitRoot),
    ]);
    if (!autoUpdateResult.success) {
      notify(
        context,
        getI18n().t('commands:slashMessages.gitAi.disableAutoUpdatesFailed', {
          error: autoUpdateResult.error,
        })
      );
    }
    if (!versionChecksResult.success) {
      notify(
        context,
        getI18n().t('commands:slashMessages.gitAi.disableVersionChecksFailed', {
          error: versionChecksResult.error,
        })
      );
    }

    const gitAiInstallResult = await runGitAiInstall(gitRoot);
    if (!gitAiInstallResult.success) {
      notify(
        context,
        getI18n().t('commands:slashMessages.gitAi.gitAiInstallFailed', {
          error: gitAiInstallResult.error,
        })
      );
      return { handled: true };
    }

    const gitAiBinaryPath = await getGitAiBinaryPath();
    if (gitAiBinaryPath) {
      const checkpointCommand = getDroolCheckpointHookCommand(gitAiBinaryPath);
      const settingsService = getSettingsService();
      for (const hookType of ['PreToolUse', 'PostToolUse'] as const) {
        settingsService.removeHookCommandsMatching(
          hookType,
          isDroolGitAiCheckpointHookCommand
        );
        settingsService.addHook(
          hookType,
          DROOL_GIT_AI_CHECKPOINT_MATCHER,
          checkpointCommand
        );
      }
    }

    const hookConfigResult = await configureGitAiHooks(gitRoot);
    if (!hookConfigResult.success) {
      notify(
        context,
        getI18n().t('commands:slashMessages.gitAi.hookConfigFailed', {
          error: hookConfigResult.error,
        })
      );
    }

    const githubCiResult = await installGitAiGithubCi(gitRoot);
    if (!githubCiResult.success) {
      notify(
        context,
        getI18n().t('commands:slashMessages.gitAi.githubCiFailed', {
          error: githubCiResult.error,
        })
      );
      return { handled: true };
    }

    const githubCiInstalled = !githubCiResult.skipped;

    const daemonResult = await getDaemonStatus();
    if (!daemonResult.success) {
      notify(
        context,
        getI18n().t('commands:slashMessages.gitAi.daemonDown', {
          error: daemonResult.error,
        })
      );
    }

    const setupCompleteMessage = getI18n().t(
      'commands:slashMessages.gitAi.setupComplete'
    );
    notify(
      context,
      githubCiInstalled
        ? `${setupCompleteMessage} ${getI18n().t(
            'commands:slashMessages.gitAi.githubCiSuccess'
          )}`
        : setupCompleteMessage
    );

    return { handled: true };
  },
};
