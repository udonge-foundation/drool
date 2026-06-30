import { useMemo, useRef, useSyncExternalStore } from 'react';

import { MessageContentBlockType } from '@industry/drool-sdk-ext/protocol/sessionV2';

import type { QueuedUserMessage } from '@/hooks/types';
import { createSessionStoreSubscribe } from '@/hooks/utils/sessionStoreSubscribe';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';

import type { MutableRefObject } from 'react';

const EMPTY_QUEUED: QueuedUserMessage[] = [];

function createGetSnapshot(
  sessionId: string | null,
  cacheRef: MutableRefObject<{
    lastVersion: number;
    lastOutput: QueuedUserMessage[];
  }>
) {
  return (): QueuedUserMessage[] => {
    if (!sessionId) return EMPTY_QUEUED;
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();
    const mgr = ssm.getSessionManager(sessionId);
    if (!mgr) return EMPTY_QUEUED;

    const version = mgr.getStore().getVersion();
    const cache = cacheRef.current;
    if (cache.lastVersion === version) {
      return cache.lastOutput;
    }

    const ssmQueued = mgr.getQueuedMessages();
    if (ssmQueued.length === 0) {
      cache.lastVersion = version;
      cache.lastOutput = EMPTY_QUEUED;
      return EMPTY_QUEUED;
    }

    const result: QueuedUserMessage[] = ssmQueued.map((q) => {
      const textParts = q.content
        .filter((b) => b.type === MessageContentBlockType.Text && 'text' in b)
        .map((b) => (b as { text: string }).text);
      return {
        id: q.requestId,
        text: textParts.join('\n'),
        createdAt: q.createdAt,
        kind: q.kind,
      };
    });

    cache.lastVersion = version;
    cache.lastOutput = result;
    return result;
  };
}

/**
 * Read queued messages from the SSM for a given session.
 * Returns QueuedUserMessage[] compatible with PendingMessagesList.
 */
export function useSessionQueuedMessages(
  sessionId: string | null
): QueuedUserMessage[] {
  const cacheRef = useRef<{
    lastVersion: number;
    lastOutput: QueuedUserMessage[];
  }>({ lastVersion: -1, lastOutput: EMPTY_QUEUED });

  const prevSessionIdRef = useRef<string | null>(null);
  if (prevSessionIdRef.current !== sessionId) {
    prevSessionIdRef.current = sessionId;
    cacheRef.current = { lastVersion: -1, lastOutput: EMPTY_QUEUED };
  }

  const subscribe = useMemo(
    () => createSessionStoreSubscribe(sessionId),
    [sessionId]
  );
  const getSnapshot = useMemo(
    () => createGetSnapshot(sessionId, cacheRef),
    [sessionId]
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}
