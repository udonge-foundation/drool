import type { FormatCompactNumberOptions } from './types';

function formatWithPrecision(value: number): string {
  const formatted = value.toFixed(1);
  if (formatted.endsWith('.0')) {
    return formatted.slice(0, -2);
  }
  return formatted;
}

/**
 * Formats a number with K / M / B suffixes for compact display.
 *
 * - Trailing `.0` is stripped (`1.0K` -> `1K`).
 * - Negative values are supported (`-1500` -> `-1.5K`).
 * - Values below 1,000 are rendered via `Intl.NumberFormat`. Pass
 *   `options.locale` to control the locale; defaults to the runtime locale.
 *
 * Examples: `1500 -> "1.5K"`, `2_500_000 -> "2.5M"`, `1_000_000_000 -> "1B"`.
 */
export function formatCompactNumber(
  value: number,
  options: FormatCompactNumberOptions = {}
): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${formatWithPrecision(value / 1_000_000_000)}B`;
  }
  if (abs >= 1_000_000) {
    return `${formatWithPrecision(value / 1_000_000)}M`;
  }
  if (abs >= 1_000) {
    return `${formatWithPrecision(value / 1_000)}K`;
  }
  return options.locale
    ? value.toLocaleString(options.locale)
    : value.toLocaleString();
}

/**
 * Formats `tokens / total` as a percentage string (`"42.0%"`).
 *
 * - Returns `"0.0%"` when `total` is non-positive.
 * - Returns `"<0.1%"` when the percentage rounds to zero but `tokens > 0`,
 *   so a non-empty share is never shown as `0.0%`.
 */
export function formatPercent(tokens: number, total: number): string {
  if (total <= 0) return '0.0%';
  const pct = (tokens / total) * 100;
  if (pct < 0.1 && tokens > 0) return '<0.1%';
  return `${pct.toFixed(1)}%`;
}
