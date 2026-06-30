/** Cross-provider tool identifier helpers. */

import { createHash } from 'crypto';

import { PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH } from './constants';

/** Sanitize `id` to Anthropic's `^[a-zA-Z0-9_-]+$`; deterministic. */
export function sanitizeToolCallId(id: string | undefined): string {
  if (!id) return '';
  return id.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
}

const HASH_LENGTH = 8;
const SEPARATOR = '_';
const INVALID_TOOL_NAME_CHAR_PATTERN = /[^a-zA-Z0-9_-]/g;

/**
 * Sanitizes a tool name for LLM provider wire formats.
 *
 * MCP tool llmIds use `serverName___toolName` and may contain dots, spaces,
 * slashes, unicode, or exceed provider-specific length limits. Sanitization
 * replaces disallowed characters with `_`, then deterministically truncates
 * long names with a `prefix_hash8` suffix for uniqueness.
 */
export function sanitizeToolNameForProvider(
  name: string,
  maxLength = PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH
): string {
  const charSanitized = name.replace(INVALID_TOOL_NAME_CHAR_PATTERN, SEPARATOR);

  if (charSanitized.length <= maxLength) {
    return charSanitized;
  }

  const hash = createHash('sha256')
    .update(charSanitized)
    .digest('hex')
    .slice(0, HASH_LENGTH);

  const prefixLength = maxLength - HASH_LENGTH - SEPARATOR.length;
  const prefix = charSanitized.slice(0, prefixLength);

  return `${prefix}${SEPARATOR}${hash}`;
}

/**
 * Stateful mapper from arbitrary tool-call ids to OpenAI `call_…` ids,
 * deterministic within a single conversion pass. Ids already starting
 * with `call_` pass through unchanged.
 */
export function createCallIdTranslator(): (id: string) => string {
  const callIdMap = new Map<string, string>();
  let syntheticCallCounter = 0;

  return function toOpenAICallId(id: string): string {
    if (id.startsWith('call_')) return id;
    let mapped = callIdMap.get(id);
    if (!mapped) {
      mapped = `call_${id.replace(/^toolu_/, '').slice(0, 24)}_${syntheticCallCounter++}`;
      callIdMap.set(id, mapped);
    }
    return mapped;
  };
}
