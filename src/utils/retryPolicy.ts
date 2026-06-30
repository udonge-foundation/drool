import { RetryStrategy } from '@industry/drool-core/llms/client/enums';
import {
  LLMThrottlingError,
  isProviderCapacityError,
  isRetryableLLMError,
  isThrottlingError,
  isTimeoutError,
} from '@industry/drool-core/llms/errors';

const NON_INTERACTIVE_BASE_DELAY = 2000;
const DEFAULT_BASE_DELAY = 1000;
const THROTTLE_MIN_DELAY = 5000;
const THROTTLE_MAX_DELAY = 30_000;
// Minimal delay for provider capacity errors (502/503/529/500) where we rotate providers
const CAPACITY_ERROR_DELAY = 500;
// Longer base delay for timeout errors — the provider may be under load
const TIMEOUT_BASE_DELAY = 3000;
const TIMEOUT_MAX_DELAY = 15_000;

export function getRetryConfig({ strategy }: { strategy: RetryStrategy }) {
  const nonInteractive = strategy === RetryStrategy.NonInteractive;
  return {
    retries: nonInteractive ? 5 : 4,
    delay: nonInteractive ? NON_INTERACTIVE_BASE_DELAY : DEFAULT_BASE_DELAY,
    jitter: true,
    backoffFactor: nonInteractive ? 2.5 : 2,
    exponentialBackoff: true,
    isRetryableError: isRetryableLLMError,
    getDelay: (error: unknown, attempt: number, baseDelay: number) => {
      if (isThrottlingError(error)) {
        // Respect server-provided retry delay as a minimum (LLMThrottlingError only)
        if (error instanceof LLMThrottlingError) {
          const serverDelay = error.retryAfterMs;
          if (serverDelay) {
            return serverDelay + serverDelay * 0.2 * Math.random();
          }
        }
        // Exponential backoff with longer base for throttling (5s min, 30s cap)
        const throttleBase = Math.max(THROTTLE_MIN_DELAY, baseDelay);
        const exponentialDelay = throttleBase * 2 ** (attempt - 1);
        const capped = Math.min(exponentialDelay, THROTTLE_MAX_DELAY);
        return capped + capped * 0.2 * Math.random();
      }
      // Provider capacity errors (502 bad gateway, 503 overloaded, 529 overloaded, 500 internal):
      // Retry immediately with minimal delay since we're rotating to a different provider.
      if (isProviderCapacityError(error)) {
        return CAPACITY_ERROR_DELAY + Math.random() * CAPACITY_ERROR_DELAY;
      }
      // Timeout errors: use a fixed base with 1.5x backoff, capped at 15s.
      // We ignore `baseDelay` here because retry() already applies exponential
      // growth to it — using it would double-stack the backoff.
      if (isTimeoutError(error)) {
        const exponentialDelay =
          TIMEOUT_BASE_DELAY * 1.5 ** (attempt - 1) + Math.random() * 1000;
        return Math.min(exponentialDelay, TIMEOUT_MAX_DELAY);
      }
      // Default: jitter in [50%, 100%] of baseDelay
      return baseDelay * 0.5 + Math.random() * baseDelay * 0.5;
    },
  } as const;
}
