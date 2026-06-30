import { logWarn } from '@industry/logging';

import { sleep } from '../time';
import { AbortError, RetryableError } from './errors';
import { RetryOptions } from './types';

const DEFAULT_RETRIES = 3;
const DEFAULT_DELAY = 250;
const DEFAULT_BACKOFF_FACTOR = 2;

// Use isRetryableError: checkRetryableErrorType to only retry RetryableErrors.
export function checkRetryableErrorType(error: unknown): boolean {
  return error instanceof RetryableError ? error.canRetry : false;
}

export function retry<T extends (...args: Parameters<T>) => ReturnType<T>>(
  func: T,
  {
    retries = DEFAULT_RETRIES,
    delay = DEFAULT_DELAY,
    exponentialBackoff = false,
    backoffFactor = DEFAULT_BACKOFF_FACTOR,
    jitter = false,
    onRetry,
    onSuccess,
    onAllError,
    isRetryableError,
    signal,
    getDelay,
  }: RetryOptions<ReturnType<T>> = {}
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
  return async function retryWrapper(
    ...args: Parameters<T>
  ): Promise<ReturnType<T>> {
    let attempts = 0;
    let funcError: unknown = new Error('No error captured');
    while (attempts < retries) {
      try {
        const result = await func(...args);
        if (onSuccess) {
          onSuccess(attempts);
        }
        return result;
      } catch (error) {
        funcError = error;
        attempts += 1;

        if (isRetryableError && !isRetryableError(funcError)) {
          break;
        }

        if (onRetry) {
          onRetry(funcError, attempts);
        }

        logWarn('Retry attempt failed', { cause: error });
      }

      if (attempts >= retries) {
        break;
      }

      const baseDelayTime = exponentialBackoff
        ? delay * backoffFactor ** attempts
        : delay;
      const delayTime = getDelay
        ? getDelay(funcError, attempts, baseDelayTime)
        : jitter
          ? baseDelayTime * 0.5 + Math.random() * baseDelayTime * 0.5
          : baseDelayTime;

      if (signal?.aborted) {
        throw new AbortError();
      }

      if (signal) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayTime);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new AbortError());
            },
            { once: true }
          );
        });
      } else {
        await sleep(delayTime);
      }
    }

    // Check if aborted after retry loop exits (edge case: abort during final attempt)
    if (signal?.aborted) {
      throw new AbortError();
    }

    if (onAllError) return onAllError(funcError);
    throw funcError;
  };
}
