import { logException } from '@industry/logging';

import { customCommandsLoader } from '@/commands/custom/CustomCommandsLoader';
import { commandRegistry } from '@/commands/registry';
import { skillCommandsLoader } from '@/commands/skills/SkillCommandsLoader';
import type {
  DeferredPromptResolveContext,
  DeferredPromptResolutionResult,
} from '@/commands/types';

let deferredPromptCommandsReadyPromise: Promise<void> | null = null;

export function ensureDeferredPromptCommandsReady(): Promise<void> {
  deferredPromptCommandsReadyPromise ??= (async () => {
    try {
      await customCommandsLoader.registerAll();
    } catch (error) {
      logException(
        error,
        '[Commands] Failed to register custom slash commands'
      );
    }

    try {
      await skillCommandsLoader.registerAll();
    } catch (error) {
      logException(error, '[Commands] Failed to register skill slash commands');
    }
  })();

  return deferredPromptCommandsReadyPromise;
}

export async function resolveDeferredPromptFromRawText(
  text: string,
  context: DeferredPromptResolveContext
): Promise<DeferredPromptResolutionResult> {
  const rawText = text.trim();
  if (!rawText.startsWith('/')) {
    return { status: 'unresolved' };
  }

  await ensureDeferredPromptCommandsReady();
  if (!commandRegistry.hasDeferredPromptResolver(rawText.slice(1))) {
    return { status: 'unresolved' };
  }

  const result = await commandRegistry.resolveDeferredPrompt(
    rawText.slice(1),
    context
  );

  if (!result.handled || !result.messageText) {
    return {
      status: 'failed',
      message: `Failed to resolve queued slash prompt: ${rawText}`,
    };
  }

  return {
    status: 'resolved',
    result: { ...result, messageText: result.messageText },
  };
}
