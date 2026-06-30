/**
 * Extract an HTTP-like status code from an error message string.
 *
 * Prefers 4xx/5xx codes (common error ranges) when present, but
 * will fall back to any 3-digit number as a best-effort guess.
 */
export function extractStatusCodeFromMessage(
  errorMessage: string
): number | undefined {
  // Prefer common HTTP error ranges (4xx, 5xx) when present in the message
  const preferredStatusMatch = errorMessage.match(/\b(4\d\d|5\d\d)\b/);
  if (preferredStatusMatch) {
    return Number.parseInt(preferredStatusMatch[1], 10);
  }

  const anyStatusMatch = errorMessage.match(/\b(\d{3})\b/);
  if (anyStatusMatch) {
    return Number.parseInt(anyStatusMatch[1], 10);
  }

  return undefined;
}
