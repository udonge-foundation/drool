import { normalizeForIndex } from '../normalization';

export function extractStringsFromUnknown(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const trimmed = normalizeForIndex(value);
    if (trimmed) out.push(trimmed);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) extractStringsFromUnknown(item, out);
    return;
  }

  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      extractStringsFromUnknown(v, out);
    }
  }
}

export function makeDocId(parts: {
  sessionId: string;
  kind: string;
  eventId: string;
  blockKey: string;
}): string {
  return `${parts.sessionId}:${parts.kind}:${parts.eventId}:${parts.blockKey}`;
}
