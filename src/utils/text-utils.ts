/**
 * Extracts the last N non-empty lines from a text string
 * Always returns exactly N lines (padding with empty lines if needed)
 */
export function getLastNLines(text: string, n: number): string {
  if (!text) return Array(n).fill('').join('\n');

  const allLines = text.split('\n');
  // Filter to get only non-empty lines
  const nonEmptyLines = allLines.filter((line) => line.trim().length > 0);

  if (nonEmptyLines.length === 0) {
    // No non-empty lines, return n empty lines
    return Array(n).fill('').join('\n');
  }

  if (nonEmptyLines.length >= n) {
    // We have enough non-empty lines, return the last n
    return nonEmptyLines.slice(-n).join('\n');
  }

  // We have fewer non-empty lines than requested
  // Pad with empty lines at the beginning to always return exactly n lines
  const padding = Array(n - nonEmptyLines.length).fill('');
  return [...padding, ...nonEmptyLines].join('\n');
}

/**
 * Truncates a line to fit within the given width, adding ellipsis if needed
 */
export function truncateLine(line: string, width?: number): string {
  if (!width || width <= 0) return line;

  // Account for indent (2 spaces for non-first line, or "↳ " for first line)
  const effectiveWidth = width - 2;

  if (line.length <= effectiveWidth) {
    return line;
  }

  // Leave room for ellipsis
  const truncateAt = effectiveWidth - 3;
  if (truncateAt <= 0) {
    return '...';
  }

  return `${line.substring(0, truncateAt)}...`;
}
