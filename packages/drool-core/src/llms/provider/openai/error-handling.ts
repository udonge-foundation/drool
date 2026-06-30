import { mapOpenAIResponseFailedChunkToLLMError } from './openai-error-mappers';
import { ChatFailureReason } from '../../../core/enums';
import { LLMError } from '../../errors';

export function throwMappedOpenAIResponseFailedChunkError(
  chunk: unknown
): never {
  throw mapOpenAIResponseFailedChunkToLLMError(chunk);
}

export function mapOpenAIResponseFailedChunkToFailure(chunk: unknown): {
  error: LLMError;
  reason?: ChatFailureReason;
} {
  const error = mapOpenAIResponseFailedChunkToLLMError(chunk);
  return {
    error,
    reason:
      error.getReason() === ChatFailureReason.ContentModerationError
        ? ChatFailureReason.ContentModerationError
        : undefined,
  };
}
