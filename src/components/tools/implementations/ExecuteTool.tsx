import { Text, Box } from 'ink';

import {
  getLatestStatusUpdateWithText,
  getStreamingOutputText,
} from '@industry/utils/session';

import { COLORS } from '@/components/chat/themedColors';
import { ToolHeaderRenderMode } from '@/components/tools/registry/enums';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import { getI18n } from '@/i18n';
import { sessionConfigService } from '@/services/SessionConfigService';
import {
  formatExecuteCommand,
  getSanitizedExecuteCommand,
} from '@/utils/executeCommandDisplay';
import {
  filterExitCodeZeroFromDisplay,
  formatExecutePreviewLine,
  getTextLineWindow,
  truncateExecuteErrorForDisplay,
} from '@/utils/executeOutputDisplay';
import { generateStableKey } from '@/utils/generateStableKey';
import { highlightShellCommand } from '@/utils/syntaxHighlighter/shellHighlight';
import { getTextContent } from '@/utils/tool-result-helpers';
import { truncateCommand, truncateLongLine } from '@/utils/truncate';
import type { HeaderLabelPart } from '@/utils/types';

const MAX_DETAILED_VIEW_LINES = 200;
const MAX_COMMAND_HEADER_LINES = 8;
const ELLIPSIS_WIDTH = 3;
const EXECUTE_RESULT_PREFIX = '↳ ';
const EXECUTE_RESULT_CONTINUATION_PREFIX = '  ';
const EXECUTE_RESULT_MARGIN_WIDTH = 4;

function getExecutePreviewContentWidth(
  contentWidth: number | undefined
): number {
  return Math.max(20, (contentWidth ?? 80) - EXECUTE_RESULT_MARGIN_WIDTH);
}

