/**
 * Utility functions for slicing file content by line ranges.
 */

/**
 * Options for slicing content by line ranges
 */
interface LineSliceOptions {
  /**
   * Start line number (1-based, inclusive)
   * If not provided, slicing starts from the first line
   */
  start?: number;

  /**
   * End line number (1-based, inclusive)
   * If not provided, slicing ends at the last line or at start + maxLines
   */
  end?: number;

  /**
   * Maximum number of lines to include
   * Used as a fallback when end is not specified
   */
  maxLines?: number;

  /**
   * Maximum number of characters to include
   * Applied after line slicing to handle files with very long lines (e.g., minified JSON)
   */
  maxChars?: number;
}

/**
 * Result of slicing content by line range
 */
interface LineSliceResult {
  /**
   * The sliced content
   */
  content: string;

  /**
   * The actual start line (1-based)
   */
  actualStart: number;

  /**
   * The actual end line (1-based)
   */
  actualEnd: number;

  /**
   * Total number of lines in the original content
   */
  totalLines: number;

  /**
   * Whether the content was truncated due to line limits
   */
  isTruncated: boolean;

  /**
   * Whether the content was truncated due to character limits
   */
  isCharTruncated?: boolean;
}

/**
 * Slices the content by line range.
 *
 * @param content - The full content to slice
 * @param options - Options for slicing
 * @returns The sliced content and metadata
 *
 * @example
 * // Get lines 10-20 from content
 * const result = sliceContentByLines(content, { start: 10, end: 20 });
 *
 * @example
 * // Get first 100 lines
 * const result = sliceContentByLines(content, { maxLines: 100 });
 */
export function sliceContentByLines(
  content: string,
  options: LineSliceOptions = {}
): LineSliceResult {
  // Split content into lines
  const lines = content.split('\n');
  const totalLines = lines.length;

  // Normalize options with defaults
  const { start = 1, maxLines = Number.MAX_SAFE_INTEGER, maxChars } = options;

  // Calculate end if not provided
  let { end } = options;
  if (end === undefined) {
    end = Math.min(totalLines, start + maxLines - 1);
  }

  // Validate and adjust start/end
  const normalizedStart = Math.max(1, Math.min(start, totalLines));
  let normalizedEnd = Math.max(normalizedStart, Math.min(end, totalLines));

  // Check if content is truncated by lines
  const isLineTruncated = normalizedStart > 1 || normalizedEnd < totalLines;

  // If start is beyond the file length, return empty content
  if (start > totalLines) {
    return {
      content: '',
      actualStart: normalizedStart,
      actualEnd: normalizedEnd,
      totalLines,
      isTruncated: isLineTruncated,
      isCharTruncated: false,
    };
  }

  // Extract the lines (adjusting for 0-based array indexing)
  const slicedLines = lines.slice(normalizedStart - 1, normalizedEnd);
  let resultContent = slicedLines.join('\n');
  let isCharTruncated = false;

  // Apply character limit if specified
  if (maxChars !== undefined && resultContent.length > maxChars) {
    isCharTruncated = true;

    // Truncate to maxChars then find last complete line
    const truncated = resultContent.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');

    if (lastNewline > 0) {
      resultContent = truncated.slice(0, lastNewline);
      normalizedEnd = normalizedStart + resultContent.split('\n').length - 1;
    } else {
      // No newline found - either single line or first line exceeds limit
      resultContent = truncated;
      normalizedEnd = normalizedStart;
    }
  }

  return {
    content: resultContent,
    actualStart: normalizedStart,
    actualEnd: normalizedEnd,
    totalLines,
    isTruncated: isLineTruncated || isCharTruncated,
    isCharTruncated,
  };
}
