export function getWindowedListSlice<T>({
  items,
  selectedIndex,
  visibleCount,
  anchorRow = 0,
}: {
  items: T[];
  selectedIndex: number;
  visibleCount: number;
  anchorRow?: number;
}): {
  windowStart: number;
  visibleItems: T[];
  padCount: number;
} {
  if (visibleCount <= 0) {
    return {
      windowStart: 0,
      visibleItems: [],
      padCount: 0,
    };
  }

  if (items.length === 0) {
    return {
      windowStart: 0,
      visibleItems: [],
      padCount: visibleCount,
    };
  }

  const clampedIndex = Math.max(0, Math.min(selectedIndex, items.length - 1));
  const effectiveAnchorRow = Math.max(0, Math.min(anchorRow, visibleCount - 1));
  const idealStart = clampedIndex - effectiveAnchorRow;
  const maxStart = Math.max(0, items.length - visibleCount);
  const windowStart = Math.max(0, Math.min(idealStart, maxStart));
  const visibleItems = items.slice(windowStart, windowStart + visibleCount);

  return {
    windowStart,
    visibleItems,
    padCount: Math.max(0, visibleCount - visibleItems.length),
  };
}
