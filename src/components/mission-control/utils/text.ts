/**
 * Mission Control text utilities.
 */

/** Truncate text with ellipsis if it exceeds maxLength */
export function truncateWithEllipsis(text: string, maxLength: number): string {
  const sanitized = String(text ?? '').replace(/[\r\n]+/g, ' ');
  if (sanitized.length <= maxLength) {
    return sanitized;
  }
  if (maxLength <= 3) {
    return sanitized.slice(0, maxLength);
  }
  return `${sanitized.slice(0, maxLength - 1)}…`;
}

/**
 * Format timestamp for Workers list display.
 * - Same calendar day as `now`: show HH:MM local time
 * - Different calendar day: show MM/DD (zero-padded)
 *
 * Accepts an optional `now` parameter for deterministic testing.
 */
export function formatStartTime(
  isoTimestamp: string | undefined,
  now?: Date
): string {
  if (!isoTimestamp) {
    return '-';
  }
  try {
    const date = new Date(isoTimestamp);
    if (Number.isNaN(date.getTime())) {
      return '-';
    }
    const today = now ?? new Date();
    const isSameDay =
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate();

    if (isSameDay) {
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');
      return `${hours}:${minutes}`;
    }

    // Different day: show MM/DD (zero-padded, 1-indexed month)
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${month}/${day}`;
  } catch {
    return '-';
  }
}

/**
 * Wrap text to fit within a given width, breaking at word boundaries.
 * Returns an array of lines.
 */
export function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine = word;
    } else if (currentLine.length + 1 + word.length <= maxWidth) {
      currentLine = `${currentLine} ${word}`;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [''];
}
