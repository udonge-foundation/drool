import { logWarn } from '@industry/logging';

import {
  MAX_CHARACTER_LIMIT,
  MIDDLE_MESSAGE,
} from '@/tools/executors/client/shell/constants';
import { extractImportantContentByKeywords } from '@/tools/executors/client/shell/extractImportantContentByKeywords';
import { extractNonMiddleContent } from '@/tools/executors/client/shell/extractNonMiddleContent';
import { SummarizeCLIOptions } from '@/tools/executors/client/shell/types';

const MAX_LINE_LENGTH = 600;
const SURROUNDING_CONTEXT_LINES = 10; // Number of lines to preserve before and after important lines
const HEAD_TAIL_LINES = 30; // Number of lines to always include at the start and end

const CRITICAL_KEYWORDS = [
  'error',
  'fail',
  'exception',
  'crash',
  'fatal',
  'panic',
  'critical',
  'test failed',
  'build failed',
  'compilation error',
] as const;

const IMPORTANT_KEYWORDS = [
  ...CRITICAL_KEYWORDS,

  // Warnings
  'warning',
  'warn',

  // Test results
  'test failed',
  'test passed',
  'passing',
  'failing',
  'assertions',
  'expect',

  // Build/compilation
  'build failed',
  'compilation error',
  'cannot compile',
  'undefined reference',

  // Success indicators
  'success',
  'succeeded',
  'completed successfully',
  'passed',

  // Common CLI status indicators
  'status:',
  'exit code',
  'terminated',
  'killed',

  // Linting and formatting
  'lint error',
  'style error',
  'format error',
  'prettier',

  // Server logs
  'listening on',
  'server started',
  'connected to',
  'connection refused',
  'port',
  'endpoint',
  'api',
  'request',
  'response',
  'status code',

  // Common debugging information
  'debug',
  'trace',
  'info',

  // Specific to common tools
  'npm',
  'yarn',
  'webpack',
  'babel',
  'eslint',
  'jest',
  'mocha',
  'pytest',
  'go test',
  'cargo test',
  'rspec',
  'gradle',
  'maven',
] as const;

function truncateLine(
  line: string,
  maxLineLength: number | undefined = MAX_LINE_LENGTH
): string {
  if (line.length <= maxLineLength) {
    return line;
  }

  const middleFiller = ' ... [truncated] ... ';
  const halfLength = Math.floor(maxLineLength / 2) - middleFiller.length / 2;
  return (
    line.substring(0, halfLength) +
    middleFiller +
    line.substring(line.length - halfLength)
  );
}

interface IsImportantLineParams {
  line: string;
  keywords?: readonly string[];
}

export function isImportantLine({
  line,
  keywords = IMPORTANT_KEYWORDS,
}: IsImportantLineParams): boolean {
  const lowerCaseLine = line.toLowerCase();
  return keywords.some((keyword) =>
    lowerCaseLine.includes(keyword.toLowerCase())
  );
}

export function summarizeCLIOutput(
  cliOutput: string,
  {
    maxLength = MAX_CHARACTER_LIMIT,
    maxLineLength = MAX_LINE_LENGTH,
    surroundingContextLines = SURROUNDING_CONTEXT_LINES,
    headTailLines = HEAD_TAIL_LINES,
  }: SummarizeCLIOptions | undefined = {}
): string {
  if (cliOutput.length <= maxLength) {
    return cliOutput;
  }
  // attempt 1: truncate super long lines in the output and see if that gets us under the limit
  const lines = cliOutput.split(/\r?\n/);
  const truncatedLines = lines.map((line) => truncateLine(line, maxLineLength));
  const truncatedOutput = truncatedLines.join('\n');
  if (truncatedOutput.length <= maxLength) {
    return truncatedOutput;
  }

  try {
    // attempt 2: identify important lines and their surrounding context
    const allImportantLinesOutput = extractImportantContentByKeywords({
      truncatedLines,
      keywords: IMPORTANT_KEYWORDS,
      options: {
        surroundingContextLines,
        headTailLines,
      },
    });

    if (allImportantLinesOutput.length <= maxLength) {
      return allImportantLinesOutput;
    }

    // attempt 3: identify critical lines and their surrounding context
    const criticalLinesOutput = extractImportantContentByKeywords({
      truncatedLines,
      keywords: CRITICAL_KEYWORDS,
      options: {
        surroundingContextLines,
        headTailLines,
      },
    });

    if (criticalLinesOutput.length <= maxLength) {
      return criticalLinesOutput;
    }
  } catch (error) {
    logWarn('Error while summarizing CLI output', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // attempt 4: if everything else fails, just truncate the output by using
  // the first and last few lines
  try {
    return extractNonMiddleContent({
      truncatedLines,
      options: { maxLength },
    });
  } catch (error) {
    logWarn('Error while extracting non-middle content', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return MIDDLE_MESSAGE;
}
