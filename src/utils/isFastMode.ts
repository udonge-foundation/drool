import { useMemo, useSyncExternalStore } from 'react';

import { getBaseVariant } from '@industry/utils/llm';

import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';

function getCurrentModel(): string {
  try {
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();
    const sessionId = getSessionService().getCurrentSessionId();
    const defaultStore = ssm.getDefaultSettingsStore();
    const store = sessionId
      ? (ssm.getSessionManager(sessionId)?.getStore() ?? defaultStore)
      : defaultStore;
    const model = store.getModelId();
    if (model) return model;
  } catch {
    // Daemon adapter not available (e.g. in tests)
  }
  return getSettingsService().getModel();
}

function subscribeToModelChanges(onStoreChange: () => void): () => void {
  try {
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();
    const unsubs: Array<() => void> = [];

    unsubs.push(ssm.getDefaultSettingsStore().subscribe(onStoreChange));

    let sessionStoreUnsub: (() => void) | null = null;

    const resubscribeSessionStore = (): void => {
      sessionStoreUnsub?.();
      sessionStoreUnsub = null;

      const sessionId = getSessionService().getCurrentSessionId();
      if (!sessionId) return;

      const mgr = ssm.getSessionManager(sessionId);
      if (mgr) {
        sessionStoreUnsub = mgr.getStore().subscribe(onStoreChange);
      }
    };

    resubscribeSessionStore();

    unsubs.push(
      ssm.subscribeToStateChanges(() => {
        resubscribeSessionStore();
        onStoreChange();
      })
    );

    return () => {
      unsubs.forEach((fn) => fn());
      sessionStoreUnsub?.();
    };
  } catch {
    return () => {};
  }
}

const getSnapshot = () => !!getBaseVariant(getCurrentModel());

export function useIsFastMode(): boolean {
  const subscribe = useMemo(() => subscribeToModelChanges, []);
  return useSyncExternalStore(subscribe, getSnapshot);
}
