import {
  SLASH_COMMAND_METADATA,
  SlashCommandName,
} from '@industry/common/slash-commands';

import { getBuiltinCommands } from '@/commands/builtins';
import { ensureDeferredPromptCommandsReady } from '@/commands/deferredPromptResolution';
import { commandRegistry } from '@/commands/registry';

const builtinCommands = getBuiltinCommands();
for (const name of Object.keys(builtinCommands) as SlashCommandName[]) {
  if (
    SLASH_COMMAND_METADATA[name].envGated === 'non-production' &&
    process.env.INDUSTRY_ENV === 'production'
  ) {
    continue;
  }
  commandRegistry.register({
    ...builtinCommands[name],
    suggestionKind: 'internal-menu',
  });
}

const slashCommandsReadyPromise = ensureDeferredPromptCommandsReady();

export function ensureSlashCommandsReady(): Promise<void> {
  return slashCommandsReadyPromise;
}
