import * as Diff from 'diff';

import { getDiffLineStats } from './getDiffLineStats';

import type { DiffLine, DiffLineSegment, DiffLineStats } from './types';

/**
 * Generate a unified diff between two strings
 * @param oldContent Original content
 * @param newContent Modified content
 * @param contextLines Number of context lines to show around changes (default: 3)
 * @returns Array of diff lines
 */
export function generateUnifiedDiff(
  oldContent: string,
  newContent: string,
  contextLines: number = 3
): DiffLine[] {
  const safeOld = (
    typeof oldContent === 'string' ? oldContent : String(oldContent ?? '')
  ).replace(/\r\n/g, '\n');
  const safeNew = (
    typeof newContent === 'string' ? newContent : String(newContent ?? '')
  ).replace(/\r\n/g, '\n');

  const diffLines: DiffLine[] = [];

  // Fast-path: both empty
  if (!safeOld && !safeNew) {
    return diffLines;
  }

  // Fast-path: file creation
  if (!safeOld && safeNew) {
    const lines = safeNew.split('\n');
    let newLineNum = 1;
    for (const l of lines) {
      if (l === '' && newLineNum === lines.length) break; // ignore trailing newline
      diffLines.push({
        type: 'added',
        content: l,
        lineNumber: { new: newLineNum++ },
      });
    }
    return diffLines;
  }

  // Fast-path: file deletion
  if (safeOld && !safeNew) {
    const lines = safeOld.split('\n');
    let oldLineNum = 1;
    for (const l of lines) {
      if (l === '' && oldLineNum === lines.length) break;
      diffLines.push({
        type: 'removed',
        content: l,
        lineNumber: { old: oldLineNum++ },
      });
    }
    return diffLines;
  }

  // Use the diff library to generate a unified diff
  const changes = Diff.diffLines(safeOld, safeNew);

  let oldLineNum = 1;
  let newLineNum = 1;
  let hasChanges = false;

  // First pass: check if there are any actual changes
  for (const change of changes) {
    if (change.added || change.removed) {
      hasChanges = true;
      break;
    }
  }

  if (!hasChanges) {
    return [];
  }

  // Find the first and last change indices
  let firstChangeIndex = -1;
  let lastChangeIndex = -1;
  for (let i = 0; i < changes.length; i++) {
    if (changes[i].added || changes[i].removed) {
      if (firstChangeIndex === -1) firstChangeIndex = i;
      lastChangeIndex = i;
    }
  }

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const lines = (change.value || '').split('\n').filter(
      (_, idx, arr) =>
        // Remove empty last line if it's a result of split
        !(idx === arr.length - 1 && arr[idx] === '')
    );

    if (change.added) {
      // Lines added
      for (const line of lines) {
        diffLines.push({
          type: 'added',
          content: line,
          lineNumber: { new: newLineNum++ },
        });
      }
    } else if (change.removed) {
      // Lines removed
      for (const line of lines) {
        diffLines.push({
          type: 'removed',
          content: line,
          lineNumber: { old: oldLineNum++ },
        });
      }
    } else if (i < firstChangeIndex) {
      // Skip unchanged lines at the very start if they're far from first change
      const linesToSkip = Math.max(0, lines.length - contextLines);
      if (linesToSkip > 0) {
        oldLineNum += linesToSkip;
        newLineNum += linesToSkip;
        // Show only the last contextLines before the first change
        for (let j = linesToSkip; j < lines.length; j++) {
          diffLines.push({
            type: 'unchanged',
            content: lines[j],
            lineNumber: { old: oldLineNum++, new: newLineNum++ },
          });
        }
      } else {
        // Show all lines if within context range
        for (const line of lines) {
          diffLines.push({
            type: 'unchanged',
            content: line,
            lineNumber: { old: oldLineNum++, new: newLineNum++ },
          });
        }
      }
    } else if (i > lastChangeIndex) {
      // Skip unchanged lines at the very end if they're far from last change
      // Show only the first contextLines after the last change
      const linesToShow = Math.min(contextLines, lines.length);
      for (let j = 0; j < linesToShow; j++) {
        diffLines.push({
          type: 'unchanged',
          content: lines[j],
          lineNumber: { old: oldLineNum++, new: newLineNum++ },
        });
      }
      // Skip the rest
      oldLineNum += lines.length - linesToShow;
      newLineNum += lines.length - linesToShow;
    } else if (lines.length <= contextLines * 2) {
      // Handle unchanged lines between changes
      // Show all lines if the block is small
      for (const line of lines) {
        diffLines.push({
          type: 'unchanged',
          content: line,
          lineNumber: { old: oldLineNum++, new: newLineNum++ },
        });
      }
    } else {
      // Show context lines at start
      for (let j = 0; j < contextLines && j < lines.length; j++) {
        diffLines.push({
          type: 'unchanged',
          content: lines[j],
          lineNumber: { old: oldLineNum++, new: newLineNum++ },
        });
      }

      // Add separator if there are hidden lines
      const hiddenLines = lines.length - contextLines * 2;
      if (hiddenLines > 0) {
        diffLines.push({
          type: 'unchanged',
          content: `... ${hiddenLines} unchanged lines ...`,
        });
        oldLineNum += hiddenLines;
        newLineNum += hiddenLines;
      }

      // Show context lines at end
      for (let j = lines.length - contextLines; j < lines.length; j++) {
        if (j >= contextLines) {
          diffLines.push({
            type: 'unchanged',
            content: lines[j],
            lineNumber: { old: oldLineNum++, new: newLineNum++ },
          });
        }
      }
    }
  }

  return diffLines;
}

