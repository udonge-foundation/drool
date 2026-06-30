import {
  INDUSTRY_BRAND_PALETTE_HEXES,
  INDUSTRY_SEMANTIC_PALETTE_HEXES,
} from '@industry/common/automations';

import type { DetectedVisualBrandIssue } from './types';

/**
 * Heuristic detector for Industry brand-guide violations in an existing
 * VISUAL.html file.
 *
 * Property-presence checks plus a palette check on every CSS hex
 * literal. False positives cost a rebuild; false negatives let bad
 * visuals persist. The check set is deliberately small.
 *
 * The off-palette check is intentionally not an exact-match allow-list:
 * data dashboards legitimately need neutral grays (borders, muted text)
 * and per-theme shade variants of the Success/Warning/Error status
 * colors, both of which an exact 11-color match wrongly rejects (the
 * Industry scaffold itself uses them). A hex is therefore accepted when
 * it is an exact palette hex, a near-neutral gray, or in the same hue
 * family as a semantic palette color; genuinely off-brand hues
 * (navy/indigo/teal/purple, Tailwind defaults) are still flagged.
 *
 * The palette is read from `INDUSTRY_BRAND_PALETTE_HEXES` /
 * `INDUSTRY_SEMANTIC_PALETTE_HEXES` in `@industry/common/automations` so
 * the prompt and the detector share one source of truth.
 */

