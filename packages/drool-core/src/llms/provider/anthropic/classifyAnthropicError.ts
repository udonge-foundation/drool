import {
  LLMContextLengthExceededError,
  LLMContentModerationError,
  LLMInternalError,
  LLMInvalidRequestError,
  LLMOverloadedError,
  LLMThrottlingError,
  LLMUnknownError,
} from '../../errors';

export function classifyAnthropicError(
  payload: { type: string; message: string },
  opts?: { cause?: unknown }
): Error {
  const { type, message } = payload;
  const cause = opts?.cause;

  // Overload / throttling detection via type or message
  if (type === 'overloaded_error' || /overloaded/i.test(message)) {
    return new LLMOverloadedError({ cause });
  }
  if (
    type === 'rate_limit_error' ||
    /model is getting throttled/i.test(message)
  ) {
    return new LLMThrottlingError({ message, cause });
  }
  if (
    /context length/i.test(message) ||
    /prompt is too long/i.test(message) ||
    /request size exceed(s|ed)/i.test(message) ||
    /context window/i.test(message)
  ) {
    return new LLMContextLengthExceededError({ cause });
  }
  if (/output blocked by content filtering policy/i.test(message)) {
    return new LLMContentModerationError({ cause });
  }
  if (
    type === 'bad_request_error' ||
    type === 'invalid_request_error' ||
    type === 'unauthorized_error' ||
    type === 'not_found_error'
  ) {
    return new LLMInvalidRequestError({ message, cause });
  }
  if (type === 'api_error' || type === 'internal_error') {
    return new LLMInternalError({ cause });
  }
  return new LLMUnknownError({ cause });
}
