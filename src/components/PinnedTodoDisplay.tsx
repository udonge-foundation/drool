import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { TodoItem } from '@/components/TodoItem';
import { parseTodosInput } from '@/utils/todo-utils';

import type { TodoWriteToolInput } from '@industry/drool-core/tools/definitions/todo';

interface PinnedTodoDisplayProps {
  todos: TodoWriteToolInput;
  width: number;
}

export function PinnedTodoDisplay({ todos, width }: PinnedTodoDisplayProps) {
  const { t } = useTranslation();
  // Show all todos (pending, in_progress, and completed)
  const displayTodos = useMemo(() => parseTodosInput(todos), [todos]);

  // Check if all todos are completed
  const allCompleted = useMemo(() => {
    if (displayTodos.length === 0) {
      return true;
    }
    return displayTodos.every((todo) => todo.status === 'completed');
  }, [displayTodos]);

  const completedCount = useMemo(
    () => displayTodos.filter((todo) => todo.status === 'completed').length,
    [displayTodos]
  );

  const MAX_VISIBLE = 6;

  const { visibleTodos, hiddenCount } = useMemo(() => {
    if (displayTodos.length <= MAX_VISIBLE) {
      return { visibleTodos: displayTodos, hiddenCount: 0 };
    }

    // Find the scroll anchor: first in_progress, or first pending
    let anchorIndex = displayTodos.findIndex(
      (todo) => todo.status === 'in_progress'
    );
    if (anchorIndex === -1) {
      anchorIndex = displayTodos.findIndex((todo) => todo.status === 'pending');
    }
    if (anchorIndex === -1) {
      anchorIndex = 0;
    }

    // Place anchor at row 3 of the window
    let start = Math.max(0, anchorIndex - 2);
    start = Math.min(start, displayTodos.length - MAX_VISIBLE);
    start = Math.max(0, start);

    const sliced = displayTodos.slice(start, start + MAX_VISIBLE);
    const hidden = displayTodos.length - (start + MAX_VISIBLE);
    return { visibleTodos: sliced, hiddenCount: Math.max(0, hidden) };
  }, [displayTodos]);

  // Don't render if there are no todos or if all are completed
  if (displayTodos.length === 0 || allCompleted) {
    return null;
  }

  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Box>
        <Text color={COLORS.text.secondary}>
          {t('common:pinnedTodo.plan')} · {completedCount}/{displayTodos.length}
        </Text>
      </Box>
      <Box
        flexDirection="column"
        borderStyle="bold"
        borderLeft
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor={COLORS.text.muted}
        paddingLeft={1}
      >
        {visibleTodos.map((todo) => (
          <TodoItem key={todo.id} todo={todo} />
        ))}
        {hiddenCount > 0 && (
          <Text color={COLORS.text.muted}>
            {t('common:pinnedTodo.moreItemsHint', { count: hiddenCount })}
          </Text>
        )}
      </Box>
    </Box>
  );
}
