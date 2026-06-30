import chalk from 'chalk';
import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { getThemedColors } from '@/components/chat/themedColors';
import { useLanguageFromFilePath } from '@/hooks/useLanguageFromFilePath';
import { padToWidth } from '@/utils/ansi-utils';
import { displayWidth } from '@/utils/displayWidth';
import { highlightLineToAnsi } from '@/utils/syntaxHighlighter/highlight';
import { truncateLongLine } from '@/utils/truncate';
import type { DiffLine } from '@/utils/types';

const TAB_SPACES = '    '; // 4-space tab expansion

function expandTabs(text: string): string {
  return text.includes('\t') ? text.replace(/\t/g, TAB_SPACES) : text;
}

// Get themed colors at runtime
function getUnifiedDiffColors() {
  const colors = getThemedColors();
  return {
    header: colors.diff.header,
    added: colors.diff.added.text,
    addedBg: colors.diff.added.bg,
    removed: colors.diff.removed.text,
    removedBg: colors.diff.removed.bg,
    unchanged: colors.diff.unchanged.text,
  };
}

// Lazy proxy so colors are always re-evaluated at access time.
type UnifiedDiffColors = ReturnType<typeof getUnifiedDiffColors>;
const UNIFIED_DIFF_COLORS: UnifiedDiffColors = new Proxy(
  {} as UnifiedDiffColors,
  {
    get(_target, prop) {
      return getUnifiedDiffColors()[prop as keyof UnifiedDiffColors];
    },
  }
);

interface UnifiedDiffRendererProps {
  diffLines: DiffLine[];
  // Optional maximum width (columns). When provided, the renderer won't exceed this width.
  maxWidth?: number;
  // Optional file path for syntax highlighting.
  filePath?: string;
}

/**
 * Renders a single line in the traditional unified diff format
 */
function UnifiedDiffLineRenderer({
  line,
  language,
  contentWidth,
}: {
  line: DiffLine;
  language?: string;
  contentWidth?: number;
}) {
  const prefix =
    line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';

  const textColor =
    line.type === 'added'
      ? UNIFIED_DIFF_COLORS.added
      : line.type === 'removed'
        ? UNIFIED_DIFF_COLORS.removed
        : UNIFIED_DIFF_COLORS.unchanged;

  const bgColor =
    (line.type === 'added'
      ? UNIFIED_DIFF_COLORS.addedBg
      : line.type === 'removed'
        ? UNIFIED_DIFF_COLORS.removedBg
        : undefined) || undefined;

  // Defense-in-depth: strip \r that may survive from Windows CRLF files
  const sanitizedContent = line.content.replace(/\r/g, '');
  const truncated = truncateLongLine(expandTabs(sanitizedContent));

  if (language) {
    const highlighted = highlightLineToAnsi(truncated, language);
    const indent = bgColor ? chalk.bgHex(bgColor)(prefix) : prefix;
    const contentStyled = bgColor
      ? chalk.bgHex(bgColor)(highlighted)
      : highlighted;
    const fullLine = indent + contentStyled;
    const padded = padToWidth(fullLine, contentWidth ?? 0, bgColor);

    return <Text wrap="truncate">{padded}</Text>;
  }

  const trailingPad = contentWidth
    ? ' '.repeat(Math.max(0, contentWidth - 1 - displayWidth(truncated)))
    : '';

  return (
    <Text color={textColor} backgroundColor={bgColor} wrap="truncate">
      {prefix}
      {truncated}
      {trailingPad}
    </Text>
  );
}

/**
 * Interface for a change block with context
 */
interface ChangeBlock {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
  // Pre-computed keys for performance
  blockKey?: string;
  lineKeys?: string[];
}

/**
 * Renders a traditional unified diff format like git diff
 * Shows line range headers and uses simple text colors
 */
