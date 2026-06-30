import { LLMError, LLMNetworkError } from './errors';

/**
 * Maps raw stream reader errors to the LLM error hierarchy.
 *
 * Handles common transport-level errors that occur when an SSE connection is
 * interrupted mid-response (provider-side close, CDN/LB truncation, network
 * issues). These are provider-agnostic — they surface identically from the
 * Anthropic, OpenAI, and other SDK streaming iterators.
 *
 * When the connection drops mid-JSON, the SDK's internal JSON.parse throws a
 * SyntaxError ("Unterminated string", "Unexpected end of JSON input", etc.).
 * These are transient and should be retried.
 *
 * Provider-specific error handlers (e.g. mapAnthropicReaderError) should call
 * this first, then layer on their own classification for unhandled errors.
 */
export function mapStreamReaderError(err: unknown): Error {
  if (err instanceof LLMError) return err;

  if (err instanceof Error) {
    // Truncated SSE stream — SDK's JSON.parse fails on incomplete data
    if (err instanceof SyntaxError) {
      return new LLMNetworkError({ cause: err });
    }

    const errorWithCode = err as Error & { code?: string };

    if (
      err.message === 'Premature close' ||
      errorWithCode.code === 'ERR_STREAM_PREMATURE_CLOSE'
    ) {
      return new LLMNetworkError({ cause: err });
    }

    // Anthropic/OpenAI SDKs: stream opened with 200 OK but closed with no data
    if (err.message.includes('request ended without sending any chunks')) {
      return new LLMNetworkError({ cause: err });
    }

    if (
      err.message.includes('ECONNRESET') ||
      err.message.includes('ETIMEDOUT') ||
      err.message.includes('ENOTFOUND') ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('socket hang up') ||
      err.message.includes('Connection reset by peer')
    ) {
      return new LLMNetworkError({ cause: err });
    }

    return err;
  }

  return new Error(String(err));
}
