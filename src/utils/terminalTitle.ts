/**
 * Sets the terminal tab/window title using the OSC 0 escape sequence.
 * Prefixes the title with 🔱 for easy identification.
 *
 * Strips C0/C1 control characters defensively so callers cannot smuggle
 * additional escape sequences into the OSC payload, and skips writes when
 * the resulting title is empty or stdout is not a TTY (renderless / piped).
 */
export function setTerminalTabTitle(title: string): void {
  if (!process.stdout.isTTY) {
    return;
  }
  // eslint-disable-next-line no-control-regex
  const sanitized = title.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
  if (sanitized.length === 0) {
    return;
  }
  process.stdout.write(`\x1b]0;🔱 ${sanitized}\x07`);
}
