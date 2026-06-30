/**
 * Shared helper for parsing JSON API responses with Zod schema validation.
 */

import { MetaError } from '@industry/logging/errors';

import type { z } from 'zod';

/**
 * Parse a raw response text as JSON and validate against a Zod schema.
 *
 * @param text Raw response text
 * @param schema Zod schema to validate against
 * @param context Human-readable context for error messages (e.g. "token response")
 * @returns Validated and typed data
 * @throws MetaError if JSON parsing or schema validation fails
 */
export function parseJsonResponse<T>(
  text: string,
  schema: z.ZodType<T>,
  context: string
): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new MetaError(`Failed to parse ${context}`, {
      body: text,
      cause: err,
    });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new MetaError(`Invalid ${context}`, {
      errorMessage: result.error.message,
      body: json,
    });
  }
  return result.data;
}
