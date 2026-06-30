import { truncateOutput as coreTruncateOutput } from '@industry/drool-core/tools/utils/truncate';
import {
  SYSTEM_REMINDER_START,
  SYSTEM_REMINDER_END,
} from '@industry/drool-sdk-ext/protocol/drool';

import {
  displayWidth as getDisplayWidth,
  sliceByDisplayWidth,
} from '@/utils/displayWidth';
import type { TruncateCommandResult } from '@/utils/types';

/**
 * Truncates file content based on line offset and limit, optionally adding line numbers.
 * Used specifically for the readCli tool to provide line-numbered output.
 * Also enforces a maximum character limit of 60k characters.
 *
 * Supports negative offsets to read from end of file (Python-style):
 * - offset = -1: last line
 * - offset = -10: last 10 lines
 */
export function truncateFileLines(
  content: string,
  offset: number = 0,
  limit: number = 2400,
  includeLineNumbers: boolean = false,
  maxChars: number = 60000
): string {
  const lines = content.split('\n');
  const totalLines = lines.length;

  // Handle negative offsets (count from end of file)
  let startLine: number;
  if (offset < 0) {
    // Negative offset: start from end
    // -1 means last line, -10 means 10 lines from end
    startLine = Math.max(0, totalLines + offset);
  } else {
    // Positive offset: start from beginning
    startLine = Math.max(0, offset);
  }

  let endLine = Math.min(totalLines, startLine + limit);
  const selectedLines = lines.slice(startLine, endLine);

  // Optionally add line numbers (1-based for user readability)
  let processedLines = includeLineNumbers
    ? selectedLines.map((line, index) => {
        const lineNumber = startLine + index + 1;
        return `${lineNumber}→${line}`;
      })
    : selectedLines;

  let result = processedLines.join('\n');

  // Check character limit and truncate if necessary
  const isCharLimited = result.length > maxChars;
  if (isCharLimited) {
    // Find how many lines we can fit within the character limit
    let charCount = 0;
    let lineCount = 0;

    for (let i = 0; i < processedLines.length; i++) {
      const lineWithNewline =
        processedLines[i] + (i < processedLines.length - 1 ? '\n' : '');
      if (charCount + lineWithNewline.length > maxChars) {
        break;
      }
      charCount += lineWithNewline.length;
      lineCount++;
    }

    processedLines = processedLines.slice(0, lineCount);
    result = processedLines.join('\n');
    endLine = startLine + lineCount;
  }

  // Add truncation info if we're not showing all lines or hit character limit
  if (startLine > 0 || endLine < totalLines || isCharLimited) {
    const showingStart = startLine + 1;
    const showingEnd = startLine + processedLines.length;
    let truncationMessage = `[Showing lines ${showingStart}-${showingEnd} of ${totalLines} total lines`;

    if (isCharLimited) {
      const displayLength =
        maxChars >= 1000 ? `${Math.floor(maxChars / 1000)}k` : `${maxChars}`;
      truncationMessage += `, truncated to ${displayLength} characters`;
    }

    truncationMessage += ']';
    result += `\n\n${SYSTEM_REMINDER_START}${truncationMessage}${SYSTEM_REMINDER_END}`;
  }

  return result;
}

/**
 * Truncates output text to a maximum length while preserving readability.
 * Shows the beginning and end of the output to maintain context.
 */
export function truncateOutput(output: string, maxLength?: number): string {
  return coreTruncateOutput(output, maxLength);
}

/**
 * Truncates file paths by removing the working directory prefix.
 * Shows relative paths when possible for cleaner tool headers.
 */
export function truncateFilePath(filePath: string): string {
  if (!filePath || typeof filePath !== 'string') {
    return filePath || '';
  }

  const cwd = process.cwd();

  // If the path starts with the current working directory, make it relative
  if (filePath.startsWith(cwd)) {
    const relativePath = filePath.substring(cwd.length);
    // Remove leading slash if present
    return relativePath.startsWith('/')
      ? relativePath.substring(1)
      : relativePath;
  }

  // If not under current directory, show at most 2 parent dirs + filename
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length > 3) {
    return `…/${parts.slice(-3).join('/')}`;
  }
  return filePath;
}

