import { Text, Box } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import { renderInputOnlyDetailedToolOutput } from '@/components/tools/InputOnlyDetailedToolOutput';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import { ToolResultContent } from '@/hooks/types';
import { getI18n } from '@/i18n';
import { generateStableKey } from '@/utils/generateStableKey';
import { getTextContent } from '@/utils/tool-result-helpers';

const MAX_PREVIEW_LINES = 8;

function getDisplayQuery(input: Record<string, unknown>): string {
  const query = input.query ?? input.objective;
  return typeof query === 'string' ? query : '';
}

// eslint-disable-next-line industry/constants-file-organization
export const WebSearchTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    const query = getDisplayQuery(input);
    if (!query) return '';
    return `"${query}"`;
  },

  renderDetailedView({ result, isError }: ToolComponentProps) {
    return renderInputOnlyDetailedToolOutput({
      result,
      isError,
      errorPrefix: getI18n().t('common:toolDisplay.webSearch.searchFailed'),
    });
  },

  getHeaderSuffix(result: ToolResultContent, isError: boolean) {
    if (isError || !result) return undefined;
    const resultText = getTextContent(result);
    if (!resultText || resultText.includes('No results found'))
      return undefined;
    const lines = resultText.split('\n').filter((l: string) => l.trim());
    if (lines.length <= MAX_PREVIEW_LINES) return undefined;
    return getI18n().t('common:toolDisplay.ctrlOToViewAll');
  },

  renderResult({ input: _input, result, isError }: ToolComponentProps) {
    if (isError) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.error}>
            {getI18n().t('common:toolDisplay.webSearch.searchFailed')}{' '}
            {getTextContent(result)}
          </Text>
        </Box>
      );
    }

    const resultText = getTextContent(result);
    if (!resultText || resultText.trim() === '') {
      return null;
    }

    if (resultText.includes('No results found')) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>
            {'↳ '}
            {getI18n().t('common:toolDisplay.webSearch.foundResults', {
              count: 0,
            })}
          </Text>
        </Box>
      );
    }

    // Show preview lines
    const allLines = resultText.split('\n');
    const previewLines = allLines.slice(-MAX_PREVIEW_LINES);

    return (
      <Box flexDirection="column">
        {previewLines.map((line, idx) => (
          <Text
            key={generateStableKey(line, idx, 'websearch-preview')}
            color={COLORS.text.secondary}
          >
            {line}
          </Text>
        ))}
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
        return getI18n().t('common:toolDisplay.cancelledByUser');
      }
      return result;
    }

    const query = getDisplayQuery(input);

    const countMatch = getTextContent(result).match(/Found (\d+) results?/);
    if (countMatch) {
      const count = parseInt(countMatch[1], 10);
      return getI18n().t('common:toolDisplay.webSearch.summaryFound', {
        count,
        suffix: count !== 1 ? 's' : '',
        query,
      });
    }

    if (result.includes('No results found')) {
      return getI18n().t('common:toolDisplay.webSearch.summaryNoResults', {
        query,
      });
    }

    return getI18n().t('common:toolDisplay.webSearch.summaryCompleted');
  },
};
