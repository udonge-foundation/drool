import { useMemo, useSyncExternalStore } from 'react';

import type { MultiSessionStateManager } from '../state/MultiSessionStateManager';

function createSubscribe(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null
) {
  return (onStoreChange: () => void): (() => void) => {
    if (!ssm || !sessionId) return () => {};

    let storeUnsub: (() => void) | null = null;

    const trySubscribeToStore = (): void => {
      if (storeUnsub) return;
      const mgr = ssm.getSessionManager(sessionId);
      if (mgr) {
        storeUnsub = mgr.getStore().subscribe(onStoreChange);
      }
    };

    const unsubscribeStateChanges = ssm.subscribeToStateChanges(
      (changedSessionId) => {
        if (changedSessionId === sessionId) {
          trySubscribeToStore();
          onStoreChange();
        }
      }
    );

    trySubscribeToStore();

    return () => {
      unsubscribeStateChanges();
      storeUnsub?.();
    };
  };
}

function createGetSnapshot(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null
) {
  return (): string | null => {
    if (!ssm || !sessionId) return null;
    return (
      ssm.getSessionManager(sessionId)?.getOptimisticAssistantBubbleId() ?? null
    );
  };
}

/**
 * Hook that reads the streaming-assistant placeholder bubble id for a
 * session from MSSM. Returns null when no submit is in flight. Pair with
 * the optimistic user message (rendered via getDisplayMessages's
 * optimisticMessages merge) to render an immediate user bubble + empty
 * streaming assistant bubble before the daemon's RPC round-trip lands.
 */
export function useSessionStreamingPlaceholder(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null
): string | null {
  const subscribe = useMemo(
    () => createSubscribe(ssm, sessionId),
    [ssm, sessionId]
  );
  const getSnapshot = useMemo(
    () => createGetSnapshot(ssm, sessionId),
    [ssm, sessionId]
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
