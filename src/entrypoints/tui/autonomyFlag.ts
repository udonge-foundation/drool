import { AutonomyLevel } from '@industry/drool-sdk-ext/protocol/shared';

const ALLOWED_AUTO_LEVELS = new Set<string>([
  AutonomyLevel.Low,
  AutonomyLevel.Medium,
  AutonomyLevel.High,
]);

/**
 * Parse the interactive `--auto <level>` flag. Mirrors `drool exec --auto`,
 * accepting only low|medium|high. Returns `ok: false` for an unrecognized
 * value so the caller can surface a clear error.
 */
export function parseAutonomyFlag(
  value: string | undefined
): { ok: true; level?: AutonomyLevel } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (!ALLOWED_AUTO_LEVELS.has(value)) return { ok: false };
  return { ok: true, level: value as AutonomyLevel };
}
