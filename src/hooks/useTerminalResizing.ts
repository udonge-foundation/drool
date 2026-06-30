import { useEffect, useRef } from 'react';

import { useMountEffect } from '@/hooks/useMountEffect';
import {
  readTerminalDimensionsSnapshot,
  subscribeToTerminalDimensions,
} from '@/hooks/useTerminalDimensions';
import { clearTerminal } from '@/utils/clearTerminal';
import { SHUTDOWN_HOOK_PRIORITY } from '@/utils/constants';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';

const cleanupHandlers = new Set<() => void>();
let shutdownHookRegistered = false;

const registerShutdownHook = () => {
  if (shutdownHookRegistered) return;
  shutdownHookRegistered = true;
  const shutdownCoordinator = getShutdownCoordinator();
  shutdownCoordinator.registerHook(
    'terminal-resizing',
    async () => {
      cleanupHandlers.forEach((cleanup) => cleanup());
    },
    { priority: SHUTDOWN_HOOK_PRIORITY.TerminalResizing }
  );
};

export function useTerminalResizing(options?: {
  clearOnResize?: boolean;
  clearTerminal?: () => void;
}): void {
  const cleanupRef = useRef<(() => void) | null>(null);
  const clearOnResizeRef = useRef(options?.clearOnResize !== false);
  const clearTerminalRef = useRef(options?.clearTerminal ?? clearTerminal);

  useEffect(() => {
    clearOnResizeRef.current = options?.clearOnResize !== false;
    clearTerminalRef.current = options?.clearTerminal ?? clearTerminal;
  }, [options?.clearOnResize, options?.clearTerminal]);

  useMountEffect(() => {
    const stdout = process.stdout as NodeJS.WriteStream;

    let previousWidth = readTerminalDimensionsSnapshot(stdout).split('x')[0];

    const onResize = () => {
      const nextSnapshot = readTerminalDimensionsSnapshot(stdout);
      const nextWidth = nextSnapshot.split('x')[0];

      // Only clear if the width of the terminal changed
      if (clearOnResizeRef.current && nextWidth !== previousWidth) {
        clearTerminalRef.current();
      }

      previousWidth = nextWidth;
    };

    let unsubscribe = () => {};

    const cleanup = () => {
      if (cleanupRef.current === null) return;

      unsubscribe();

      cleanupHandlers.delete(cleanup);

      cleanupRef.current = null;
    };

    unsubscribe = subscribeToTerminalDimensions(stdout, onResize);

    cleanupRef.current = cleanup;

    cleanupHandlers.add(cleanup);
    registerShutdownHook();
    // ShutdownCoordinator owns cleanup; `exit` is synchronous, so avoid fallback handlers.

    return cleanup;
  });
}
