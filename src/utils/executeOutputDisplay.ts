import { getI18n } from '@/i18n';
import {
  displayWidth as getDisplayWidth,
  sliceByDisplayWidth,
} from '@/utils/displayWidth';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';

const MAX_EXECUTE_ERROR_LINES = 5;
const MAX_EXECUTE_DETAILED_VIEW_LINES = 200;
const EXECUTE_PREVIEW_ELLIPSIS = '...';

export function formatExecutePreviewLine(
  line: string,
  { contentWidth, prefix = '' }: { contentWidth?: number; prefix?: string } = {}
): string {
  const safeLine = sanitizeTerminalDisplayText(line);
  const availableWidth = Math.max(
    0,
    Math.floor(contentWidth ?? 80) - getDisplayWidth(prefix)
  );

  if (availableWidth === 0) {
    return '';
  }

  if (getDisplayWidth(safeLine) <= availableWidth) {
    return safeLine;
  }

  if (availableWidth <= EXECUTE_PREVIEW_ELLIPSIS.length) {
    return EXECUTE_PREVIEW_ELLIPSIS.slice(0, availableWidth);
  }

  const { slice } = sliceByDisplayWidth(
    safeLine,
    availableWidth - EXECUTE_PREVIEW_ELLIPSIS.length
  );
  return `${slice}${EXECUTE_PREVIEW_ELLIPSIS}`;
}

export function getTextLineWindow(
  text: string | undefined | null,
  {
    maxLines = MAX_EXECUTE_DETAILED_VIEW_LINES,
    direction = 'start',
  }: { maxLines?: number; direction?: 'start' | 'end' } = {}
): {
  displayText: string;
  isTruncated: boolean;
  totalLines: number;
  shownLineCount: number;
  hiddenLineCount: number;
} {
  if (!text) {
    return {
      displayText: '',
      isTruncated: false,
      totalLines: 0,
      shownLineCount: 0,
      hiddenLineCount: 0,
    };
  }

  const lines = text.split('\n');
  const totalLines = lines.length;

  if (totalLines <= maxLines) {
    return {
      displayText: text,
      isTruncated: false,
      totalLines,
      shownLineCount: totalLines,
      hiddenLineCount: 0,
    };
  }

  const displayLines =
    direction === 'start'
      ? lines.slice(0, maxLines)
      : lines.slice(totalLines - maxLines);

  return {
    displayText: displayLines.join('\n'),
    isTruncated: true,
    totalLines,
    shownLineCount: displayLines.length,
    hiddenLineCount: totalLines - displayLines.length,
  };
}

export function truncateExecuteErrorForDisplay(errorMessage: string): string {
  if (!errorMessage) return errorMessage;

  const message = errorMessage.startsWith('Error: ')
    ? errorMessage.slice(7)
    : errorMessage;

  const lines = message.split('\n').filter((line) => line.trim() !== '');

  if (lines.length <= MAX_EXECUTE_ERROR_LINES) {
    return errorMessage;
  }

  const firstLines = lines.slice(0, MAX_EXECUTE_ERROR_LINES);
  const remainingLineCount = lines.length - MAX_EXECUTE_ERROR_LINES;

  const prefix = errorMessage.startsWith('Error: ') ? 'Error: ' : '';
  return `${prefix}${firstLines.join('\n')}\n${getI18n().t('common:toolDisplay.execute.andMoreLines', { count: remainingLineCount })}`;
}

export function filterExitCodeZeroFromDisplay(text: string): string {
  if (!text) return text;

  return text.replace(/\n*\[Process exited with code 0\]\s*$/i, '').trimEnd();
}
