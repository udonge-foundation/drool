import chalk from 'chalk';
import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { getThemedColors } from '@/components/chat/themedColors';
import { UnifiedDiffRenderer } from '@/components/UnifiedDiffRenderer';
import { useLanguageFromFilePath } from '@/hooks/useLanguageFromFilePath';
import { getSettingsService } from '@/services/SettingsService';
import { padToWidth } from '@/utils/ansi-utils';
import { computeWordDiffs } from '@/utils/diff-utils';
import { displayWidth } from '@/utils/displayWidth';
import { generateStableKey } from '@/utils/generateStableKey';
import { highlightLineToAnsi } from '@/utils/syntaxHighlighter/highlight';
import { truncateLongLine } from '@/utils/truncate';
import type { DiffLine, DiffLineSegment } from '@/utils/types';

const LINE_NUMBER_COL_WIDTH = 11; // 10 chars + 1 margin
const TAB_SPACES = '    '; // 4-space tab expansion

function expandTabs(text: string): string {
  return text.includes('\t') ? text.replace(/\t/g, TAB_SPACES) : text;
}

// Get themed colors at runtime
function getDiffColors() {
  const colors = getThemedColors();
  return {
    added: {
      text: colors.diff.added.text,
      bg: colors.diff.added.bg,
      wordBg: colors.diff.added.wordBg,
      header: colors.diff.header,
    },
    removed: {
      text: colors.diff.removed.text,
      bg: colors.diff.removed.bg,
      wordBg: colors.diff.removed.wordBg,
      header: colors.diff.header,
    },
    unchanged: {
      text: colors.diff.unchanged.text,
      dimText: colors.diff.unchanged.dimText,
    },
    lineNumber: colors.diff.lineNumber,
    blockHeader: colors.diff.header,
  };
}

// Lazy proxy so colors are always re-evaluated at access time, matching
// the pattern used by `COLORS` in themedColors.ts.  This avoids stale
// values when the theme or feature flags change after module import.
type DiffColors = ReturnType<typeof getDiffColors>;
const DIFF_COLORS: DiffColors = new Proxy({} as DiffColors, {
  get(_target, prop) {
    return getDiffColors()[prop as keyof DiffColors];
  },
});

// Interface for grouped changes
interface DiffBlock {
  id: string;
  type: 'change' | 'context';
  beforeLines: DiffLine[];
  afterLines: DiffLine[];
  contextLines?: DiffLine[];
  startLine?: {
    old?: number;
    new?: number;
  };
  endLine?: {
    old?: number;
    new?: number;
  };
}

interface DiffRendererProps {
  diffLines: DiffLine[];
  showLineNumbers?: boolean;
  // Optional maximum width in columns. When provided, the diff will not exceed this width.
  maxWidth?: number;
  // Optional file path for syntax highlighting. When provided, lines are syntax-highlighted.
  filePath?: string;
}

/**
 * Groups consecutive changes into blocks for better visualization
 */
