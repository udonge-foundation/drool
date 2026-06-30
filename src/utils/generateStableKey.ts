/**
 * Generate a stable key for React components based on content and index
 * This avoids using Math.random() which causes React key warnings
 */
export function generateStableKey(
  content: string,
  index: number,
  prefix?: string
): string {
  // Simple hash function for strings
  const hashString = (str: string): number => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      // eslint-disable-next-line no-bitwise
      hash = (hash << 5) - hash + char;
      // eslint-disable-next-line no-bitwise
      hash &= hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  };

  // Take first 50 chars of content for hashing
  const contentPart = content.substring(0, 50).replace(/[^a-zA-Z0-9]/g, '');
  const contentHash = hashString(content);

  const parts = [
    prefix,
    index,
    contentPart.substring(0, 20),
    contentHash.toString(36),
    content.length,
  ].filter(Boolean);

  return parts.join('-');
}
