import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { SettingsManager } from '@industry/runtime/settings';

import { executeCustomCommand } from '@/commands/custom/executeCustomCommand';
import { commandRegistry } from '@/commands/registry';
import type {
  CommandResult,
  DeferredPromptResolveContext,
  SlashCommand,
} from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

import type { CustomCommand } from '@industry/common/settings';

class CustomCommandsLoader {
  private registeredCommandNames = new Set<string>();

  /**
   * Get custom commands from hierarchical settings
   */
  public async getCommands(): Promise<CustomCommand[]> {
    const manager = SettingsManager.getInstance();
    const settings = await manager.getResolvedSettings();
    return settings.commands ?? [];
  }

  public async registerAll(): Promise<void> {
    const commands = await this.getCommands();
    this.unregisterAll();

    for (const meta of commands) {
      const desc = meta.argumentHint
        ? `${meta.description} • ${meta.argumentHint}`
        : meta.description;
      const resolveCustomPrompt = async (
        args: string[],
        context: DeferredPromptResolveContext,
        rawArgs?: string
      ): Promise<CommandResult> => {
        context.addEphemeralSystemMessage(
          getI18n().t('commands:slashMessages.customCommandRunning', {
            name: meta.name,
          }),
          {
            messageType: MessageType.Text,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return executeCustomCommand(meta, args, { rawArgs });
      };
      const cmd: SlashCommand = {
        name: meta.name,
        description: desc,
        resolveDeferredPrompt: resolveCustomPrompt,
        execute: async (args, context, rawArgs) =>
          resolveCustomPrompt(args, context, rawArgs),
      };
      commandRegistry.register(cmd);
      this.registeredCommandNames.add(meta.name.toLowerCase());
    }
  }

  public unregisterAll(): void {
    for (const name of this.registeredCommandNames) {
      commandRegistry.unregister(name);
    }
    this.registeredCommandNames.clear();
  }
}

export const customCommandsLoader = new CustomCommandsLoader();
