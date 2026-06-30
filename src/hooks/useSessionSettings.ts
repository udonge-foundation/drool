import { useMemo, useSyncExternalStore } from 'react';

import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import {
  AutonomyLevel,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';

import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';

import type { MissionModelSettings } from '@industry/common/settings';

type SettingsStore = {
  subscribe: (callback: () => void) => () => void;
  getInteractionMode: () => DroolInteractionMode | null;
  getAutonomyLevel: () => AutonomyLevel | null;
  getModelId: () => string | null;
  getReasoningEffort: () => string | null;
  getSpecModeModelId: () => string | null;
  getSpecModeReasoningEffort: () => string | null;
  getMissionSettings: () => MissionModelSettings | null;
  getCompactionThresholdCheckEnabled: () => boolean | null;
};

/**
 * Read the current session's visible settings from the daemon-client SSM.
 * Session stores carry daemon snapshots/results for loaded sessions; the
 * default store is refreshed from daemon default settings before a session is
 * connected.
 */
function getStores(sessionId: string | null): {
  sessionStore: SettingsStore | null;
  pendingStore: SettingsStore;
  defaultStore: SettingsStore;
} {
  const adapter = getTuiDaemonAdapter();
  const ssm = adapter.getSessionStateManager();
  const sessionStore = sessionId
    ? (ssm.getSessionManager(sessionId)?.getStore() ?? null)
    : null;
  return {
    sessionStore,
    pendingStore: ssm.getPendingStore(),
    defaultStore: ssm.getDefaultSettingsStore(),
  };
}

function hasSessionSettings(store: SettingsStore | null): boolean {
  return (
    store !== null &&
    (store.getModelId() !== null ||
      store.getReasoningEffort() !== null ||
      store.getInteractionMode() !== null ||
      store.getAutonomyLevel() !== null)
  );
}

function createSubscribe(sessionId: string | null) {
  return (onStoreChange: () => void): (() => void) => {
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();

    const defaultUnsub = ssm.getDefaultSettingsStore().subscribe(onStoreChange);
    const pendingUnsub = ssm.getPendingStore().subscribe(onStoreChange);
    let storeUnsub: (() => void) | null = null;

    const subscribeToSessionStore = (): void => {
      storeUnsub?.();
      storeUnsub = null;
      if (!sessionId) {
        return;
      }
      const store = ssm.getSessionManager(sessionId)?.getStore();
      if (store) {
        storeUnsub = store.subscribe(onStoreChange);
      }
    };

    subscribeToSessionStore();

    const stateUnsub = sessionId
      ? ssm.subscribeToStateChanges((changedSessionId) => {
          if (changedSessionId === sessionId) {
            subscribeToSessionStore();
            onStoreChange();
          }
        })
      : null;

    return () => {
      defaultUnsub();
      pendingUnsub();
      storeUnsub?.();
      stateUnsub?.();
    };
  };
}

function createDefaultSubscribe() {
  return (onStoreChange: () => void): (() => void) => {
    const adapter = getTuiDaemonAdapter();
    return adapter
      .getSessionStateManager()
      .getDefaultSettingsStore()
      .subscribe(onStoreChange);
  };
}

function readDefaultStore<T>(read: (store: SettingsStore) => T): T {
  const adapter = getTuiDaemonAdapter();
  const store = adapter.getSessionStateManager().getDefaultSettingsStore();
  return read(store);
}

export function useSessionSettings(sessionId?: string | null) {
  const id = sessionId ?? null;
  const subscribe = useMemo(() => createSubscribe(id), [id]);

  const getInteractionMode = useMemo(
    () => (): DroolInteractionMode | null => {
      const { sessionStore, pendingStore, defaultStore } = getStores(id);
      return (
        sessionStore?.getInteractionMode() ??
        pendingStore.getInteractionMode() ??
        defaultStore.getInteractionMode()
      );
    },
    [id]
  );
  const getAutonomyLevel = useMemo(
    () => (): AutonomyLevel | null => {
      const { sessionStore, pendingStore, defaultStore } = getStores(id);
      return (
        sessionStore?.getAutonomyLevel() ??
        pendingStore.getAutonomyLevel() ??
        defaultStore.getAutonomyLevel()
      );
    },
    [id]
  );
  const getModel = useMemo(
    () => (): string | null => {
      const { sessionStore, pendingStore, defaultStore } = getStores(id);
      return (
        sessionStore?.getModelId() ??
        pendingStore.getModelId() ??
        defaultStore.getModelId()
      );
    },
    [id]
  );
  const getReasoningEffort = useMemo(
    () => (): ReasoningEffort | null => {
      const { sessionStore, pendingStore, defaultStore } = getStores(id);
      return (
        (sessionStore?.getReasoningEffort() as ReasoningEffort | null) ??
        (pendingStore.getReasoningEffort() as ReasoningEffort | null) ??
        (defaultStore.getReasoningEffort() as ReasoningEffort | null)
      );
    },
    [id]
  );
  const getSpecModeModel = useMemo(
    () => (): string | undefined => {
      const { sessionStore, pendingStore, defaultStore } = getStores(id);
      const store = hasSessionSettings(sessionStore)
        ? sessionStore
        : hasSessionSettings(pendingStore)
          ? pendingStore
          : defaultStore;
      return store?.getSpecModeModelId() ?? undefined;
    },
    [id]
  );
  const getSpecReasoningEffort = useMemo(
    () => (): ReasoningEffort | null => {
      const { sessionStore, pendingStore, defaultStore } = getStores(id);
      const store = hasSessionSettings(sessionStore)
        ? sessionStore
        : hasSessionSettings(pendingStore)
          ? pendingStore
          : defaultStore;
      return (
        (store?.getSpecModeReasoningEffort() as ReasoningEffort | null) ?? null
      );
    },
    [id]
  );
  const getMissionSettings = useMemo(
    () => (): MissionModelSettings | null => {
      const { sessionStore, pendingStore, defaultStore } = getStores(id);
      return (
        sessionStore?.getMissionSettings() ??
        pendingStore.getMissionSettings() ??
        defaultStore.getMissionSettings()
      );
    },
    [id]
  );
  const getCompactionThresholdCheckEnabled = useMemo(
    () => (): boolean => {
      const { sessionStore, pendingStore, defaultStore } = getStores(id);
      return (
        sessionStore?.getCompactionThresholdCheckEnabled() ??
        pendingStore.getCompactionThresholdCheckEnabled() ??
        defaultStore.getCompactionThresholdCheckEnabled() ??
        true
      );
    },
    [id]
  );

  return {
    interactionMode: useSyncExternalStore(subscribe, getInteractionMode),
    autonomyLevel: useSyncExternalStore(subscribe, getAutonomyLevel),
    model: useSyncExternalStore(subscribe, getModel),
    reasoningEffort: useSyncExternalStore(subscribe, getReasoningEffort),
    specModeModel: useSyncExternalStore(subscribe, getSpecModeModel),
    specReasoningEffort: useSyncExternalStore(
      subscribe,
      getSpecReasoningEffort
    ),
    missionSettings: useSyncExternalStore(subscribe, getMissionSettings),
    compactionThresholdCheckEnabled: useSyncExternalStore(
      subscribe,
      getCompactionThresholdCheckEnabled
    ),
  };
}

export function useDefaultSessionSettings() {
  const subscribe = useMemo(() => createDefaultSubscribe(), []);

  const getInteractionMode = useMemo(
    () => (): DroolInteractionMode | null =>
      readDefaultStore((store) => store.getInteractionMode()),
    []
  );
  const getAutonomyLevel = useMemo(
    () => (): AutonomyLevel | null =>
      readDefaultStore((store) => store.getAutonomyLevel()),
    []
  );
  const getModel = useMemo(
    () => (): string | null => readDefaultStore((store) => store.getModelId()),
    []
  );
  const getReasoningEffort = useMemo(
    () => (): ReasoningEffort | null =>
      readDefaultStore(
        (store) => store.getReasoningEffort() as ReasoningEffort | null
      ),
    []
  );
  const getSpecModeModel = useMemo(
    () => (): string | undefined =>
      readDefaultStore((store) => store.getSpecModeModelId() ?? undefined),
    []
  );
  const getSpecReasoningEffort = useMemo(
    () => (): ReasoningEffort | null =>
      readDefaultStore(
        (store) =>
          (store.getSpecModeReasoningEffort() as ReasoningEffort | null) ?? null
      ),
    []
  );
  const getMissionSettings = useMemo(
    () => (): MissionModelSettings | null =>
      readDefaultStore((store) => store.getMissionSettings()),
    []
  );
  const getCompactionThresholdCheckEnabled = useMemo(
    () => (): boolean =>
      readDefaultStore(
        (store) => store.getCompactionThresholdCheckEnabled() ?? true
      ),
    []
  );

  return {
    interactionMode: useSyncExternalStore(subscribe, getInteractionMode),
    autonomyLevel: useSyncExternalStore(subscribe, getAutonomyLevel),
    model: useSyncExternalStore(subscribe, getModel),
    reasoningEffort: useSyncExternalStore(subscribe, getReasoningEffort),
    specModeModel: useSyncExternalStore(subscribe, getSpecModeModel),
    specReasoningEffort: useSyncExternalStore(
      subscribe,
      getSpecReasoningEffort
    ),
    missionSettings: useSyncExternalStore(subscribe, getMissionSettings),
    compactionThresholdCheckEnabled: useSyncExternalStore(
      subscribe,
      getCompactionThresholdCheckEnabled
    ),
  };
}
