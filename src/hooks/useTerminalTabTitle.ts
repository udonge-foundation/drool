import { DroolEvent } from '@industry/daemon-client';

import { useMountEffect } from '@/hooks/useMountEffect';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { setTerminalTabTitle } from '@/utils/terminalTitle';

/**
 * Listens for session title updates from the daemon controller and updates
 * the terminal tab/window title accordingly.
 *
 * The daemon (stream-jsonrpc drool) doesn't have access to the terminal, so
 * the renderer is responsible for reflecting title changes in the tab.
 *
 * Sanitization (control-character stripping, empty-string handling) is owned
 * by `setTerminalTabTitle` itself; this hook just forwards the payload.
 */
export function useTerminalTabTitle(): void {
  useMountEffect(() => {
    const adapter = getTuiDaemonAdapter();
    return adapter.onControllerEvent(
      DroolEvent.SessionTitleUpdated,
      (params: { sessionId: string; title: string }) => {
        setTerminalTabTitle(params.title);
      }
    );
  });
}
