/**
 * Optimistic JSON parser that can extract partial data from incomplete JSON strings
 * during streaming scenarios.
 */

import type { OptimisticParseResult } from './types';

interface OptimisticJsonParserOptions {
  includeIncompleteStringValueKeys?: readonly string[];
}

interface KeyValuePair {
  key?: string;
  value: unknown;
  isValueComplete: boolean;
}

/**
 * Parse a JSON key (quoted string)
 */
function parseKey(
  content: string,
  startPos: number
): { key?: string; endPos: number } {
  if (content[startPos] !== '"') {
    return { endPos: startPos };
  }

  let pos = startPos + 1;
  let key = '';

  while (pos < content.length && content[pos] !== '"') {
    if (content[pos] === '\\' && pos + 1 < content.length) {
      // Handle escaped characters
      pos++;
      const escaped = content[pos];
      switch (escaped) {
        case 'n':
          key += '\n';
          break;
        case 't':
          key += '\t';
          break;
        case 'r':
          key += '\r';
          break;
        case '\\':
          key += '\\';
          break;
        case '"':
          key += '"';
          break;
        default:
          key += escaped;
          break;
      }
    } else {
      key += content[pos];
    }
    pos++;
  }

  if (pos < content.length && content[pos] === '"') {
    return { key, endPos: pos + 1 };
  }

  // Unterminated string - return what we have
  return { key, endPos: pos };
}

function parseStringValue(
  content: string,
  startPos: number
): { value: unknown; isComplete: boolean; endPos: number } {
  if (content[startPos] !== '"') {
    return { value: undefined, isComplete: false, endPos: startPos };
  }

  let pos = startPos + 1;
  let value = '';

  while (pos < content.length && content[pos] !== '"') {
    if (content[pos] === '\\' && pos + 1 < content.length) {
      pos++;
      const escaped = content[pos];
      switch (escaped) {
        case 'n':
          value += '\n';
          break;
        case 't':
          value += '\t';
          break;
        case 'r':
          value += '\r';
          break;
        case '\\':
          value += '\\';
          break;
        case '"':
          value += '"';
          break;
        default:
          value += escaped;
          break;
      }
    } else {
      value += content[pos];
    }
    pos++;
  }

  const isComplete = pos < content.length && content[pos] === '"';
  const endPos = isComplete ? pos + 1 : pos;

  return { value, isComplete, endPos };
}

function parseNumberValue(
  content: string,
  startPos: number
): { value: unknown; isComplete: boolean; endPos: number } {
  let pos = startPos;
  let numberStr = '';

  // Handle negative sign
  if (content[pos] === '-') {
    numberStr += content[pos];
    pos++;
  }

  // Parse digits
  while (pos < content.length && /[\d.]/.test(content[pos])) {
    numberStr += content[pos];
    pos++;
  }

  // Check if we have a valid number
  const value = parseFloat(numberStr);
  const isComplete = !Number.isNaN(value) && numberStr.length > 0;

  return { value: isComplete ? value : undefined, isComplete, endPos: pos };
}

function parseBooleanValue(
  content: string,
  startPos: number
): { value: unknown; isComplete: boolean; endPos: number } {
  const remaining = content.slice(startPos);

  if (remaining.startsWith('true')) {
    return { value: true, isComplete: true, endPos: startPos + 4 };
  }
  if (remaining.startsWith('false')) {
    return { value: false, isComplete: true, endPos: startPos + 5 };
  }

  // Partial match
  if ('true'.startsWith(remaining) || 'false'.startsWith(remaining)) {
    return { value: undefined, isComplete: false, endPos: content.length };
  }

  return { value: undefined, isComplete: false, endPos: startPos + 1 };
}

function parseNullValue(
  content: string,
  startPos: number
): { value: unknown; isComplete: boolean; endPos: number } {
  const remaining = content.slice(startPos);

  if (remaining.startsWith('null')) {
    return { value: null, isComplete: true, endPos: startPos + 4 };
  }

  // Partial match
  if ('null'.startsWith(remaining)) {
    return { value: undefined, isComplete: false, endPos: content.length };
  }

  return { value: undefined, isComplete: false, endPos: startPos + 1 };
}

function parseArrayValue(
  content: string,
  startPos: number
): { value: unknown; isComplete: boolean; endPos: number } {
  // For simplicity, we'll just return an empty array for now
  // A full implementation would recursively parse array elements
  const pos = startPos + 1;

  // Find matching closing bracket (basic implementation)
  let depth = 1;
  let currentPos = pos;

  while (currentPos < content.length && depth > 0) {
    if (content[currentPos] === '[') depth++;
    else if (content[currentPos] === ']') depth--;
    currentPos++;
  }

  const isComplete = depth === 0;
  return { value: [], isComplete, endPos: currentPos };
}

