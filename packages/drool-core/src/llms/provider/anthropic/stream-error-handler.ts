import { logWarn } from '@industry/logging';

import { classifyAnthropicError } from './classifyAnthropicError';
import { LLMError, mapStreamReaderError } from '../../errors';

/**
 * Maps raw reader errors from Anthropic streams to appropriate LLM error classes.
 *
 * Delegates common stream-level errors (SyntaxError from truncated SSE,
 * network resets, premature close) to the shared {@link mapStreamReaderError},
 * then layers on Anthropic-specific classification for JSON error payloads.
 */
export function mapAnthropicReaderError(err: unknown): Error {
  // 1. Handle common stream-level errors (SyntaxError, network, premature close)
  const mapped = mapStreamReaderError(err);
  if (mapped instanceof LLMError) return mapped;

  // 2. Try to parse error message as Anthropic JSON error response
  const msg = mapped.message;
  try {
    const parsed: unknown = JSON.parse(msg);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'type' in parsed &&
      (parsed as { type: unknown }).type === 'error' &&
      'error' in parsed
    ) {
      const errorPayload = (
        parsed as { error: { type: string; message: string } }
      ).error;
      if (
        typeof errorPayload?.type === 'string' &&
        typeof errorPayload?.message === 'string'
      ) {
        logWarn('Mapping Anthropic stream reader error', {
          errorName: errorPayload.type,
          errorMessage: errorPayload.message,
          error: err,
        });
        return classifyAnthropicError(errorPayload, { cause: err });
      }
    }
  } catch (parseErr) {
    // Not JSON — fall through to return the original error
    logWarn('Failed to parse Anthropic stream error as JSON', {
      cause: parseErr,
    });
  }

  // 3. Return the (unclassified) error as-is
  return mapped;
}
