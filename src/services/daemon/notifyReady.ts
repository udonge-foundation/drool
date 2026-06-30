import { execFile } from 'node:child_process';

import { EnvironmentVariable, resolveEnv } from '@industry/environment';
import { logException, logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { SystemdNotifyState } from '@/services/daemon/enums';

function encodeState(state: SystemdNotifyState): string {
  switch (state) {
    case SystemdNotifyState.Ready:
      return 'READY=1';
    case SystemdNotifyState.Stopping:
      return 'STOPPING=1';
    case SystemdNotifyState.Reloading:
      return 'RELOADING=1';
    default: {
      const exhaustiveCheck: never = state;
      throw new MetaError('Unhandled SystemdNotifyState', {
        state: exhaustiveCheck,
      });
    }
  }
}

/**
 * Returns true when the process was launched under a systemd unit with
 * `Type=notify` (i.e. NOTIFY_SOCKET is set). Callers should guard their
 * notification calls with this so the relationship between
 * "configured for systemd" and "we'll emit a state" is explicit at the
 * call site rather than hidden inside the helper.
 */
export function isSystemdNotifyEnabled(): boolean {
  return !!resolveEnv({ name: EnvironmentVariable.NOTIFY_SOCKET });
}

/**
 * Emit a systemd `sd_notify` message to `$NOTIFY_SOCKET`.
 *
 * When the daemon's systemd unit uses `Type=notify`, `systemctl start`
 * blocks until the daemon writes `READY=1` to the notification socket
 * passed via the `NOTIFY_SOCKET` environment variable. This lets us
 * gate provisioning steps (e.g. install-deps) on the daemon being
 * actually registered with the relay rather than just having been
 * forked.
 *
 * Caller is expected to guard with `isSystemdNotifyEnabled()` so it's
 * obvious at the call site that nothing happens off-systemd. We still
 * defensively no-op when the env var is missing as a belt-and-braces
 * measure.
 *
 * Implementation note: neither node:dgram nor Bun.udpSocket currently
 * support `AF_UNIX`/`SOCK_DGRAM` client sockets, so we shell out to
 * `systemd-notify(1)`, which ships with every systemd installation.
 *
 * No-op when `systemd-notify` is unavailable — failing to notify must
 * never crash a healthy daemon.
 */
export async function systemdNotify(state: SystemdNotifyState): Promise<void> {
  if (!isSystemdNotifyEnabled()) return;
  const encoded = encodeState(state);

  await new Promise<void>((resolve) => {
    try {
      execFile(
        'systemd-notify',
        [`--pid=${process.pid}`, encoded],
        { timeout: 5_000 },
        (error, _stdout, stderr) => {
          if (error) {
            logWarn('[notifyReady] systemd-notify failed', {
              state: encoded,
              stderr: stderr?.toString().trim(),
              cause: error,
            });
          } else {
            logInfo('[notifyReady] sd_notify sent', {
              state: encoded,
            });
          }
          resolve();
        }
      );
    } catch (err) {
      logException(err, '[notifyReady] systemd-notify call threw', {
        state: encoded,
      });
      resolve();
    }
  });
}

export async function notifyReady(): Promise<void> {
  await systemdNotify(SystemdNotifyState.Ready);
}

export async function notifyStopping(): Promise<void> {
  await systemdNotify(SystemdNotifyState.Stopping);
}
