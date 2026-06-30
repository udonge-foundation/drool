import { once } from 'lodash-es';

import { processTracker } from '@/services/ProcessTracker';
import { TerminalServiceMode } from '@/services/TerminalService/enums';
import { HostTerminalService } from '@/services/TerminalService/HostTerminalService';
import { LocalTerminalService } from '@/services/TerminalService/LocalTerminalService';
import type {
  ITerminalService,
  TerminalServiceConfig,
} from '@/services/TerminalService/types';
import { SHUTDOWN_HOOK_PRIORITY } from '@/utils/constants';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';

let terminalServiceConfig: TerminalServiceConfig = {
  mode: TerminalServiceMode.Local,
};

const createTerminalService = once((): ITerminalService => {
  const service =
    terminalServiceConfig.mode === TerminalServiceMode.Host
      ? new HostTerminalService(
          terminalServiceConfig.connection,
          terminalServiceConfig.sessionId
        )
      : new LocalTerminalService();

  getShutdownCoordinator().registerHook(
    'tool-processes',
    async () => {
      await processTracker.killAllProcesses();
      await service.releaseAll();
    },
    { priority: SHUTDOWN_HOOK_PRIORITY.ToolProcesses }
  );

  return service;
});

export function initializeTerminalService(config: TerminalServiceConfig): void {
  terminalServiceConfig = config;
}

export function getTerminalService(): ITerminalService {
  return createTerminalService();
}
