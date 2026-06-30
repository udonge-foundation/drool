import { SessionSearchDocKind } from '@industry/common/daemon';

import { normalizeForIndex, stripSystemReminders } from '../normalization';
import { makeDocId } from './shared';

import type { BlockExtractor, SessionSearchDoc } from '../types';

// Extracts user/assistant message text blocks.
// - `text` is normalized for indexing.
// - `snippets` preserves the original markdown (minus system reminders) for display.
export function createMessageTextExtractor(): BlockExtractor {
  return {
    kind: SessionSearchDocKind.MessageText,
    canExtract: (block: unknown) => {
      if (!block || typeof block !== 'object') return false;
      const type = (block as { type?: unknown }).type;
      return type === 'text';
    },
    extract: (ctx, block) => {
      const b = block as { id?: unknown; text?: unknown };
      if (typeof b.text !== 'string') return [];
      const normalized = normalizeForIndex(b.text);
      if (!normalized) return [];

      const snippet = stripSystemReminders(b.text);
      const blockKey = String(b.id ?? ctx.blockIndex);
      const messageRole = ctx.message.role === 'user' ? 'user' : 'assistant';
      const doc: SessionSearchDoc = {
        id: makeDocId({
          sessionId: ctx.sessionId,
          kind: SessionSearchDocKind.MessageText,
          eventId: ctx.eventId,
          blockKey,
        }),
        text: normalized,
        snippets: [snippet],
        messageRole,
      };
      return [doc];
    },
  };
}

export function extractMessageTextFromStringContent(ctx: {
  sessionId: string;
  eventId: string;
  content: string;
  messageRole: 'user' | 'assistant';
}): SessionSearchDoc[] {
  const normalized = normalizeForIndex(ctx.content);
  if (!normalized) return [];
  return [
    {
      id: makeDocId({
        sessionId: ctx.sessionId,
        kind: SessionSearchDocKind.MessageText,
        eventId: ctx.eventId,
        blockKey: '0',
      }),
      text: normalized,
      snippets: [stripSystemReminders(ctx.content)],
      messageRole: ctx.messageRole,
    },
  ];
}
