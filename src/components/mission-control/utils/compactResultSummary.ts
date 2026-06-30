/**
 * Pure text helpers for the mission-control compact transcript renderer.
 * Split out of CompactTranscriptEntries.tsx for unit-testability (no ink).
 * `normalizeToSingleLine` accepts `unknown` and coerces via `String(x ?? '')`
 * as defence-in-depth against non-string content leaking through typed-as-
 * `string` code paths.
 */

import { TOOL_RESULT_PENDING_MARKER } from '@industry/common/sessionV2';

/** Collapse all whitespace runs (including newlines) to single spaces and trim. */
export function normalizeToSingleLine(text: unknown): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Get a compact result summary for a tool. */
export function getCompactResultSummary(
  result: string | undefined,
  isError: boolean | undefined
): string {
  if (!result || result === TOOL_RESULT_PENDING_MARKER) return '';

  const normalized = normalizeToSingleLine(result);
  if (!normalized) return '';

  const prefix = isError ? '✗ ' : '→ ';
  return prefix + normalized;
}