/**
 * Truncates a single line to a maximum display width for safe display.
 * Uses display width (string-width) so CJK double-width characters are
 * counted correctly.
 */
export function truncateLongLine(
  line: string,
  maxLength: number = 2000
): string {
  if (!line || getDisplayWidth(line) <= maxLength) {
    return line;
  }

  // Reserve 3 columns for the ellipsis
  const { slice } = sliceByDisplayWidth(line, maxLength - 3);
  return `${slice}...`;
}

/**
 * Truncate text in the middle, preserving start and end.
 * Useful for file names where both the beginning and extension are important.
 * Uses display width (string-width) so CJK double-width characters are
 * counted correctly and never split.
 *
 * @param text - The text to truncate
 * @param maxWidth - Maximum display width (terminal columns) including ellipsis
 * @returns Truncated text with ellipsis in the middle, or original if within max width
 */
export function truncateMiddle(text: string, maxWidth: number): string {
  if (!text || getDisplayWidth(text) <= maxWidth) {
    return text || '';
  }

  // Ensure we have at least room for ellipsis (3 columns)
  if (maxWidth < 4) {
    return '...';
  }

  // Reserve 3 columns for ellipsis
  const availableWidth = maxWidth - 3;

  // Split available width between start and end
  // Slightly favor the end to preserve extensions and test indicators
  const startWidth = Math.floor(availableWidth * 0.45);
  const endWidth = availableWidth - startWidth;

  // Slice from the start by display width
  const { slice: start } = sliceByDisplayWidth(text, startWidth);

  // For the end, we need to take from the end of the string by display width.
  // Iterate from the end of the string backwards to accumulate endWidth columns.
  const chars = [...text]; // Spread to handle surrogate pairs correctly
  let endStr = '';
  let endCurrentWidth = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const charWidth = getDisplayWidth(chars[i]);
    if (endCurrentWidth + charWidth > endWidth) {
      break;
    }
    endStr = chars[i] + endStr;
    endCurrentWidth += charWidth;
  }

  return `${start}...${endStr}`;
}

/**
 * Truncates a command string by both display width and line count.
 * Whichever limit is hit first triggers truncation.
 * Uses display width (string-width) so CJK double-width characters are
 * counted correctly.
 *
 * @param command - The command string to truncate
 * @param maxLength - Maximum display width in terminal columns (default: 80)
 * @param maxLines - Maximum number of lines (default: 3)
 * @returns Object with truncated text and whether truncation occurred
 */
export function truncateCommand(
  command: string,
  maxLength: number = 80,
  maxLines: number = 3
): TruncateCommandResult {
  if (!command) {
    return { text: command || '', isTruncated: false };
  }

  const lines = command.split('\n');
  const needsLineTruncation = lines.length > maxLines;
  const needsCharTruncation = getDisplayWidth(command) > maxLength;

  if (!needsLineTruncation && !needsCharTruncation) {
    return { text: command, isTruncated: false };
  }

  // Truncate by lines first if needed
  let truncatedCmd = needsLineTruncation
    ? lines.slice(0, maxLines).join('\n')
    : command;

  // Then truncate by display width if still too wide
  if (getDisplayWidth(truncatedCmd) > maxLength) {
    const { slice } = sliceByDisplayWidth(truncatedCmd, maxLength);
    truncatedCmd = slice;
  }

  return {
    text: truncatedCmd,
    isTruncated: true,
  };
}

const CMD_OUTPUT_MAX_LINES = 20;
const CMD_OUTPUT_MAX_CHARS = 2000;

/**
 * Truncates command output by line count and character count.
 * Used for system info command outputs (ls, git status, etc.) to prevent
 * oversized context in LLM requests.
 */
export function truncateCommandOutput(
  output: string,
  maxLines: number = CMD_OUTPUT_MAX_LINES,
  maxChars: number = CMD_OUTPUT_MAX_CHARS
): string {
  if (!output) return output;

  const lines = output.split('\n');
  let truncated = false;

  let result: string[];
  if (lines.length > maxLines) {
    result = lines.slice(0, maxLines);
    truncated = true;
  } else {
    result = lines;
  }

  let text = result.join('\n');
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }

  if (truncated) {
    text += '\n... [truncated]';
  }
  return text;
}
