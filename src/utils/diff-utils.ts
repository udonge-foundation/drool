import {
  computeWordDiffs as computeSharedWordDiffs,
  generateUnifiedDiff as generateSharedUnifiedDiff,
  getDiffSummary as getSharedDiffSummary,
  smartTruncateDiff as smartSharedTruncateDiff,
} from '@industry/utils/text';

import type { DiffLine, DiffLineSegment } from '@/utils/types';

export function generateUnifiedDiff(
  oldContent: string,
  newContent: string,
  contextLines: number = 3
): DiffLine[] {
  return generateSharedUnifiedDiff(oldContent, newContent, contextLines);
}

export function getDiffSummary(diffLines: DiffLine[]): string {
  return getSharedDiffSummary(diffLines);
}

export function smartTruncateDiff(
  diffLines: DiffLine[],
  contextLines: number = 3,
  maxUnchangedBlock: number = 6
): DiffLine[] {
  return smartSharedTruncateDiff(diffLines, contextLines, maxUnchangedBlock);
}

export function computeWordDiffs(
  removedLines: DiffLine[],
  addedLines: DiffLine[]
): {
  removedSegments: DiffLineSegment[][];
  addedSegments: DiffLineSegment[][];
} | null {
  return computeSharedWordDiffs(removedLines, addedLines);
}
