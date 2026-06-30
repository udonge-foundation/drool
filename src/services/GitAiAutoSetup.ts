import fs from 'fs';

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getFlag } from '@industry/runtime/feature-flags';
import { findGitRoot } from '@industry/utils/shell/node';

import {
  DROOL_GIT_AI_CHECKPOINT_MATCHER,
  GIT_AI_VERSION,
} from '@/services/constants';
import {
  configureGitAiHooks,
  disableAutoUpdates,
  disableVersionChecks,
  getDroolCheckpointHookCommand,
  getExpectedBinaryPath,
  getGitAiVersion,
  installGitAi,
  isDroolGitAiCheckpointHookCommand,
  parseVersion,
  runGitAiInstall,
} from '@/services/GitAiInstaller';
import { getSandboxService } from '@/services/SandboxService';
import { getSettingsService } from '@/services/SettingsService';

const setupPromisesByGitRoot = new Map<string, Promise<void>>();

export function isGitActivityCommand(command: string): boolean {
  return /^git(?:\s|$)/i.test(command.trim());
}

function logIfStepFailed(
  step: string,
  result: { success: boolean; error?: string }
): void {
  if (result.success) {
    return;
  }

  logWarn('[GitAiAutoSetup] Step failed', {
    step,
    cause: result.error,
  });
}

async function configureDroolCheckpointHooks(
  gitAiBinaryPath: string
): Promise<void> {
  const checkpointCommand = getDroolCheckpointHookCommand(gitAiBinaryPath);
  const settingsService = getSettingsService();
  for (const hookType of ['PreToolUse', 'PostToolUse'] as const) {
    // Clear stale Git AI checkpoint hooks under any matcher (legacy `*`
    // imports, older constants without MultiEdit, etc.) before installing
    // the canonical entry. Without this, addHook would only dedupe inside
    // the matching matcher bucket and leave duplicates firing on every tool.
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

async function ensureGitAiBinary(): Promise<string> {
  const gitAiBinaryPath = getExpectedBinaryPath();
  if (!fs.existsSync(gitAiBinaryPath)) {
    logInfo('[GitAiAutoSetup] Installing Git AI automatically', {
      reason: 'missing_binary',
      version: GIT_AI_VERSION,
    });
    const installResult = await installGitAi();
    if (!installResult.success) {
      throw new Error(installResult.error ?? 'git-ai install failed');
    }
  }

  if (!fs.existsSync(gitAiBinaryPath)) {
    throw new Error('git-ai binary not found at expected install path');
  }

  let versionOutput = await getGitAiVersion(gitAiBinaryPath);
  let currentVersion = versionOutput ? parseVersion(versionOutput) : null;
  if (currentVersion !== GIT_AI_VERSION) {
    logInfo('[GitAiAutoSetup] Updating Git AI automatically', {
      reason: 'version_mismatch',
      currentVersion: currentVersion ?? 'unknown',
      version: GIT_AI_VERSION,
    });
    const installResult = await installGitAi();
    if (!installResult.success) {
      throw new Error(installResult.error ?? 'git-ai install failed');
    }

    versionOutput = await getGitAiVersion(gitAiBinaryPath);
    currentVersion = versionOutput ? parseVersion(versionOutput) : null;
  }

  if (currentVersion !== GIT_AI_VERSION) {
    throw new MetaError('git-ai version does not match expected version', {
      value: {
        currentVersion: currentVersion ?? 'unknown',
        expectedVersion: GIT_AI_VERSION,
      },
    });
  }

  return gitAiBinaryPath;
}

async function performGitAiAutoSetup(gitRoot: string): Promise<void> {
  const gitAiBinaryPath = await ensureGitAiBinary();

  const [autoUpdates, versionChecks] = await Promise.all([
    disableAutoUpdates(gitRoot, gitAiBinaryPath),
    disableVersionChecks(gitRoot, gitAiBinaryPath),
  ]);
  logIfStepFailed('disable auto updates', autoUpdates);
  logIfStepFailed('disable version checks', versionChecks);

  const installHooks = await runGitAiInstall(gitRoot, gitAiBinaryPath);
  if (!installHooks.success) {
    throw new Error(installHooks.error ?? 'git-ai install failed');
  }

  const notesHook = await configureGitAiHooks(gitRoot, gitAiBinaryPath);
  if (!notesHook.success) {
    throw new Error(notesHook.error ?? 'git-ai notes hook config failed');
  }

  await configureDroolCheckpointHooks(gitAiBinaryPath);

  logInfo('[GitAiAutoSetup] Configured Git AI automatically', {
    filePath: gitRoot,
  });
}

async function ensureGitAiAutoSetup(cwd: string): Promise<void> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    return;
  }

  const existing = setupPromisesByGitRoot.get(gitRoot);
  if (existing) {
    await existing;
    return;
  }

  const setupPromise = performGitAiAutoSetup(gitRoot).catch((error) => {
    setupPromisesByGitRoot.delete(gitRoot);
    logWarn('[GitAiAutoSetup] Failed to configure Git AI automatically', {
      filePath: gitRoot,
      cause: error,
    });
  });
  setupPromisesByGitRoot.set(gitRoot, setupPromise);
  await setupPromise;
}

export async function ensureGitAiAutoSetupForCommands(
  commands: string[],
  cwd: string
): Promise<void> {
  if (!commands.some(isGitActivityCommand)) {
    return;
  }

  if (
    !getFlag(IndustryFeatureFlags.GitAi) ||
    !getFlag(IndustryFeatureFlags.GitAiAutoSetup)
  ) {
    return;
  }

  if (getSandboxService().isEnabled()) {
    logInfo('[GitAiAutoSetup] Sandbox enabled, skipping Git AI auto-setup');
    return;
  }

  await ensureGitAiAutoSetup(cwd);
}

export function clearGitAiAutoSetupCacheForTests(): void {
  setupPromisesByGitRoot.clear();
}
