import ansiEscapes from 'ansi-escapes';

const ESC = '\x1b';
const CSI_CLEAR_SCROLLBACK = `${ESC}[3J`;
// iTerm-specific OSC sequence to clear scrollback buffer
// This bypasses the user's "Disable E3 scrollback clearing" preference
const ITERM_CLEAR_SCROLLBACK = `${ESC}]1337;ClearScrollback\x07`;

type PassthroughWrapper = (sequence: string) => string;

function wrapTmuxPassthrough(sequence: string): string {
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ESC}\\`;
}

function wrapScreenPassthrough(sequence: string): string {
  return `${ESC}P${sequence}${ESC}\\`;
}

function getPassthroughWrapper(): PassthroughWrapper | null {
  if (process.env.TMUX) {
    return wrapTmuxPassthrough;
  }

  if (process.env.STY) {
    return wrapScreenPassthrough;
  }

  return null;
}

/**
 * Clears the terminal screen and scrollback buffer.
 *
 * Uses ansi-escapes.clearTerminal (ESC[2J + ESC[3J + ESC[H) for most terminals.
 * When running inside a multiplexer, also passes a scrollback-only clear through
 * to the outer terminal without changing its visible screen state.
 */
export function getClearTerminalSequence(): string {
  const parts = [ansiEscapes.clearTerminal];
  const wrapPassthrough = getPassthroughWrapper();

  if (wrapPassthrough) {
    parts.push(wrapPassthrough(CSI_CLEAR_SCROLLBACK));
  }

  if (process.env.TERM_PROGRAM === 'iTerm.app') {
    parts.push(
      wrapPassthrough
        ? wrapPassthrough(ITERM_CLEAR_SCROLLBACK)
        : ITERM_CLEAR_SCROLLBACK
    );
  }

  return parts.join('');
}

export function clearTerminal(): void {
  process.stdout.write(getClearTerminalSequence());
}
