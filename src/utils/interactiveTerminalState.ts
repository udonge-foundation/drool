import { ANSI } from '@/components/chat/constants';
import { disableKittyProtocol } from '@/utils/kittyProtocolDetector';

type TerminalLike = {
  isTTY?: boolean;
  write: (text: string, callback?: () => void) => unknown;
};

interface RestoreInteractiveTerminalStateParams {
  setRawMode?: (isEnabled: boolean) => void;
  stdout?: TerminalLike;
  enableFocusReporting?: boolean;
  enableBracketedPaste?: boolean;
  enableTmuxExtendedKeys?: boolean;
  hideCursor?: boolean;
}

export function requestTmuxExtendedKeyMode(
  stdout: TerminalLike = process.stdout
): void {
  if (!process.env.TMUX || !stdout?.isTTY) {
    return;
  }

  stdout.write(ANSI.ENABLE_XTERM_MODIFY_OTHER_KEYS);
}

export function restoreInteractiveTerminalState({
  setRawMode,
  stdout = process.stdout,
  enableFocusReporting = true,
  enableBracketedPaste = true,
  enableTmuxExtendedKeys = true,
  hideCursor = true,
}: RestoreInteractiveTerminalStateParams): void {
  try {
    setRawMode?.(true);
  } catch {
    // no-op
  }

  if (!stdout?.isTTY) {
    return;
  }

  if (enableFocusReporting) {
    stdout.write(ANSI.ENABLE_FOCUS_REPORTING);
  }
  if (enableBracketedPaste) {
    stdout.write(ANSI.ENABLE_BRACKETED_PASTE);
  }
  if (enableTmuxExtendedKeys) {
    requestTmuxExtendedKeyMode(stdout);
  }
  if (hideCursor) {
    stdout.write(ANSI.HIDE_CURSOR);
  }
}

interface RestoreShellTerminalStateParams {
  setRawMode?: (isEnabled: boolean) => void;
  stdout?: TerminalLike;
  exitAlternateScreen?: boolean;
}

export async function restoreShellTerminalState({
  setRawMode,
  stdout = process.stdout,
  exitAlternateScreen = false,
}: RestoreShellTerminalStateParams = {}): Promise<void> {
  try {
    if (setRawMode) {
      setRawMode(false);
    } else if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(false);
    }
  } catch {
    // no-op
  }

  if (stdout?.isTTY) {
    if (exitAlternateScreen) {
      stdout.write(ANSI.EXIT_ALTERNATE_SCREEN);
    }
    stdout.write(ANSI.SHOW_CURSOR);
    if (process.env.TMUX) {
      stdout.write(ANSI.DISABLE_XTERM_MODIFY_OTHER_KEYS);
    }
    stdout.write(ANSI.DISABLE_FOCUS_REPORTING);
    stdout.write(ANSI.DISABLE_BRACKETED_PASTE);
  }

  await disableKittyProtocol({ force: true, stdout });
}
