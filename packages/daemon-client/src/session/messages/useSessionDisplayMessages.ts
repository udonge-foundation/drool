import { useMemo, useRef, useSyncExternalStore } from 'react';

import type { MultiSessionStateManager } from '../state/MultiSessionStateManager';
import type { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';
import type { MutableRefObject } from 'react';

const EMPTY_MESSAGES: IndustryDroolMessage[] = [];

interface DisplayMessagesCache {
  ssm: MultiSessionStateManager | null;
  sessionId: string | null;
  snapshotVersion: number;
  streamingVersion: number;
  messages: IndustryDroolMessage[];
}

interface UseSessionDisplayMessagesParams {
  ssm: MultiSessionStateManager | null;
  sessionId: string | null;
  isChunkLevel: boolean;
}

function createSubscribe(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null,
  isChunkLevel: boolean
) {
  return (onStoreChange: () => void): (() => void) => {
    if (!ssm || !sessionId) return () => {};

    let storeUnsub: (() => void) | null = null;
    let streamingUnsub: (() => void) | null = null;

    const trySubscribeToStore = (): void => {
      if (storeUnsub) return;
      const mgr = ssm.getSessionManager(sessionId);
      if (mgr) {
        const store = mgr.getStore();
        storeUnsub = store.subscribe(onStoreChange);
        if (isChunkLevel) {
          streamingUnsub = store.subscribeToStreamingChanges(onStoreChange);
        }
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
      streamingUnsub?.();
    };
  };
}

function createGetSnapshot(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null,
  cacheRef: MutableRefObject<DisplayMessagesCache>,
  isChunkLevel: boolean
) {
  return (): IndustryDroolMessage[] => {
    if (!ssm || !sessionId) return EMPTY_MESSAGES;

    const manager = ssm.getSessionManager(sessionId);
    if (!manager) return EMPTY_MESSAGES;

    // Chunk-level consumers (the web/desktop transcript) key the cache on the
    // message-content version (not the general store version) so unrelated
    // store mutations (terminal buffers, token usage, MCP polling, working
    // state) keep the snapshot identity stable and do not retrigger
    // downstream transcript derivation. Coarse consumers (Ink CLI) keep the
    // general store version: they merge store-only state (hook executions,
    // tool progress, the progressive render limit) into the rendered
    // transcript, so any store change must produce a fresh snapshot.
    const snapshotVersion = isChunkLevel
      ? manager.getStore().getMessagesVersion()
      : manager.getStore().getVersion();
    const streamingVersion = isChunkLevel
      ? manager.getStore().getStreamingVersion()
      : -1;
    const cache = cacheRef.current;
    if (
      cache.ssm === ssm &&
      cache.sessionId === sessionId &&
      cache.snapshotVersion === snapshotVersion &&
      cache.streamingVersion === streamingVersion
    ) {
      return cache.messages;
    }

    const next = ssm.getDisplayMessages(sessionId);
    const messages = [...next];
    cacheRef.current = {
      ssm,
      sessionId,
      snapshotVersion,
      streamingVersion,
      messages,
    };
    return messages;
  };
}

/**
 * Hook that exposes the active session's `IndustryDroolMessage[]` (the raw
 * protocol messages from `getDisplayMessages()`). Suitable for consumers
 * (e.g. the web/desktop chat surface) that perform their own
 * message-derivation pipeline.
 *
 * For the already-derived `HistoryMessage[]` shape used by the CLI, see
 * `useSessionMessages`.
 */
export function useSessionDisplayMessages({
  ssm,
  sessionId,
  isChunkLevel,
}: UseSessionDisplayMessagesParams): IndustryDroolMessage[] {
  const cacheRef = useRef<DisplayMessagesCache>({
    ssm: null,
    sessionId: null,
    snapshotVersion: -1,
    streamingVersion: -1,
    messages: EMPTY_MESSAGES,
  });

  const subscribe = useMemo(
    () => createSubscribe(ssm, sessionId, isChunkLevel),
    [ssm, sessionId, isChunkLevel]
  );
  const getSnapshot = useMemo(
    () => createGetSnapshot(ssm, sessionId, cacheRef, isChunkLevel),
    [ssm, sessionId, isChunkLevel]
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}
