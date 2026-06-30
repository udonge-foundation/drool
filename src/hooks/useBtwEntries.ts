import { useMemo, useSyncExternalStore } from 'react';

import type { BtwManager } from '@/services/btw/BtwManager';
import type { BtwEntry } from '@/services/btw/types';

const EMPTY_SNAPSHOT: ReadonlyArray<BtwEntry> = [];

/**
 * Subscribe to the BtwManager's entry list.
 * Returns an empty list if no manager is provided.
 */
export function useBtwEntries(manager: BtwManager | null): {
  entries: ReadonlyArray<BtwEntry>;
} {
  const subscribe = useMemo(() => {
    if (!manager) {
      return () => () => undefined;
    }
    return (listener: () => void) => manager.subscribe(listener);
  }, [manager]);

  const getSnapshot = useMemo(() => {
    if (!manager) {
      return () => EMPTY_SNAPSHOT;
    }
    return () => manager.getEntries();
  }, [manager]);

  const entries = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { entries };
}
