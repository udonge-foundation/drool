const encoder = new TextEncoder();

function toUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }

  if (typeof chunk === 'string') {
    return encoder.encode(chunk);
  }

  if (Buffer.isBuffer(chunk)) {
    return new Uint8Array(chunk);
  }

  return encoder.encode(String(chunk ?? ''));
}

type DestroyableStream = {
  destroy?: (error?: Error) => void;
};

function destroyStream(
  stream: NodeJS.ReadableStream | NodeJS.WritableStream,
  reason?: unknown
): void {
  const target = stream as DestroyableStream;
  if (typeof target.destroy === 'function') {
    target.destroy(reason instanceof Error ? reason : undefined);
  }
}

export function nodeToWebReadable(
  stream: NodeJS.ReadableStream
): ReadableStream<Uint8Array> {
  let cleanup: (() => void) | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: unknown) => {
        try {
          controller.enqueue(toUint8Array(chunk));
        } catch (error) {
          controller.error(error);
        }
      };

      const onEnd = () => {
        cleanup?.();
        cleanup = undefined;
        controller.close();
      };
      const onError = (error: unknown) => {
        cleanup?.();
        cleanup = undefined;
        controller.error(error);
      };

      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.on('error', onError);

      cleanup = () => {
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('error', onError);
      };
    },
    cancel(reason) {
      destroyStream(stream, reason);
      cleanup?.();
      cleanup = undefined;
    },
  });
}

export function nodeToWebWritable(
  stream: NodeJS.WritableStream
): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        const buffer = Buffer.from(chunk);
        stream.write(buffer, (error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    abort(reason) {
      destroyStream(stream, reason);
    },
  });
}
