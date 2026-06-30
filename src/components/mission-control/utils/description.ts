/**
 * Parse mission description text into optional numbered items.
 * Supports segments that start with patterns like "(1)", "(2)", etc.
 */
export function parseNumberedDescription(
  description: string
): Array<{ number?: string; text: string }> {
  return description
    .split(/(?=\(\d+\))/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const match = segment.match(/^\((\d+)\)\s*/);
      if (!match) {
        return { text: segment };
      }

      return {
        number: match[1],
        text: segment.slice(match[0].length),
      };
    });
}
