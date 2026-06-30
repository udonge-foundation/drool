import { useMemo, useSyncExternalStore } from 'react';

import type { UseMissionStoreSnapshotParams } from '../types';

function subscribeToNothing(_listener: () => void): () => void {
  return () => {};
}

export function useMissionStoreSnapshot<TSnapshot, TFallback>({
  sessionId,
  getMissionStore,
  fallbackSnapshot,
}: UseMissionStoreSnapshotParams<TSnapshot, TFallback>): TSnapshot | TFallback {
  const subscribe = useMemo(() => {
    if (!sessionId) {
      return subscribeToNothing;
    }

    return (onStoreChange: () => void) =>
      getMissionStore(sessionId).subscribe(onStoreChange);
  }, [getMissionStore, sessionId]);

  const getSnapshot = useMemo<() => TSnapshot | TFallback>(() => {
    if (!sessionId) {
      return () => fallbackSnapshot;
    }

    return () => getMissionStore(sessionId).getSnapshot();
  }, [fallbackSnapshot, getMissionStore, sessionId]);

  return useSyncExternalStore<TSnapshot | TFallback>(
    subscribe,
    getSnapshot,
    getSnapshot
  );
}
