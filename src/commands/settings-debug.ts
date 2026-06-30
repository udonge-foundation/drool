import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';

import type {
  SlashCommand,
  CommandContext,
  CommandResult,
} from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getSettingsService } from '@/services/SettingsService';

import type { SettingsResolutionEvent } from '@industry/common/settings';

function formatSource(source: SettingsResolutionEvent['source']): string {
  switch (source.type) {
    case 'org':
      return source.orgId ? `org (${source.orgId})` : 'org';
    case 'user':
    case 'project':
    case 'folder':
      return source.filePath
        ? `${source.type} (${source.filePath})`
        : source.type;
    case 'feature-flag':
      return source.flagName
        ? `feature-flag (${source.flagName})`
        : 'feature-flag';
    case 'localstorage':
      return source.key ? `localstorage (${source.key})` : 'localstorage';
    default:
      return source.type;
  }
}

function formatValue(value: Record<string, unknown> | undefined): string {
  if (!value) return '-';
  return Object.entries(value)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ');
}

function isModelEvent(event: SettingsResolutionEvent): boolean {
  return event.keys.some((k) => k.startsWith('availableModels.'));
}

function buildOutput(chain: SettingsResolutionEvent[]): string {
  const sessionEvents = chain.filter((e) => !isModelEvent(e));
  const modelEvents = chain.filter(isModelEvent);

  const lines: string[] = [];
  lines.push(`Settings Resolution Chain (${chain.length} events)`);
  lines.push('─'.repeat(72));

  if (sessionEvents.length > 0) {
    lines.push('');
    lines.push('Session Default Settings:');
    lines.push(
      `  ${'#'.padEnd(4)} ${'Action'.padEnd(10)} ${'Source'.padEnd(34)} ${'Keys'.padEnd(22)} Value`
    );
    lines.push(
      `  ${'─'.repeat(3)} ${'─'.repeat(9)} ${'─'.repeat(33)} ${'─'.repeat(21)} ${'─'.repeat(20)}`
    );
    for (let i = 0; i < sessionEvents.length; i++) {
      const e = sessionEvents[i]!;
      lines.push(
        `  ${String(i + 1).padEnd(4)} ${e.action.padEnd(10)} ${formatSource(e.source).padEnd(34)} ${e.keys.join(', ').padEnd(22)} ${formatValue(e.value)}`
      );
      if (e.reason) {
        lines.push(
          `  ${''.padEnd(4)} ${''.padEnd(10)} ${''.padEnd(34)} (${e.reason})`
        );
      }
    }
  }

  if (modelEvents.length > 0) {
    lines.push('');
    lines.push('Available Models:');
    lines.push(
      `  ${'#'.padEnd(4)} ${'Action'.padEnd(10)} ${'Source'.padEnd(34)} ${'Model'.padEnd(22)} Detail`
    );
    lines.push(
      `  ${'─'.repeat(3)} ${'─'.repeat(9)} ${'─'.repeat(33)} ${'─'.repeat(21)} ${'─'.repeat(20)}`
    );
    const offset = sessionEvents.length;
    for (let i = 0; i < modelEvents.length; i++) {
      const e = modelEvents[i]!;
      const modelKey = e.keys.find((k) => k.startsWith('availableModels.'));
      const modelName = modelKey
        ? modelKey.replace('availableModels.', '')
        : e.keys.join(', ');
      lines.push(
        `  ${String(offset + i + 1).padEnd(4)} ${e.action.padEnd(10)} ${formatSource(e.source).padEnd(34)} ${modelName.padEnd(22)} ${e.reason ?? ''}`
      );
    }
  }

  return lines.join('\n');
}

// eslint-disable-next-line industry/constants-file-organization
export const settingsDebugCommand: SlashCommand = {
  name: 'settings-debug',
  description: 'Show the settings resolution chain from initial load',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    try {
      const chain = getSettingsService().getDebugResolutionChain();

      if (chain.length === 0) {
        context.addEphemeralSystemMessage(
          'No settings resolution chain available.',
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return { handled: true, shouldRunAgent: false };
      }

      const output = buildOutput(chain);
      context.addEphemeralSystemMessage(output, {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });

      return { handled: true, shouldRunAgent: false };
    } catch (error) {
      logException(error, 'Error executing settings-debug command');
      context.addEphemeralSystemMessage(
        'Failed to display settings resolution chain. Check logs for details.',
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return { handled: true, shouldRunAgent: false };
    }
  },
};
