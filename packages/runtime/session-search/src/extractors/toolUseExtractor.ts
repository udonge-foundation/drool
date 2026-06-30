import { SessionSearchDocKind } from '@industry/common/daemon';
import { logWarn } from '@industry/logging';

import { normalizeForIndex, stripSystemReminders } from '../normalization';
import { extractStringsFromUnknown, makeDocId } from './shared';

import type { BlockExtractor, SessionSearchDoc } from '../types';

// Extracts `tool_use` blocks.
// Index text includes tool name plus any string values found in `input`.
// Snippet markdown shows the tool name and a pretty-printed JSON view of `input` (when possible).
export function createToolUseExtractor(): BlockExtractor {
  return {
    kind: SessionSearchDocKind.ToolUse,
    canExtract: (block: unknown) => {
      if (!block || typeof block !== 'object') return false;
      const type = (block as { type?: unknown }).type;
      return type === 'tool_use';
    },
    extract: (ctx, block) => {
      const toolUse = block as {
        id?: unknown;
        name?: unknown;
        input?: unknown;
      };
      const toolName = typeof toolUse.name === 'string' ? toolUse.name : '';
      const strings: string[] = [];
      extractStringsFromUnknown(toolUse.input, strings);
      const joined = [toolName, ...strings].filter(Boolean).join('\n');
      const normalized = normalizeForIndex(joined);
      if (!normalized) return [];

      let inputPretty = '';
      try {
        inputPretty = JSON.stringify(toolUse.input ?? null, null, 2) ?? '';
      } catch (err) {
        logWarn('Failed to stringify tool use input', { cause: err });
        inputPretty = '';
      }

      const snippetParts: string[] = [];
      if (toolName) snippetParts.push(`**${toolName}**`);
      if (inputPretty) {
        snippetParts.push(
          `\`\`\`json\n${stripSystemReminders(inputPretty)}\n\`\`\``
        );
      } else if (strings.length > 0) {
        snippetParts.push(stripSystemReminders(strings.join('\n')));
      }

      const snippet = snippetParts.join('\n\n');

      const blockKey = String(toolUse.id ?? ctx.blockIndex);
      const doc: SessionSearchDoc = {
        id: makeDocId({
          sessionId: ctx.sessionId,
          kind: SessionSearchDocKind.ToolUse,
          eventId: ctx.eventId,
          blockKey,
        }),
        text: normalized,
        snippets: snippet ? [snippet] : [],
        toolName: toolName || undefined,
      };
      return [doc];
    },
  };
}