function groupChangesIntoBlocks(diffLines: DiffLine[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let currentBeforeLines: DiffLine[] = [];
  let currentAfterLines: DiffLine[] = [];
  let currentContextLines: DiffLine[] = [];
  let blockId = 0;

  // Helper to create a new block
  const createBlock = (type: 'change' | 'context'): DiffBlock => {
    const beforeStartLine = currentBeforeLines[0]?.lineNumber?.old;
    const beforeEndLine =
      currentBeforeLines[currentBeforeLines.length - 1]?.lineNumber?.old;
    const afterStartLine = currentAfterLines[0]?.lineNumber?.new;
    const afterEndLine =
      currentAfterLines[currentAfterLines.length - 1]?.lineNumber?.new;

    return {
      id: `block-${blockId++}`,
      type,
      beforeLines: [...currentBeforeLines],
      afterLines: [...currentAfterLines],
      contextLines: type === 'context' ? [...currentContextLines] : undefined,
      startLine: {
        old: beforeStartLine,
        new: afterStartLine,
      },
      endLine: {
        old: beforeEndLine,
        new: afterEndLine,
      },
    };
  };

  // Helper to reset current block state
  const resetCurrentBlock = () => {
    currentBeforeLines = [];
    currentAfterLines = [];
    currentContextLines = [];
  };

  // Process each line to group them into blocks
  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];

    // Skip separator lines (they'll be handled differently)
    if (!line.lineNumber && line.content.includes('unchanged lines')) {
      // If we have a current change block, add it
      if (currentBeforeLines.length > 0 || currentAfterLines.length > 0) {
        blocks.push(createBlock('change'));
        resetCurrentBlock();
      }

      // Add a context block for the separator
      currentContextLines = [line];
      blocks.push(createBlock('context'));
      resetCurrentBlock();
      continue;
    }

    // Handle change lines
    if (line.type === 'removed') {
      // If we have context lines and now hit a change, create a context block first
      if (currentContextLines.length > 0) {
        blocks.push(createBlock('context'));
        resetCurrentBlock();
      }

      currentBeforeLines.push(line);
    } else if (line.type === 'added') {
      // If we have context lines and now hit a change, create a context block first
      if (currentContextLines.length > 0) {
        blocks.push(createBlock('context'));
        resetCurrentBlock();
      }

      currentAfterLines.push(line);
    } else if (line.type === 'unchanged') {
      // If we have a current change block, add it
      if (currentBeforeLines.length > 0 || currentAfterLines.length > 0) {
        blocks.push(createBlock('change'));
        resetCurrentBlock();
      }

      // Start collecting context lines
      currentContextLines.push(line);

      // If we have 3+ context lines or this is the last line, create a context block
      const isLastLine = i === diffLines.length - 1;
      if (currentContextLines.length >= 3 || isLastLine) {
        blocks.push(createBlock('context'));
        resetCurrentBlock();
      }
    }
  }

  // Add any remaining changes as a block
  if (currentBeforeLines.length > 0 || currentAfterLines.length > 0) {
    blocks.push(createBlock('change'));
  }

  return blocks;
}

/**
 * Renders a unified line number column with old and new line numbers
 */
function LineNumberColumn({
  oldLine,
  newLine,
}: {
  oldLine?: number;
  newLine?: number;
}) {
  // Pad each column to 4 characters so the central divider `│` always
  // lines up even when line numbers grow beyond two digits.
  const oldLineStr =
    oldLine !== undefined ? oldLine.toString().padStart(4, ' ') : '    ';
  const newLineStr =
    newLine !== undefined ? newLine.toString().padStart(4, ' ') : '    ';

  // 4 chars old + space + space + 4 chars new = 10
  // keep fixed width and disable shrinking so it never wraps
  return (
    <Box width={10} marginRight={1} flexShrink={0}>
      <Text color={DIFF_COLORS.lineNumber}>
        {oldLineStr} {newLineStr}
      </Text>
    </Box>
  );
}

/**
 * Extract ANSI escape code at a given position, or null if none.
 */
function ansiCodeAt(str: string, pos: number): number | null {
  if (str[pos] !== '\x1b') return null;
  if (str[pos + 1] === '[') {
    let j = pos + 2;
    while (j < str.length && !/[a-zA-Z]/.test(str[j])) j++;
    if (j < str.length) return j + 1 - pos;
  }
  return null;
}

/**
 * Highlight the full line once, then split the resulting ANSI string by
 * word-diff segment boundaries and wrap each segment with the appropriate
 * background color. This preserves full-line highlight.js context.
 */
function highlightWithWordSegments(
  lineContent: string,
  segments: DiffLineSegment[],
  language: string | undefined,
  bgColor: string | undefined,
  wordBgColor: string | undefined
): string {
  const truncated = truncateLongLine(expandTabs(lineContent));
  const fullAnsi = highlightLineToAnsi(truncated, language);

  // Expand tabs in segments so their lengths match the expanded content.
  const expandedSegments = segments.map((s) => ({
    ...s,
    text: expandTabs(s.text),
  }));

  // Build a mapping from plain-text char index to ANSI string position.
  // Walk the ANSI string tracking which plain char each position corresponds to.
  const plainToAnsi: number[] = []; // plainToAnsi[i] = position in fullAnsi where plain char i starts
  let plainIdx = 0;
  let ansiIdx = 0;
  while (ansiIdx < fullAnsi.length) {
    const codeLen = ansiCodeAt(fullAnsi, ansiIdx);
    if (codeLen) {
      ansiIdx += codeLen;
      continue;
    }
    plainToAnsi[plainIdx] = ansiIdx;
    plainIdx++;
    ansiIdx++;
  }
  // Sentinel: end position
  plainToAnsi[plainIdx] = ansiIdx;

  // Now split the ANSI string at segment boundaries
  let offset = 0;
  const parts: string[] = [];
  for (const seg of expandedSegments) {
    const segLen = seg.text.length;
    const start = Math.min(offset, plainToAnsi.length - 1);
    const end = Math.min(offset + segLen, plainToAnsi.length - 1);
    const ansiStart = plainToAnsi[start] ?? fullAnsi.length;
    const ansiEnd = plainToAnsi[end] ?? fullAnsi.length;
    const slice = fullAnsi.slice(ansiStart, ansiEnd);

    const segBg = seg.highlighted ? wordBgColor : bgColor;
    parts.push(segBg ? chalk.bgHex(segBg)(slice) : slice);
    offset += segLen;
  }

  return parts.join('');
}

