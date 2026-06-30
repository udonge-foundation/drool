import {
  LLMInvalidRequestError,
  LLMThrottlingError,
  LLMInternalError,
  LLMOverloadedError,
  LLMUnknownError,
  LLMContentModerationError,
} from '../../errors';
import { OpenAI } from '../../openai-reexport';

export function isOpenAIContentModerationMessage(
  message: string | undefined
): boolean {
  if (!message) return false;
  return (
    /cyber[_\s-]?policy/i.test(message) ||
    /flagged as potentially violating our usage policy/i.test(message)
  );
}

export function isOpenAIContentModerationCode(
  code: string | null | undefined
): boolean {
  if (!code) return false;
  const normalizedCode = code.toLowerCase();
  return (
    normalizedCode === 'content_filter' || normalizedCode === 'cyber_policy'
  );
}

export function throwMappedOpenAIChunkError(
  errorChunk: OpenAI.Responses.ResponseErrorEvent
): never {
  const errorMessage = `OpenAI Error: ${errorChunk.message}${errorChunk.param ? ` (param: ${errorChunk.param})` : ''}`;

  if (
    isOpenAIContentModerationCode(errorChunk.code) ||
    isOpenAIContentModerationMessage(errorChunk.message)
  ) {
    throw new LLMContentModerationError({ cause: errorChunk });
  }

  switch (errorChunk.code) {
    case '401':
      throw new LLMInvalidRequestError({
        message: errorMessage,
        cause: errorChunk,
      });

    case '403':
      throw new LLMInvalidRequestError({
        message: errorMessage,
        cause: errorChunk,
      });

    case '429':
      throw new LLMThrottlingError({
        message: errorMessage,
        cause: errorChunk,
      });

    case '500':
      throw new LLMInternalError({
        cause: errorChunk,
      });

    case '503':
      throw new LLMOverloadedError({
        cause: errorChunk,
      });

    default:
      throw new LLMUnknownError({
        cause: errorChunk,
      });
  }
}
