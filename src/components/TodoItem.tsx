import { Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import { MC_COLORS } from '@/components/mission-control/constants';

interface TodoItemProps {
  todo: {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    priority?: 'high' | 'medium' | 'low';
    id: string;
  };
}

export function TodoItem({ todo }: TodoItemProps) {
  type Status = 'pending' | 'in_progress' | 'completed';

  const STATUS_COLOR: Record<Status, string | undefined> = {
    pending: COLORS.text.muted,
    in_progress: COLORS.text.primary,
    completed: COLORS.text.muted,
  };

  const isCompleted = todo.status === 'completed';
  const isInProgress = todo.status === 'in_progress';
  const icon = isCompleted ? '✓' : isInProgress ? '●' : '○';

  return (
    <Text color={STATUS_COLOR[todo.status]} strikethrough={isCompleted}>
      <Text color={isCompleted ? MC_COLORS.done : STATUS_COLOR[todo.status]}>
        {icon}
      </Text>
      <Text color={STATUS_COLOR[todo.status]} strikethrough={isCompleted}>
        {' '}
        {todo.content}
      </Text>
    </Text>
  );
}
