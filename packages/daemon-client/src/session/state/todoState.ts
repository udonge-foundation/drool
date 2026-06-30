import { MessageContentBlockType } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logWarn } from '@industry/logging';

import type { SessionTodoItem, SessionTodoList } from './types';
import type {
  IndustryDroolMessage,
  ToolUseBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

const TODO_WRITE_TOOL_NAME = 'TodoWrite';

interface AcceptedTodoItem {
  content: string;
  status: SessionTodoItem['status'];
  id?: unknown;
  priority?: unknown;
}

// Mirrors the acceptance rules of the canonical TodoWrite parser in
// @industry/drool-core (only content and a valid status are required);
// daemon-client cannot depend on drool-core, so the rules are duplicated
// here. Diverging would leave currentTodos stale for shapes the transcript
// fallback still accepts.
function isAcceptedTodoItem(item: unknown): item is AcceptedTodoItem {
  if (!item || typeof item !== 'object') return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.content === 'string' &&
    (obj.status === 'pending' ||
      obj.status === 'in_progress' ||
      obj.status === 'completed')
  );
}

function normalizeTodoItems(items: unknown[]): SessionTodoItem[] {
  return items.filter(isAcceptedTodoItem).map((item, index) => ({
    id: typeof item.id === 'string' ? item.id : String(index + 1),
    content: item.content,
    status: item.status,
    priority:
      item.priority === 'high' ||
      item.priority === 'medium' ||
      item.priority === 'low'
        ? item.priority
        : 'high',
  }));
}

function parseTodoString(input: string): SessionTodoItem[] {
  const lines = input
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0);

  return lines.map((line, index) => {
    const trimmed = line.trim();
    const statusMatch = trimmed.match(
      /^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[(completed|in_progress|pending)\]\s*(.*)$/
    );
    if (statusMatch) {
      return {
        id: String(index + 1),
        status: statusMatch[1] as SessionTodoItem['status'],
        content: statusMatch[2].trim() || '(no description)',
        priority: 'high',
      };
    }

    const checkedMatch = trimmed.match(
      /^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[[xX]\]\s*(.*)$/
    );
    if (checkedMatch) {
      return {
        id: String(index + 1),
        status: 'completed',
        content: checkedMatch[1].trim() || '(no description)',
        priority: 'high',
      };
    }

    const uncheckedMatch = trimmed.match(
      /^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[\s*\]\s*(.*)$/
    );
    if (uncheckedMatch) {
      return {
        id: String(index + 1),
        status: 'pending',
        content: uncheckedMatch[1].trim() || '(no description)',
        priority: 'high',
      };
    }

    const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    return {
      id: String(index + 1),
      status: 'pending',
      content: (numberedMatch?.[1] ?? bulletMatch?.[1] ?? trimmed).trim(),
      priority: 'high',
    };
  });
}

function parseTodos(todosParam: unknown): SessionTodoItem[] {
  if (Array.isArray(todosParam)) {
    if (todosParam.length > 0 && typeof todosParam[0] === 'string') {
      return parseTodoString(todosParam.join('\n'));
    }
    return normalizeTodoItems(todosParam);
  }

  if (typeof todosParam !== 'string') {
    return [];
  }

  const trimmed = todosParam.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        if (parsed.length > 0 && typeof parsed[0] === 'string') {
          return parseTodoString(parsed.join('\n'));
        }
        return normalizeTodoItems(parsed);
      }
    } catch (error) {
      logWarn('Failed to parse TodoWrite todos as JSON', { cause: error });
      return parseTodoString(trimmed);
    }
  }

  return parseTodoString(trimmed);
}

/**
 * Returns true when a tool-use block is a TodoWrite call.
 */
export function isTodoWriteToolUse(toolUse: ToolUseBlock): boolean {
  return toolUse.name === TODO_WRITE_TOOL_NAME;
}

/**
 * Parses a TodoWrite tool use into daemon session Todo state.
 */
export function getTodoListFromToolUse(
  toolUse: ToolUseBlock
): SessionTodoList | null {
  if (toolUse.name !== TODO_WRITE_TOOL_NAME) {
    return null;
  }

  if (
    typeof toolUse.input !== 'object' ||
    toolUse.input === null ||
    !('todos' in toolUse.input)
  ) {
    return null;
  }

  const todos = parseTodos(toolUse.input.todos);
  return todos.length > 0 ? { todos } : null;
}

/**
 * Finds the tool use producing the latest successful TodoWrite state in
 * session history (falling back to the latest non-failed TodoWrite without
 * a result yet).
 */
export function getLatestTodoWriteToolUse(
  messages: IndustryDroolMessage[]
): ToolUseBlock | null {
  const successfulToolResultIds = new Set<string>();
  const failedToolResultIds = new Set<string>();
  let latestTodoWriteWithoutResult: ToolUseBlock | undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];

    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j];

      if (block.type === MessageContentBlockType.ToolResult) {
        if (!block.isError) {
          successfulToolResultIds.add(block.toolUseId);
        } else {
          failedToolResultIds.add(block.toolUseId);
        }
        continue;
      }

      if (block.type !== MessageContentBlockType.ToolUse) {
        continue;
      }

      const todoList = getTodoListFromToolUse(block);
      if (!todoList) {
        continue;
      }

      if (!failedToolResultIds.has(block.id)) {
        latestTodoWriteWithoutResult ??= block;
      }
      if (successfulToolResultIds.has(block.id)) {
        return block;
      }
    }
  }

  return latestTodoWriteWithoutResult ?? null;
}
