import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';

/**
 * Build a `subscribe` function compatible with `useSyncExternalStore` that
 * forwards both per-session SessionStore changes and MSSM-level state
 * changes for the given sessionId.
 *
 * The MSSM subscription handles the timing race where the session manager
 * is created after the initial render — once it appears, we eagerly attach
 * to its store.
 */
export function createSessionStoreSubscribe(sessionId: string | null) {
  return (onStoreChange: () => void): (() => void) => {
    if (!sessionId) return () => {};
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();

    let storeUnsub: (() => void) | null = null;

    const trySubscribeToStore = (): void => {
      if (storeUnsub) return;
      const mgr = ssm.getSessionManager(sessionId);
      if (mgr) {
        storeUnsub = mgr.getStore().subscribe(onStoreChange);
      }
    };

    const mssmUnsub = ssm.subscribeToStateChanges((changedSessionId) => {
      if (changedSessionId === sessionId) {
        trySubscribeToStore();
        onStoreChange();
      }
    });

    trySubscribeToStore();

    return () => {
      mssmUnsub();
      if (storeUnsub) storeUnsub();
    };
  };
}
