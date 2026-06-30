/**
 * Terminal appearance detector.
 *
 * Queries the terminal's actual background color via OSC 11 and computes
 * whether it is light or dark, falling back to the COLORFGBG env var when
 * the query times out. Used to auto-pick between industry-dark and
 * industry-light at startup so users running on a light Terminal.app or
 * iTerm2 profile get a readable TUI without enabling
 * overrideTerminalColors (which would mutate the user's terminal palette).
 *
 * NOTE: Must run AFTER the Kitty keyboard-protocol detector. Both use raw
 * mode + a one-shot stdin data listener, and concurrent runs would
 * interleave responses or have one consume the other's reply.
 */
import { logInfo } from '@industry/logging';

import { TerminalAppearance } from '@/utils/terminalAppearanceDetector/enums';
import type {
  DetectOptions,
  DetectorStdin,
  DetectorStdout,
} from '@/utils/terminalAppearanceDetector/types';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const OSC_11_QUERY = `${ESC}]11;?${BEL}`;
const DEFAULT_TIMEOUT_MS = 150;
const LUMA_LIGHT_THRESHOLD = 0.5;

/** Match `rgb:RRRR/GGGG/BBBB` (16-bit) or `rgb:RR/GG/BB` (8-bit). */
const OSC_11_RESPONSE = new RegExp(
  `${ESC}\\]11;rgb:([0-9a-fA-F]+)\\/([0-9a-fA-F]+)\\/([0-9a-fA-F]+)(?:${BEL}|${ESC}\\\\)`
);

let cachedResult: TerminalAppearance | null = null;

/** Convert a hex component (any width) to a normalized 0..1 value. */
function normalizeHexComponent(hex: string): number {
  const max = 16 ** hex.length - 1;
  return parseInt(hex, 16) / max;
}

/**
 * Relative luminance per WCAG 2.x. Inputs are 0..1 sRGB components.
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function computeRelativeLuminance(
  r: number,
  g: number,
  b: number
): number {
  const f = (c: number) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Parse an OSC 11 background-color response.
 * Returns the relative luminance, or null if the buffer doesn't contain a
 * valid response yet.
 */
export function parseOsc11Response(buffer: string): number | null {
  const match = OSC_11_RESPONSE.exec(buffer);
  if (!match) return null;
  const [, rHex, gHex, bHex] = match;
  return computeRelativeLuminance(
    normalizeHexComponent(rHex),
    normalizeHexComponent(gHex),
    normalizeHexComponent(bHex)
  );
}

/**
 * Heuristic fallback using the COLORFGBG env var.
 * Format is "fg;bg" (e.g. "15;0"). When bg is one of the bright slots (7
 * or 15) or "default", we treat the terminal as light; index 0/8 ⇒ dark.
 * Anything else returns Unknown so callers can fall back to dark.
 */
export function appearanceFromColorFgBg(
  value: string | undefined
): TerminalAppearance {
  if (!value) return TerminalAppearance.Unknown;
  const parts = value.split(';');
  if (parts.length < 2) return TerminalAppearance.Unknown;
  const bg = parts[parts.length - 1].trim();
  if (bg === 'default') return TerminalAppearance.Light;
  const idx = Number(bg);
  if (!Number.isFinite(idx)) return TerminalAppearance.Unknown;
  if (idx === 7 || idx === 15) return TerminalAppearance.Light;
  if (idx === 0 || idx === 8) return TerminalAppearance.Dark;
  return TerminalAppearance.Unknown;
}

function shouldSkipDetection(env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR) return true;
  if (env.FORCE_COLOR === '0') return true;
  // Most CI runners don't have a real terminal background; skip to avoid
  // the timeout cost.
  if (env.CI && env.CI !== 'false') return true;
  return false;
}

function queryViaOsc11(
  stdin: DetectorStdin,
  stdout: DetectorStdout,
  timeoutMs: number
): Promise<TerminalAppearance> {
  return new Promise((resolve) => {
    const originalRawMode = (stdin as { isRaw?: boolean }).isRaw;
    if (!originalRawMode) {
      stdin.setRawMode?.(true);
    }

    let buffer = '';
    let finished = false;
    let listener: ((data: Buffer) => void) | null = null;

    const finish = (result: TerminalAppearance): void => {
      if (finished) return;
      finished = true;
      if (listener) {
        stdin.removeListener('data', listener);
        listener = null;
      }
      if (!originalRawMode) {
        stdin.setRawMode?.(false);
      }
      resolve(result);
    };

    listener = (data: Buffer): void => {
      buffer += data.toString('binary');
      const luma = parseOsc11Response(buffer);
      if (luma === null) return;
      finish(
        luma > LUMA_LIGHT_THRESHOLD
          ? TerminalAppearance.Light
          : TerminalAppearance.Dark
      );
    };

    stdin.on('data', listener);

    try {
      stdout.write(OSC_11_QUERY);
    } catch {
      finish(TerminalAppearance.Unknown);
      return;
    }

    const timer = setTimeout(
      () => finish(TerminalAppearance.Unknown),
      timeoutMs
    );
    timer.unref?.();
  });
}

/**
 * Detects the terminal's appearance (light or dark).
 * Result is cached for the process lifetime.
 *
 * Safe to call when stdin/stdout aren't TTYs — returns Unknown immediately.
 */
export async function detectTerminalAppearance(
  opts: DetectOptions = {}
): Promise<TerminalAppearance> {
  if (cachedResult !== null) return cachedResult;

  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // TODO(CLI-657 follow-up): Windows can't be auto-detected reliably with
  // OSC 11 today — legacy ConHost and most remote channels (SSH/RDP/SSM)
  // drop the reply before Node sees it, costing a 150ms timeout per
  // startup for no benefit. Re-evaluate once we have a non-flaky Windows
  // signal (WT_SESSION-gated query, native Win32 console API, or a
  // DROOL_TERMINAL_APPEARANCE env override).
  if (process.platform === 'win32') {
    cachedResult = appearanceFromColorFgBg(env.COLORFGBG);
    return cachedResult;
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    cachedResult = appearanceFromColorFgBg(env.COLORFGBG);
    return cachedResult;
  }

  if (shouldSkipDetection(env)) {
    cachedResult = appearanceFromColorFgBg(env.COLORFGBG);
    return cachedResult;
  }

  const result = await queryViaOsc11(stdin, stdout, timeoutMs);
  if (result === TerminalAppearance.Light) {
    cachedResult = result;
    logInfo('[TerminalAppearance] Detected light via OSC 11');
    return cachedResult;
  }
  if (result === TerminalAppearance.Dark) {
    cachedResult = result;
    logInfo('[TerminalAppearance] Detected dark via OSC 11');
    return cachedResult;
  }

  const fallback = appearanceFromColorFgBg(env.COLORFGBG);
  cachedResult = fallback;
  if (fallback === TerminalAppearance.Light) {
    logInfo('[TerminalAppearance] Detected light via COLORFGBG');
  } else if (fallback === TerminalAppearance.Dark) {
    logInfo('[TerminalAppearance] Detected dark via COLORFGBG');
  }
  return cachedResult;
}

/** For tests only — clear the cached result so subsequent calls re-detect. */
export function resetCachedAppearanceForTesting(): void {
  cachedResult = null;
}
