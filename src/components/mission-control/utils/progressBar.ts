type ProgressBarCounts = {
  completed: number;
  pending: number;
  estimated: number;
};

function sanitizeProgressBarCounts(counts: ProgressBarCounts): number[] {
  return [counts.completed, counts.pending, counts.estimated].map((count) =>
    Math.max(0, count)
  );
}

export function getProgressDisplayTotal(counts: ProgressBarCounts): number {
  return sanitizeProgressBarCounts(counts).reduce(
    (sum, count) => sum + count,
    0
  );
}

export function allocateProgressBarSegments(
  counts: ProgressBarCounts,
  barWidth: number
): {
  filled: number;
  pending: number;
  estimate: number;
} {
  const sanitizedCounts = sanitizeProgressBarCounts(counts);
  const totalCount = getProgressDisplayTotal(counts);

  if (barWidth <= 0) {
    return { filled: 0, pending: 0, estimate: 0 };
  }

  if (totalCount === 0) {
    return { filled: 0, pending: 0, estimate: barWidth };
  }

  const nonZeroSegmentCount = sanitizedCounts.filter(
    (count) => count > 0
  ).length;
  const baseWidths: number[] =
    barWidth >= nonZeroSegmentCount
      ? sanitizedCounts.map((count) => (count > 0 ? 1 : 0))
      : sanitizedCounts.map(() => 0);
  const reservedWidth = baseWidths.reduce((sum, width) => sum + width, 0);
  const distributableWidth = Math.max(0, barWidth - reservedWidth);
  const rawExtras = sanitizedCounts.map((count) =>
    count > 0 ? (count / totalCount) * distributableWidth : 0
  );
  const extraWidths: number[] = rawExtras.map((width) => Math.floor(width));
  const leftoverWidth =
    distributableWidth - extraWidths.reduce((sum, width) => sum + width, 0);

  const rankedRemainders = rawExtras
    .map((width, index) => ({
      index,
      remainder: width - Math.floor(width),
      weight: sanitizedCounts[index] ?? 0,
    }))
    .filter(({ weight }) => weight > 0)
    .sort(
      (a, b) =>
        b.remainder - a.remainder || b.weight - a.weight || a.index - b.index
    );

  for (let i = 0; i < leftoverWidth; i++) {
    const target = rankedRemainders[i % rankedRemainders.length];
    if (!target) {
      break;
    }
    extraWidths[target.index] = (extraWidths[target.index] ?? 0) + 1;
  }

  const widths = baseWidths.map(
    (baseWidth, index) => baseWidth + (extraWidths[index] ?? 0)
  );

  return {
    filled: widths[0] ?? 0,
    pending: widths[1] ?? 0,
    estimate: widths[2] ?? 0,
  };
}
