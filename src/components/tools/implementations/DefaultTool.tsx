import { Text, Box } from 'ink';

import { isMarkdownContent } from '@industry/utils/text';

import { COLORS } from '@/components/chat/themedColors';
import { MarkdownText } from '@/components/MarkdownText';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import { getI18n } from '@/i18n';
import { getTextContent } from '@/utils/tool-result-helpers';

const MAX_PREVIEW_LINES = 4;

function getIndentedContentWidth(contentWidth?: number): number | undefined {
  return contentWidth === undefined ? undefined : Math.max(1, contentWidth - 2);
}

// eslint-disable-next-line industry/constants-file-organization
export const DefaultTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    if (!input || Object.keys(input).length === 0) {
      return '';
    }

    const params: string[] = [];

    const paramOrder = [
      'file_path',
      'directory_path',
      'command',
      'pattern',
      'patterns',
    ];

    const formatParam = (key: string, value: unknown): string => {
      if (typeof value === 'string') {
        const truncated =
          value.length > 50 ? `${value.slice(0, 47)}...` : value;
        return `${key}: "${truncated}"`;
      }
      let formattedValue: string;
      if (typeof value === 'object' && value !== null) {
        const json = JSON.stringify(value);
        formattedValue = json.length > 50 ? `${json.slice(0, 47)}...` : json;
      } else {
        formattedValue = String(value);
      }
      return `${key}: ${formattedValue}`;
    };

    for (const key of paramOrder) {
      if (input[key]) {
        params.push(formatParam(key, input[key]));
      }
    }

    if (params.length === 0) {
      const keys = Object.keys(input).filter(
        (key) => input[key] && key !== 'timeout'
      );
      for (const key of keys.slice(0, 2)) {
        params.push(formatParam(key, input[key]));
      }
    }

    if (params.length === 0) return '';
    const label = params.join(', ');
    return label;
  },

  renderDetailedView({
    input: _input,
    result,
    isError,
    contentWidth,
  }: ToolComponentProps) {
    const resultString = getTextContent(result) || '';
    const maxWidth = getIndentedContentWidth(contentWidth);
    return (
      <Box flexDirection="column">
        {isError ? (
          <Text color={COLORS.error}>{resultString}</Text>
        ) : isMarkdownContent(resultString) ? (
          <Box flexDirection="row">
            <Text>{'↳ '}</Text>
            <MarkdownText maxWidth={maxWidth}>{resultString}</MarkdownText>
          </Box>
        ) : (
          <Text color={COLORS.text.muted}>↳ {resultString}</Text>
        )}
      </Box>
    );
  },

  renderResult({
    input: _input,
    result,
    isError,
    contentWidth,
  }: ToolComponentProps) {
    const resultString = getTextContent(result) || '';
    const maxWidth = getIndentedContentWidth(contentWidth);

    if (isError) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.error}>{resultString}</Text>
        </Box>
      );
    }

    const lines = resultString.split('\n');
    const isTruncated = lines.length > MAX_PREVIEW_LINES;
    const previewText = isTruncated
      ? lines.slice(0, MAX_PREVIEW_LINES).join('\n')
      : resultString;

    return (
      <Box flexDirection="column">
        {isMarkdownContent(previewText) ? (
          <Box flexDirection="row">
            <Text>{'↳ '}</Text>
            <MarkdownText maxWidth={maxWidth}>{previewText}</MarkdownText>
          </Box>
        ) : (
          <Text color={COLORS.text.muted}>↳ {previewText}</Text>
        )}
        {isTruncated && (
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {getI18n().t('common:toolDisplay.moreLines', {
                count: lines.length - MAX_PREVIEW_LINES,
              })}
            </Text>
          </Box>
        )}
      </Box>
    );
  },

  getSummaryLine(
    input: Record<string, unknown>,
    result: string,
    isError: boolean
  ): string {
    if (isError) return result;

    if (result === '') {
      return getI18n().t('common:toolDisplay.default.noResult');
    }

    if (!result) {
      return getI18n().t('common:toolDisplay.default.executed');
    }

    const trimmedResult = result.trim();
    if (trimmedResult === '') {
      return result;
    }

    const firstLine = result.split('\n')[0].trim();
    return firstLine || getI18n().t('common:toolDisplay.default.executed');
  },
};
