import { DEFAULT_OUTPUT_TRUNCATION_THRESHOLD } from './constants';

/**
 * Truncates output text to a maximum length while preserving readability.
 * Shows the beginning and end of the output to maintain context.
 *
 * The result is passed through String.toWellFormed() so that any surrogate
 * pairs broken by the substring split are replaced with U+FFFD, preventing
 * invalid JSON when the output is later serialized.
 */
export function truncateOutput(
  output: string,
  maxLength: number = DEFAULT_OUTPUT_TRUNCATION_THRESHOLD
): string {
  if (output.length <= maxLength) {
    return output;
  }

  const headSize = Math.floor(maxLength * 0.75);
  const tailSize = maxLength - headSize;

  const head = output.substring(0, headSize);
  const tail = output.substring(output.length - tailSize);

  const totalChars = output.length;
  const totalLines = output.split('\n').length;
  const truncatedChars = totalChars - maxLength;

  const formatSize = (value: number) =>
    value >= 1000 ? `${Math.floor(value / 1000)}k` : `${value}`;

  const headLines = head.split('\n').length;
  const tailLines = tail.split('\n').length;

  const result = `${head}\n\n[... truncated ${truncatedChars} characters from middle section ...]\n\n${tail}\n\n[Output truncated. Showing first ${formatSize(headSize)} characters (${headLines} lines) and last ${formatSize(tailSize)} characters (${tailLines} lines) out of ${formatSize(totalChars)} total characters (${totalLines} lines)]`;

  return result.toWellFormed();
}
