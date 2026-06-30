import { InvalidArgumentError } from 'commander';

import {
  SessionTag,
  SessionTagSchema,
} from '@industry/drool-sdk-ext/protocol/session';

/**
 * Parses a single --tag flag value into a SessionTag.
 *
 * Supports two forms:
 * - Plain string: "code-review" -> { name: "code-review" }
 * - JSON object: '{"name":"code-review","metadata":{"prUrl":"..."}}' -> parsed and validated
 *
 * Throws Commander's InvalidArgumentError so callers using this as a
 * Commander argParser get nicely formatted errors; outside of an argParser
 * it still behaves as a regular Error subclass.
 */
function parseTagFlag(value: string): SessionTag {
  const trimmed = value.trim();

  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new InvalidArgumentError(
        'Invalid JSON in --tag flag. JSON requires double quotes, e.g. \'{"name":"my-tag"}\''
      );
    }
    const result = SessionTagSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.message).join(', ');
      // eslint-disable-next-line industry/structured-logging -- Must use InvalidArgumentError for Commander error display
      throw new InvalidArgumentError(`Invalid tag: ${issues}`);
    }
    return result.data;
  }

  if (!trimmed) {
    throw new InvalidArgumentError('Tag name cannot be empty');
  }

  return { name: trimmed };
}

/**
 * Collects repeated --tag flag values into a SessionTag array.
 */
export function collectTags(
  value: string,
  previous: SessionTag[] = []
): SessionTag[] {
  return [...previous, parseTagFlag(value)];
}
