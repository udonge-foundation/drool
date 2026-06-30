import { GoogleError } from 'google-gax';

import { logWarn } from '@industry/logging';

import {
  LLMUnknownError,
  LLMThrottlingError,
  LLMStreamError,
  LLMRetryExhaustedError,
  LLMInternalError,
  LLMInvalidResponseDataError,
  LLMInvalidRequestError,
  LLMContextLengthExceededError,
  LLMTextFieldsTooLargeError,
  LLMNetworkError,
} from '../../errors';

/**
 * Parses a duration string (e.g., "34.074824224s", "60s", "900ms") and returns the time in milliseconds.
 * Mirrors the Gemini CLI's parseDurationInSeconds but returns ms directly.
 */
function parseDurationMs(duration: string): number | undefined {
  if (duration.endsWith('ms')) {
    const ms = parseFloat(duration.slice(0, -2));
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (duration.endsWith('s')) {
    const seconds = parseFloat(duration.slice(0, -1));
    return Number.isNaN(seconds) ? undefined : seconds * 1000;
  }
  return undefined;
}

/**
 * Extracts a server-suggested retry delay from a Google API error.
 * Checks two sources (same approach as Gemini CLI):
 * 1. RetryInfo in error details: {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "40s"}
 * 2. Inline message pattern: "Please retry in 54.887755558s"
 */
function extractRetryDelayMs(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  // Check structured error details for RetryInfo
  const errorObj = error as Record<string, unknown>;
  const details =
    errorObj.details ??
    (errorObj.error as Record<string, unknown> | undefined)?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (
        detail &&
        typeof detail === 'object' &&
        '@type' in detail &&
        typeof detail['@type'] === 'string' &&
        detail['@type'].includes('RetryInfo') &&
        'retryDelay' in detail &&
        typeof detail.retryDelay === 'string'
      ) {
        const ms = parseDurationMs(detail.retryDelay);
        if (ms !== undefined) return ms;
      }
    }
  }

  // Fallback: parse "Please retry in Xs" from error message
  const message =
    typeof errorObj.message === 'string'
      ? errorObj.message
      : typeof (errorObj.error as Record<string, unknown> | undefined)
            ?.message === 'string'
        ? ((errorObj.error as Record<string, unknown>).message as string)
        : undefined;
  if (message) {
    const match = message.match(/Please retry in ([0-9.]+(?:ms|s))/);
    if (match?.[1]) {
      return parseDurationMs(match[1]);
    }
  }

  return undefined;
}

/**
 * Maps Google Gemini errors to our custom LLM error types
 */
