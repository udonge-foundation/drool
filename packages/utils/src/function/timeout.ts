import { MetaError } from '@industry/logging/errors';

/**
 * Message of the rejection produced by `withTimeout`. Shared with
 * `isTimeoutError` so the producer and the narrower never diverge.
 */
const TIMEOUT_ERROR_MESSAGE = 'Operation timed out';

/**
 * Race a promise against a timeout. If `promise` settles first, the timeout
 * timer is cleared so it does not keep the event loop alive (important in
 * vitest and in long-lived processes that call this frequently).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new MetaError(TIMEOUT_ERROR_MESSAGE, { timeout: timeoutMs })),
      timeoutMs
    );
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/**
 * Narrows an unknown error to the rejection produced by `withTimeout`, so
 * callers can distinguish a deadline breach from any other failure.
 */
export function isTimeoutError(error: unknown): error is MetaError {
  return (
    error instanceof MetaError &&
    error.message === TIMEOUT_ERROR_MESSAGE &&
    typeof error.metadata?.timeout === 'number'
  );
}
