import { Text, Box } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import { renderInputOnlyDetailedToolOutput } from '@/components/tools/InputOnlyDetailedToolOutput';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import { ToolResultContent } from '@/hooks/types';
import { getI18n } from '@/i18n';
import { getToolErrorMessage } from '@/utils/error-messages';
import { getTextContent } from '@/utils/tool-result-helpers';
import { truncateFilePath } from '@/utils/truncate';

const MAX_PREVIEW_LINES = 8;

// eslint-disable-next-line industry/constants-file-organization
export const LSTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    const directoryPath = input.directory_path as string;
    const ignorePatterns = Array.isArray(input.ignorePatterns)
      ? input.ignorePatterns
      : [];

    const parts: string[] = [];

    if (directoryPath) {
      const pathDisplay = truncateFilePath(directoryPath);
      parts.push(pathDisplay || 'current directory');
    } else {
      parts.push('current directory');
    }

    if (ignorePatterns.length > 0) {
      const ignoreDisplay =
        ignorePatterns.length > 2
          ? `ignoring ${ignorePatterns.slice(0, 2).join(', ')}... (+${ignorePatterns.length - 2} more)`
          : `ignoring ${ignorePatterns.join(', ')}`;
      parts.push(ignoreDisplay);
    }

    const label = parts.join(', ');
    return label;
  },

  renderDetailedView({ result, isError }: ToolComponentProps) {
    return renderInputOnlyDetailedToolOutput({ result, isError });
  },

  getHeaderSuffix(result: ToolResultContent, isError: boolean) {
    if (isError || !result) return undefined;
    const resultText = getTextContent(result);
    if (!resultText) return undefined;
    const lines = resultText.split('\n').filter((l: string) => l.trim());
    if (lines.length <= MAX_PREVIEW_LINES) return undefined;
    return getI18n().t('common:toolDisplay.ctrlOToViewAll');
  },

  renderResult({ input: _input, result, isError }: ToolComponentProps) {
    if (isError) {
      const errorMessage = getToolErrorMessage('LS', getTextContent(result));
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>↳ {errorMessage}</Text>
        </Box>
      );
    }

    const resultText = getTextContent(result);
    if (!resultText || resultText.trim() === '') {
      return null;
    }

    const lines = resultText
      .split('\n')
      .filter((line: string) => line.trim()).length;

    return (
      <Box flexDirection="column">
        <Text color={COLORS.text.muted}>
          {'↳ '}
          {getI18n().t('common:toolDisplay.ls.listed', { count: lines })}
        </Text>
      </Box>
    );
  },

  getSummaryLine(
    input: Record<string, unknown>,
    result: string,
    isError: boolean
  ): string {
    if (isError) {
      if (
        result.includes('cancelled by user') ||
        result.includes('interrupted by user')
      ) {
        return 'Cancelled by user';
      }
      return result;
    }

    // Check if output was truncated - now includes line count information
    const truncatedMatch = result.match(
      /\[Truncated\. Showing first \d+k characters out of (\d+) \((\d+) lines out of (\d+)\)\]/
    );
    if (truncatedMatch) {
      const totalLines = truncatedMatch[3];
      // For LS, lines roughly equal items (each item is on a line)
      return `${totalLines} items listed (truncated to first 20k characters)`;
    }

    // For backward compatibility, check old truncation format
    const oldTruncatedMatch = result.match(
      /\[Truncated\. Showing first \d+k characters out of (\d+)\]/
    );
    if (oldTruncatedMatch) {
      return `List truncated (showing first 20k characters out of ${oldTruncatedMatch[1]})`;
    }

    const items = getTextContent(result)
      .split('\n')
      .filter((line: string) => line.trim()).length;
    return `${items} items listed`;
  },
};
