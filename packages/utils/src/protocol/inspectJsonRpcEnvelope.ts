import z from 'zod';

import { INDUSTRY_PROTOCOL_VERSION } from '@industry/drool-sdk-ext/protocol/drool';
import {
  JsonRpcEnvelopeSchema,
  JsonRpcMessageType,
  type JsonRpcProtocolVersionMismatchErrorData,
} from '@industry/drool-sdk-ext/protocol/shared';

const JsonRpcEnvelopePeekSchema = JsonRpcEnvelopeSchema.partial()
  .extend({
    type: z.nativeEnum(JsonRpcMessageType).optional(),
    method: z.string().optional(),
    id: z.string().nullable().optional(),
  })
  .passthrough();

type JsonRpcEnvelopePeek = z.infer<typeof JsonRpcEnvelopePeekSchema>;

export function inspectJsonRpcEnvelope(message: unknown): {
  envelope: JsonRpcEnvelopePeek | null;
  protocolVersionMismatch: JsonRpcProtocolVersionMismatchErrorData | null;
} {
  const result = JsonRpcEnvelopePeekSchema.safeParse(message);

  if (!result.success) {
    return {
      envelope: null,
      protocolVersionMismatch: null,
    };
  }

  const envelope = result.data;

  const protocolVersionMismatch =
    envelope.industryProtocolVersion !== undefined &&
    envelope.industryProtocolVersion !== INDUSTRY_PROTOCOL_VERSION
      ? {
          localIndustryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
          peerIndustryProtocolVersion: envelope.industryProtocolVersion,
          messageType: envelope.type,
          method: envelope.method,
          requestId: envelope.id,
        }
      : null;

  return {
    envelope,
    protocolVersionMismatch,
  };
}
