import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { logInfo } from '@industry/logging';

const SOCKET_PREFIX = 'agent-browser-';
const SOCKET_SUFFIX = '.sock';
const CLOSE_COMMAND = JSON.stringify({ id: 'cleanup', action: 'close' });
const PER_SOCKET_TIMEOUT_MS = 2000;
const TOTAL_TIMEOUT_MS = 10000;

/**
 * Send a "close" command to a single agent-browser daemon via its Unix socket.
 * Returns true if the daemon acknowledged or the socket was already dead.
 */
function closeDaemonViaSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    const socket = net.createConnection({ path: socketPath }, () => {
      socket.write(`${CLOSE_COMMAND}\n`);
    });

    timeout = setTimeout(() => {
      socket.destroy();
      done(false);
    }, PER_SOCKET_TIMEOUT_MS);

    socket.on('data', () => {
      socket.destroy();
      done(true);
    });

    socket.on('error', () => {
      done(true);
    });

    socket.on('close', () => {
      done(true);
    });
  });
}

/**
 * Remove an orphaned socket file that no daemon is listening on.
 */
function removeStaleSocket(socketPath: string): void {
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // Ignore — file may already be gone.
  }
}

/**
 * Scan $TMPDIR for agent-browser Unix sockets and send each daemon a "close"
 * command. Orphaned socket files (no listener) are cleaned up.
 *
 * This is intentionally best-effort: errors are logged but never thrown.
 *
 * @param tmpdir Override the directory to scan (defaults to os.tmpdir()). Useful for tests.
 */
export async function cleanupAgentBrowserDaemons(
  tmpdir?: string
): Promise<void> {
  // Windows uses TCP, not Unix sockets — skip for now.
  if (process.platform === 'win32') return;

  const dir = tmpdir ?? os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  const sockets = entries.filter(
    (e) => e.startsWith(SOCKET_PREFIX) && e.endsWith(SOCKET_SUFFIX)
  );

  if (sockets.length === 0) return;

  logInfo('[agent-browser-cleanup] Found sockets to clean up', {
    count: sockets.length,
  });

  const closePromises = sockets.map(async (socketName) => {
    const socketPath = path.join(dir, socketName);
    const closed = await closeDaemonViaSocket(socketPath);
    if (closed) {
      // Give the daemon a moment to remove its own socket, then clean up if it didn't.
      setTimeout(() => {
        if (fs.existsSync(socketPath)) {
          removeStaleSocket(socketPath);
        }
      }, 500);
    }
  });

  // Cap total wait time so we never block exit indefinitely.
  await Promise.race([
    Promise.allSettled(closePromises),
    new Promise<void>((resolve) => {
      setTimeout(resolve, TOTAL_TIMEOUT_MS);
    }),
  ]);

  logInfo('[agent-browser-cleanup] Cleanup complete');
}
