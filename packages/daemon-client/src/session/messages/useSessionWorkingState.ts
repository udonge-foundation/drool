import { useMemo, useSyncExternalStore } from 'react';

import { DroolWorkingState } from '@industry/drool-sdk-ext/protocol/drool';

import { createSessionStoreSubscribe } from './createSessionStoreSubscribe';

import type { MultiSessionStateManager } from '../state/MultiSessionStateManager';

function getWorkingStateSnapshot(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null
): DroolWorkingState {
  if (!ssm || !sessionId) return DroolWorkingState.Idle;
  const mgr = ssm.getSessionManager(sessionId);
  if (!mgr) return DroolWorkingState.Idle;
  return mgr.getDroolWorkingState();
}

function createGetSnapshot(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null
) {
  return (): DroolWorkingState => getWorkingStateSnapshot(ssm, sessionId);
}

/**
 * Hook that reads `DroolWorkingState` from the active session's SSM. Returns
 * `DroolWorkingState.Idle` when the SSM or session is not available.
 */
export function useSessionWorkingState(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null
): DroolWorkingState {
  const subscribe = useMemo(
    () => createSessionStoreSubscribe(ssm, sessionId),
    [ssm, sessionId]
  );
  const getSnapshot = useMemo(
    () => createGetSnapshot(ssm, sessionId),
    [ssm, sessionId]
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}
