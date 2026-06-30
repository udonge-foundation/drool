import { useMemo, useRef, useSyncExternalStore } from 'react';

import type { MultiSessionStateManager } from '../state/MultiSessionStateManager';
import type { SessionTagsCache, SessionTagsSnapshot } from '../types';
import type { SessionTag } from '@industry/drool-sdk-ext/protocol/session';
import type { MutableRefObject } from 'react';

const EMPTY_SESSION_TAG_SNAPSHOTS: SessionTagsSnapshot[] = [];

type SubscribeToSessionTagSnapshotUpdates = (
  onStoreChange: () => void
) => () => void;

function createSubscribe(
  ssm: MultiSessionStateManager | null,
  subscribeToSessionTagSnapshotUpdates?: SubscribeToSessionTagSnapshotUpdates
) {
  return (onStoreChange: () => void): (() => void) => {
    if (!ssm) return () => {};

    const storeUnsubscribers = new Map<string, () => void>();

    const syncStoreSubscriptions = (): void => {
      const sessionIds = new Set(ssm.getAllSessionIds());

      for (const [sessionId, unsubscribe] of storeUnsubscribers.entries()) {
        if (!sessionIds.has(sessionId)) {
          unsubscribe();
          storeUnsubscribers.delete(sessionId);
        }
      }

      if (subscribeToSessionTagSnapshotUpdates) {
        return;
      }

      for (const sessionId of sessionIds) {
        if (storeUnsubscribers.has(sessionId)) {
          continue;
        }

        const manager = ssm.getSessionManager(sessionId);
        if (manager) {
          storeUnsubscribers.set(
            sessionId,
            manager.getStore().subscribe(onStoreChange)
          );
        }
      }
    };

    const unsubscribeSessionTagSnapshotUpdates =
      subscribeToSessionTagSnapshotUpdates?.(() => {
        syncStoreSubscriptions();
        onStoreChange();
      }) ?? (() => {});
    const unsubscribeStateChanges = ssm.subscribeToStateChanges(() => {
      syncStoreSubscriptions();
      onStoreChange();
    });
    syncStoreSubscriptions();

    return () => {
      unsubscribeSessionTagSnapshotUpdates();
      unsubscribeStateChanges();
      for (const unsubscribe of storeUnsubscribers.values()) {
        unsubscribe();
      }
      storeUnsubscribers.clear();
    };
  };
}

function createGetSnapshot(
  ssm: MultiSessionStateManager | null,
  cacheRef: MutableRefObject<SessionTagsCache>
) {
  return (): SessionTagsSnapshot[] => {
    if (!ssm) return EMPTY_SESSION_TAG_SNAPSHOTS;

    const sessionIds = ssm.getAllSessionIds();
    const key = sessionIds
      .map((sessionId) => {
        const manager = ssm.getSessionManager(sessionId);
        return `${sessionId}:${manager?.getStore().getVersion() ?? 'missing'}`;
      })
      .join('|');
    const cache = cacheRef.current;
    if (cache.ssm === ssm && cache.key === key) {
      return cache.snapshots;
    }

    const snapshots = sessionIds.flatMap((sessionId) => {
      const manager = ssm.getSessionManager(sessionId);
      if (!manager) return [];

      const store = manager.getStore();
      const tags = store.getTags();
      if (tags === null) return [];

      return [
        {
          cwd: store.getCwd(),
          machineId: store.getMachineId(),
          sessionId,
          tags: [...tags],
          title: store.getTitle(),
        },
      ];
    });

    cacheRef.current = { key, snapshots, ssm };
    return snapshots;
  };
}

export function useSessionTagSnapshots(
  ssm: MultiSessionStateManager | null,
  subscribeToSessionTagSnapshotUpdates?: SubscribeToSessionTagSnapshotUpdates
): SessionTagsSnapshot[] {
  const cacheRef = useRef<SessionTagsCache>({
    key: '',
    snapshots: EMPTY_SESSION_TAG_SNAPSHOTS,
    ssm: null,
  });

  const subscribe = useMemo(
    () => createSubscribe(ssm, subscribeToSessionTagSnapshotUpdates),
    [ssm, subscribeToSessionTagSnapshotUpdates]
  );
  const getSnapshot = useMemo(() => createGetSnapshot(ssm, cacheRef), [ssm]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useSessionTags(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null,
  subscribeToSessionTagSnapshotUpdates?: SubscribeToSessionTagSnapshotUpdates
): SessionTag[] | null {
  const snapshots = useSessionTagSnapshots(
    ssm,
    subscribeToSessionTagSnapshotUpdates
  );
  return (
    snapshots.find((snapshot) => snapshot.sessionId === sessionId)?.tags ?? null
  );
}