/**
 * Renders a single line in the diff, with optional word-level highlight segments
 * and syntax highlighting.
 */
function DiffLineRenderer({
  line,
  showLineNumbers,
  segments,
  language,
  contentWidth,
}: {
  line: DiffLine;
  showLineNumbers?: boolean;
  segments?: DiffLineSegment[];
  language?: string;
  contentWidth?: number;
}) {
  let oldLine;
  let newLine;

  if (line.type === 'removed') {
    oldLine = line.lineNumber?.old;
    newLine = undefined;
  } else if (line.type === 'added') {
    oldLine = undefined;
    newLine = line.lineNumber?.new;
  } else {
    oldLine = line.lineNumber?.old;
    newLine = line.lineNumber?.new;
  }

  const bgColor =
    (line.type === 'added'
      ? DIFF_COLORS.added.bg
      : line.type === 'removed'
        ? DIFF_COLORS.removed.bg
        : undefined) || undefined;

  const wordBg =
    (line.type === 'added'
      ? DIFF_COLORS.added.wordBg
      : line.type === 'removed'
        ? DIFF_COLORS.removed.wordBg
        : undefined) || undefined;

  const textColor =
    line.type === 'added'
      ? DIFF_COLORS.added.text
      : line.type === 'removed'
        ? DIFF_COLORS.removed.text
        : DIFF_COLORS.unchanged.text;

  const hasWordHighlights = segments && segments.some((s) => s.highlighted);
  const useSyntax = !!language;

  // Defense-in-depth: strip \r that may survive from Windows CRLF files
  const sanitizedContent = line.content.replace(/\r/g, '');

  // Available width for the content area (after line numbers + 1 space indent)
  const availableWidth = contentWidth
    ? contentWidth - (showLineNumbers ? LINE_NUMBER_COL_WIDTH : 0) - 1
    : undefined;

  if (useSyntax) {
    const indent = bgColor ? chalk.bgHex(bgColor)(' ') : ' ';

    let contentStr: string;
    if (hasWordHighlights) {
      contentStr = highlightWithWordSegments(
        sanitizedContent,
        segments!,
        language,
        bgColor,
        wordBg
      );
    } else {
      const truncated = truncateLongLine(expandTabs(sanitizedContent));
      const highlighted = highlightLineToAnsi(truncated, language);
      contentStr = bgColor ? chalk.bgHex(bgColor)(highlighted) : highlighted;
    }

    const fullLine = indent + contentStr;
    const padded = padToWidth(fullLine, availableWidth ?? 0, bgColor);

    return (
      <Box flexDirection="row" width="100%">
        {showLineNumbers && (
          <Box flexShrink={0}>
            <LineNumberColumn oldLine={oldLine} newLine={newLine} />
          </Box>
        )}
        <Box flexGrow={1}>
          <Text wrap="truncate">{padded}</Text>
        </Box>
      </Box>
    );
  }

  // Non-syntax fallback
  const truncated = truncateLongLine(expandTabs(sanitizedContent));
  const trailingPad = availableWidth
    ? ' '.repeat(Math.max(0, availableWidth - 1 - displayWidth(truncated)))
    : '';

  return (
    <Box flexDirection="row" width="100%">
      {showLineNumbers && (
        <Box flexShrink={0}>
          <LineNumberColumn oldLine={oldLine} newLine={newLine} />
        </Box>
      )}
      <Box flexGrow={1}>
        <Text color={textColor} backgroundColor={bgColor} wrap="truncate">
          {' '}
          {hasWordHighlights
            ? segments!.map((seg, i) => (
                <Text
                  key={i}
                  backgroundColor={seg.highlighted ? wordBg : bgColor}
                >
                  {truncateLongLine(expandTabs(seg.text))}
                </Text>
              ))
            : truncated}
          {trailingPad}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Renders a block of context lines
 */
function ContextBlock({
  block,
  showLineNumbers,
  language,
  contentWidth,
}: {
  block: DiffBlock;
  showLineNumbers?: boolean;
  language?: string;
  contentWidth?: number;
}) {
  return (
    <Box flexDirection="column" paddingY={0}>
      {block.contextLines?.map((line) => {
        if (!line.lineNumber) {
          const separatorKey = generateStableKey(
            `context-separator-${block.id}`,
            0,
            line.content
          );
          return (
            <Box key={separatorKey} marginY={1}>
              <Text color={DIFF_COLORS.unchanged.dimText} dimColor>
                {line.content}
              </Text>
            </Box>
          );
        }

        const lineKey = generateStableKey(
          `context-${block.id}`,
          line.lineNumber?.old || line.lineNumber?.new || 0,
          line.content
        );
        return (
          <DiffLineRenderer
            key={lineKey}
            line={line}
            showLineNumbers={showLineNumbers}
            language={language}
            contentWidth={contentWidth}
          />
        );
      })}
    </Box>
  );
}

/**
 * Renders a block of changes (added/removed lines) with word-level highlights.
 */
function ChangeBlock({
  block,
  showLineNumbers,
  language,
  contentWidth,
}: {
  block: DiffBlock;
  showLineNumbers?: boolean;
  language?: string;
  contentWidth?: number;
}) {
  const wordDiffs = useMemo(
    () => computeWordDiffs(block.beforeLines, block.afterLines),
    [block.beforeLines, block.afterLines]
  );

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" width="100%">
        {block.beforeLines.map((line, i) => {
          const lineKey = generateStableKey(
            `before-${block.id}`,
            line.lineNumber?.old || 0,
            line.content
          );
          return (
            <DiffLineRenderer
              key={lineKey}
              line={line}
              showLineNumbers={showLineNumbers}
              segments={wordDiffs?.removedSegments[i]}
              language={language}
              contentWidth={contentWidth}
            />
          );
        })}

        {block.afterLines.map((line, i) => {
          const lineKey = generateStableKey(
            `after-${block.id}`,
            line.lineNumber?.new || 0,
            line.content
          );
          return (
            <DiffLineRenderer
              key={lineKey}
              line={line}
              showLineNumbers={showLineNumbers}
              segments={wordDiffs?.addedSegments[i]}
              language={language}
              contentWidth={contentWidth}
            />
          );
        })}
      </Box>
    </Box>
  );
}

/**
 * Main DiffRenderer component
 */
export function DiffRenderer({
  diffLines,
  showLineNumbers = true,
  maxWidth,
  filePath,
}: DiffRendererProps) {
  const { t } = useTranslation();
  // Group the diff lines into blocks for better visualization
  const blocks = useMemo(() => groupChangesIntoBlocks(diffLines), [diffLines]);

  // Detect language from file extension for syntax highlighting
  const language = useLanguageFromFilePath(filePath);

  // Get the user's diff mode preference
  const diffMode = getSettingsService().getDiffMode();

  // If using unified mode, render the traditional unified diff
  if (diffMode === 'unified') {
    return (
      <UnifiedDiffRenderer
        diffLines={diffLines}
        maxWidth={maxWidth}
        filePath={filePath}
      />
    );
  }

  // If no changes, show a message
  if (blocks.length === 0) {
    return (
      <Box paddingX={1} paddingY={1} width={maxWidth ?? '100%'}>
        <Text color={DIFF_COLORS.unchanged.dimText}>
          {t('common:diff.noChanges')}
        </Text>
      </Box>
    );
  }

  // Default to GitHub-style renderer
  return (
    <Box flexDirection="column" width={maxWidth ?? '100%'}>
      {blocks.map((block) => {
        const key = generateStableKey(block.id, 0, `block-${block.type}`);

        if (block.type === 'context') {
          return (
            <ContextBlock
              key={key}
              block={block}
              showLineNumbers={showLineNumbers}
              language={language}
              contentWidth={maxWidth}
            />
          );
        }
        return (
          <ChangeBlock
            key={key}
            block={block}
            showLineNumbers={showLineNumbers}
            language={language}
            contentWidth={maxWidth}
          />
        );
      })}
    </Box>
  );
}
