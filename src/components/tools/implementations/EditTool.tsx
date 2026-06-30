import { Text, Box } from 'ink';

import { MAX_DIFF_LINES } from '@/components/chat/constants';
import { COLORS } from '@/components/chat/themedColors';
import { HorizontalLine } from '@/components/common/HorizontalLine';
import { DiffRenderer } from '@/components/DiffRenderer';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import { getI18n } from '@/i18n';
import {
  generateUnifiedDiff,
  getDiffSummary,
  smartTruncateDiff,
} from '@/utils/diff-utils';
import { getToolErrorMessage } from '@/utils/error-messages';
import { parseToolResultForDiff } from '@/utils/parse-diff-result';
import { getTextContent } from '@/utils/tool-result-helpers';
import { truncateFilePath } from '@/utils/truncate';

// eslint-disable-next-line industry/constants-file-organization
export const EditTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    if (!input.file_path) return '';
    const label = truncateFilePath(input.file_path as string);
    return label;
  },

  renderPreview(input: Record<string, unknown>) {
    const changeAll = input.change_all === true || input.replace_all === true;
    if (!changeAll) {
      return null;
    }
    return (
      <Text color={COLORS.warning} dimColor>
        {getI18n().t('common:toolDisplay.edit.replaceAll')}
      </Text>
    );
  },

  renderResult({ input, result, isError, contentWidth }: ToolComponentProps) {
    // Calculate maxWidth from provided contentWidth; fallback to sensible default
    const baseWidth = contentWidth ?? 80;
    // Account for borders/inner padding in this component
    const maxWidth = Math.max(baseWidth - 2, 40); // Ensure minimum width of 40

    if (isError) {
      const errorMessage = getToolErrorMessage('Edit', getTextContent(result));
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>↳ {errorMessage}</Text>
        </Box>
      );
    }

    if (result === undefined) {
      return null;
    }

    const parsed = parseToolResultForDiff(getTextContent(result) || '');

    let diffLines;
    if (parsed.diffLines) {
      // New format: use pre-computed diff directly
      diffLines = parsed.diffLines;
    } else if (
      parsed.diffData &&
      typeof parsed.diffData.oldContent === 'string' &&
      typeof parsed.diffData.newContent === 'string'
    ) {
      // Old format: generate from full content
      diffLines = generateUnifiedDiff(
        parsed.diffData.oldContent,
        parsed.diffData.newContent,
        3
      );
    }

    if (diffLines) {
      const summary = getDiffSummary(diffLines);

      // Apply smart truncation to keep diffs readable
      let truncatedDiff = smartTruncateDiff(diffLines, 2, 4);

      // Further limit for very large diffs
      if (truncatedDiff.length > MAX_DIFF_LINES) {
        const hiddenLines = truncatedDiff.length - MAX_DIFF_LINES;
        truncatedDiff = truncatedDiff.slice(0, MAX_DIFF_LINES);
        truncatedDiff.push({
          type: 'unchanged',
          content: getI18n().t('common:toolDisplay.moreLines', {
            count: hiddenLines,
          }),
        });
      }

      // Single line status message
      const statusMessage = `↳ ${getI18n().t('common:toolDisplay.edit.succeeded')} ${summary}`;

      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>{statusMessage}</Text>
          <Box flexDirection="column" width={maxWidth}>
            {/* Top horizontal line */}
            <HorizontalLine width={maxWidth} />

            <DiffRenderer
              diffLines={truncatedDiff}
              showLineNumbers
              maxWidth={maxWidth}
              filePath={input.file_path as string | undefined}
            />

            {/* Bottom horizontal line */}
            <HorizontalLine width={maxWidth} />
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Text color={COLORS.text.muted}>
          {isError
            ? getI18n().t('common:toolDisplay.edit.unsuccessful')
            : `↳ ${getI18n().t('common:toolDisplay.edit.succeeded')}`}
        </Text>
      </Box>
    );
  },

  renderDetailedView({
    input,
    result,
    isError,
    contentWidth,
  }: ToolComponentProps) {
    // For errors, use the regular result rendering
    if (isError) {
      return this.renderResult({
        input,
        result,
        isError,
        contentWidth,
      });
    }

    const filePath = input.file_path as string | undefined;
    const parsed = parseToolResultForDiff(getTextContent(result) || '');

    // If we have precomputed diff lines (new format), use them directly
    if (parsed.diffLines) {
      const fullDiffLines = parsed.diffLines;

      const summary = getDiffSummary(fullDiffLines);
      const statusMessage = `↳ ${getI18n().t('common:toolDisplay.edit.succeeded')} ${summary}`;

      // Calculate maxWidth from provided contentWidth
      const baseWidth = contentWidth ?? 80;
      const maxWidth = Math.max(baseWidth - 2, 40);

      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>{statusMessage}</Text>
          <Box
            borderStyle="classic"
            borderColor={COLORS.text.muted}
            paddingLeft={1}
            paddingRight={0}
            paddingY={0}
            marginY={1}
            width={maxWidth}
          >
            <DiffRenderer
              diffLines={fullDiffLines}
              maxWidth={maxWidth - 4}
              filePath={filePath}
            />
          </Box>
        </Box>
      );
    }

    // If we have full diff data (old format), compute full diff
    if (
      parsed.diffData &&
      typeof parsed.diffData.oldContent === 'string' &&
      typeof parsed.diffData.newContent === 'string'
    ) {
      const fullDiffLines = generateUnifiedDiff(
        parsed.diffData.oldContent,
        parsed.diffData.newContent,
        3
      );

      const summary = getDiffSummary(fullDiffLines);
      const statusMessage = `↳ ${getI18n().t('common:toolDisplay.edit.succeeded')} ${summary}`;

      // Calculate maxWidth from provided contentWidth
      const baseWidth = contentWidth ?? 80;
      const maxWidth = Math.max(baseWidth - 2, 40);

      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>{statusMessage}</Text>
          <Box
            borderStyle="classic"
            borderColor={COLORS.text.muted}
            paddingLeft={1}
            paddingRight={0}
            paddingY={0}
            marginY={1}
            width={maxWidth}
          >
            <DiffRenderer
              diffLines={fullDiffLines}
              maxWidth={maxWidth - 4}
              filePath={filePath}
            />
          </Box>
        </Box>
      );
    }

    // Fallback to regular result if no diff data available
    return this.renderResult({ input, result, isError, contentWidth });
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

    const parsed = parseToolResultForDiff(result);

    let diffLines;
    if (parsed.diffLines) {
      // New format: use pre-computed diff
      diffLines = parsed.diffLines;
    } else if (
      parsed.diffData &&
      typeof parsed.diffData.oldContent === 'string' &&
      typeof parsed.diffData.newContent === 'string'
    ) {
      // Old format: generate from full content
      diffLines = generateUnifiedDiff(
        parsed.diffData.oldContent,
        parsed.diffData.newContent,
        0
      );
    }

    if (diffLines) {
      const summary = getDiffSummary(diffLines);
      return summary;
    }

    const replaceAll =
      input.change_all || input.replace_all
        ? ` ${getI18n().t('common:toolDisplay.edit.allOccurrences')}`
        : '';
    return `${getI18n().t('common:toolDisplay.edit.summaryEdited')}${replaceAll}`;
  },
};
