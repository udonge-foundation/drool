import { DaemonDroolEvent } from '@industry/common/daemon';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { DROOL_METHOD_SET } from '../../capabilities/constants';
import { DroolRegistry } from '../../drool/drool-registry';
import {
  PENDING_DAEMON_REQUEST_MAX_RESEND_ATTEMPTS,
  PENDING_DAEMON_REQUEST_TTL_MS,
} from '../constants/constants';
import { DaemonConnectionHandler } from '../daemon-connection-handler';
import { PendingDaemonRequestStore } from '../handlers/pending-daemon-request-store';
import { RequestDispatcher } from '../request-dispatcher';

import type { DroolCapability } from '../../capabilities/drool/types';
import type { BaseRequestHandler } from '../handlers/base-request-handler';
import type { ConnectionCleanupHook } from '../types';
import type {
  CapabilityToolbox,
  DaemonCapability,
  DaemonRequestCore,
  DaemonRequestCoreConfig,
  DaemonRequestCoreEnv,
} from './types';

function isDroolCapability(
  capability: DaemonCapability
): capability is DroolCapability {
  return capability.methods.some((method) => DROOL_METHOD_SET.has(method));
}

export async function createDaemonRequestCore(
  config: DaemonRequestCoreConfig
): Promise<{
  core: DaemonRequestCore;
  connectionHandler: DaemonConnectionHandler;
}> {
  let connectionHandler: DaemonConnectionHandler | undefined;

  const registry = new DroolRegistry(config.machineId, config.machineType, {
    sessionTimeoutMsOverride: config.sessionTimeoutMsOverride,
    broadcastToAuthenticatedConnections: (message) => {
      if (!connectionHandler) {
        logWarn(
          'Daemon connection handler not ready - skipping broadcast to authenticated connections'
        );
        return;
      }
      connectionHandler.broadcastToAuthenticatedConnections(message);
    },
  });

  const pendingRequests = new PendingDaemonRequestStore({
    defaultTtlMs: PENDING_DAEMON_REQUEST_TTL_MS,
    defaultMaxResendAttempts: PENDING_DAEMON_REQUEST_MAX_RESEND_ATTEMPTS,
    noTimeoutMethods: [
      DaemonDroolEvent.ASK_USER,
      DaemonDroolEvent.REQUEST_PERMISSION,
    ],
  });

  const env: DaemonRequestCoreEnv = {
    apiClient: config.apiClient,
    runtimeAuthConfig: config.runtimeAuthConfig,
    apiBaseUrl: config.apiBaseUrl,
    deploymentEnv: config.deploymentEnv,
    isDevelopment: config.isDevelopment,
    machineId: config.machineId,
    machineType: config.machineType,
    homeDir: config.homeDir,
    shell: config.shell,
    terminalEnv: config.terminalEnv,
    droolExecPath: config.droolExecPath,
  };

  // Per-connection cleanup seam: the terminal capability installs a hook to
  // release PTYs for a dropped connection. Reads `connectionHandler` at call time,
  // after it is assigned below.
  const setConnectionCleanup = (hook: ConnectionCleanupHook): void => {
    if (!connectionHandler) {
      throw new MetaError(
        'setConnectionCleanup called before the connection handler was wired'
      );
    }
    connectionHandler.setConnectionCleanup(hook);
  };

  const toolbox: CapabilityToolbox = {
    env,
    registry,
    pendingRequests,
    setConnectionCleanup,
  };

  const loadedHandlers = new Set<BaseRequestHandler>();

  const droolCapability = config.capabilities.find(isDroolCapability);
  if (!droolCapability) {
    throw new MetaError(
      'createDaemonRequestCore requires the drool capability to be enabled'
    );
  }
  const droolHandler = await droolCapability.load(
    droolCapability.buildDeps(toolbox)
  );

  const requestDispatcher = new RequestDispatcher(
    config.debug ?? false,
    droolHandler
  );

  connectionHandler = new DaemonConnectionHandler({
    droolRegistry: registry,
    droolHandler,
    requestDispatcher,
    cliVersion: config.cliVersion,
    runtimeAuthConfig: config.runtimeAuthConfig,
    homeDir: config.homeDir,
    connectionLabel: config.connectionLabel,
  });

  requestDispatcher.bind(droolCapability.methods, droolHandler);
  loadedHandlers.add(droolHandler);

  for (const capability of config.capabilities) {
    if (capability === droolCapability) {
      continue;
    }
    const handler = await capability.load(capability.buildDeps(toolbox));
    requestDispatcher.bind(capability.methods, handler);
    loadedHandlers.add(handler);
  }

  const core: DaemonRequestCore = {
    registry,
    shutdown: async () => {
      await registry.unregisterAllDroolClients();
      for (const handler of loadedHandlers) {
        handler.shutdown();
      }
      await connectionHandler!.shutdown();
    },
  };

  return { core, connectionHandler };
}
