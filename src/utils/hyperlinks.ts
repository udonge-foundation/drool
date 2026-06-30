import ansiEscapes from 'ansi-escapes';

const SUPPORTED_TERM_PROGRAMS = new Set([
  'iterm.app',
  'vscode',
  'warpterminal',
  'ghostty',
]);

let cachedSupportsTerminalHyperlinks: boolean | null = null;

function cacheHyperlinkSupport(value: boolean): boolean {
  cachedSupportsTerminalHyperlinks = value;
  return value;
}

function normalizeEnvValue(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function parseForceHyperlinkValue(value: string | undefined): boolean | null {
  const normalized = normalizeEnvValue(value);
  if (!normalized) return null;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  return null;
}

function stripControlCharacters(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code >= 0 && code <= 31) || (code >= 127 && code <= 159)) {
      continue;
    }

    result += char;
  }

  return result;
}

export function supportsTerminalHyperlinks(): boolean {
  if (cachedSupportsTerminalHyperlinks !== null) {
    return cachedSupportsTerminalHyperlinks;
  }

  const forcedSupport = parseForceHyperlinkValue(process.env.FORCE_HYPERLINK);
  if (forcedSupport !== null) {
    return cacheHyperlinkSupport(forcedSupport);
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    return cacheHyperlinkSupport(false);
  }

  const term = normalizeEnvValue(process.env.TERM);
  if (!term || term === 'dumb') {
    return cacheHyperlinkSupport(false);
  }

  if (process.env.CI && !process.env.GITHUB_ACTIONS) {
    return cacheHyperlinkSupport(false);
  }

  if (process.env.TMUX || process.env.STY) {
    return cacheHyperlinkSupport(false);
  }

  const termProgram = normalizeEnvValue(process.env.TERM_PROGRAM);
  if (SUPPORTED_TERM_PROGRAMS.has(termProgram)) {
    return cacheHyperlinkSupport(true);
  }

  if (
    term.includes('kitty') ||
    term.includes('wezterm') ||
    term.includes('ghostty')
  ) {
    return cacheHyperlinkSupport(true);
  }

  if (process.env.KITTY_WINDOW_ID || process.env.WEZTERM_EXECUTABLE) {
    return cacheHyperlinkSupport(true);
  }

  if (process.env.WT_SESSION) {
    return cacheHyperlinkSupport(true);
  }

  const vteVersion = Number(process.env.VTE_VERSION);
  if (!Number.isNaN(vteVersion) && vteVersion >= 5000) {
    return cacheHyperlinkSupport(true);
  }

  return cacheHyperlinkSupport(false);
}

export function sanitizeHyperlinkUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const sanitized = stripControlCharacters(raw).trim();
  if (!sanitized) return null;

  try {
    const parsed = new URL(sanitized);
    if (
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'https:' &&
      parsed.protocol !== 'file:'
    ) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

export function makeHyperlink(label: string, url: string): string {
  const sanitizedUrl = sanitizeHyperlinkUrl(url);
  if (sanitizedUrl && supportsTerminalHyperlinks()) {
    return ansiEscapes.link(label, sanitizedUrl);
  }
  return label;
}

export function resetHyperlinkSupportCacheForTesting(): void {
  cachedSupportsTerminalHyperlinks = null;
}
