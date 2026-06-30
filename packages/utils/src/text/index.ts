export {
  computeWordDiffs,
  countUnifiedDiffLines,
  generateUnifiedDiff,
  getContentDiffLineStats,
  getDiffSummary,
  smartTruncateDiff,
} from './diff-lines';
export { getDiff } from './diff';
export { matchesGlobPattern } from './glob';
export { isMarkdownContent } from './markdown';
export type { DiffLine, DiffLineSegment, DiffLineStats } from './types';
export { sanitizeDeepToWellFormed } from './unicode';
