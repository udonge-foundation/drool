import type { DiffLine, DiffLineStats } from './types';

export function getDiffLineStats(diffLines: DiffLine[]): DiffLineStats {
  return diffLines.reduce<DiffLineStats>(
    (stats, line) => {
      if (line.type === 'added') {
        stats.additions += 1;
      } else if (line.type === 'removed') {
        stats.deletions += 1;
      }
      return stats;
    },
    { additions: 0, deletions: 0 }
  );
}
