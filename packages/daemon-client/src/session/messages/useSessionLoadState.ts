import { useMemo, useSyncExternalStore } from 'react';

import { SessionLoadState } from '@industry/common/daemon';

import type { MultiSessionStateManager } from '../state/MultiSessionStateManager';

function createSubscribe(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null
) {
  return (onStoreChange: () => void): (() => void) => {
    if (!ssm || !sessionId) return () => {};
    return ssm.subscribeToStateChanges((changedSessionId) => {
      if (changedSessionId === sessionId) onStoreChange();
    });
  };
}

function createGetSnapshot(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null
) {
  return (): SessionLoadState => {
    if (!ssm || !sessionId) return SessionLoadState.NotLoaded;
    return ssm.getSessionLoadState(sessionId);
  };
}

/**
 * Hook that reads `SessionLoadState` from the SSM and re-renders when the
 * given session transitions between load states (e.g. Loading -> Loaded
 * after a new-session init completes). Returns `SessionLoadState.NotLoaded`
 * when the SSM or session is not available.
 */
export function useSessionLoadState(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null
): SessionLoadState {
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
