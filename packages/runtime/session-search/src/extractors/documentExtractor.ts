import { SessionSearchDocKind } from '@industry/common/daemon';

import { normalizeForIndex, stripSystemReminders } from '../normalization';
import { makeDocId } from './shared';

import type { BlockExtractor, SessionSearchDoc } from '../types';

// Extracts `document` blocks.
// Index text includes name/path plus the full document content (parsed_data preferred).
// Snippet markdown wraps the content in a fenced block for readability.
export function createDocumentExtractor(): BlockExtractor {
  return {
    kind: SessionSearchDocKind.Document,
    canExtract: (block: unknown) => {
      if (!block || typeof block !== 'object') return false;
      const type = (block as { type?: unknown }).type;
      return type === 'document';
    },
    extract: (ctx, block) => {
      const docBlock = block as {
        id?: unknown;
        source?: unknown;
      };
      const src = docBlock.source;
      const srcObj =
        src && typeof src === 'object'
          ? (src as Record<string, unknown>)
          : undefined;

      const name = typeof srcObj?.name === 'string' ? srcObj.name : '';
      const filePath = typeof srcObj?.path === 'string' ? srcObj.path : '';
      const parsed =
        typeof srcObj?.parsed_data === 'string'
          ? srcObj.parsed_data
          : undefined;
      const data = typeof srcObj?.data === 'string' ? srcObj.data : undefined;

      const parts: string[] = [];
      if (name) parts.push(name);
      if (filePath) parts.push(filePath);
      if (parsed) parts.push(parsed);
      else if (data) parts.push(data);

      const normalized = normalizeForIndex(parts.join('\n'));
      if (!normalized) return [];

      const displayHeaderParts: string[] = [];
      if (name) displayHeaderParts.push(`**${name}**`);
      if (filePath) displayHeaderParts.push(`\`${filePath}\``);
      const displayHeader = displayHeaderParts.join(' ');
      const displayBody = stripSystemReminders(parsed ?? data ?? '');
      const snippet =
        displayBody.length > 0
          ? `${displayHeader}${displayHeader ? '\n\n' : ''}\`\`\`\n${displayBody}\n\`\`\``
          : displayHeader;

      const blockKey = String(docBlock.id ?? ctx.blockIndex);
      const doc: SessionSearchDoc = {
        id: makeDocId({
          sessionId: ctx.sessionId,
          kind: SessionSearchDocKind.Document,
          eventId: ctx.eventId,
          blockKey,
        }),
        text: normalized,
        snippets: snippet ? [snippet] : [],
      };
      return [doc];
    },
  };
}
