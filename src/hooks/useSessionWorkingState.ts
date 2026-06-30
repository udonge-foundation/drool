import { useMemo, useSyncExternalStore } from 'react';

import { DroolWorkingState } from '@industry/drool-sdk-ext/protocol/drool';

import { AgentStatusState } from '@/hooks/enums';
import { createSessionStoreSubscribe } from '@/hooks/utils/sessionStoreSubscribe';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';

/**
 * Map DroolWorkingState from the daemon to AgentStatusState used by CLI components.
 */
function mapWorkingState(state: DroolWorkingState): AgentStatusState {
  switch (state) {
    case DroolWorkingState.Idle:
      return AgentStatusState.Idle;
    case DroolWorkingState.Thinking:
      return AgentStatusState.Thinking;
    case DroolWorkingState.StreamingAssistantMessage:
      return AgentStatusState.Streaming;
    case DroolWorkingState.ExecutingTool:
      return AgentStatusState.ExecutingTool;
    case DroolWorkingState.WaitingForToolConfirmation:
      return AgentStatusState.ToolConfirmation;
    case DroolWorkingState.CompactingConversation:
      return AgentStatusState.Compressing;
    default: {
      // Exhaustive check
      const _exhaustive: never = state;
      return AgentStatusState.Idle;
    }
  }
}

/**
 * Create a getSnapshot function for a given sessionId.
 * Reads DroolWorkingState from the SessionStateManager and maps it
 * to AgentStatusState. Since the return is a primitive enum value,
 * no memoization is needed — useSyncExternalStore uses Object.is
 * comparison which handles primitives correctly.
 */
function createGetSnapshot(sessionId: string | null) {
  return (): AgentStatusState => {
    if (!sessionId) return AgentStatusState.Idle;
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();
    const mgr = ssm.getSessionManager(sessionId);
    if (!mgr) return AgentStatusState.Idle;
    return mapWorkingState(mgr.getDroolWorkingState());
  };
}

/**
 * Hook that reads DroolWorkingState from the active session's SSM using
 * useSyncExternalStore and maps it to AgentStatusState for CLI components.
 *
 * Follows the pattern established in useSessionMessages.ts with
 * memoized subscribe/getSnapshot functions for referential stability.
 *
 * @param sessionId - The active session ID, or null if no session is active.
 * @returns AgentStatusState — Idle when sessionId is null or session not found.
 */
export function useSessionWorkingState(
  sessionId: string | null
): AgentStatusState {
  // Memoize subscribe and getSnapshot so useSyncExternalStore doesn't
  // re-subscribe on every render — only when sessionId changes.
  const subscribe = useMemo(
    () => createSessionStoreSubscribe(sessionId),
    [sessionId]
  );
  const getSnapshot = useMemo(() => createGetSnapshot(sessionId), [sessionId]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
