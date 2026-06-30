/**
 * Sanitize tool call IDs from various providers.
 *
 * Anthropic requires tool_use IDs to match `^[a-zA-Z0-9_-]+$`.
 * IDs from other providers (OpenAI, Kimi/Fireworks, MCP) may contain
 * characters outside this set — dots, colons, plus signs, spaces, etc.
 *
 * This function:
 * 1. Trims leading/trailing whitespace
 * 2. Replaces any character not matching [a-zA-Z0-9_-] with '_'
 *
 * The replacement is deterministic so the same raw ID always produces
 * the same sanitized ID, keeping tool_use ↔ tool_result pairs consistent.
 */
export function sanitizeToolCallId(id: string | undefined): string {
  if (!id) return '';
  return id.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
}
