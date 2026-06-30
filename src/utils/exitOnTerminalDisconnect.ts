import * as tty from 'tty';

import { TerminalDisconnectReason } from '@/utils/enums';

export function registerExitOnTerminalDisconnect(options: {
  enabled: boolean;
  onDisconnect: (reason: TerminalDisconnectReason) => void;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  pollIntervalMs?: number;
  isatty?: (fd: number) => boolean;
}): () => void {
  if (!options.enabled) {
    return () => undefined;
  }

  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const isatty = options.isatty ?? tty.isatty;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let disconnected = false;

  const onDisconnectOnce = (reason: TerminalDisconnectReason) => {
    if (disconnected) return;
    disconnected = true;
    options.onDisconnect(reason);
  };

  const onSighup = () => onDisconnectOnce(TerminalDisconnectReason.Sighup);
  const onStdinEnd = () => onDisconnectOnce(TerminalDisconnectReason.StdinEnd);
  const onStdinClose = () =>
    onDisconnectOnce(TerminalDisconnectReason.StdinClose);
  const onStdinError = (error: NodeJS.ErrnoException) => {
    // On some terminals, stdin can emit transient EIO even while tty remains attached.
    // Only treat as disconnect when at least one side is no longer a tty.
    if (error?.code === 'EIO' && isatty(0) && isatty(1)) {
      return;
    }
    onDisconnectOnce(TerminalDisconnectReason.StdinError);
  };
  const onStdoutError = () =>
    onDisconnectOnce(TerminalDisconnectReason.StdoutError);
  const onStderrError = () =>
    onDisconnectOnce(TerminalDisconnectReason.StderrError);

  process.on('SIGHUP', onSighup);
  stdin.on('end', onStdinEnd);
  stdin.on('close', onStdinClose);
  stdin.on('error', onStdinError);
  stdout.on('error', onStdoutError);
  stderr.on('error', onStderrError);

  intervalId = setInterval(() => {
    if (!isatty(0) || !isatty(1)) {
      onDisconnectOnce(TerminalDisconnectReason.TtyPoll);
    }
  }, pollIntervalMs);

  if (typeof intervalId.unref === 'function') {
    intervalId.unref();
  }

  return () => {
    process.off('SIGHUP', onSighup);
    stdin.off('end', onStdinEnd);
    stdin.off('close', onStdinClose);
    stdin.off('error', onStdinError);
    stdout.off('error', onStdoutError);
    stderr.off('error', onStderrError);
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}
