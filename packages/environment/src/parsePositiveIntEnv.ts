/**
 * Parse a non-negative integer from a raw env-var string.
 *
 * Returns `undefined` for missing, empty, non-numeric, fractional, or
 * negative input so callers can fall back to their own default with `??`.
 */
export function parsePositiveIntEnv(
  raw: string | undefined
): number | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}
