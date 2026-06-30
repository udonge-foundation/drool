function isControlCharacter(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/**
 * Strips C0/C1 control characters (and optionally clamps length) so untrusted
 * single-line values, such as MCP server names from project-level config or
 * transport error messages, cannot inject terminal escapes or break message
 * structure in rendered output.
 */
export function sanitizeInlineText(value: string, maxLength?: number): string {
  const stripped = [...value]
    .filter((character) => !isControlCharacter(character.codePointAt(0) ?? 0))
    .join('');
  if (maxLength !== undefined && stripped.length > maxLength) {
    return `${stripped.slice(0, maxLength)}…`;
  }
  return stripped;
}
