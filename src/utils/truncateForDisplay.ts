/**
 * Truncate long text for display, preserving structure
 */
export function truncateForDisplay(
  text: string,
  maxLines: number = 10
): {
  displayText: string;
  isTruncated: boolean;
  totalLines: number;
  additionalLines: number;
} {
  if (!text) {
    return {
      displayText: '',
      isTruncated: false,
      totalLines: 0,
      additionalLines: 0,
    };
  }

  const lines = text.split('\n');
  const totalLines = lines.length;

  if (totalLines <= maxLines) {
    return {
      displayText: text,
      isTruncated: false,
      totalLines,
      additionalLines: 0,
    };
  }

  // Take first maxLines - 1 lines (leave room for truncation message)
  const displayLines = lines.slice(0, maxLines - 1);
  const additionalLines = totalLines - (maxLines - 1);

  return {
    displayText: displayLines.join('\n'),
    isTruncated: true,
    totalLines,
    additionalLines,
  };
}
