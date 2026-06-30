interface ColumnWidthsInput {
  remainingWidth: number;
  maxPathWidth: number;
  showPath: boolean;
  titlePathGap?: number;
  minTitleWidth?: number;
  pathTitleReserve?: number;
}

interface ColumnWidthsResult {
  pathWidth: number;
  titleWidth: number;
}

export function computeTitlePathColumnWidths({
  remainingWidth,
  maxPathWidth,
  showPath,
  titlePathGap = 2,
  minTitleWidth = 16,
  pathTitleReserve = 16,
}: ColumnWidthsInput): ColumnWidthsResult {
  if (!showPath) {
    return { pathWidth: 0, titleWidth: remainingWidth };
  }
  const pathWidth = Math.min(
    maxPathWidth,
    remainingWidth - pathTitleReserve - titlePathGap
  );
  const titleWidth = Math.max(
    minTitleWidth,
    remainingWidth - pathWidth - titlePathGap
  );
  return { pathWidth, titleWidth };
}
