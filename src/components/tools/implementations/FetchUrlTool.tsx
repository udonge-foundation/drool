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

// eslint-disable-next-line industry/constants-file-organization
export const FetchUrlTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    const url = input.url as string;
    if (!url) return '';
    return `"${url}"`;
  },

  renderDetailedView({ result, isError }: ToolComponentProps) {
    return renderInputOnlyDetailedToolOutput({
      result,
      isError,
      errorPrefix: getI18n().t('common:toolDisplay.fetchUrl.failedToFetch'),
    });
  },

  getHeaderSuffix(result: ToolResultContent, isError: boolean) {
    if (isError || !result) return undefined;
    const resultText = getTextContent(result);
    if (!resultText) return undefined;
    const lines = resultText.split('\n').filter((l: string) => l.trim());
    if (lines.length <= MAX_PREVIEW_LINES) return undefined;
    return getI18n().t('common:toolDisplay.ctrlOToViewAll');
  },

  renderResult({ result, isError }: ToolComponentProps) {
    if (isError) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.error}>
            {getI18n().t('common:toolDisplay.fetchUrl.failedToFetch')}{' '}
            {getTextContent(result)}
          </Text>
        </Box>
      );
    }

    const resultText = getTextContent(result);
    if (!resultText || resultText.trim() === '') {
      return null;
    }

    // Show preview lines
    const allLines = resultText.split('\n');
    const previewLines = allLines.slice(-MAX_PREVIEW_LINES);

    return (
      <Box flexDirection="column">
        {previewLines.map((line, idx) => (
          <Text
            key={generateStableKey(line, idx, 'fetch-preview')}
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

    const url = input.url as string;

    // Parse title from result
    let title = null;
    try {
      const titleMatch = result?.match(/Title: ([^\n]+)/);
      if (titleMatch) {
        title = titleMatch[1];
      }
    } catch {
      // Ignore parsing errors
    }

    if (title && title !== url) {
      return getI18n().t('common:toolDisplay.fetchUrl.summaryFetchedTitle', {
        title,
        url,
      });
    }

    return getI18n().t('common:toolDisplay.fetchUrl.summaryFetched', { url });
  },
};
