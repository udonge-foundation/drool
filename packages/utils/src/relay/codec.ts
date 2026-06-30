import { RelayEnvelopeSchema } from '@industry/common/relay/schemas';

import type { RelayEnvelope } from '@industry/common/relay';

export function encodeEnvelope(envelope: RelayEnvelope): string {
  return JSON.stringify(envelope);
}

export function decodeEnvelope(raw: string): RelayEnvelope {
  const parsed: unknown = JSON.parse(raw);
  return RelayEnvelopeSchema.parse(parsed);
}