export function getContentDiffLineStats(
  oldContent: string | undefined,
  newContent: string | undefined
): DiffLineStats {
  return getDiffLineStats(
    generateUnifiedDiff(oldContent ?? '', newContent ?? '')
  );
}

export function countUnifiedDiffLines(diff: string | undefined): DiffLineStats {
  if (!diff) return { additions: 0, deletions: 0 };

  let inHunk = false;
  return diff.split('\n').reduce<DiffLineStats>(
    (stats, line) => {
      if (line.startsWith('diff --git')) {
        inHunk = false;
        return stats;
      }
      if (line.startsWith('@@')) {
        inHunk = true;
        return stats;
      }
      if (!inHunk) {
        return stats;
      }
      if (line.startsWith('+')) {
        stats.additions += 1;
      } else if (line.startsWith('-')) {
        stats.deletions += 1;
      }
      return stats;
    },
    { additions: 0, deletions: 0 }
  );
}

export function getDiffSummary(diffLines: DiffLine[]): string {
  const { additions, deletions } = getDiffLineStats(diffLines);

  const parts: string[] = [];
  if (additions > 0) parts.push(`+${additions} added`);
  if (deletions > 0) parts.push(`-${deletions} removed`);

  return parts.length > 0 ? `(${parts.join(', ')})` : '(no changes)';
}

/**
 * Smart truncation that shows all changes and collapses only unchanged sections
 * @param diffLines Array of diff lines
 * @param contextLines Number of context lines to show around changes (default: 3)
 * @param maxUnchangedBlock Maximum consecutive unchanged lines to show (default: 6)
 * @returns Smart truncated diff lines
 */
export function smartTruncateDiff(
  diffLines: DiffLine[],
  contextLines: number = 3,
  maxUnchangedBlock: number = 6
): DiffLine[] {
  const result: DiffLine[] = [];
  let unchangedBuffer: DiffLine[] = [];

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];

    if (line.type === 'unchanged' && line.lineNumber) {
      // Accumulate unchanged lines
      unchangedBuffer.push(line);
    } else if (line.type === 'added' || line.type === 'removed') {
      // Found a change, process the unchanged buffer
      if (unchangedBuffer.length > 0) {
        if (unchangedBuffer.length <= maxUnchangedBlock) {
          // Show all unchanged lines if the block is small
          result.push(...unchangedBuffer);
        } else {
          // Show context lines before the change
          const beforeContext = unchangedBuffer.slice(-contextLines);
          const hiddenCount = unchangedBuffer.length - contextLines;

          // Add context lines at the start if this is not the first block
          if (result.length > 0 && hiddenCount > contextLines) {
            result.push(...unchangedBuffer.slice(0, contextLines));
            result.push({
              type: 'unchanged',
              content: `... ${hiddenCount - contextLines} unchanged lines ...`,
            });
          }

          result.push(...beforeContext);
        }
        unchangedBuffer = [];
      }

      // Add the changed line
      result.push(line);
    } else {
      // Separator or other non-line content
      if (unchangedBuffer.length > 0) {
        // Process any buffered unchanged lines
        if (unchangedBuffer.length <= maxUnchangedBlock) {
          result.push(...unchangedBuffer);
        } else {
          result.push(...unchangedBuffer.slice(0, contextLines));
          const hiddenCount = unchangedBuffer.length - contextLines * 2;
          if (hiddenCount > 0) {
            result.push({
              type: 'unchanged',
              content: `... ${hiddenCount} unchanged lines ...`,
            });
          }
          result.push(...unchangedBuffer.slice(-contextLines));
        }
        unchangedBuffer = [];
      }
      result.push(line);
    }
  }

  // Process any remaining unchanged lines at the end
  if (unchangedBuffer.length > 0) {
    if (unchangedBuffer.length <= maxUnchangedBlock) {
      result.push(...unchangedBuffer);
    } else {
      result.push(...unchangedBuffer.slice(0, contextLines));
      const hiddenCount = unchangedBuffer.length - contextLines;
      if (hiddenCount > 0) {
        result.push({
          type: 'unchanged',
          content: `... ${hiddenCount} unchanged lines ...`,
        });
      }
    }
  }

  return result;
}

