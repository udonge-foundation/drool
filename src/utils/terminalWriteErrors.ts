const BROKEN_TERMINAL_WRITE_CODES = new Set(['EIO', 'EPIPE', 'EBADF']);

interface ErrnoLike {
  code?: unknown;
  syscall?: unknown;
}

export function isBrokenTerminalWriteError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code, syscall } = error as ErrnoLike;
  return (
    typeof code === 'string' &&
    BROKEN_TERMINAL_WRITE_CODES.has(code) &&
    (syscall === undefined || syscall === 'write')
  );
}
