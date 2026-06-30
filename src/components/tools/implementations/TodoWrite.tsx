import { Text, Box } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import { getI18n } from '@/i18n';
import { formatTodoSummary, parseTodosInput } from '@/utils/todo-utils';
import { getTextContent } from '@/utils/tool-result-helpers';

import type { TodoWriteToolInput } from '@industry/drool-core/tools/definitions/todo';

// eslint-disable-next-line industry/constants-file-organization
export const TodoWriteTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    const todos = parseTodosInput(input as TodoWriteToolInput);
    if (todos.length === 0) {
      return '';
    }
    return ` ${getI18n().t('common:toolDisplay.todoWrite.headerUpdated', { summary: formatTodoSummary({ todos }) })}`;
  },

  renderResult({ result, isError }: ToolComponentProps) {
    if (isError) {
      const displayText = getTextContent(result) ?? '';
      return (
        <Box flexDirection="column">
          <Text color={COLORS.error}>{displayText}</Text>
        </Box>
      );
    }

    // Success: we purposely hide the verbose internal system note.
    // The concise header already shows the summary and the TodoDisplay
    // panel renders the updated list, so we don't need anything else here.
    return null;
  },

  getSummaryLine(
    input: Record<string, unknown>,
    result: string,
    isError: boolean
  ): string {
    if (isError) {
      return result;
    }

    const todos = parseTodosInput(input as TodoWriteToolInput);
    return getI18n().t('common:toolDisplay.todoWrite.summaryUpdated', {
      summary: formatTodoSummary({ todos }),
    });
  },
};
