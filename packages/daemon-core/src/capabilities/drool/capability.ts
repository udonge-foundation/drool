import * as path from 'path';

import { DaemonDroolMethod, MachineType } from '@industry/common/daemon';
import { getIndustryDirName } from '@industry/utils/environment';

import type { DroolCapability, DroolCapabilityHostDeps } from './types';

export function createDroolCapability(
  host: DroolCapabilityHostDeps = {}
): DroolCapability {
  return {
    methods: Object.values(DaemonDroolMethod),
    buildDeps: (toolbox) => ({
      env: toolbox.env,
      registry: toolbox.registry,
      pendingRequests: toolbox.pendingRequests,
      ...host,
    }),
    load: async (deps) => {
      const { DroolRequestHandler } = await import(
        '../../server/handlers/drool-request-handler'
      );
      const { AutomationSyncService } = await import(
        '../../automations/automation-sync-service'
      );
      const { CronRegistry, CronRuntime } = await import('../../crons');

      const automationSyncService = new AutomationSyncService({
        homeDir: deps.env.homeDir,
        machineId: deps.env.machineId,
        apiBaseUrl: deps.env.apiBaseUrl,
        runtimeAuthConfig: deps.env.runtimeAuthConfig,
        registry: deps.registry,
      });
      // Run startup + periodic reconcile syncs (see AutomationSyncService.start).
      automationSyncService.start();

      const cronRegistry = new CronRegistry({
        cronsDir: path.join(deps.env.homeDir, getIndustryDirName(), 'crons'),
        onChange: (event) => deps.registry.broadcastCronStateChanged(event),
      });
      const cronRuntime = new CronRuntime({
        registry: cronRegistry,
        onSessionPrompt: async (cron) => {
          if (cron.kind !== 'session_prompt' || cron.scope.type !== 'session') {
            return;
          }
          const client = deps.registry.getDroolClient(cron.scope.sessionId);
          if (!client) {
            cronRegistry.updateCron(cron.id, {
              status: 'held',
              heldAt: new Date().toISOString(),
              holdReason: 'session-inactive',
            });
            cronRuntime.sync();
            return;
          }
          await client.addUserMessage({ text: cron.payload.prompt });
        },
        canRegister: (cron) => cron.scope.type === 'session',
      });

      const handler = new DroolRequestHandler({
        ...deps,
        automationSyncService,
        cronRegistry,
        cronRuntime,
      });

      if (deps.env.machineType === MachineType.Local) {
        cronRuntime.start();
      }

      return handler;
    },
  };
}