export function mapGoogleError(
  error: unknown
):
  | LLMContextLengthExceededError
  | LLMTextFieldsTooLargeError
  | LLMThrottlingError
  | LLMInvalidResponseDataError
  | LLMInvalidRequestError
  | LLMStreamError
  | LLMRetryExhaustedError
  | LLMInternalError
  | LLMUnknownError {
  logWarn('Gemini response error', { cause: error });

  // If it's already one of our error types, return it directly
  if (
    error instanceof LLMContextLengthExceededError ||
    error instanceof LLMTextFieldsTooLargeError ||
    error instanceof LLMThrottlingError ||
    error instanceof LLMInvalidResponseDataError ||
    error instanceof LLMInvalidRequestError ||
    error instanceof LLMStreamError ||
    error instanceof LLMRetryExhaustedError ||
    error instanceof LLMUnknownError ||
    error instanceof LLMInternalError
  ) {
    return error;
  }

  // Extract server-suggested retry delay from structured error details
  const retryAfterMs = extractRetryDelayMs(error);

  // Extract useful information regardless of error type
  let errorMessage = '';
  let statusCode: number | null = null;

  // Try to get the error message and status
  if (error instanceof Error) {
    errorMessage = error.message;

    // Try to extract status code from error message using regex
    // Matches patterns like "[500 Internal Server Error]"
    const statusMatch = errorMessage.match(/\[(\d+)\s+[^\]]+\]/);
    if (statusMatch) {
      statusCode = Number(statusMatch[1]);
    }

    if (
      errorMessage.includes('Input too long') ||
      errorMessage.includes('Prompt is too long') ||
      errorMessage.includes('exceed context limit') ||
      errorMessage.includes('exceeds the maximum number of tokens')
    ) {
      return new LLMContextLengthExceededError();
    }

    if (
      errorMessage.includes('Request contains text fields that are too large')
    ) {
      return new LLMTextFieldsTooLargeError();
    }

    if (
      errorMessage.includes('Resource exhausted') ||
      errorMessage.includes('quota exceeded') ||
      errorMessage.includes('rate limit')
    ) {
      return new LLMThrottlingError({
        message: error.message,
        retryAfterMs,
      });
    }

    if (
      errorMessage.includes('Invalid argument') ||
      errorMessage.includes('Bad request') ||
      errorMessage.includes('malformed request') ||
      errorMessage.includes('invalid parameter')
    ) {
      return new LLMInvalidRequestError({ message: error.message });
    }
  }

  if (error instanceof GoogleError) {
    if (error.code) {
      statusCode = error.code;
      // Handle gRPC status codes
      switch (error.code) {
        case 3: // INVALID_ARGUMENT
          if (
            errorMessage.includes('Input too long') ||
            errorMessage.includes('Prompt is too long') ||
            errorMessage.includes('exceed context limit') ||
            errorMessage.includes('exceeds the maximum number of tokens')
          ) {
            return new LLMContextLengthExceededError();
          }
          return new LLMInvalidRequestError({ message: errorMessage });
        case 5: // NOT_FOUND
          return new LLMInvalidResponseDataError();
        case 7: // PERMISSION_DENIED
          return new LLMThrottlingError({
            message: errorMessage,
            retryAfterMs,
          });
        case 8: // RESOURCE_EXHAUSTED
          return new LLMThrottlingError({
            message: errorMessage,
            retryAfterMs,
          });
        case 11: // OUT_OF_RANGE
          return new LLMContextLengthExceededError();
        case 13: // INTERNAL
          return new LLMInternalError();
        case 14: // UNAVAILABLE
          return new LLMThrottlingError({
            message: errorMessage,
            retryAfterMs,
          });
        case 16: // UNAUTHENTICATED
          return new LLMInvalidRequestError({ message: errorMessage });
        default:
          return new LLMUnknownError();
      }
    }
    if (error.message) {
      errorMessage = error.message;
    }
  }
  // Handle plain objects with error-like properties
  else if (typeof error === 'object' && error !== null) {
    // Try to get status from object properties
    if ('status' in error && !statusCode) {
      statusCode = Number(error.status);
    }

    // Try to get message from various possible locations
    if ('message' in error && typeof error.message === 'string') {
      errorMessage = error.message;
    } else if (
      'error' in error &&
      typeof error.error === 'object' &&
      error.error !== null &&
      'message' in error.error
    ) {
      errorMessage = String(error.error.message);
    }
  }

  switch (statusCode) {
    case 400:
      return new LLMInvalidRequestError({ message: errorMessage });
    case 401:
      return new LLMInvalidRequestError({ message: errorMessage });
    case 402:
      return new LLMInvalidRequestError({ message: errorMessage });
    case 403:
      return new LLMThrottlingError({ message: errorMessage, retryAfterMs });
    case 404:
      return new LLMInvalidResponseDataError();
    case 429:
      return new LLMThrottlingError({ message: errorMessage, retryAfterMs });
    case 500:
      // Context length errors often come as 500 errors
      if (
        errorMessage.includes('Input too long') ||
        errorMessage.includes('Prompt is too long') ||
        errorMessage.includes('exceed context limit') ||
        errorMessage.includes('exceeds the maximum number of tokens')
      ) {
        return new LLMContextLengthExceededError();
      }
      return new LLMInternalError();
    case 503:
      return new LLMThrottlingError({ message: errorMessage, retryAfterMs });
    case 504:
      return new LLMNetworkError({ cause: errorMessage });
    default:
      break;
  }

  return new LLMUnknownError();
}
