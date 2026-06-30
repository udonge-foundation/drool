import { TERMINAL_METHODS } from './methods';

import type { TerminalCapabilityDeps } from './types';
import type { DaemonCapability } from '../../server/core/types';

export function createTerminalCapability(): DaemonCapability<TerminalCapabilityDeps> {
  return {
    methods: TERMINAL_METHODS,
    buildDeps: (toolbox) => ({
      env: toolbox.env,
      setConnectionCleanup: toolbox.setConnectionCleanup,
    }),
    load: async (deps) => {
      const { TerminalManager } = await import(
        '../../terminal/terminal-manager'
      );
      const { TerminalRequestHandler } = await import(
        '../../server/handlers/terminal-request-handler'
      );

      const manager = new TerminalManager({
        shell: deps.env.shell,
        terminalEnv: deps.env.terminalEnv ?? {},
      });
      const handler = new TerminalRequestHandler(manager);
      deps.setConnectionCleanup(handler.buildConnectionCleanup());
      return handler;
    },
  };
}