/**
 * Find common prefix/suffix between two strings and split into segments.
 * Inspired by diff-so-fancy's DiffHighlight approach: instead of word-level
 * diffing that produces multiple disjoint highlights, find the single
 * contiguous changed region by locating common prefix and suffix.
 */
function highlightPairPrefixSuffix(
  oldText: string,
  newText: string
): { oldSegs: DiffLineSegment[]; newSegs: DiffLineSegment[] } {
  const oldChars = [...oldText];
  const newChars = [...newText];

  // Find common prefix length
  let prefixLen = 0;
  while (
    prefixLen < oldChars.length &&
    prefixLen < newChars.length &&
    oldChars[prefixLen] === newChars[prefixLen]
  ) {
    prefixLen++;
  }

  // Find common suffix length (don't overlap with prefix)
  let suffixLen = 0;
  while (
    suffixLen < oldChars.length - prefixLen &&
    suffixLen < newChars.length - prefixLen &&
    oldChars[oldChars.length - 1 - suffixLen] ===
      newChars[newChars.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldPrefix = oldChars.slice(0, prefixLen).join('');
  const oldMid = oldChars
    .slice(prefixLen, oldChars.length - suffixLen)
    .join('');
  const oldSuffix = oldChars.slice(oldChars.length - suffixLen).join('');

  const newPrefix = newChars.slice(0, prefixLen).join('');
  const newMid = newChars
    .slice(prefixLen, newChars.length - suffixLen)
    .join('');
  const newSuffix = newChars.slice(newChars.length - suffixLen).join('');

  // Interestingness check: only highlight if we're highlighting a subset of the
  // line. If the prefix is only whitespace and the suffix is empty (or vice
  // versa), the entire meaningful content changed -- skip highlighting.
  const prefixInteresting = oldPrefix.trim().length > 0;
  const suffixInteresting = oldSuffix.trim().length > 0;

  if (!prefixInteresting && !suffixInteresting) {
    return {
      oldSegs: [{ text: oldText, highlighted: false }],
      newSegs: [{ text: newText, highlighted: false }],
    };
  }

  const buildSegments = (
    prefix: string,
    mid: string,
    suffix: string
  ): DiffLineSegment[] => {
    const segs: DiffLineSegment[] = [];
    if (prefix) segs.push({ text: prefix, highlighted: false });
    if (mid) segs.push({ text: mid, highlighted: true });
    if (suffix) segs.push({ text: suffix, highlighted: false });
    if (segs.length === 0) segs.push({ text: '', highlighted: false });
    return segs;
  };

  return {
    oldSegs: buildSegments(oldPrefix, oldMid, oldSuffix),
    newSegs: buildSegments(newPrefix, newMid, newSuffix),
  };
}

/**
 * Compute word-level diffs for paired removed/added lines using a common
 * prefix/suffix strategy (inspired by diff-so-fancy). Produces at most one
 * contiguous highlighted region per line.
 * Returns null when line counts don't match (can't pair).
 */
export function computeWordDiffs(
  removedLines: DiffLine[],
  addedLines: DiffLine[]
): {
  removedSegments: DiffLineSegment[][];
  addedSegments: DiffLineSegment[][];
} | null {
  if (removedLines.length === 0 || addedLines.length === 0) {
    return null;
  }
  if (removedLines.length !== addedLines.length) {
    return null;
  }

  const removedSegments: DiffLineSegment[][] = [];
  const addedSegments: DiffLineSegment[][] = [];

  for (let i = 0; i < removedLines.length; i++) {
    const oldText = removedLines[i].content;
    const newText = addedLines[i].content;

    const { oldSegs, newSegs } = highlightPairPrefixSuffix(oldText, newText);
    removedSegments.push(oldSegs);
    addedSegments.push(newSegs);
  }

  return { removedSegments, addedSegments };
}
