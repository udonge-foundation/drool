import type { Stream } from '@agentclientprotocol/sdk';

// Methods that are in the ACP spec but not yet supported by the SDK
// These get rewritten to use the SDK's extension method mechanism (_prefix)
const UNSTABLE_METHODS = [
  'session/list',
  'session/resume',
  'session/set_config_option',
];

/**
 * Wraps a stream to rewrite unstable ACP methods to use the SDK's extension mechanism.
 * The SDK routes methods starting with '_' to extMethod(), so we rewrite
 * 'session/list' -> '_session/list' on incoming messages.
 */
export function wrapStreamForUnstableMethods(baseStream: Stream): Stream {
  const transformer = new TransformStream({
    transform(chunk, controller) {
      if (
        chunk &&
        typeof chunk === 'object' &&
        'method' in chunk &&
        typeof chunk.method === 'string' &&
        UNSTABLE_METHODS.includes(chunk.method)
      ) {
        controller.enqueue({ ...chunk, method: `_${chunk.method}` });
      } else {
        controller.enqueue(chunk);
      }
    },
  });

  // Pipe the base stream through the transformer
  // Catch errors to avoid unhandled promise rejection if the readable is canceled
  baseStream.readable.pipeTo(transformer.writable).catch(() => {});

  return {
    writable: baseStream.writable,
    readable: transformer.readable,
  };
}
