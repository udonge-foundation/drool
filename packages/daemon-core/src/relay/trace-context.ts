import { z } from 'zod';

import { OtelTracing } from '@industry/logging/tracing';
import { inspectJsonRpcEnvelope } from '@industry/utils/protocol';

import type { TraceContextMeta } from '@industry/drool-sdk-ext/protocol/shared';
import type { Context } from '@opentelemetry/api';

const TraceInjectableMessageSchema = z.record(z.unknown());

function parseJsonMessage(message: string): unknown {
  try {
    return JSON.parse(message);
    // eslint-disable-next-line industry/require-catch-handling
  } catch {
    return null;
  }
}

export function extractMessageTraceMeta(
  message: string
): TraceContextMeta | undefined {
  return inspectJsonRpcEnvelope(parseJsonMessage(message)).envelope?._meta;
}

export function injectMessageTraceMeta(message: string, ctx: Context): string {
  const parsed = TraceInjectableMessageSchema.safeParse(
    parseJsonMessage(message)
  );
  if (!parsed.success) {
    return message;
  }

  const _meta: TraceContextMeta = {};
  OtelTracing.injectContext(_meta, ctx);
  return JSON.stringify({
    ...parsed.data,
    _meta: _meta.traceparent ? _meta : undefined,
  });
}
