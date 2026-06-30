import { useMemo, useSyncExternalStore } from 'react';

import { createSessionStoreSubscribe } from '@/hooks/utils/sessionStoreSubscribe';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';

function createGetSnapshot(sessionId: string | null) {
  return (): boolean => {
    if (!sessionId) return true;
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();
    const mgr = ssm.getSessionManager(sessionId);
    if (!mgr) return true;
    return mgr.isConversationEmpty();
  };
}

export function useSessionConversationEmpty(sessionId: string | null): boolean {
  const subscribe = useMemo(
    () => createSessionStoreSubscribe(sessionId),
    [sessionId]
  );
  const getSnapshot = useMemo(() => createGetSnapshot(sessionId), [sessionId]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
