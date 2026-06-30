import {
  LLMError,
  LLMThrottlingError,
  isContextLimitError,
} from '@industry/drool-core/llms/errors';
import { logInfo, logWarn } from '@industry/logging';
import { FetchError } from '@industry/logging/errors';
import { isAbortError } from '@industry/utils/function';

import { logFailedLLMRequestToS3 } from '@/utils/logFailedLLMRequestToS3';

interface RetryErrorHandlerParams {
  error: unknown;
  rawRequest: string;
  sessionId: string;
  assistantMessageId: string;
  model: string;
  provider: 'anthropic' | 'openai' | 'generic_chat_completion' | 'gemini';
  apiProvider?: string;
  attempt: number;
  isS3LoggingEnabled: boolean;
  allowContextLimitS3Logging?: boolean;
}

/**
 * Handler for logging LLM errors during streaming.
 * Logs warnings and optionally sends failed requests to S3.
 */
export function handleLlmError({
  error,
  attempt,
  model,
  apiProvider,
  rawRequest,
  provider,
  sessionId,
  assistantMessageId,
  isS3LoggingEnabled,
  allowContextLimitS3Logging,
}: RetryErrorHandlerParams): void {
  // Skip logging for user-initiated aborts (defensive: shouldn't be called for aborts)
  if (isAbortError(error)) {
    return;
  }

  // Log the error with structured fields for Axiom filtering
  logWarn('[useLLMStreaming] LLM error', {
    error,
    attempt,
    modelId: model,
    ...(apiProvider && { apiProvider }),
    errorName: error instanceof Error ? error.name : 'unknown',
    ...(error instanceof LLMError && {
      errorClass: error.constructor.name,
      failureReason: error.getReason(),
      isRetryable: error.shouldRetry(),
    }),
    ...(error instanceof FetchError && {
      statusCode: error.response?.status,
    }),
    ...(error instanceof LLMThrottlingError &&
      error.retryAfterMs !== undefined && {
        retryAfterMs: error.retryAfterMs,
      }),
  });

  // Handle S3 logging if enabled
  if (isS3LoggingEnabled) {
    logInfo('[useLLMStreaming] S3Logging is true');
    if (!isContextLimitError(error) || allowContextLimitS3Logging) {
      void logFailedLLMRequestToS3({
        error,
        rawRequest,
        sessionId,
        assistantMessageId,
        model,
        provider,
        ...(apiProvider && { apiProvider }),
      });
    }
  } else {
    logInfo('[useLLMStreaming] S3Logging is false');
  }
}
