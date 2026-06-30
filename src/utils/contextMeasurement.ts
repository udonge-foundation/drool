import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import {
  SYSTEM_REMINDER_START,
  SYSTEM_REMINDER_END,
} from '@industry/drool-sdk-ext/protocol/drool';
import { getFlag } from '@industry/runtime/feature-flags';

import {
  formatDeferredToolLine,
  getMcpServerName,
  resolveEffectiveToolContext,
} from '@/agent/deferredTools';
import { generateToolsFromRegistry } from '@/agent/tools';
import { escapeRegex } from '@/commands/contextUtils';
import { buildSystemMessageBlocks } from '@/hooks/buildSystemMessageBlocks';
import { getDeferredToolsService } from '@/services/deferredTools/DeferredToolsService';
import { getSessionService } from '@/services/SessionService';
import { formatAvailableSkillEntry } from '@/skills/availableSkillsReminder';
import type { McpServerStats, RawMessage } from '@/utils/types';

import type { CustomDrool, Skill } from '@industry/common/settings';
import type {
  LLMToolDescriptor,
  LLMToolSpec,
} from '@industry/drool-core/tools/types';

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function measureToolSpecChars(tool: LLMToolSpec): number {
  return (
    (tool.name ?? '').length +
    (tool.description ?? '').length +
    safeJsonLength(tool.input_schema)
  );
}

async function resolveMeasuredToolContext(): Promise<{
  tools: LLMToolSpec[];
  hidden: LLMToolDescriptor[];
  deferredToolsReminder: string;
}> {
  const allTools = await generateToolsFromRegistry();
  const sessionId = getSessionService().getCurrentSessionId();

  return resolveEffectiveToolContext({
    enabled: getFlag(IndustryFeatureFlags.McpToolSearch),
    allTools,
    loaded: getDeferredToolsService().getLoaded(sessionId),
  });
}

function addMcpServerChars(
  servers: Map<string, McpServerStats>,
  serverName: string,
  chars: number
): void {
  if (!serverName) return;

  const existing = servers.get(serverName);
  if (existing) {
    existing.toolCount += 1;
    existing.chars += chars;
    return;
  }

  servers.set(serverName, {
    name: serverName,
    toolCount: 1,
    chars,
  });
}

function measureHiddenMcpReminderChars(hidden: LLMToolDescriptor[]): number {
  return hidden.reduce((sum, tool) => {
    if (!getMcpServerName(tool.spec.name)) {
      return sum;
    }
    return sum + formatDeferredToolLine(tool).length;
  }, 0);
}

export function measureSystemPromptChars(
  modelId: string,
  modelProvider: string
): number {
  try {
    const blocks = buildSystemMessageBlocks({
      modelId: modelId as Parameters<
        typeof buildSystemMessageBlocks
      >[0]['modelId'],
      modelProvider: modelProvider as Parameters<
        typeof buildSystemMessageBlocks
      >[0]['modelProvider'],
      tools: [],
    });
    let chars = 0;
    for (const block of blocks) {
      chars += (block.text ?? '').length;
    }
    return chars;
  } catch {
    return 0;
  }
}

export async function measureToolsChars(): Promise<number> {
  try {
    const { tools, hidden, deferredToolsReminder } =
      await resolveMeasuredToolContext();
    let chars = 0;
    for (const tool of tools) {
      if (getMcpServerName(tool.name)) {
        continue;
      }
      chars += measureToolSpecChars(tool);
    }
    chars += Math.max(
      0,
      deferredToolsReminder.length - measureHiddenMcpReminderChars(hidden)
    );
    return chars;
  } catch {
    return 0;
  }
}

export async function measureMcpToolsChars(): Promise<{
  totalChars: number;
  servers: McpServerStats[];
}> {
  try {
    const { tools, hidden } = await resolveMeasuredToolContext();
    const servers = new Map<string, McpServerStats>();
    let totalChars = 0;

    for (const tool of tools) {
      const serverName = getMcpServerName(tool.name);
      if (!serverName) continue;

      const chars = measureToolSpecChars(tool);
      totalChars += chars;
      addMcpServerChars(servers, serverName, chars);
    }

    for (const tool of hidden) {
      const serverName = getMcpServerName(tool.spec.name);
      if (!serverName) continue;

      const chars = formatDeferredToolLine(tool).length;
      totalChars += chars;
      addMcpServerChars(servers, serverName, chars);
    }
    return { totalChars, servers: [...servers.values()] };
  } catch {
    return { totalChars: 0, servers: [] };
  }
}

export function measureMessagesChars(
  conversationHistory: RawMessage[]
): number {
  let chars = 0;

  for (const msg of conversationHistory) {
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (typeof block === 'string') {
        chars += (block as string).length;
        continue;
      }
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      switch (b.type) {
        case 'text': {
          const text = typeof b.text === 'string' ? b.text : '';
          if (text.includes(SYSTEM_REMINDER_START)) {
            const stripped = text.replace(
              new RegExp(
                `${escapeRegex(SYSTEM_REMINDER_START)}[\\s\\S]*?${escapeRegex(SYSTEM_REMINDER_END)}`,
                'g'
              ),
              ''
            );
            chars += stripped.length;
          } else {
            chars += text.length;
          }
          break;
        }
        case 'thinking': {
          const thinking = typeof b.thinking === 'string' ? b.thinking : '';
          chars += thinking.length;
          break;
        }
        case 'tool_result': {
          const c = b.content !== undefined ? b.content : '';
          if (typeof c === 'string') {
            chars += c.length;
          } else {
            chars += safeJsonLength(c);
          }
          break;
        }
        case 'tool_use': {
          const name = typeof b.name === 'string' ? b.name : '';
          chars += name.length;
          chars += safeJsonLength(b.input);
          break;
        }
        default:
          chars += safeJsonLength(b);
          break;
      }
    }
  }

  return chars;
}

export function measureDroolDescriptionChars(drool: CustomDrool): number {
  const desc = drool.metadata.description ?? '';
  const name = drool.metadata.name;
  const modelLabel = drool.metadata.model ?? 'inherit';
  const locationLabel = drool.location === 'project' ? 'project' : 'personal';
  // Matches buildDroolSection() in taskToolDescription.ts
  return `• **${name}** — ${desc} (model: ${modelLabel}, location: ${locationLabel})`
    .length;
}

export function measureSkillDescriptionChars(skill: Skill): number {
  return formatAvailableSkillEntry(skill).length;
}
