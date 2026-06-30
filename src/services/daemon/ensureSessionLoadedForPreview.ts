import { SessionLoadState } from '@industry/common/daemon';
import { logWarn } from '@industry/logging';

import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';

/**
 * Kicks off a daemon session load for a read-only preview surface if the
 * session has not been loaded yet. Failures degrade the preview to its
 * empty state, so they are logged rather than surfaced.
 */
export function ensureSessionLoadedForPreview(
  sessionId: string,
  caller: string
): void {
  const adapter = getTuiDaemonAdapter();
  if (
    adapter.getSessionStateManager().getSessionLoadState(sessionId) !==
    SessionLoadState.NotLoaded
  ) {
    return;
  }
  void adapter.loadSession(sessionId).catch((error) => {
    logWarn('[ensureSessionLoadedForPreview] failed to load session', {
      cause: error,
      sessionId,
      caller,
    });
  });
}
