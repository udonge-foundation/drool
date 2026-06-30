/**
 * Utility for handling pasted text in terminal inputs.
 * Removes bracketed paste mode escape sequences and control characters.
 */

/**
 * Clean up pasted text by removing control characters and bracketed paste escape sequences.
 * When text is pasted in terminal applications, it often includes special escape sequences
 * like [200~ at the start. This function strips those out.
 *
 * @param text - The raw text from the input
 * @returns Cleaned text with control characters and escape sequences removed
 */
export function cleanPastedText(text: string): string {
  return (
    text
      // Remove all control characters (including ESC sequences)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]/g, '')
      // Clean up any leftover bracket patterns from bracketed paste mode
      .replace(/\[[0-9;]*[A-Za-z~]/g, '')
  );
}
