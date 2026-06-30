import { useStdout } from 'ink';
import { useMemo, useSyncExternalStore } from 'react';

interface TerminalDimensions {
  width: number;
  height: number;
}

interface TerminalSizeStream {
  columns?: number;
  rows?: number;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

interface TerminalDimensionsStore {
  listeners: Set<() => void>;
  snapshot: string;
  stop: (() => void) | null;
}

const DEFAULT_TERMINAL_WIDTH = 80;
const DEFAULT_TERMINAL_HEIGHT = 24;
const MIN_TERMINAL_DIMENSION = 1;
const RESIZE_POLL_INTERVAL_MS = 1000;
const DEFAULT_TERMINAL_SNAPSHOT = `${DEFAULT_TERMINAL_WIDTH}x${DEFAULT_TERMINAL_HEIGHT}`;

const stores = new WeakMap<TerminalSizeStream, TerminalDimensionsStore>();

function normalizeTerminalDimension(
  value: number | undefined,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  if (value <= 0) {
    return MIN_TERMINAL_DIMENSION;
  }

  return Math.max(MIN_TERMINAL_DIMENSION, Math.floor(value));
}

export function getTerminalDimensionsSnapshot(
  stdout: Pick<TerminalSizeStream, 'columns' | 'rows'>
): string {
  const width = normalizeTerminalDimension(
    stdout.columns,
    DEFAULT_TERMINAL_WIDTH
  );
  const height = normalizeTerminalDimension(
    stdout.rows,
    DEFAULT_TERMINAL_HEIGHT
  );

  return `${width}x${height}`;
}

function parseTerminalDimensionsSnapshot(snapshot: string): TerminalDimensions {
  const [widthText, heightText] = snapshot.split('x');
  return {
    width: Number(widthText) || DEFAULT_TERMINAL_WIDTH,
    height: Number(heightText) || DEFAULT_TERMINAL_HEIGHT,
  };
}

function getStore(stdout: TerminalSizeStream): TerminalDimensionsStore {
  const existingStore = stores.get(stdout);
  if (existingStore) {
    return existingStore;
  }

  const store: TerminalDimensionsStore = {
    listeners: new Set(),
    snapshot: getTerminalDimensionsSnapshot(stdout),
    stop: null,
  };
  stores.set(stdout, store);
  return store;
}

function refreshStoreSnapshot(
  stdout: TerminalSizeStream,
  store: TerminalDimensionsStore
): boolean {
  const nextSnapshot = getTerminalDimensionsSnapshot(stdout);
  if (nextSnapshot === store.snapshot) {
    return false;
  }

  store.snapshot = nextSnapshot;
  return true;
}

export function readTerminalDimensionsSnapshot(
  stdout: TerminalSizeStream
): string {
  const store = getStore(stdout);
  refreshStoreSnapshot(stdout, store);
  return store.snapshot;
}

export function subscribeToTerminalDimensions(
  stdout: TerminalSizeStream,
  listener: () => void
): () => void {
  const store = getStore(stdout);
  store.listeners.add(listener);

  if (!store.stop) {
    const notifyIfChanged = () => {
      if (!refreshStoreSnapshot(stdout, store)) {
        return;
      }

      store.listeners.forEach((activeListener) => activeListener());
    };

    stdout.on('resize', notifyIfChanged);
    process.on('SIGWINCH', notifyIfChanged);

    const pollInterval = setInterval(notifyIfChanged, RESIZE_POLL_INTERVAL_MS);
    pollInterval.unref?.();

    store.stop = () => {
      stdout.off('resize', notifyIfChanged);
      process.off('SIGWINCH', notifyIfChanged);
      clearInterval(pollInterval);
      store.stop = null;
    };
  }

  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0) {
      store.stop?.();
    }
  };
}

/**
 * Hook to get current terminal dimensions and listen for resize events
 */
export function useTerminalDimensions(): TerminalDimensions {
  const { stdout } = useStdout();
  const terminalSizeStream = stdout as TerminalSizeStream;

  const snapshot = useSyncExternalStore(
    (listener) => subscribeToTerminalDimensions(terminalSizeStream, listener),
    () => readTerminalDimensionsSnapshot(terminalSizeStream),
    () => DEFAULT_TERMINAL_SNAPSHOT
  );

  return useMemo(() => parseTerminalDimensionsSnapshot(snapshot), [snapshot]);
}
