import type {
  TodoItem,
  TodoWriteToolInput,
  TodoWriteToolParams,
} from '@industry/drool-core/tools/definitions/todo';

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

/**
 * Parses todo input from either string format or array format
 * @param input - Raw input that may be string or array
 * @returns Array of TodoItem objects
 */
function coerceTodoItem(raw: unknown, index: number): TodoItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;

  const content =
    typeof item.content === 'string' && item.content.trim().length > 0
      ? item.content
      : null;
  if (!content) return null;

  const id =
    typeof item.id === 'string' && item.id.length > 0
      ? item.id
      : String(index + 1);

  const rawStatus =
    typeof item.status === 'string' ? item.status.toLowerCase() : '';
  const status: TodoItem['status'] =
    rawStatus === 'in_progress' || rawStatus === 'completed'
      ? rawStatus
      : 'pending';

  const rawPriority =
    typeof item.priority === 'string' ? item.priority.toLowerCase() : '';
  const priority: TodoItem['priority'] =
    rawPriority === 'low' || rawPriority === 'high' ? rawPriority : 'medium';

  return { id, content, status, priority };
}

function coerceTodoItemArray(items: unknown[]): TodoItem[] {
  const result: TodoItem[] = [];
  items.forEach((item, index) => {
    const coerced = coerceTodoItem(item, index);
    if (coerced) result.push(coerced);
  });
  return result;
}

export function parseTodosInput(input: TodoWriteToolInput): TodoItem[] {
  const { todos } = input;

  if (Array.isArray(todos)) {
    // Check if it's an array of strings (malformed LLM output) vs array of TodoItems
    if (todos.length > 0 && typeof todos[0] === 'string') {
      return parseStringFormat(todos.join('\n'));
    }
    return coerceTodoItemArray(todos);
  }

  if (typeof todos !== 'string') {
    return [];
  }

  const str = todos.trim();

  // Try JSON array first
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        // Check if it's array of strings (malformed) vs array of objects (old format)
        if (parsed.length > 0 && typeof parsed[0] === 'string') {
          return parseStringFormat(parsed.join('\n'));
        }
        return coerceTodoItemArray(parsed);
      }
    } catch {
      // Not valid JSON, fall through to string format
    }
  }

  // Parse new string format
  return parseStringFormat(str);
}

/**
 * Formats TODO list into a concise summary string
 * @param todos - TodoWriteToolParams containing the todo items
 * @returns Formatted summary string like "3 total (2 pending, 1 in progress, 0 completed)"
 */
export function formatTodoSummary(todos: TodoWriteToolParams): string {
  const { todos: todoItems } = todos;

  const items = Array.isArray(todoItems) ? todoItems : [];

  const pending = items.filter((t) => t.status === 'pending').length;
  const inProgress = items.filter((t) => t.status === 'in_progress').length;
  const completed = items.filter((t) => t.status === 'completed').length;

  return `${items.length} total (${pending} pending, ${inProgress} in progress, ${completed} completed)`;
}
