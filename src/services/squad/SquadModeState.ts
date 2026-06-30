import { watch, type FSWatcher } from 'fs';
import path from 'path';

import { getSquadsDir } from '@/services/squad/paths';
import { loadSquadBoardSnapshot } from '@/services/squad/SquadBoardStore';
import {
  getActiveSquad,
  getSquadChannelsDir,
  getSquadDmsDir,
  getSquadNotificationsDir,
} from '@/services/squad/SquadStateService';
import type { SquadOverview } from '@/services/squad/types';

type SquadOverviewSubscriber = (overview: SquadOverview) => void;

const OVERVIEW_REFRESH_DEBOUNCE_MS = 50;

const overviewSubscribers = new Set<SquadOverviewSubscriber>();
let latestOverview: SquadOverview | null = null;
let latestOverviewKey: string | null = null;
let rootWatchers: FSWatcher[] = [];
let activeSquadWatchers: FSWatcher[] = [];
let watchedSquadId: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshPromise: Promise<SquadOverview> | null = null;
let refreshQueued = false;
let performScheduledRefresh: (() => void) | null = null;

function createEmptyOverview(): SquadOverview {
  return {
    snapshot: null,
    selectedSquadId: null,
    agents: [],
  };
}

function serializeOverview(overview: SquadOverview): string {
  return JSON.stringify(overview);
}

function buildSquadWatchPaths(squadId: string): string[] {
  const squadDir = path.join(getSquadsDir(), squadId);
  return [
    squadDir,
    getSquadChannelsDir(squadId),
    getSquadDmsDir(squadId),
    getSquadNotificationsDir(squadId),
  ];
}

function emitOverview(overview: SquadOverview): void {
  overviewSubscribers.forEach((subscriber) => {
    subscriber(overview);
  });
}

function closeWatchers(watchers: FSWatcher[]): void {
  watchers.forEach((watcher) => {
    watcher.close();
  });
}

function scheduleOverviewRefresh(): void {
  if (refreshTimer) {
    return;
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    performScheduledRefresh?.();
  }, OVERVIEW_REFRESH_DEBOUNCE_MS);

  if (typeof refreshTimer.unref === 'function') {
    refreshTimer.unref();
  }
}

function createWatcher(watchPath: string): FSWatcher | null {
  try {
    return watch(watchPath, () => {
      scheduleOverviewRefresh();
    });
  } catch {
    return null;
  }
}

function ensureRootWatchers(): void {
  if (rootWatchers.length > 0) {
    return;
  }

  const watcherPaths = [path.dirname(getSquadsDir()), getSquadsDir()];
  rootWatchers = watcherPaths
    .map((watchPath) => createWatcher(watchPath))
    .flatMap((watcher) => (watcher ? [watcher] : []));
}

function syncActiveSquadWatchers(squadId: string | null): void {
  if (watchedSquadId === squadId) {
    return;
  }

  closeWatchers(activeSquadWatchers);
  activeSquadWatchers = [];
  watchedSquadId = squadId;

  if (!squadId) {
    return;
  }

  activeSquadWatchers = buildSquadWatchPaths(squadId)
    .map((watchPath) => createWatcher(watchPath))
    .flatMap((watcher) => (watcher ? [watcher] : []));
}

function stopWatchingSquadOverview(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  closeWatchers(rootWatchers);
  closeWatchers(activeSquadWatchers);
  rootWatchers = [];
  activeSquadWatchers = [];
  watchedSquadId = null;
  latestOverview = null;
  latestOverviewKey = null;
  refreshPromise = null;
  refreshQueued = false;
}

async function loadSquadOverview(): Promise<SquadOverview> {
  const activeSquad = await getActiveSquad();
  if (!activeSquad) {
    return createEmptyOverview();
  }

  const snapshot = await loadSquadBoardSnapshot(activeSquad.id);
  if (!snapshot) {
    return {
      snapshot: null,
      selectedSquadId: activeSquad.id,
      agents: [],
    };
  }

  return {
    snapshot,
    selectedSquadId: snapshot.squad.id,
    agents: snapshot.squad.agents.map((agent) => ({
      agentId: agent.agentId,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      introduced: Boolean(agent.introducedAt),
      pendingNotifications:
        snapshot.notificationsByAgent[agent.agentId]?.length ?? 0,
      lastActivityAt: agent.lastActivityAt,
    })),
  };
}

async function refreshSquadOverviewInternal(): Promise<SquadOverview> {
  if (refreshPromise) {
    refreshQueued = true;
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const overview = await loadSquadOverview();
    const overviewKey = serializeOverview(overview);

    if (overviewSubscribers.size > 0) {
      ensureRootWatchers();
      syncActiveSquadWatchers(overview.selectedSquadId);
    } else {
      syncActiveSquadWatchers(null);
    }

    latestOverview = overview;
    if (overviewKey !== latestOverviewKey) {
      latestOverviewKey = overviewKey;
      emitOverview(overview);
    }

    return overview;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
    if (refreshQueued) {
      refreshQueued = false;
      void refreshSquadOverviewInternal();
    }
  }
}

export async function refreshSquadOverview(): Promise<SquadOverview> {
  return refreshSquadOverviewInternal();
}

performScheduledRefresh = () => {
  void refreshSquadOverviewInternal();
};

export function subscribeToSquadOverview(
  subscriber: SquadOverviewSubscriber
): () => void {
  const shouldStartWatching = overviewSubscribers.size === 0;
  overviewSubscribers.add(subscriber);

  if (shouldStartWatching) {
    void refreshSquadOverview();
  } else if (latestOverview) {
    subscriber(latestOverview);
  }

  return () => {
    overviewSubscribers.delete(subscriber);
    if (overviewSubscribers.size === 0) {
      stopWatchingSquadOverview();
    }
  };
}

export function _resetSquadOverviewSubscriptionsForTesting(): void {
  overviewSubscribers.clear();
  stopWatchingSquadOverview();
}
