import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { CommandContext, CommandResult, SlashCommand } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getFolderTrustService } from '@/services/FolderTrustService';
import {
  changeSessionWorkingDirectory,
  resolveWorkingDirectoryPath,
} from '@/utils/sessionCwd';

function getCwdErrorMessage(error: unknown): string {
  if (error instanceof MetaError && typeof error.metadata?.path === 'string') {
    return `${error.message}: ${error.metadata.path}`;
  }

  return error instanceof Error ? error.message : String(error);
}

// eslint-disable-next-line industry/constants-file-organization
export const cwdCommand: SlashCommand = {
  name: 'cwd',
  description: 'Change the current session working directory',
  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage, onWorkingDirectoryChanged } = context;
    const targetPath = args.join(' ').trim();

    if (!targetPath) {
      return { handled: true };
    }

    try {
      // Folder trust gate (CLI-897): /cwd chdir + daemon child respawn would
      // load the target folder's project hooks/MCP servers. Confirm trust for
      // the target BEFORE switching, so an untrusted folder cannot execute
      // its config without an explicit decision.
      const resolvedTarget = resolveWorkingDirectoryPath(targetPath);
      if (getFolderTrustService().needsTrustPromptForPath(resolvedTarget)) {
        // Fail closed: when the gate needs a prompt but no prompt surface is
        // available, refuse the change rather than load untrusted config.
        const trusted =
          (await context.requestFolderTrust?.(resolvedTarget)) ?? false;
        if (!trusted) {
          addEphemeralSystemMessage(
            getI18n().t('commands:slashMessages.cwdTrustDeclined', {
              path: resolvedTarget,
            }),
            {
              messageType: MessageType.SystemNotification,
              visibility: MessageVisibility.UserOnly,
            }
          );
          return { handled: true };
        }
      }

      const resolvedPath = (await changeSessionWorkingDirectory(targetPath))!;

      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.cwdChanged', {
          path: resolvedPath,
        }),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      try {
        await Promise.resolve(onWorkingDirectoryChanged?.(resolvedPath));
      } catch (error) {
        logException(
          error,
          'Error refreshing UI after working directory change'
        );
      }
      return { handled: true };
    } catch (error) {
      logException(error, 'Error changing session working directory');
      addEphemeralSystemMessage(
        getI18n().t('commands:slashMessages.errorChangingCwd', {
          message: getCwdErrorMessage(error),
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
