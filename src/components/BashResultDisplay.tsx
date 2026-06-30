import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import {
  getTextLineWindow,
  truncateExecuteErrorForDisplay,
} from '@/utils/executeOutputDisplay';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';
import { truncateLongLine } from '@/utils/truncate';

interface BashResult {
  type: 'bash_result';
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode: number;
  metadata?: {
    commandTruncated?: boolean;
    commandTotalLines?: number;
    commandAdditionalLines?: number;
    stdoutTruncated?: boolean;
    stdoutTotalLines?: number;
    stdoutAdditionalLines?: number;
    stderrTruncated?: boolean;
    stderrTotalLines?: number;
    stderrAdditionalLines?: number;
  };
}

interface BashResultDisplayProps {
  content: string;
  maxWidth?: number;
  isDetailedView?: boolean;
}

const DETAILED_MAX_OUTPUT_LINES = 200;

function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/u, '');
}

export function BashResultDisplay({
  content,
  maxWidth,
  isDetailedView = false,
}: BashResultDisplayProps) {
  const { t } = useTranslation();
  const safeContent = sanitizeTerminalDisplayText(content);
  const previewMaxLines = 8;
  const previewCommandLines = 8;
  const lineWidth = Math.max(20, (maxWidth ?? 80) - 4);
  // Try to parse the content as a bash result
  let bashResult: BashResult | null = null;
  try {
    const parsed = JSON.parse(content);
    if (parsed.type === 'bash_result') {
      bashResult = parsed;
    }
  } catch {
    // Not a bash result, display as plain text
    return <Text>{safeContent}</Text>;
  }

  if (!bashResult) {
    return <Text>{safeContent}</Text>;
  }

  const safeCommand = sanitizeTerminalDisplayText(bashResult.command ?? '');
  const safeStdout = sanitizeTerminalDisplayText(bashResult.stdout ?? '');
  const safeStderr = sanitizeTerminalDisplayText(bashResult.stderr ?? '');

  const stdoutDisplay = useMemo(
    () =>
      getTextLineWindow(safeStdout, {
        maxLines: isDetailedView ? DETAILED_MAX_OUTPUT_LINES : previewMaxLines,
        direction: isDetailedView ? 'end' : 'start',
      }),
    [safeStdout, isDetailedView, previewMaxLines]
  );

  const stderrDisplay = useMemo(
    () =>
      getTextLineWindow(safeStderr, {
        maxLines: isDetailedView ? DETAILED_MAX_OUTPUT_LINES : previewMaxLines,
        direction: isDetailedView ? 'end' : 'start',
      }),
    [safeStderr, isDetailedView, previewMaxLines]
  );

  const commandDisplay = useMemo(
    () =>
      getTextLineWindow(safeCommand, {
        maxLines: isDetailedView
          ? DETAILED_MAX_OUTPUT_LINES
          : previewCommandLines,
        direction: 'start',
      }),
    [safeCommand, isDetailedView, previewCommandLines]
  );

  const commandContent = stripTrailingNewlines(commandDisplay.displayText);
  const stdoutContent = stripTrailingNewlines(stdoutDisplay.displayText);
  const stderrContent = stripTrailingNewlines(stderrDisplay.displayText);

  const shouldShowStdout = Boolean(stdoutContent);
  const shouldShowStderr = Boolean(stderrContent);
  const commandLines = commandContent ? commandContent.split('\n') : [];
  const stdoutLines = stdoutContent.split('\n');
  const stderrPreviewLines = truncateExecuteErrorForDisplay(stderrContent)
    .split('\n')
    .filter((line) => line.trim() !== '');

  const getPreviewHint = (hiddenLineCount: number): string =>
    t('common:toolDisplay.moreCtrlOToView', { count: hiddenLineCount });

  return (
    <Box flexDirection="column" width={maxWidth}>
      {commandLines.length > 0 && (
        <Box flexDirection="column">
          <Box>
            <Text color={COLORS.text.muted}>$ </Text>
            <Text color={COLORS.toolParam} bold>
              {commandLines[0]}
            </Text>
          </Box>
          {commandLines.slice(1).map((line, index) => (
            <Text key={`command-${index}`} color={COLORS.toolParam} bold>
              {`  ${line}`}
            </Text>
          ))}
          {commandDisplay.isTruncated && (
            <Text color={COLORS.text.muted}>
              {isDetailedView
                ? `↳ showing first ${commandDisplay.shownLineCount}/${commandDisplay.totalLines} lines`
                : getPreviewHint(commandDisplay.hiddenLineCount)}
            </Text>
          )}
        </Box>
      )}

      {shouldShowStdout && (
        <Box flexDirection="column">
          {isDetailedView ? (
            <Text color={COLORS.text.primary}>{stdoutContent}</Text>
          ) : (
            stdoutLines.map((line, index) => (
              <Text key={`stdout-${index}`} color={COLORS.text.muted}>
                {index === 0 ? '↳ ' : '  '}
                {truncateLongLine(line, lineWidth)}
              </Text>
            ))
          )}
          {stdoutDisplay.isTruncated && (
            <Text color={COLORS.text.muted}>
              {isDetailedView
                ? t('common:toolDisplay.showingLast', {
                    shown: stdoutDisplay.shownLineCount,
                    total: stdoutDisplay.totalLines,
                  })
                : getPreviewHint(stdoutDisplay.hiddenLineCount)}
            </Text>
          )}
        </Box>
      )}

      {shouldShowStderr && (
        <Box
          flexDirection="column"
          marginTop={shouldShowStdout && !isDetailedView ? 1 : 0}
        >
          {isDetailedView ? (
            <Text color={COLORS.error}>{stderrContent}</Text>
          ) : (
            stderrPreviewLines.map((line, index) => (
              <Text key={`stderr-${index}`} color={COLORS.error}>
                {index === 0 ? '↳ ' : '  '}
                {truncateLongLine(line, lineWidth)}
              </Text>
            ))
          )}
          {stderrDisplay.isTruncated && (
            <Text color={COLORS.text.muted}>
              {isDetailedView
                ? t('common:toolDisplay.showingLast', {
                    shown: stderrDisplay.shownLineCount,
                    total: stderrDisplay.totalLines,
                  })
                : getPreviewHint(stderrDisplay.hiddenLineCount)}
            </Text>
          )}
        </Box>
      )}

      {bashResult.exitCode !== 0 && (
        <Box marginTop={1}>
          <Text color={COLORS.error}>
            {t('common:bashResult.exitCode', { code: bashResult.exitCode })}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Check if content is a bash result
 */
export function isBashResult(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return parsed.type === 'bash_result';
  } catch {
    return false;
  }
}