function parseObjectValue(
  content: string,
  startPos: number
): { value: unknown; isComplete: boolean; endPos: number } {
  // For simplicity, we'll just return an empty object for now
  // A full implementation would recursively parse object properties
  const pos = startPos + 1;

  // Find matching closing brace (basic implementation)
  let depth = 1;
  let currentPos = pos;

  while (currentPos < content.length && depth > 0) {
    if (content[currentPos] === '{') depth++;
    else if (content[currentPos] === '}') depth--;
    currentPos++;
  }

  const isComplete = depth === 0;
  return { value: {}, isComplete, endPos: currentPos };
}

/**
 * Parse a JSON value (string, number, boolean, null, array, object)
 */
function parseValue(
  content: string,
  startPos: number
): { value: unknown; isComplete: boolean; endPos: number } {
  const char = content[startPos];

  switch (char) {
    case '"':
      return parseStringValue(content, startPos);
    case 't':
    case 'f':
      return parseBooleanValue(content, startPos);
    case 'n':
      return parseNullValue(content, startPos);
    case '[':
      return parseArrayValue(content, startPos);
    case '{':
      return parseObjectValue(content, startPos);
    default:
      if (char === '-' || /\d/.test(char)) {
        return parseNumberValue(content, startPos);
      }
      // Unknown character - skip it
      return { value: undefined, isComplete: false, endPos: startPos + 1 };
  }
}

/**
 * Extract key-value pairs from the JSON content, handling partial values
 */
function extractKeyValuePairs(content: string): KeyValuePair[] {
  const pairs: KeyValuePair[] = [];
  let pos = 0;

  while (pos < content.length) {
    // Skip whitespace
    while (pos < content.length && /\s/.test(content[pos])) {
      pos++;
    }

    if (pos >= content.length) break;

    // Parse key
    const keyResult = parseKey(content, pos);
    if (!keyResult.key) break;

    pos = keyResult.endPos;

    // Skip whitespace and colon
    while (
      pos < content.length &&
      (/\s/.test(content[pos]) || content[pos] === ':')
    ) {
      pos++;
    }

    if (pos >= content.length) {
      // Key exists but no value yet
      pairs.push({
        key: keyResult.key,
        value: undefined,
        isValueComplete: false,
      });
      break;
    }

    // Parse value
    const valueResult = parseValue(content, pos);
    pairs.push({
      key: keyResult.key,
      value: valueResult.value,
      isValueComplete: valueResult.isComplete,
    });

    pos = valueResult.endPos;

    // Skip whitespace and comma
    while (
      pos < content.length &&
      (/\s/.test(content[pos]) || content[pos] === ',')
    ) {
      pos++;
    }
  }

  return pairs;
}

/**
 * Internal function to extract partial JSON data from incomplete strings
 */
function parsePartialJson(
  jsonString: string,
  options: OptimisticJsonParserOptions = {}
): OptimisticParseResult {
  const result: Record<string, unknown> = {};
  let isComplete = false;
  const includeIncompleteStringValueKeys = new Set(
    options.includeIncompleteStringValueKeys ?? []
  );

  // Remove leading/trailing whitespace
  const trimmed = jsonString.trim();

  // Must start with opening brace
  if (!trimmed.startsWith('{')) {
    return { data: {}, isComplete: false, error: 'JSON must start with {' };
  }

  // Check if it ends with closing brace (complete)
  if (trimmed.endsWith('}')) {
    isComplete = true;
  }

  // Extract the content between braces
  const content = trimmed.slice(1, isComplete ? -1 : undefined).trim();

  if (!content) {
    return { data: {}, isComplete };
  }

  // Parse key-value pairs
  const pairs = extractKeyValuePairs(content);

  for (const pair of pairs) {
    const { key, value, isValueComplete } = pair;
    if (key && isValueComplete) {
      result[key] = value;
    } else if (
      key &&
      includeIncompleteStringValueKeys.has(key) &&
      typeof value === 'string' &&
      value.length > 0
    ) {
      result[key] = value;
    }
  }

  return { data: result, isComplete };
}

/**
 * Attempts to parse JSON optimistically, extracting what it can from incomplete JSON.
 *
 * Examples:
 * - '{"name": "John"' → { data: { name: "John" }, isComplete: false }
 * - '{"name": "John", "age":' → { data: { name: "John" }, isComplete: false }
 * - '{"name": "John", "age": 30}' → { data: { name: "John", age: 30 }, isComplete: true }
 */
export function parseOptimisticJson(
  jsonString: string,
  options: OptimisticJsonParserOptions = {}
): OptimisticParseResult {
  if (!jsonString.trim()) {
    return { data: {}, isComplete: false };
  }

  // First, try normal JSON parsing - if it works, we're done.
  // Hot path: called on every streamed tool-args chunk. Expected-case failures
  // (incomplete JSON during streaming) must not log.
  try {
    const data = JSON.parse(jsonString);
    return { data: data || {}, isComplete: true };
    // eslint-disable-next-line industry/require-catch-handling
  } catch {
    // Normal parsing failed, try optimistic parsing below.
  }

  try {
    return parsePartialJson(jsonString, options);
    // eslint-disable-next-line industry/require-catch-handling
  } catch (error) {
    return {
      data: {},
      isComplete: false,
      error: error instanceof Error ? error.message : 'Unknown parsing error',
    };
  }
}
