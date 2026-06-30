import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PermissionQueueEntry } from '@/hooks/types';

/**
 * Maintains the FIFO queue of daemon permission prompts shown by the TUI.
 * Use when multiple relayed permissions can arrive before the first is answered.
 */
export function usePermissionQueue() {
  const [permissionQueue, setPermissionQueue] = useState<
    PermissionQueueEntry[]
  >([]);
  const pendingConfirmation = useMemo(
    () => permissionQueue[0]?.details ?? null,
    [permissionQueue]
  );
  const pendingPermissionCount = permissionQueue.length;

  // High-water mark of the queue size for the current burst. It provides a
  // stable denominator so the "Approval N of M" indicator advances
  // (1 of 3 -> 2 of 3 -> 3 of 3) instead of shrinking as entries resolve.
  const permissionQueueTotalRef = useRef(0);
  const [pendingPermissionTotal, setPendingPermissionTotal] = useState(0);
  useEffect(() => {
    if (permissionQueue.length === 0) {
      permissionQueueTotalRef.current = 0;
      setPendingPermissionTotal((prev) => (prev === 0 ? prev : 0));
      return;
    }
    if (permissionQueue.length > permissionQueueTotalRef.current) {
      permissionQueueTotalRef.current = permissionQueue.length;
      setPendingPermissionTotal(permissionQueue.length);
    }
  }, [permissionQueue]);

  const removePermissionFromQueue = useCallback((requestId: string) => {
    setPermissionQueue((prev) =>
      prev.filter((entry) => entry.requestId !== requestId)
    );
  }, []);

  const clearPermissionQueue = useCallback(() => {
    setPermissionQueue([]);
  }, []);

  const clearResolvedPermission = useCallback((requestId: unknown) => {
    if (typeof requestId === 'string') {
      setPermissionQueue((prev) =>
        prev.filter((entry) => entry.requestId !== requestId)
      );
      return;
    }
    setPermissionQueue([]);
  }, []);

  const enqueuePermission = useCallback((entry: PermissionQueueEntry) => {
    setPermissionQueue((prev) => {
      const withoutDuplicate = prev.filter(
        (existing) => existing.requestId !== entry.requestId
      );
      return [...withoutDuplicate, entry];
    });
  }, []);

  return {
    pendingConfirmation,
    pendingPermissionCount,
    pendingPermissionTotal,
    removePermissionFromQueue,
    clearPermissionQueue,
    clearResolvedPermission,
    enqueuePermission,
  };
}
