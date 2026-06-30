import { exec } from 'child_process';
import { promisify } from 'util';

import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { sanitizeGitRemoteUrl } from '@industry/utils/agentReadiness';

import { CommandContext } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

const execAsync = promisify(exec);

export async function resolveGitRepoUrlOrNotify(
  addEphemeralSystemMessage: CommandContext['addEphemeralSystemMessage']
): Promise<string | null> {
  const t = getI18n().t;
  const notify = (key: string) => {
    addEphemeralSystemMessage(t(key), {
      messageType: MessageType.SystemNotification,
      visibility: MessageVisibility.UserOnly,
    });
  };

  try {
    await execAsync('git rev-parse --is-inside-work-tree', {
      cwd: process.cwd(),
      timeout: 5000,
    });
  } catch {
    notify('commands:readiness.notInGitRepo');
    return null;
  }

  let repoUrl: string;
  try {
    const { stdout } = await execAsync('git remote get-url origin', {
      cwd: process.cwd(),
      timeout: 5000,
    });
    repoUrl = sanitizeGitRemoteUrl(stdout.trim());
  } catch {
    notify('commands:readiness.noGitRemote');
    return null;
  }

  if (!repoUrl) {
    notify('commands:readiness.emptyRemoteUrl');
    return null;
  }

  return repoUrl;
}
