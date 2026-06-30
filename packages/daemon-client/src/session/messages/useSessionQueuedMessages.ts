import { useMemo, useRef, useSyncExternalStore } from 'react';

import { createSessionStoreSubscribe } from './createSessionStoreSubscribe';

import type { MultiSessionStateManager } from '../state/MultiSessionStateManager';
import type { QueuedUserMessageState } from '../state/types';
import type { MutableRefObject } from 'react';

const EMPTY_QUEUE: QueuedUserMessageState[] = [];

interface QueuedMessagesCache {
  ssm: MultiSessionStateManager | null;
  sessionId: string | null;
  version: number;
  queuedMessages: QueuedUserMessageState[];
}

function createGetSnapshot(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null,
  cacheRef: MutableRefObject<QueuedMessagesCache>
) {
  return (): QueuedUserMessageState[] => {
    if (!ssm || !sessionId) return EMPTY_QUEUE;

    const manager = ssm.getSessionManager(sessionId);
    if (!manager) return EMPTY_QUEUE;

    const version = manager.getStore().getVersion();
    const cache = cacheRef.current;
    if (
      cache.ssm === ssm &&
      cache.sessionId === sessionId &&
      cache.version === version
    ) {
      return cache.queuedMessages;
    }

    const next = ssm.getQueuedMessages(sessionId);
    const queuedMessages = next.length === 0 ? EMPTY_QUEUE : next;
    cacheRef.current = { ssm, sessionId, version, queuedMessages };
    return queuedMessages;
  };
}

/**
 * Hook that reads queued user messages for the active session from the SSM.
 *
 * Returns an empty array when the SSM or session is not available.
 */
export function useSessionQueuedMessages(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null
): QueuedUserMessageState[] {
  const cacheRef = useRef<QueuedMessagesCache>({
    ssm: null,
    sessionId: null,
    version: -1,
    queuedMessages: EMPTY_QUEUE,
  });

  const subscribe = useMemo(
    () => createSessionStoreSubscribe(ssm, sessionId),
    [ssm, sessionId]
  );
  const getSnapshot = useMemo(
    () => createGetSnapshot(ssm, sessionId, cacheRef),
    [ssm, sessionId]
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}
