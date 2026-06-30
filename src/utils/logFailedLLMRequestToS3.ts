import { logWarn } from '@industry/logging';

import { getIndustryApiConfig } from '@/api/config';
import { fetchBackend } from '@/api/fetchBackend';
import {
  shouldLogFailedRequest,
  extractStatusCode,
  serializeError,
} from '@/services/aws/FailedRequestLogger';

interface LogFailedLLMRequestParams {
  error: unknown;
  rawRequest: string;
  providerRequest?: unknown;
  sessionId: string;
  assistantMessageId: string;
  model: string;
  provider: 'anthropic' | 'openai' | 'generic_chat_completion' | 'gemini';
  apiProvider?: string;
}

/**
 * Send failed LLM request to the API endpoint for S3 logging
 */
async function sendFailedRequestToAPI(body: {
  request: string;
  providerRequest?: unknown;
  error: string;
  metadata: {
    sessionId: string;
    assistantMessageId: string;
    model: string;
    provider: string;
    statusCode?: number;
    timestamp?: number;
  };
}): Promise<void> {
  const apiConfig = getIndustryApiConfig();
  const headers = apiConfig.getHeaders ? await apiConfig.getHeaders() : {};
  const response = await fetchBackend('/api/llm/failed-requests', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    logWarn('[llmErrorLogger] API request failed', {
      statusCode: response.status,
      statusText: response.statusText,
    });
  }
}

/**
 * Check if an LLM error should be logged to S3 and handle the logging if needed.
 * This is an async operation that should be called with `void` for fire-and-forget behavior.
 *
 * @param params - Parameters for logging the failed request
 * @returns Promise that resolves when logging is complete (typically ignored for fire-and-forget)
 */
export async function logFailedLLMRequestToS3(
  params: LogFailedLLMRequestParams
): Promise<void> {
  try {
    const {
      error,
      rawRequest,
      providerRequest,
      sessionId,
      assistantMessageId,
      model,
      provider,
      apiProvider,
    } = params;

    // Check if this is a whitelisted error for S3 logging
    if (!shouldLogFailedRequest(error)) {
      return;
    }

    const statusCode = extractStatusCode(error);

    // Parse raw request if a structured providerRequest wasn't provided
    let parsedRequest: unknown | undefined = providerRequest;
    if (parsedRequest === undefined) {
      try {
        parsedRequest = JSON.parse(rawRequest);
      } catch {
        parsedRequest = undefined;
      }
    }

    // Prepare request body for API
    const requestBody = {
      request: rawRequest,
      providerRequest: parsedRequest,
      error: serializeError(error),
      metadata: {
        timestamp: Date.now(),
        sessionId,
        assistantMessageId,
        model,
        provider,
        statusCode,
      },
    };

    // Log locally for debugging
    const logValue: Record<string, unknown> = {
      statusCode,
      model,
      provider,
    };

    if (apiProvider) {
      logValue.apiProvider = apiProvider;
    }

    logWarn('[useLLMStreaming] Logging failed request', {
      error,
      value: logValue,
    });

    await sendFailedRequestToAPI(requestBody);
  } catch (uploadError) {
    // Log any errors that occur during the entire logging process
    logWarn('[llmErrorLogger] Failed to send to API', {
      error: uploadError,
      sessionId: params.sessionId,
      assistantMessageId: params.assistantMessageId,
      modelId: params.model,
      apiProvider: params.provider,
    });
  }
}
