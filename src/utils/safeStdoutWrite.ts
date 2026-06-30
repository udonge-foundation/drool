import { logWarn } from '@industry/logging';
import { isErrnoException } from '@industry/utils/errors';

let pipeBrokenLogged = false;

/**
 * Write to stdout, swallowing EPIPE so a closed downstream pipe (e.g.
 * `drool exec --output-format stream-json | head -1`) does not bubble up
 * to the global `uncaughtException` handler and abort the process with a
 * "Critical error: EPIPE" log line. Mirrors the helper in
 * `JsonRpcProtocolAdapter.safeStdoutWrite` and `commands/daemon.ts:writeStdout`.
 */
export function safeStdoutWrite(data: string): void {
  try {
    process.stdout.write(data);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EPIPE') {
      if (!pipeBrokenLogged) {
        pipeBrokenLogged = true;
        logWarn('[exec] stdout pipe broken, parent likely disconnected');
      }
      return;
    }
    throw err;
  }
}

export function safeStdoutWriteLine(message: string): void {
  safeStdoutWrite(`${message}\n`);
}

export function __resetSafeStdoutWriteForTests(): void {
  pipeBrokenLogged = false;
}