export function UnifiedDiffRenderer({
  diffLines,
  maxWidth,
  filePath,
}: UnifiedDiffRendererProps) {
  const { t } = useTranslation();

  const language = useLanguageFromFilePath(filePath);

  if (diffLines.length === 0) {
    return (
      <Box width={maxWidth ?? '100%'}>
        <Text color={UNIFIED_DIFF_COLORS.unchanged}>
          {t('common:diff.noChanges')}
        </Text>
      </Box>
    );
  }

  // Group changes into blocks with context
  const changeBlocks = useMemo(() => {
    const blocks: ChangeBlock[] = [];
    let currentBlock: ChangeBlock | null = null;
    const contextSize = 3; // Number of context lines before/after changes

    // Helper to finalize a block and add it to blocks array
    const finalizeBlock = () => {
      if (currentBlock && currentBlock.lines.length > 0) {
        blocks.push(currentBlock);
      }
    };

    // Helper to start a new block
    const startNewBlock = (line: DiffLine) => {
      // Find the first line with a line number to use as the start
      const oldStart = line.lineNumber?.old || 1;
      const newStart = line.lineNumber?.new || 1;

      currentBlock = {
        oldStart,
        oldCount: 0,
        newStart,
        newCount: 0,
        lines: [],
      };
    };

    // First pass: identify change regions (added/removed lines)
    const changeRegions: { start: number; end: number }[] = [];
    let currentRegionStart = -1;

    // Also identify separator lines
    const separatorIndices: number[] = [];

    diffLines.forEach((line, i) => {
      // Track separator lines
      if (!line.lineNumber && line.content.includes('unchanged lines')) {
        separatorIndices.push(i);
        return;
      }

      if (line.type === 'added' || line.type === 'removed') {
        if (currentRegionStart === -1) {
          currentRegionStart = i;
        }
      } else if (currentRegionStart !== -1) {
        changeRegions.push({ start: currentRegionStart, end: i - 1 });
        currentRegionStart = -1;
      }
    });

    // Handle the last region if it exists
    if (currentRegionStart !== -1) {
      changeRegions.push({
        start: currentRegionStart,
        end: diffLines.length - 1,
      });
    }

    // Second pass: create blocks with context
    if (changeRegions.length === 0) {
      // No changes, just show a few lines
      const linesToShow = Math.min(diffLines.length, 5);
      startNewBlock(diffLines[0]);

      for (let i = 0; i < linesToShow; i++) {
        const line = diffLines[i];
        currentBlock!.lines.push(line);
        if (line.lineNumber?.old) currentBlock!.oldCount++;
        if (line.lineNumber?.new) currentBlock!.newCount++;
      }

      finalizeBlock();
    } else {
      // Process each change region with context
      changeRegions.forEach((region, _regionIndex) => {
        const contextStart = Math.max(0, region.start - contextSize);
        const contextEnd = Math.min(
          diffLines.length - 1,
          region.end + contextSize
        );

        // Always create a new block for each change region
        finalizeBlock();

        // Find the first line with a line number to use as the start
        let firstLineWithNumber = contextStart;
        while (firstLineWithNumber <= contextEnd) {
          const line = diffLines[firstLineWithNumber];
          if (line.lineNumber?.old || line.lineNumber?.new) {
            break;
          }
          firstLineWithNumber++;
        }

        // If we found a line with a number, use it as the start
        if (firstLineWithNumber <= contextEnd) {
          startNewBlock(diffLines[firstLineWithNumber]);
        } else {
          // Fallback to the context start
          startNewBlock(diffLines[contextStart]);
        }

        // Add lines to the current block
        for (let i = contextStart; i <= contextEnd; i++) {
          const line = diffLines[i];

          // Skip separator lines
          if (!line.lineNumber && line.content.includes('unchanged lines')) {
            continue;
          }

          currentBlock!.lines.push(line);

          // Update line counts
          if (line.type === 'unchanged' || line.type === 'removed') {
            if (line.lineNumber?.old) currentBlock!.oldCount++;
          }

          if (line.type === 'unchanged' || line.type === 'added') {
            if (line.lineNumber?.new) currentBlock!.newCount++;
          }
        }
      });

      finalizeBlock();
    }

    // Pre-compute keys for performance optimization
    const blocksWithKeys = blocks.map((block, blockIndex) => ({
      ...block,
      blockKey: `unified-block-${blockIndex}`,
      lineKeys: block.lines.map(
        (_, lineIndex) => `unified-line-${blockIndex}-${lineIndex}`
      ),
    }));

    return blocksWithKeys;
  }, [diffLines]);

  return (
    <Box flexDirection="column" width={maxWidth ?? '100%'}>
      {changeBlocks.map((block) => (
        <Box key={block.blockKey} flexDirection="column" width="100%">
          {/* Header line */}
          <Text color={UNIFIED_DIFF_COLORS.header}>
            @@ -{block.oldStart},{block.oldCount} +{block.newStart},
            {block.newCount} @@
          </Text>

          {/* Content lines */}
          {block.lines.map((line, lineIndex) => (
            <Box
              key={block.lineKeys?.[lineIndex] || `line-${lineIndex}`}
              width="100%"
            >
              <UnifiedDiffLineRenderer
                line={line}
                language={language}
                contentWidth={maxWidth}
              />
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
