import { logWarn } from '@industry/logging';

import { isValidTodoItem, parseStringFormat } from './todo-parsing-utils';

import type { TodoItem } from './schema';

/**
 * Parses various todo input formats into a normalized TodoItem array.
 * Supports:
 * - Array of TodoItem objects (old format)
 * - Array of strings (malformed LLM output)
 * - JSON string of array
 * - Plain text string format (new format)
 */
export function parseTodos(todosParam: unknown): TodoItem[] {
  if (Array.isArray(todosParam)) {
    // Check if it's an array of strings (malformed LLM output) vs array of TodoItems
    if (todosParam.length > 0 && typeof todosParam[0] === 'string') {
      return parseStringFormat(todosParam.join('\n'));
    }
    // Validate that items have required fields
    const validItems = todosParam.filter(isValidTodoItem);
    return validItems;
  }

  if (typeof todosParam === 'string') {
    const str = todosParam.trim();

    // Try JSON array first
    if (str.startsWith('[')) {
      try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed)) {
          // Check if it's array of strings (malformed) vs array of objects (old format)
          if (parsed.length > 0 && typeof parsed[0] === 'string') {
            return parseStringFormat(parsed.join('\n'));
          }
          // Validate items from JSON
          const validItems = parsed.filter(isValidTodoItem);
          return validItems;
        }
      } catch (err) {
        // Not valid JSON, fall through to string format
        logWarn('Failed to parse todo input as JSON', { cause: err });
      }
    }

    // Parse new string format
    return parseStringFormat(str);
  }

  return [];
}
