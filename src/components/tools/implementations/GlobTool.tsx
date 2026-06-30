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
import { truncateFilePath } from '@/utils/truncate';

const MAX_PREVIEW_LINES = 8;

// eslint-disable-next-line industry/constants-file-organization
export const GlobTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    const patterns = Array.isArray(input.patterns) ? input.patterns : [];
    const excludePatterns = Array.isArray(input.excludePatterns)
      ? input.excludePatterns
      : [];
    const folder = input.folder as string;

    const parts: string[] = [];

    if (patterns.length > 0) {
      const patternDisplay =
        patterns.length > 3
          ? `${patterns.slice(0, 3).join(', ')}... (+${patterns.length - 3} more)`
          : patterns.join(', ');
      parts.push(patternDisplay);
    }

    if (folder) {
      const folderDisplay = truncateFilePath(folder);
      parts.push(`in ${folderDisplay || 'current directory'}`);
    }

    if (excludePatterns.length > 0) {
      const excludeDisplay =
        excludePatterns.length > 2
          ? `excluding ${excludePatterns.slice(0, 2).join(', ')}... (+${excludePatterns.length - 2} more)`
          : `excluding ${excludePatterns.join(', ')}`;
      parts.push(excludeDisplay);
    }

    if (parts.length === 0) return '';
    const label = parts.join(', ');
    return label;
  },

  renderDetailedView({ result, isError }: ToolComponentProps) {
    return renderInputOnlyDetailedToolOutput({ result, isError });
  },

  getHeaderSuffix(result: ToolResultContent, isError: boolean) {
    if (isError || !result) return undefined;
    const resultText = getTextContent(result);
    if (!resultText || resultText.includes('No matching files found'))
      return undefined;
    const lines = resultText.split('\n').filter((l: string) => l.trim());
    if (lines.length <= MAX_PREVIEW_LINES) return undefined;
    return getI18n().t('common:toolDisplay.ctrlOToViewAll');
  },

  renderResult({ input: _input, result, isError }: ToolComponentProps) {
    if (isError) {
      const resultText = getTextContent(result);

      if (resultText.includes('Ripgrep binary not found')) {
        const downloadCommand =
          process.platform === 'win32'
            ? 'irm https://app.example.com/cli/windows | iex'
            : 'curl -fsSL https://app.example.com/cli | sh';

        return (
          <Box flexDirection="column">
            <Text color={COLORS.error}>
              {getI18n().t('common:toolDisplay.glob.ripgrepMissing')}{' '}
              {downloadCommand}
            </Text>
          </Box>
        );
      }

      return (
        <Box flexDirection="column">
          <Text color={COLORS.error}>
            {getI18n().t('common:toolDisplay.glob.failedToSearch')}
          </Text>
        </Box>
      );
    }

    const resultText = getTextContent(result);
    if (!resultText || resultText.trim() === '') {
      return null;
    }

    if (resultText.includes('No matching files found')) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>
            {'↳ '}
            {getI18n().t('common:toolDisplay.glob.foundFiles', { count: 0 })}
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
            key={generateStableKey(line, idx, 'glob-preview')}
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
        typeof result === 'string' &&
        (result.includes('cancelled by user') ||
          result.includes('interrupted by user'))
      ) {
        return getI18n().t('common:toolDisplay.cancelledByUser');
      }

      // Provide a cleaner summary for ripgrep errors
      if (
        typeof result === 'string' &&
        (result.includes('Ripgrep binary not found') ||
          result.includes('Ripgrep is required but not found'))
      ) {
        return getI18n().t('common:toolDisplay.glob.summaryRipgrepMissing');
      }

      return typeof result === 'string'
        ? result
        : getI18n().t('common:toolDisplay.glob.summaryError');
    }

    if (typeof result !== 'string') {
      return getI18n().t('common:toolDisplay.glob.foundFilesMatchingPattern');
    }

    const files = getTextContent(result)
      .split('\n')
      .filter((line: string) => line.trim()).length;
    const patterns = Array.isArray(input.patterns) ? input.patterns : [];
    const pattern = patterns.length > 0 ? patterns[0] : 'pattern';
    return getI18n().t('common:toolDisplay.glob.summaryFound', {
      count: files,
      suffix: files !== 1 ? 's' : '',
      pattern,
    });
  },
};
