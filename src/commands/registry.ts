import { logException } from '@industry/logging';

import { parseCommandText } from '@/commands/parseCommandText';
import {
  SlashCommand,
  SlashCommandRegistry,
  CommandContext,
  CommandResult,
} from '@/commands/types';
import type { DeferredPromptResolveContext } from '@/commands/types';
import { CustomerMetrics } from '@/telemetry/customer/CustomerMetrics';
import { AttributeName, MetricName } from '@/telemetry/customer/enums';

class CommandRegistryImpl implements SlashCommandRegistry {
  private commands = new Map<string, SlashCommand>();

  register(command: SlashCommand): void {
    this.commands.set(command.name.toLowerCase(), command);
  }

  unregister(commandName: string): void {
    this.commands.delete(commandName.toLowerCase());
  }

  async execute(
    commandText: string,
    context: CommandContext
  ): Promise<CommandResult> {
    const trimmed = commandText.trim();
    const parsedCommandText = parseCommandText(commandText);
    if (!parsedCommandText) {
      return { handled: false, shouldRunAgent: true };
    }

    const { commandName, args } = parsedCommandText;

    // Preserve the raw argument text (everything after the first token)
    // so commands accepting free-form prose can bypass shell-quote's
    // operator stringification (e.g. `?` → `[object Object]`).
    // Use any-whitespace (not just space) so tabs/newlines between the
    // command and its arguments don't produce empty rawArgs.
    const firstWhitespace = trimmed.search(/\s/);
    const rawArgs =
      firstWhitespace === -1 ? '' : trimmed.slice(firstWhitespace + 1);

    const command = this.commands.get(commandName);
    if (!command) {
      return { handled: false, shouldRunAgent: true };
    }

    // Customer telemetry for slash command invocations
    CustomerMetrics.addToCounter(MetricName.SLASH_COMMAND_INVOCATIONS, 1, {
      [AttributeName.SLASH_COMMAND_NAME]: commandName,
    });

    try {
      const result = await command.execute(args, context, rawArgs);
      return result;
    } catch (error) {
      logException(error, 'Error executing command');
      return { handled: true, shouldRunAgent: false };
    }
  }

  hasDeferredPromptResolver(commandText: string): boolean {
    const parsedCommandText = parseCommandText(commandText);
    if (!parsedCommandText) {
      return false;
    }

    return Boolean(
      this.commands.get(parsedCommandText.commandName)?.resolveDeferredPrompt
    );
  }

  async resolveDeferredPrompt(
    commandText: string,
    context: DeferredPromptResolveContext
  ): Promise<CommandResult> {
    const trimmed = commandText.trim();
    const parsedCommandText = parseCommandText(commandText);
    if (!parsedCommandText) {
      return { handled: false, shouldRunAgent: true };
    }

    const { commandName, args } = parsedCommandText;
    const command = this.commands.get(commandName);
    if (!command?.resolveDeferredPrompt) {
      return { handled: false, shouldRunAgent: true };
    }

    const firstWhitespace = trimmed.search(/\s/);
    const rawArgs =
      firstWhitespace === -1 ? '' : trimmed.slice(firstWhitespace + 1);

    try {
      return await command.resolveDeferredPrompt(args, context, rawArgs);
    } catch (error) {
      logException(error, 'Error resolving deferred command');
      return { handled: true, shouldRunAgent: false };
    }
  }

  getCommands(): SlashCommand[] {
    return Array.from(this.commands.values());
  }
}

export const commandRegistry = new CommandRegistryImpl();
