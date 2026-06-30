import fs from 'fs';
import path from 'path';

import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { SettingsManager } from '@industry/runtime/settings';
import { expandTilde } from '@industry/utils/shell/node';

import { getSandboxService } from '@/services/SandboxService';
import { getSessionService } from '@/services/SessionService';
import { DynamicContextDiscovery } from '@/utils/dynamicContextDiscovery';
import { restartSystemInfoPrefetch } from '@/utils/systemInfo';

export async function reinitializeSandboxForCwd(): Promise<void> {
  try {
    const resolved = await SettingsManager.getInstance().getResolvedSettings();
    const newSandboxSettings = resolved.general?.sandbox;
    await getSandboxService().reinitialize(newSandboxSettings);
  } catch (error) {
    logWarn('[SessionCwd] Failed to reinitialize sandbox after CWD change', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function resolveWorkingDirectoryPath(inputPath: string): string {
  const expandedPath = expandTilde(inputPath);
  const resolvedPath = path.resolve(expandedPath);

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolvedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new MetaError('Working directory does not exist', {
        path: resolvedPath,
      });
    }

    throw new MetaError('Cannot access working directory', {
      path: resolvedPath,
      cause: error,
    });
  }

  if (!stats.isDirectory()) {
    throw new MetaError('Working directory is not a directory', {
      path: resolvedPath,
    });
  }

  return resolvedPath;
}

async function reloadSlashCommandsForCwd(): Promise<void> {
  const [{ customCommandsLoader }, { skillCommandsLoader }] = await Promise.all(
    [
      import('@/commands/custom/CustomCommandsLoader'),
      import('@/commands/skills/SkillCommandsLoader'),
    ]
  );

  skillCommandsLoader.unregisterAll();
  customCommandsLoader.unregisterAll();
  await customCommandsLoader.registerAll();
  await skillCommandsLoader.registerAll();
}

export async function changeSessionWorkingDirectory(
  inputPath?: string
): Promise<string | null> {
  const trimmedPath = inputPath?.trim();
  if (!trimmedPath) {
    return null;
  }

  const resolvedPath = resolveWorkingDirectoryPath(trimmedPath);

  if (resolvedPath !== process.cwd()) {
    try {
      process.chdir(resolvedPath);
    } catch (error) {
      throw new MetaError('Failed to change working directory', {
        path: resolvedPath,
        cause: error,
      });
    }
  }

  DynamicContextDiscovery.resetInstance();
  SettingsManager.getInstance().refresh();
  await reinitializeSandboxForCwd();
  await reloadSlashCommandsForCwd();
  void restartSystemInfoPrefetch();

  const sessionService = getSessionService();
  sessionService.updateSessionLastCwd(resolvedPath);
  sessionService.markSystemInfoRefreshNeeded();

  return resolvedPath;
}
