import { intervalToCron } from '@/services/crons/loopSchedule';
import type {
  CreateSessionCronParams,
  EditCronParams,
} from '@/services/crons/types';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';

import type { CronRecord } from '@industry/common/daemon';

export async function createSessionCron(
  params: CreateSessionCronParams
): Promise<CronRecord> {
  const c = await getTuiDaemonAdapter().ensureConnectedAndGetController();
  const { cron } = await c.createCron({
    kind: 'session_prompt',
    source: 'loop_command',
    scope: {
      type: 'session',
      sessionId: params.sessionId,
      sessionCwd: params.sessionCwd,
    },
    schedule: {
      expression: intervalToCron(params.intervalMs).expression,
      recurring: true,
    },
    runImmediately: true,
    runPolicy: { whenSessionInactive: 'hold' },
    payload: {
      type: 'prompt',
      prompt: params.prompt,
      target: { type: 'same_session' },
    },
  });
  return cron;
}

export async function editCron(
  params: EditCronParams
): Promise<CronRecord | null> {
  const c = await getTuiDaemonAdapter().ensureConnectedAndGetController();
  const { cron } = await c.updateCron({
    cronId: params.cronId,
    schedule: {
      expression: intervalToCron(params.intervalMs).expression,
      recurring: true,
    },
    payload: {
      prompt: params.prompt,
    },
  });
  return cron;
}

export async function pauseCron(cronId: string): Promise<CronRecord | null> {
  const c = await getTuiDaemonAdapter().ensureConnectedAndGetController();
  const { cron } = await c.updateCron({ cronId, status: 'paused' });
  return cron;
}

export async function resumeCron(cronId: string): Promise<CronRecord | null> {
  const c = await getTuiDaemonAdapter().ensureConnectedAndGetController();
  const { cron } = await c.updateCron({ cronId, status: 'active' });
  return cron;
}

export async function deleteCronAction(
  cronId: string,
  sessionId?: string
): Promise<void> {
  const c = await getTuiDaemonAdapter().ensureConnectedAndGetController();
  await c.deleteCron({ cronId, sessionId });
}
