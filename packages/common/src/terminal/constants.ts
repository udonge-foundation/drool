/**
 * Shared terminal configuration constants
 */

/**
 * Base terminal options shared between frontend and backend xterm instances
 */
export const TERMINAL_BASE_OPTIONS = {
  fontSize: 12,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  cursorStyle: 'block' as const,
  cursorBlink: true,
  scrollback: 50000,
  allowTransparency: true,
} as const;

export const CURSOR_ESCAPE_SEQUENCES = {
  HIDE: '\u001b[?25l',
  SHOW: '\u001b[?25h',
} as const;

export const ESCAPE_BUFFER_LENGTH = 8;
