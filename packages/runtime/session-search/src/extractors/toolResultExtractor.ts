import { SessionSearchDocKind } from '@industry/common/daemon';
import { logWarn } from '@industry/logging';

import { normalizeForIndex, stripSystemReminders } from '../normalization';
import { extractStringsFromUnknown, makeDocId } from './shared';

import type { BlockExtractor, SessionSearchDoc } from '../types';

// Extracts `tool_result` blocks.
// Index text includes any string values found in the tool result content.
// Snippet markdown preserves the original markdown when content is a string; otherwise it falls back to JSON.
export function createToolResultExtractor(): BlockExtractor {
  return {
    kind: SessionSearchDocKind.ToolResult,
    canExtract: (block: unknown) => {
      if (!block || typeof block !== 'object') return false;
      const type = (block as { type?: unknown }).type;
      return type === 'tool_result';
    },
    extract: (ctx, block) => {
      const toolResult = block as {
        id?: unknown;
        tool_use_id?: unknown;
        content?: unknown;
      };
      const toolUseId =
        typeof toolResult.tool_use_id === 'string'
          ? toolResult.tool_use_id
          : String(toolResult.id ?? ctx.blockIndex);

      const strings: string[] = [];
      extractStringsFromUnknown(toolResult.content, strings);
      const normalized = normalizeForIndex(strings.join('\n'));
      if (!normalized) return [];

      let snippet = '';
      if (typeof toolResult.content === 'string') {
        snippet = stripSystemReminders(toolResult.content);
      } else {
        try {
          const json =
            JSON.stringify(toolResult.content ?? null, null, 2) ?? '';
          if (json)
            snippet = `\`\`\`json\n${stripSystemReminders(json)}\n\`\`\``;
        } catch (err) {
          logWarn('Failed to stringify tool result content', { cause: err });
        }

        if (!snippet && strings.length > 0) {
          snippet = stripSystemReminders(strings.join('\n'));
        }
      }

      const doc: SessionSearchDoc = {
        id: makeDocId({
          sessionId: ctx.sessionId,
          kind: SessionSearchDocKind.ToolResult,
          eventId: ctx.eventId,
          blockKey: toolUseId,
        }),
        text: normalized,
        snippets: snippet ? [snippet] : [],
        toolName:
          typeof toolResult.tool_use_id === 'string'
            ? ctx.toolUseNameById[toolResult.tool_use_id]
            : undefined,
      };
      return [doc];
    },
  };
}
