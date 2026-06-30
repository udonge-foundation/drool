/**
 * Normalizes a server name so it is safe for MCP usage.
 *
 * Behaviour:
 *  • Converts whitespace, slashes, and most punctuation to a single hyphen (`-`)
 *  • Removes any remaining characters not matching `[a-zA-Z0-9_-]`
 *  • Collapses duplicate hyphens and trims leading/trailing hyphens
 *  • Truncates the result to **max 32 characters**
 *  • Falls back to `"unnamed-server"` if the result is empty / invalid
 *
 * The resulting string therefore matches the regex `^[a-zA-Z0-9_-]{1,32}$`.
 * @param name The server name to normalize
 * @returns The normalized server name (≤ 32 chars)
 */
export function normalizeServerName(name: string): string {
  // Guard against non-string or empty input early
  if (!name || typeof name !== 'string') {
    return 'invalid-server-name';
  }

  /*
   * 1. Replace common invalid separators (whitespace, slashes, and a handful
   *    of shell-relevant punctuation) with a hyphen so that we keep word
   *    boundaries while avoiding invalid filename chars.
   */
  let normalized = name.replace(/[\s/\\@#$%^&*()+=[\]{}|;:'"<>,.?]+/g, '-');

  // 2. Strip any remaining characters that are not [a-zA-Z0-9_-]
  normalized = normalized.replace(/[^a-zA-Z0-9_-]/g, '');

  // 3. Collapse multiple consecutive hyphens introduced above
  normalized = normalized.replace(/-+/g, '-');

  // 4. Trim leading / trailing hyphens
  normalized = normalized.replace(/^-+|-+$/g, '');

  // 5. Enforce maximum length of 32 characters
  if (normalized.length > 32) {
    normalized = normalized.substring(0, 32).replace(/-+$/g, '');
  }

  // 6. Ensure we return something valid
  if (!normalized) {
    return 'invalid-server-name';
  }

  return normalized;
}

export function canonicalizeMcpServerNameMap<T>(
  servers: Record<string, T>
): Record<string, T> {
  const canonical = Object.create(null) as Record<string, T>;

  for (const [name, config] of Object.entries(servers)) {
    canonical[normalizeServerName(name)] = config;
  }

  return canonical;
}

export function getMcpServerNameAliases(
  serverName: string,
  servers: Record<string, unknown>
): string[] {
  const normalizedName = normalizeServerName(serverName);
  return Object.keys(servers).filter(
    (name) => normalizeServerName(name) === normalizedName
  );
}
