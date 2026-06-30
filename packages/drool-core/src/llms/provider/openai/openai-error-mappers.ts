import { logWarn } from '@industry/logging';

import {
  isOpenAIContentModerationCode,
  isOpenAIContentModerationMessage,
  throwMappedOpenAIChunkError,
} from './throwMappedOpenAIChunkError';
import {
  LLMContentModerationError,
  LLMContextLengthExceededError,
  LLMError,
  LLMInternalError,
  LLMInvalidRequestError,
  LLMOverloadedError,
  LLMUnknownError,
} from '../../errors';
import { OpenAI } from '../../openai-reexport';

type OpenAIResponseFailedErrorDetails = {
  message: string;
  code?: string;
  type?: string;
  param?: string | null;
};

function parseOpenAIResponseFailedError(
  chunk: unknown
): OpenAIResponseFailedErrorDetails {
  if (typeof chunk !== 'object' || chunk === null) {
    return { message: 'OpenAI response failed' };
  }

  const chunkObj = chunk as Record<string, unknown>;
  const response =
    typeof chunkObj.response === 'object' && chunkObj.response !== null
      ? (chunkObj.response as Record<string, unknown>)
      : undefined;
  const responseError =
    response && typeof response.error === 'object' && response.error !== null
      ? (response.error as Record<string, unknown>)
      : undefined;

  const message =
    typeof responseError?.message === 'string'
      ? responseError.message
      : 'OpenAI response failed';
  const code =
    typeof responseError?.code === 'string' ? responseError.code : undefined;
  const type =
    typeof responseError?.type === 'string' ? responseError.type : undefined;
  const param =
    typeof responseError?.param === 'string' ? responseError.param : null;

  return { message, code, type, param };
}

export function mapOpenAIResponseFailedChunkToLLMError(
  chunk: unknown
): LLMError {
  const { message, code, type, param } = parseOpenAIResponseFailedError(chunk);

  if (
    isOpenAIContentModerationCode(code) ||
    isOpenAIContentModerationMessage(message)
  ) {
    return new LLMContentModerationError({ cause: chunk });
  }

  const providerCode = code;
  const errorMessage = providerCode
    ? `OpenAI response failed: ${message} (code: ${providerCode})`
    : `OpenAI response failed: ${message}`;

  // OpenAI's Responses API returns `response.failed` events with semantic,
  // non-numeric codes for provider-capacity and context-length conditions.
  // These were previously collapsed into `LLMInvalidRequestError` below,
  // which short-circuits `ChatOutcomeRecorder.deriveReasonFromError` (any
  // `instanceof LLMError` is treated as self-classifying) and inflated the
  // `invalidRequest` reason on the LLM Traffic dashboard. Map them to the
  // correct LLM error classes so retry/backoff and dashboards reflect the
  // true failure mode (FAC-19787).
  if (providerCode === 'server_is_overloaded') {
    return new LLMOverloadedError({ cause: chunk });
  }
  if (providerCode === 'context_length_exceeded') {
    return new LLMContextLengthExceededError({ cause: chunk });
  }
  // Bedrock (and OpenAI) emit transient internal failures mid-stream as a
  // `response.failed` event whose non-numeric `server_error` code/type would
  // otherwise fall through to `LLMInvalidRequestError` below and be treated as
  // a deterministic, non-rotatable failure. Map it to `LLMInternalError` so the
  // turn is retried and the OpenAI proxy provider is rotated (CL-668).
  if (providerCode === 'server_error' || type === 'server_error') {
    return new LLMInternalError({ cause: chunk });
  }

  if (!providerCode || !/^\d+$/.test(providerCode) || providerCode === '400') {
    return new LLMInvalidRequestError({ message: errorMessage, cause: chunk });
  }

  const errorEvent: OpenAI.Responses.ResponseErrorEvent = {
    type: 'error',
    sequence_number: Number.NaN,
    message: errorMessage,
    code: providerCode,
    param: param ?? null,
  };

  try {
    throwMappedOpenAIChunkError(errorEvent);
  } catch (error) {
    logWarn('Failed to map OpenAI chunk error', { cause: error });
    if (error instanceof LLMError) return error;
    return new LLMUnknownError({ cause: error });
  }
}
