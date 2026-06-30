import { Text, Box } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import { renderInputOnlyDetailedToolOutput } from '@/components/tools/InputOnlyDetailedToolOutput';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import { ToolResultContent } from '@/hooks/types';
import { getI18n } from '@/i18n';
import { truncateFilePath } from '@/utils/truncate';

// eslint-disable-next-line industry/constants-file-organization
export const ReadTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    const filePath = input.file_path as string | undefined;
    const parseNumber = (value: unknown): number | undefined => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      return undefined;
    };

    const offset = parseNumber(input.offset);
    const limit = parseNumber(input.limit);

    const segments: string[] = [];

    if (filePath) {
      segments.push(truncateFilePath(filePath));
    }

    const suffixParts: string[] = [];
    if (offset !== undefined) {
      suffixParts.push(`offset: ${offset}`);
    }
    if (limit !== undefined) {
      suffixParts.push(`limit: ${limit}`);
    }

    if (suffixParts.length > 0) {
      segments.push(`${suffixParts.join(', ')}`);
    }

    if (segments.length === 0) return '';
    const label = segments.join(', ');
    return label;
  },

  getHeaderSuffix(_result: ToolResultContent, _isError: boolean) {
    return undefined;
  },

  renderDetailedView({ result, isError }: ToolComponentProps) {
    return renderInputOnlyDetailedToolOutput({ result, isError });
  },

  renderResult({ input: _input, result, isError }: ToolComponentProps) {
    if (isError) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.error}>{String(result)}</Text>
        </Box>
      );
    }

    if (Array.isArray(result)) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>
            {'↳ '}
            {getI18n().t('common:toolDisplay.read.imageSuccess')}
          </Text>
        </Box>
      );
    }

    const resultText = String(result ?? '');
    if (!resultText || resultText.trim() === '') {
      return null;
    }

    const lines = resultText.split('\n').length;

    return (
      <Box flexDirection="column">
        <Text color={COLORS.text.muted}>
          {'↳ '}
          {getI18n().t('common:toolDisplay.read.readLines', {
            count: lines,
            suffix: lines !== 1 ? 's' : '',
          })}
        </Text>
      </Box>
    );
  },

  getSummaryLine(
    input: Record<string, unknown>,
    result: ToolResultContent,
    isError: boolean
  ): string {
    if (isError) {
      const errorStr = String(result);
      if (
        errorStr.includes('cancelled by user') ||
        errorStr.includes('interrupted by user')
      ) {
        return getI18n().t('common:toolDisplay.cancelledByUser');
      }
      return errorStr;
    }

    // Handle image results
    if (Array.isArray(result)) {
      // Extract filename from the first text block if available
      const textBlock = result.find((block) => block.type === 'text');
      if (textBlock && 'text' in textBlock) {
        // Try to extract filename from text like "Image file: photo.jpg (1.0 KB)"
        const match = textBlock.text.match(/Image file: ([^\s]+)/);
        if (match) {
          return getI18n().t('common:toolDisplay.read.summaryImageFile', {
            filename: match[1],
          });
        }
      }
      return 'Image file read successfully';
    }

    // Handle text results
    // Check if output was truncated - now includes line count information
    const truncatedMatch = result.match(
      /\[Truncated\. Showing first \d+k characters out of (\d+) \((\d+) lines out of (\d+)\)\]/
    );
    if (truncatedMatch) {
      const totalLines = parseInt(truncatedMatch[3], 10);
      return getI18n().t('common:toolDisplay.read.summaryTruncated', {
        count: totalLines,
      });
    }

    // For backward compatibility, check old truncation format
    const oldTruncatedMatch = result.match(
      /\[Truncated\. Showing first \d+k characters out of (\d+)\]/
    );
    if (oldTruncatedMatch) {
      return getI18n().t('common:toolDisplay.read.oldTruncated', {
        size: oldTruncatedMatch[1],
      });
    }

    const lines = result.split('\n').length;
    return getI18n().t('common:toolDisplay.read.summaryLines', {
      count: lines,
    });
  },
};
