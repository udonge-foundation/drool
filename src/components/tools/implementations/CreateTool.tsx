import { Text, Box } from 'ink';

import { MAX_DIFF_LINES } from '@/components/chat/constants';
import { COLORS } from '@/components/chat/themedColors';
import { HorizontalLine } from '@/components/common/HorizontalLine';
import { SyntaxHighlighter } from '@/components/SyntaxHighlighter';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import { getI18n } from '@/i18n';
import { getToolErrorMessage } from '@/utils/error-messages';
import {
  detectLanguage,
  getThemedSyntaxConfig,
} from '@/utils/syntaxHighlighter/highlight';
import { getTextContent } from '@/utils/tool-result-helpers';
import { truncateFilePath } from '@/utils/truncate';

// eslint-disable-next-line industry/constants-file-organization
export const CreateTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    if (!input.file_path) return '';
    const label = truncateFilePath(input.file_path as string);
    return label;
  },

  renderPreview(_input: Record<string, unknown>) {
    return null;
  },

  renderResult({ input, result, isError, contentWidth }: ToolComponentProps) {
    const baseWidth = contentWidth ?? 80;
    const maxWidth = Math.max(baseWidth - 2, 40);

    if (isError) {
      const errorMessage = getToolErrorMessage(
        'Create',
        getTextContent(result)
      );
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>↳ {errorMessage}</Text>
        </Box>
      );
    }

    if (result === undefined) {
      return null;
    }

    const content = typeof input.content === 'string' ? input.content : '';

    if (content) {
      const filePath = (input.file_path as string) ?? 'file';
      const ext = filePath.split('.').pop() ?? '';
      const language = detectLanguage(ext);
      const lines = content.split('\n');
      const totalLines = lines.length;
      const isTruncated = totalLines > MAX_DIFF_LINES;
      const displayContent = isTruncated
        ? lines.slice(0, MAX_DIFF_LINES).join('\n')
        : content;

      const statusMessage = `${getI18n().t('common:toolDisplay.create.succeeded')} (+${totalLines} added)`;

      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>
            {'↳ '}
            {statusMessage}
          </Text>
          <Box flexDirection="column" width={maxWidth}>
            <HorizontalLine width={maxWidth} />
            <SyntaxHighlighter
              code={displayContent}
              language={language}
              config={{ ...getThemedSyntaxConfig(), showLineNumbers: true }}
            />
            {isTruncated && (
              <Text color={COLORS.text.muted} dimColor>
                {getI18n().t('common:toolDisplay.moreLines', {
                  count: totalLines - MAX_DIFF_LINES,
                })}
              </Text>
            )}
            <HorizontalLine width={maxWidth} />
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Text color={COLORS.text.muted}>
          ↳ {getI18n().t('common:toolDisplay.create.succeeded')}
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
    if (isError) {
      const errorMessage = getToolErrorMessage(
        'Create',
        getTextContent(result)
      );
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>↳ {errorMessage}</Text>
        </Box>
      );
    }

    const content = typeof input.content === 'string' ? input.content : '';

    if (content) {
      const filePath = (input.file_path as string) ?? 'file';
      const ext = filePath.split('.').pop() ?? '';
      const language = detectLanguage(ext);
      const totalLines = content.split('\n').length;

      const baseWidth = contentWidth ?? 80;
      const maxWidth = Math.max(baseWidth - 2, 40);

      const statusMessage = `↳ ${getI18n().t('common:toolDisplay.create.succeeded')} (+${totalLines} added)`;

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
            <SyntaxHighlighter
              code={content}
              language={language}
              config={{ ...getThemedSyntaxConfig(), showLineNumbers: true }}
            />
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Text color={COLORS.text.muted}>
          ↳ {getI18n().t('common:toolDisplay.create.succeeded')}
        </Text>
      </Box>
    );
  },

  getSummaryLine(
    _input: Record<string, unknown>,
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
    return getI18n().t('common:toolDisplay.create.summaryCreated');
  },
};
