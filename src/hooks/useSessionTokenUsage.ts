/**
 * Hook to read token usage from the daemon's SessionStateManager (SSM).
 *
 * Uses useSyncExternalStore to efficiently subscribe to token usage changes
 * for a specific session. Returns the latest provider-reported token count
 * used by threshold compaction (input + output + cache read).
 *
 * @param sessionId - Session to read token usage from (null if no active session)
 * @returns Last-call compaction token count, or null if no data is available
 */

import { useMemo, useSyncExternalStore } from 'react';

import { createSessionStoreSubscribe } from '@/hooks/utils/sessionStoreSubscribe';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { computeLastCallCompactionTokens } from '@/utils/contextUsage';

/**
 * Create a getSnapshot function for a given sessionId.
 * Reads token usage from the SessionStore and returns last-call compaction count.
 */
function createGetSnapshot(sessionId: string | null) {
  return (): number | null => {
    if (!sessionId) return null;
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();
    const mgr = ssm.getSessionManager(sessionId);
    if (!mgr) return null;

    const lastCall = mgr.getStore().getLastCallTokenUsage?.() ?? null;
    if (!lastCall) return null;
    const tokenCount = computeLastCallCompactionTokens(lastCall);
    return tokenCount > 0 ? tokenCount : null;
  };
}

/**
 * Hook that reads last-call threshold-compaction token usage from the active
 * session's SSM using useSyncExternalStore.
 *
 * Returns null if:
 * - No sessionId provided
 * - Session manager doesn't exist
 * - No token usage data available
 *
 * @param sessionId - Session ID to read token usage from
 * @returns Last-call compaction token count, or null
 */
export function useSessionTokenUsage(sessionId: string | null): number | null {
  const subscribe = useMemo(
    () => createSessionStoreSubscribe(sessionId),
    [sessionId]
  );
  const getSnapshot = useMemo(() => createGetSnapshot(sessionId), [sessionId]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
