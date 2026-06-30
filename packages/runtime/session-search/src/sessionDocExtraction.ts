import { logException } from '@industry/logging';

import { extractMessageTextFromStringContent } from './extractors/messageTextExtractor';
import { getExtractorRegistry } from './extractors/registry';

import type {
  DroolMessageEvent,
  LocallyPersistedDroolMessage,
  SessionSearchDoc,
} from './types';

const EXTRACTORS = getExtractorRegistry().map((r) => r.extractor);

export function extractDocsFromMessageEvent(
  sessionId: string,
  event: DroolMessageEvent
): SessionSearchDoc[] {
  const eventId = typeof event.id === 'string' ? event.id : 'unknown';
  const msg: LocallyPersistedDroolMessage = event.message;
  const content = msg.content;

  if (typeof content === 'string') {
    return extractMessageTextFromStringContent({
      sessionId,
      eventId,
      content,
      messageRole: msg.role === 'user' ? 'user' : 'assistant',
    });
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const toolUseNameById: Record<string, string> = {};
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    try {
      const b = block as { type?: unknown; id?: unknown; name?: unknown };
      if (
        b.type === 'tool_use' &&
        typeof b.id === 'string' &&
        typeof b.name === 'string'
      ) {
        toolUseNameById[b.id] = b.name;
      }
    } catch (error) {
      logException(
        error,
        '[search] Failed to scan tool_use block for tool name',
        {
          sessionId,
          eventId,
        }
      );
    }
  }

  const docs: SessionSearchDoc[] = [];

  for (let i = 0; i < content.length; i++) {
    const block = content[i] as unknown;
    if (!block || typeof block !== 'object') continue;

    const ctx = {
      sessionId,
      eventId,
      blockIndex: i,
      message: msg,
      toolUseNameById,
    };

    for (const extractor of EXTRACTORS) {
      let canExtract = false;
      try {
        canExtract = extractor.canExtract(block);
      } catch (error) {
        logException(error, '[search] extractor.canExtract failed', {
          sessionId,
          type: extractor.kind,
          eventId,
          index: i,
        });
        continue;
      }

      if (!canExtract) continue;

      try {
        docs.push(...extractor.extract(ctx, block));
      } catch (error) {
        logException(error, '[search] extractor.extract failed', {
          sessionId,
          type: extractor.kind,
          eventId,
          index: i,
        });
      }
    }
  }

  return docs;
}
