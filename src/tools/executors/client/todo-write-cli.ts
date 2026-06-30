import { ToolExecutionErrorType } from '@industry/common/session';
import {
  TODO_MAX_ITEMS_LENGTH,
  TODO_ITEM_MAX_CHAR_LENGTH,
} from '@industry/drool-core/tools/definitions/todo';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import { ToolAbortError } from '@industry/logging/errors';

import type {
  CliClientToolDependencies,
  CliClientSpecificToolDependencies,
} from '@/tools/types';

import type {
  TodoItem,
  TodoWriteToolInput,
  TodoWriteToolResult,
} from '@industry/drool-core/tools/definitions/todo';
import type {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';

function parseStringFormat(str: string): TodoItem[] {
  const lines = str
    .trim()
    .split('\n')
    .filter((line) => line.trim());

  if (lines.length === 0) {
    return [];
  }

  return lines.map((line, index) => {
    const trimmed = line.trim();

    // Standard format: "1. [status] content", "[status] content", "1) [status] content",
    // or "- [status] content", "* [status] content" (bullet + bracket-status)
    const standardMatch = trimmed.match(
      /^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[(completed|in_progress|pending)\]\s*(.*)$/
    );
    if (standardMatch) {
      return {
        id: String(index + 1),
        status: standardMatch[1] as 'completed' | 'in_progress' | 'pending',
        content: standardMatch[2].trim() || '(no description)',
        priority: 'high' as const,
      };
    }

    // Markdown checkbox (checked): "- [x] content", "* [X] content", "1. [x] content", "1) [x] content"
    const checkedMatch = trimmed.match(
      /^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[[xX]\]\s*(.*)$/
    );
    if (checkedMatch) {
      return {
        id: String(index + 1),
        status: 'completed' as const,
        content: checkedMatch[1].trim() || '(no description)',
        priority: 'high' as const,
      };
    }

    // Markdown checkbox (unchecked): "- [ ] content", "* [ ] content", "1. [ ] content", "1) [ ] content"
    const uncheckedMatch = trimmed.match(
      /^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[\s*\]\s*(.*)$/
    );
    if (uncheckedMatch) {
      return {
        id: String(index + 1),
        status: 'pending' as const,
        content: uncheckedMatch[1].trim() || '(no description)',
        priority: 'high' as const,
      };
    }

    // Numbered without status: "1. content" or "1) content"
    const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (numberedMatch) {
      return {
        id: String(index + 1),
        status: 'pending' as const,
        content: numberedMatch[1].trim(),
        priority: 'high' as const,
      };
    }

    // Bullet without status: "- content" or "* content"
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      return {
        id: String(index + 1),
        status: 'pending' as const,
        content: bulletMatch[1].trim(),
        priority: 'high' as const,
      };
    }

    // Plain text fallback: treat as pending
    return {
      id: String(index + 1),
      status: 'pending' as const,
      content: trimmed,
      priority: 'high' as const,
    };
  });
}

export function parseTodos(input: string | unknown[]): TodoItem[] {
  if (Array.isArray(input)) {
    // Check if it's an array of strings (malformed LLM output) vs array of TodoItems
    if (input.length > 0 && typeof input[0] === 'string') {
      // Array of strings - join and parse as string format
      return parseStringFormat(input.join('\n'));
    }
    return input as TodoItem[];
  }

  const str = String(input).trim();

  // Try JSON array first
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        // Check if it's array of strings (malformed) vs array of objects (old format)
        if (parsed.length > 0 && typeof parsed[0] === 'string') {
          // Array of strings - join and parse as string format
          return parseStringFormat(parsed.join('\n'));
        }
        // Array of TodoItem objects (old format)
        return parsed as TodoItem[];
      }
    } catch {
      // Not valid JSON, fall through to string format
    }
  }

  return parseStringFormat(str);
}

export class TodoWriteCliExecutor
  implements
    ClientToolExecutor<CliClientSpecificToolDependencies, TodoWriteToolResult>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: TodoWriteToolInput
  ): AsyncGenerator<DraftToolFeedback<TodoWriteToolResult>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    let todos: TodoItem[];
    try {
      todos = parseTodos(parameters.todos);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid format';
      yield this.error(message);
      return;
    }

    // Truncate to max items instead of erroring
    if (todos.length > TODO_MAX_ITEMS_LENGTH) {
      todos = todos.slice(0, TODO_MAX_ITEMS_LENGTH);
    }

    // Filter out non-object entries (e.g. null, numbers, booleans) to avoid runtime crashes
    todos = todos.filter(
      (item): item is TodoItem => !!item && typeof item === 'object'
    );

    for (const [i, todo] of todos.entries()) {
      // Auto-fill empty or non-string content instead of erroring
      if (
        !todo.content ||
        typeof todo.content !== 'string' ||
        !todo.content.trim()
      ) {
        todo.content = '(no description)';
      }

      if (todo.content.length > TODO_ITEM_MAX_CHAR_LENGTH) {
        yield this.error(
          `Todo item ${i + 1}: content cannot exceed ${TODO_ITEM_MAX_CHAR_LENGTH} characters`
        );
        return;
      }

      if (!['pending', 'in_progress', 'completed'].includes(todo.status)) {
        yield this.error(
          `Todo item ${i + 1}: status must be pending, in_progress, or completed`
        );
        return;
      }

      if (todo.priority && !['high', 'medium', 'low'].includes(todo.priority)) {
        yield this.error(
          `Todo item ${i + 1}: priority must be high, medium, or low`
        );
        return;
      }
    }

    // Store normalized todos back in parameters for downstream consumers
    (parameters as { todos: TodoItem[] }).todos = todos;

    yield {
      type: DraftToolFeedbackType.Result,
      isError: false,
      value: 'TODO List Updated',
    };
  }

  private error(llmError: string): DraftToolFeedback<TodoWriteToolResult> {
    return {
      type: DraftToolFeedbackType.Result,
      isError: true,
      errorType: ToolExecutionErrorType.InvalidParameterLLMError,
      llmError,
      userError: 'Invalid TODO parameters',
    };
  }
}
