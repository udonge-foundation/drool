import { randomBytes } from 'crypto';

let daemonProxyToken: string | null = null;

export function getOrCreateDaemonProxyToken(): string {
  if (!daemonProxyToken) {
    daemonProxyToken = randomBytes(32).toString('base64url');
  }
  return daemonProxyToken;
}

export function getDaemonProxyToken(): string | null {
  return daemonProxyToken;
}

/** @public */
export function __resetDaemonProxyTokenForTests(): void {
  daemonProxyToken = null;
}

/** @public */
export function __setDaemonProxyTokenForTests(token: string): void {
  daemonProxyToken = token;
}