const THEME_SYNC_INDUSTRY_MESSAGE = /industry:set-theme/i;
const THEME_SYNC_HASH = /location\.hash[^;]*theme\s*=/i;
const PREFERS_COLOR_SCHEME = /@media[^{]*prefers-color-scheme\s*:\s*light/i;

const VISIBLE_THEME_CONTROL_PATTERNS: ReadonlyArray<RegExp> = [
  /<button\b[^>]*(?:aria-label|title|id|class|data-[a-z-]+)\s*=\s*["'][^"']*(?:theme|dark-mode|light-mode)[^"']*["']/i,
  /<button\b[^>]{0,200}>[\s\S]{0,200}\b(?:theme|dark mode|light mode)\b[\s\S]{0,200}<\/button>/i,
  /<input\b(?=[^>]*\btype\s*=\s*["']checkbox["'])(?=[^>]*(?:aria-label|title|id|class|name|data-[a-z-]+)\s*=\s*["'][^"']*(?:theme|dark-mode|light-mode)[^"']*["'])[^>]*>/i,
  /<select\b[^>]*(?:aria-label|title|id|class|name)\s*=\s*["'][^"']*theme[^"']*["']/i,
];

/**
 * Only valid CSS hex lengths (3/4/6/8 digits) are matched, longest
 * first, with a trailing word boundary. This deliberately rejects
 * malformed 5- and 7-digit runs (e.g. `#14414`) that an open-ended
 * `{3,8}` quantifier would otherwise truncate into bogus "hexes".
 */
const HEX_LITERAL_PATTERN =
  /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/gi;
const MAX_OFF_PALETTE_HEXES_TO_REPORT = 5;

/**
 * Max HSL saturation (0–1) for a hex to count as a near-neutral gray.
 * Saturation is used rather than absolute chroma because near-white /
 * near-black tints (e.g. Tailwind `blue-50` #EFF6FF) have a small
 * absolute chroma yet are fully saturated, and must NOT pass as
 * neutral. The Industry scaffold's grays (#4D4D4D, #E4E2E1, #CBC5C2,
 * #B8B3B0, …) all sit well under this threshold.
 */
const NEUTRAL_MAX_SATURATION = 0.15;
/** Hue tolerance (degrees) for accepting a semantic-color shade variant. */
const SEMANTIC_HUE_TOLERANCE_DEGREES = 18;

/**
 * Normalize a CSS hex literal (3/4/6/8 digits, case-insensitive) to the
 * canonical 6-digit uppercase form used in the brand palette. Alpha
 * channels are stripped before comparison so `#161413AA` matches
 * `#161413`. Returns `null` when the input is not a valid hex literal.
 */
function normalizeHex(value: string): string | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(
    value.trim()
  );
  if (!match) return null;
  const digits = match[1];
  const expanded =
    digits.length <= 4
      ? digits
          .slice(0, 3)
          .split('')
          .map((c) => c + c)
          .join('')
      : digits.slice(0, 6);
  return `#${expanded.toUpperCase()}`;
}

function hexToRgb(normalizedHex: string): [number, number, number] {
  return [
    parseInt(normalizedHex.slice(1, 3), 16),
    parseInt(normalizedHex.slice(3, 5), 16),
    parseInt(normalizedHex.slice(5, 7), 16),
  ];
}

function rgbSaturation([r, g, b]: readonly [number, number, number]): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  if (delta === 0) return 0;
  const lightness = (max + min) / 2;
  return delta / (1 - Math.abs(2 * lightness - 1));
}

function rgbHueDegrees([r, g, b]: readonly [number, number, number]): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const delta = max - Math.min(rn, gn, bn);
  if (delta === 0) return 0;
  let hue: number;
  if (max === rn) hue = ((gn - bn) / delta) % 6;
  else if (max === gn) hue = (bn - rn) / delta + 2;
  else hue = (rn - gn) / delta + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

function hueDistanceDegrees(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

const SEMANTIC_HUES: readonly number[] = [
  ...INDUSTRY_SEMANTIC_PALETTE_HEXES,
].map((hex) => rgbHueDegrees(hexToRgb(hex)));

/**
 * A non-palette hex is still brand-acceptable when it is a near-neutral
 * gray (borders, muted text) or a shade variant of a semantic
 * (Success/Warning/Error) color — i.e. it shares that color's hue
 * family. Off-brand hues (navy/indigo/teal/purple/Tailwind) fail both
 * tests and are reported.
 */
function isBrandTolerated(normalizedHex: string): boolean {
  const rgb = hexToRgb(normalizedHex);
  if (rgbSaturation(rgb) <= NEUTRAL_MAX_SATURATION) return true;
  const hue = rgbHueDegrees(rgb);
  return SEMANTIC_HUES.some(
    (semanticHue) =>
      hueDistanceDegrees(hue, semanticHue) <= SEMANTIC_HUE_TOLERANCE_DEGREES
  );
}

function findOffPaletteHexes(visualHtml: string): readonly string[] {
  const seen = new Set<string>();
  const offPalette: string[] = [];
  const matches = visualHtml.match(HEX_LITERAL_PATTERN) ?? [];
  for (const raw of matches) {
    const normalized = normalizeHex(raw);
    if (!normalized) continue;
    if (INDUSTRY_BRAND_PALETTE_HEXES.has(normalized)) continue;
    if (isBrandTolerated(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    offPalette.push(normalized);
  }
  return offPalette;
}

function hasDataThemeSelector(
  visualHtml: string,
  theme: 'light' | 'dark'
): boolean {
  const pattern = new RegExp(
    `\\[\\s*data-theme\\s*=\\s*["']${theme}["']\\s*\\]`,
    'gi'
  );
  for (const match of visualHtml.matchAll(pattern)) {
    const prefix = visualHtml.slice(
      Math.max(0, (match.index ?? 0) - 16),
      match.index
    );
    if (/:not\(\s*$/i.test(prefix)) continue;
    return true;
  }
  return false;
}

export function detectVisualBrandIssues(
  visualHtml: string
): DetectedVisualBrandIssue[] {
  const issues: DetectedVisualBrandIssue[] = [];

  if (!visualHtml.trim()) {
    return issues;
  }

  const hasIndustryMessageHook = THEME_SYNC_INDUSTRY_MESSAGE.test(visualHtml);
  const hasHashThemeHook = THEME_SYNC_HASH.test(visualHtml);
  if (!hasIndustryMessageHook && !hasHashThemeHook) {
    issues.push({
      id: 'missing-theme-sync-script',
      message:
        'No theme-sync wiring detected. The visual must respond to the host app via #theme=light|dark or postMessage({ type: "industry:set-theme", theme }).',
    });
  }

  if (VISIBLE_THEME_CONTROL_PATTERNS.some((re) => re.test(visualHtml))) {
    issues.push({
      id: 'visible-theme-control',
      message:
        'A visible theme control was detected. The visual must follow the host app theme silently, not render its own toggle.',
    });
  }

  const hasPrefersLight = PREFERS_COLOR_SCHEME.test(visualHtml);
  const hasDataThemeLight = hasDataThemeSelector(visualHtml, 'light');
  const hasDataThemeDark = hasDataThemeSelector(visualHtml, 'dark');
  if (!hasPrefersLight || !hasDataThemeLight || !hasDataThemeDark) {
    issues.push({
      id: 'missing-theme-switching',
      message:
        'No complete theme switching detected. The visual must adapt to light/dark via @media (prefers-color-scheme: light), [data-theme="light"], and [data-theme="dark"] selectors.',
    });
  }

  const offPaletteHexes = findOffPaletteHexes(visualHtml);
  if (offPaletteHexes.length > 0) {
    const sample = offPaletteHexes.slice(0, MAX_OFF_PALETTE_HEXES_TO_REPORT);
    const moreSuffix =
      offPaletteHexes.length > sample.length
        ? ` and ${offPaletteHexes.length - sample.length} more`
        : '';
    issues.push({
      id: 'off-palette-hex',
      message: `Off-palette hex literal(s) detected: ${sample.join(', ')}${moreSuffix}. Use the documented Industry palette colors; neutral grays and Success/Warning/Error shade variants are tolerated, but other hues (navy/indigo/teal/purple, Tailwind defaults) are not.`,
    });
  }

  return issues;
}
