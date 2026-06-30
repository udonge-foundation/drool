import { Text, Box } from 'ink';

import {
  NO_MATCHES_FOUND,
  NO_MATCHING_FILES_FOUND,
} from '@industry/drool-sdk-ext/protocol/tools';

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
export const GrepTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    const pattern = input.pattern as string;
    const folder = (input.path ?? input.folder) as string;
    const globPattern = input.glob_pattern as string;
    const type = input.type as string;
    const outputMode = input.output_mode as string;
    const caseInsensitive = input.case_insensitive as boolean;

    const parts: string[] = [];

    if (pattern) {
      const patternDisplay =
        pattern.length > 30 ? `${pattern.substring(0, 30)}...` : pattern;
      parts.push(`"${patternDisplay}"`);
    }

    if (folder) {
      const folderDisplay = truncateFilePath(folder);
      parts.push(`in ${folderDisplay || 'current directory'}`);
    }

    if (globPattern) parts.push(`glob: ${globPattern}`);
    if (type) parts.push(`type: ${type}`);
    if (outputMode === 'content') {
      parts.push('content mode');
    }
    if (caseInsensitive) {
      parts.push('case-insensitive');
    }
    if (input.context) parts.push(`context ${input.context}`);
    if (input.context_before)
      parts.push(`context-before ${input.context_before}`);
    if (input.context_after) parts.push(`context-after ${input.context_after}`);

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
    if (
      !resultText ||
      resultText.includes(NO_MATCHES_FOUND) ||
      resultText.includes(NO_MATCHING_FILES_FOUND)
    )
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
              {getI18n().t('common:toolDisplay.grep.ripgrepMissing')}{' '}
              {downloadCommand}
            </Text>
          </Box>
        );
      }

      return (
        <Box flexDirection="column">
          <Text color={COLORS.error}>
            {getI18n().t('common:toolDisplay.grep.failedToSearch')}
          </Text>
        </Box>
      );
    }

    const resultText = getTextContent(result);
    if (!resultText || resultText.trim() === '') {
      return null;
    }

    if (
      resultText.includes(NO_MATCHES_FOUND) ||
      resultText.includes(NO_MATCHING_FILES_FOUND)
    ) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>
            {'↳ '}
            {getI18n().t('common:toolDisplay.grep.foundMatches', { count: 0 })}
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
            key={generateStableKey(line, idx, 'grep-preview')}
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

    const lines = getTextContent(result)
      .split('\n')
      .filter((line: string) => line.trim()).length;
    const pattern = input.pattern as string;
    return getI18n().t('common:toolDisplay.grep.summaryRead', {
      count: lines,
      suffix: lines !== 1 ? 's' : '',
      pattern,
    });
  },
};