// eslint-disable-next-line industry/constants-file-organization
export const ExecuteTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    // Use getHeaderParts for Execute tool - this is a fallback
    if (!getSanitizedExecuteCommand(input)) return '';
    const parts = this.getHeaderParts?.(input) ?? [];
    if (parts.length === 0) return '';
    const label = parts.map((p) => p.text).join(', ');
    return label;
  },

  getHeaderParts(
    input: Record<string, unknown>,
    contentWidth?: number,
    renderMode?: ToolHeaderRenderMode
  ) {
    const cmd = getSanitizedExecuteCommand(input);
    if (!cmd) return [];

    const parts: HeaderLabelPart[] = [];

    // Offset for tool name ("Execute ") + left margin so truncation fits on the header line
    const HEADER_OFFSET = 12;

    // Check block/deny/allow status early so we can reserve space for the right-aligned label
    const isBlocked = sessionConfigService.isCommandBlocked(cmd);
    const isDenied = !isBlocked && sessionConfigService.isCommandDenied(cmd);
    const isAllowed =
      !isBlocked && !isDenied && sessionConfigService.isCommandAllowed(cmd);
    const rightLabel = isBlocked
      ? getI18n().t('common:toolDisplay.execute.blocked')
      : isDenied
        ? getI18n().t('common:toolDisplay.execute.denylisted')
        : isAllowed
          ? getI18n().t('common:toolDisplay.execute.allowlisted')
          : null;
    const rightReserved = rightLabel ? rightLabel.length + 3 : 0;
    const availableWidth = Math.max(
      20,
      (contentWidth ?? 80) - HEADER_OFFSET - rightReserved
    );

    // Add linebreaks before && and || for readability in all views
    const formatted = formatExecuteCommand(cmd);

    if (renderMode === ToolHeaderRenderMode.Detailed) {
      parts.push({
        text: highlightShellCommand(formatted),
        highlighted: true,
      });
    } else {
      // Normal/confirmation view: limit command lines, then truncate
      const lines = formatted.split('\n');
      if (lines.length > MAX_COMMAND_HEADER_LINES) {
        const visibleLines = lines.slice(0, MAX_COMMAND_HEADER_LINES);
        const truncated = visibleLines
          .map((line, index) => {
            const isLastVisibleLine = index === visibleLines.length - 1;
            const lineWidth = isLastVisibleLine
              ? availableWidth - ELLIPSIS_WIDTH
              : availableWidth;
            return `${truncateLongLine(line, lineWidth)}${
              isLastVisibleLine ? '...' : ''
            }`;
          })
          .join('\n');
        parts.push({
          text: highlightShellCommand(truncated),
          highlighted: true,
        });
      } else {
        const initial = truncateCommand(
          formatted,
          availableWidth,
          MAX_COMMAND_HEADER_LINES
        );

        const { text: truncatedCmd } = initial.isTruncated
          ? truncateCommand(
              formatted,
              availableWidth - ELLIPSIS_WIDTH,
              MAX_COMMAND_HEADER_LINES
            )
          : initial;

        const displayCmd = initial.isTruncated
          ? `${truncatedCmd}...`
          : truncatedCmd;
        parts.push({
          text: highlightShellCommand(displayCmd),
          highlighted: true,
        });
      }
    }

    if (isBlocked) {
      parts.push({
        text: getI18n().t('common:toolDisplay.execute.blocked'),
        rightAligned: true,
        color: COLORS.error,
      });
    } else if (isDenied) {
      parts.push({
        text: getI18n().t('common:toolDisplay.execute.denylisted'),
        rightAligned: true,
        color: COLORS.error,
      });
    } else if (isAllowed) {
      parts.push({
        text: getI18n().t('common:toolDisplay.execute.allowlisted'),
        rightAligned: true,
      });
    }

    return parts;
  },

  renderPreview(
    input: Record<string, unknown>,
    renderMode?: ToolHeaderRenderMode
  ) {
    const cmd = getSanitizedExecuteCommand(input);
    if (!cmd) return null;
    if (
      renderMode === ToolHeaderRenderMode.Detailed ||
      renderMode === ToolHeaderRenderMode.Confirmation
    ) {
      return null;
    }
    const formatted = formatExecuteCommand(cmd);
    const lines = formatted.split('\n');
    if (lines.length <= MAX_COMMAND_HEADER_LINES) return null;
    const remaining = lines.length - MAX_COMMAND_HEADER_LINES;
    return (
      <Box marginLeft={1}>
        <Text color={COLORS.text.muted}>
          {getI18n().t('common:toolDisplay.moreCtrlOToView', {
            count: remaining,
          })}
        </Text>
      </Box>
    );
  },

  renderDetailedView({ result, isError, progressUpdates }: ToolComponentProps) {
    const resultText = getTextContent(result);

    // Show streaming updates if no final result yet
    if (!resultText || resultText.trim() === '') {
      if (progressUpdates && progressUpdates.length > 0) {
        const lastStatusUpdate = getLatestStatusUpdateWithText(progressUpdates);

        if (lastStatusUpdate) {
          const outputToShow =
            getStreamingOutputText(progressUpdates) ||
            lastStatusUpdate.text ||
            '';

          if (outputToShow) {
            const detailedDisplay = getTextLineWindow(outputToShow, {
              maxLines: MAX_DETAILED_VIEW_LINES,
              direction: 'end',
            });

            return (
              <Box flexDirection="column">
                <Text color={COLORS.text.primary}>
                  {detailedDisplay.displayText}
                </Text>
                {detailedDisplay.isTruncated && (
                  <Box marginTop={1}>
                    <Text color={COLORS.text.muted}>
                      {getI18n().t('common:toolDisplay.showingLast', {
                        shown: detailedDisplay.shownLineCount,
                        total: detailedDisplay.totalLines,
                      })}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          }
        }
      }

      return null;
    }

    // Filter out exit code 0 from UI display (keep in message history for LLM)
    const filteredText = filterExitCodeZeroFromDisplay(resultText);

    if (isError) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.error}>{filteredText}</Text>
        </Box>
      );
    }

    const detailedDisplay = getTextLineWindow(filteredText, {
      maxLines: MAX_DETAILED_VIEW_LINES,
      direction: 'end',
    });

    return (
      <Box flexDirection="column">
        <Text color={COLORS.text.primary}>{detailedDisplay.displayText}</Text>
        {detailedDisplay.isTruncated && (
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {getI18n().t('common:toolDisplay.showingLast', {
                shown: detailedDisplay.shownLineCount,
                total: detailedDisplay.totalLines,
              })}
            </Text>
          </Box>
        )}
      </Box>
    );
  },

  renderResult({
    input,
    result,
    isError,
    progressUpdates,
    contentWidth,
    hideHeader,
  }: ToolComponentProps) {
    const maxPreviewLines = 8;
    const resultText = getTextContent(result);

    // Show streaming updates if no final result yet
    if (!resultText || resultText.trim() === '') {
      if (progressUpdates && progressUpdates.length > 0) {
        const lastStatusUpdate = getLatestStatusUpdateWithText(progressUpdates);

        if (lastStatusUpdate && lastStatusUpdate.text) {
          const lines = lastStatusUpdate.text.split('\n');
          // We expect exactly 2 lines from getLastNLines (which pads if needed)
          // Make sure we always display exactly 2 lines
          let displayLines: string[];
          if (lines.length >= 2) {
            displayLines = lines.slice(0, 2);
          } else if (lines.length === 1) {
            displayLines = ['', lines[0]];
          } else {
            displayLines = ['', ''];
          }

          return (
            <Box flexDirection="column">
              {displayLines.map((line, idx) => {
                const prefix =
                  idx === 0
                    ? EXECUTE_RESULT_PREFIX
                    : EXECUTE_RESULT_CONTINUATION_PREFIX;
                const previewLine = formatExecutePreviewLine(line.trim(), {
                  contentWidth: getExecutePreviewContentWidth(contentWidth),
                  prefix,
                });
                return (
                  <Text key={`streaming-${idx}`} color={COLORS.text.muted}>
                    {prefix}
                    {previewLine}
                  </Text>
                );
              })}
            </Box>
          );
        }
      }

      return null;
    }

    // Filter out exit code 0 from UI display (keep in message history for LLM)
    const displayText = filterExitCodeZeroFromDisplay(resultText);

    if (isError) {
      const truncatedError = truncateExecuteErrorForDisplay(displayText);
      const lines = truncatedError.split('\n').filter((line) => line.trim());
      const previewContentWidth = getExecutePreviewContentWidth(contentWidth);

      return (
        <Box flexDirection="column">
          {lines.map((line, index) => {
            const prefix =
              index === 0
                ? EXECUTE_RESULT_PREFIX
                : EXECUTE_RESULT_CONTINUATION_PREFIX;
            return (
              <Text
                key={`error-${index}-${line.slice(0, 30).replace(/\W/g, '')}-${line.length}`}
                color={COLORS.error}
              >
                {prefix}
                {formatExecutePreviewLine(line, {
                  contentWidth: previewContentWidth,
                  prefix,
                })}
              </Text>
            );
          })}
        </Box>
      );
    }

    const allLines = displayText.split('\n');
    const previewLines = allLines.slice(0, maxPreviewLines);
    const total = allLines.length;

    const previewContentWidth = getExecutePreviewContentWidth(contentWidth);

    // Check if command was truncated in header
    const cmd = getSanitizedExecuteCommand(input) ?? '';
    const cmdLines = formatExecuteCommand(cmd).split('\n');
    const cmdTruncated = cmdLines.length > MAX_COMMAND_HEADER_LINES;
    const cmdRemaining = cmdLines.length - MAX_COMMAND_HEADER_LINES;

    return (
      <Box flexDirection="column">
        {!hideHeader && cmdTruncated && (
          <Text color={COLORS.text.muted}>
            {'       '}
            {getI18n().t('common:toolDisplay.moreCtrlOToView', {
              count: cmdRemaining,
            })}
          </Text>
        )}
        {previewLines.map((line, idx) => {
          const prefix =
            idx === 0
              ? EXECUTE_RESULT_PREFIX
              : EXECUTE_RESULT_CONTINUATION_PREFIX;
          return (
            <Text
              key={generateStableKey(line, idx, 'exec-preview')}
              color={COLORS.text.muted}
            >
              {prefix}
              {formatExecutePreviewLine(line, {
                contentWidth: previewContentWidth,
                prefix,
              })}
            </Text>
          );
        })}
        {total > maxPreviewLines && (
          <Text color={COLORS.text.muted}>
            {getI18n().t('common:toolDisplay.moreCtrlOToView', {
              count: total - maxPreviewLines,
            })}
          </Text>
        )}
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

      const exitCodeMatch = result.match(/exited with code: (\d+)/);
      if (exitCodeMatch) {
        return getI18n().t('common:toolDisplay.execute.summaryFailedWithCode', {
          code: exitCodeMatch[1],
        });
      }
      return getI18n().t('common:toolDisplay.execute.summaryFailed');
    }

    const outputLines = result
      ? result.split('\n').filter((line) => line.trim()).length
      : 0;

    if (
      result === 'Command completed successfully' ||
      !result.includes('exited with code:')
    ) {
      return getI18n().t('common:toolDisplay.execute.summarySuccess', {
        count: outputLines,
      });
    }

    const exitCodeMatch = result.match(/exited with code: (\d+)/);
    const exitCode = exitCodeMatch ? exitCodeMatch[1] : '0';
    return getI18n().t('common:toolDisplay.execute.summaryExitCode', {
      code: exitCode,
      count: outputLines,
    });
  },
};
