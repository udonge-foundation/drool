import { useRef } from 'react';

import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';

import type { MissionModelSettings } from '@industry/common/settings';

/**
 * Populate the MSSM pending store with current session defaults from SessionService.
 * Must run before useSessionSettings so the status bar shows correct values
 * on the very first render (before a daemon session is created).
 *
 * This is a render-phase side-effect (not a useEffect) because the pending
 * store must be populated synchronously before useSyncExternalStore reads it.
 */
export function usePendingStoreDefaults(activeSessionId: string | null): void {
  const initializedRef = useRef(false);
  const prevSessionIdRef = useRef<string | null>(activeSessionId);

  const needsPopulation =
    !initializedRef.current || prevSessionIdRef.current !== activeSessionId;

  if (!needsPopulation) return;

  initializedRef.current = true;
  prevSessionIdRef.current = activeSessionId;

  try {
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();
    const svc = getSessionService();

    const hasSettings = (store: {
      getModelId: () => string | null;
      getReasoningEffort: () => string | null;
      getInteractionMode: () =>
        | import('@industry/drool-sdk-ext/protocol/shared').DroolInteractionMode
        | null;
      getAutonomyLevel: () =>
        | import('@industry/drool-sdk-ext/protocol/shared').AutonomyLevel
        | null;
    }) =>
      store.getModelId() !== null ||
      store.getReasoningEffort() !== null ||
      store.getInteractionMode() !== null ||
      store.getAutonomyLevel() !== null;

    const applyDefaults = (
      store: {
        getModelId: () => string | null;
        getReasoningEffort: () => string | null;
        getInteractionMode: () =>
          | import('@industry/drool-sdk-ext/protocol/shared').DroolInteractionMode
          | null;
        getAutonomyLevel: () =>
          | import('@industry/drool-sdk-ext/protocol/shared').AutonomyLevel
          | null;
        setModelId: (v: string) => void;
        setReasoningEffort: (v: string) => void;
        setInteractionMode: (
          v: import('@industry/drool-sdk-ext/protocol/shared').DroolInteractionMode
        ) => void;
        setAutonomyLevel: (
          v: import('@industry/drool-sdk-ext/protocol/shared').AutonomyLevel
        ) => void;
        setSpecModeModelId: (v: string | null) => void;
        setSpecModeReasoningEffort: (v: string | null) => void;
        setMissionSettings: (v: MissionModelSettings | null) => void;
      },
      options?: { includeMissionSettings?: boolean }
    ) => {
      store.setModelId(svc.getModel());
      store.setReasoningEffort(svc.getReasoningEffort());
      store.setInteractionMode(svc.getInteractionMode());
      store.setAutonomyLevel(svc.getAutonomyLevel());
      if (svc.hasSpecModeModel()) {
        store.setSpecModeModelId(svc.getSpecModeModel());
        store.setSpecModeReasoningEffort(svc.getSpecModeReasoningEffort());
      } else {
        store.setSpecModeModelId(null);
        store.setSpecModeReasoningEffort(null);
      }
      if (options?.includeMissionSettings !== false) {
        store.setMissionSettings(svc.getMissionSettings() ?? null);
      }
    };

    applyDefaults(ssm.getPendingStore());

    // Also populate pre-created session store if it exists
    const preSessionId = svc.getCurrentSessionId();
    if (preSessionId) {
      const mgr = ssm.getSessionManager(preSessionId);
      if (mgr) {
        const store = mgr.getStore();
        if (!hasSettings(store)) {
          applyDefaults(store, { includeMissionSettings: false });
        }
      }
    }
  } catch {
    // Adapter may not be ready yet on initial mount
  }
}
