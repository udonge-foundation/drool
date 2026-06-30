import { logException, logInfo, logWarn, Metrics } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { CronRegistry } from './CronRegistry';

import type { CronRecord } from '@industry/common/daemon';

interface CronRuntimeOptions {
  registry: CronRegistry;
  onSessionPrompt: (cron: CronRecord) => Promise<void>;
  onRootPrompt?: (cron: CronRecord) => Promise<void>;
  canRegister?: (cron: CronRecord) => boolean;
}

type BunCronJob = {
  stop(): BunCronJob;
  unref(): BunCronJob;
};

interface RegisteredCronJob {
  job: BunCronJob;
  expression: string;
}
const CRON_RUNTIME_METRIC = 'daemon_cron_runtime_count';

const FIRST_FIRE_GRACE_MS = 30_000;
const FIRST_FIRE_GUARD_BUFFER_MS = 5_000;
const OVERDUE_FIRE_GRACE_MS = 5_000;
const WATCHDOG_INTERVAL_MS = 30_000;

function logRuntimeEvent(cron: CronRecord, status: string): void {
  Metrics.addToCounter(CRON_RUNTIME_METRIC, 1, {
    source: cron.source,
    status,
    type: cron.kind,
  });
}

export class CronRuntime {
  private readonly registry: CronRegistry;

  private readonly onSessionPrompt: (cron: CronRecord) => Promise<void>;

  private readonly onRootPrompt?: (cron: CronRecord) => Promise<void>;

  private readonly canRegister?: (cron: CronRecord) => boolean;

  private readonly jobs = new Map<string, RegisteredCronJob>();

  private watchdog: ReturnType<typeof setInterval> | undefined;

  constructor(options: CronRuntimeOptions) {
    this.registry = options.registry;
    this.onSessionPrompt = options.onSessionPrompt;
    this.onRootPrompt = options.onRootPrompt;
    this.canRegister = options.canRegister;
  }

  start(): void {
    for (const cron of this.registry.listRuntimeCrons()) {
      if (cron.kind === 'root_prompt' && cron.status === 'running') {
        this.registry.updateCron(cron.id, {
          status: 'active',
          stats: {
            ...cron.stats,
            lastError: undefined,
          },
        });
        continue;
      }

      if (
        cron.scope.type !== 'session' ||
        cron.runPolicy.whenSessionInactive !== 'hold'
      ) {
        continue;
      }
      this.registry.updateCron(cron.id, {
        status: 'held',
        heldAt: new Date().toISOString(),
        holdReason: 'daemon-start',
      });
    }
    this.startWatchdog();
    this.sync();
  }

  stop(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    for (const registered of this.jobs.values()) {
      registered.job.stop();
    }
    this.jobs.clear();
  }

  sync(): void {
    const runtimeCrons = this.registry.listRuntimeCrons();

    const runtimeCronById = new Map(
      runtimeCrons.map((cron) => [cron.id, cron])
    );

    for (const [cronId, registered] of this.jobs) {
      const cron = runtimeCronById.get(cronId);
      if (
        !cron ||
        cron.status !== 'active' ||
        !this.shouldRegister(cron) ||
        registered.expression !== cron.schedule.expression
      ) {
        registered.job.stop();
        this.jobs.delete(cronId);
      }
    }

    for (const cron of runtimeCrons) {
      if (cron.status !== 'active') {
        continue;
      }

      if (!this.shouldRegister(cron)) {
        continue;
      }

      if (this.isOverdue(cron)) {
        const existing = this.jobs.get(cron.id);
        if (existing) {
          existing.job.stop();
          this.jobs.delete(cron.id);
        }
        this.fireAndLog(cron.id, { bypassFirstFireGuard: true });
        continue;
      }

      if (this.jobs.has(cron.id)) {
        continue;
      }
      this.register(cron);
    }
  }

  async fireNow(cronId: string): Promise<void> {
    await this.fire(cronId, { bypassFirstFireGuard: true });
  }

  private fireAndLog(
    cronId: string,
    options: { bypassFirstFireGuard?: boolean } = {}
  ): void {
    void this.fire(cronId, options).catch((error) => {
      logException(error, '[CronRuntime] Detached cron fire failed', {
        externalId: cronId,
      });
    });
  }

  private startWatchdog(): void {
    if (this.watchdog) {
      return;
    }

    this.watchdog = setInterval(() => {
      this.sync();
    }, WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();
  }

  private isOverdue(cron: CronRecord): boolean {
    const nextRunAt = cron.schedule.nextRunAt;
    if (!nextRunAt) {
      return false;
    }
    const nextRunTime = new Date(nextRunAt).getTime();
    if (Number.isNaN(nextRunTime)) {
      return false;
    }
    const lastCompletedAt = cron.stats.lastCompletedAt;
    if (lastCompletedAt) {
      const lastCompletedTime = new Date(lastCompletedAt).getTime();
      if (
        !Number.isNaN(lastCompletedTime) &&
        lastCompletedTime >= nextRunTime
      ) {
        return false;
      }
    }
    return Date.now() - nextRunTime > OVERDUE_FIRE_GRACE_MS;
  }

  private shouldRegister(cron: CronRecord): boolean {
    if (cron.payload.target.type === 'new_session' && !this.onRootPrompt) {
      return false;
    }

    return this.canRegister?.(cron) ?? true;
  }

  private getPromptHandler(
    cron: CronRecord
  ): ((record: CronRecord) => Promise<void>) | null {
    if (cron.payload.target.type === 'new_session') {
      return this.onRootPrompt ?? null;
    }

    return this.onSessionPrompt;
  }

  private register(scheduledCron: CronRecord): void {
    try {
      const next = Bun.cron.parse(scheduledCron.schedule.expression);
      const msUntilNext = next ? next.getTime() - Date.now() : undefined;
      const guardUntil =
        next &&
        msUntilNext !== undefined &&
        msUntilNext > 0 &&
        msUntilNext < FIRST_FIRE_GRACE_MS
          ? new Date(next.getTime() + FIRST_FIRE_GUARD_BUFFER_MS).toISOString()
          : undefined;
      this.registry.updateCron(scheduledCron.id, {
        schedule: {
          ...scheduledCron.schedule,
          nextRunAt: next?.toISOString(),
          firstFireGuardUntil: guardUntil,
        },
      });
      const job = Bun.cron(scheduledCron.schedule.expression, () => {
        this.fireAndLog(scheduledCron.id);
      }).unref();
      this.jobs.set(scheduledCron.id, {
        job,
        expression: scheduledCron.schedule.expression,
      });
      logInfo('[CronRuntime] Registered cron', {
        externalId: scheduledCron.id,
        actionType: scheduledCron.kind,
      });
    } catch (error) {
      logWarn('[CronRuntime] Failed to register cron', {
        externalId: scheduledCron.id,
        cause: error,
      });
      this.registry.updateCron(scheduledCron.id, {
        status: 'error',
        stats: {
          ...scheduledCron.stats,
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async fire(
    cronId: string,
    options: { bypassFirstFireGuard?: boolean } = {}
  ): Promise<void> {
    const cron = this.registry.getCron(cronId);
    if (!cron || cron.status !== 'active') {
      return;
    }

    const guardUntil = cron.schedule.firstFireGuardUntil;
    if (
      !options.bypassFirstFireGuard &&
      guardUntil &&
      Date.now() < new Date(guardUntil).getTime()
    ) {
      const next = Bun.cron.parse(cron.schedule.expression);
      this.registry.updateCron(cron.id, {
        schedule: {
          ...cron.schedule,
          nextRunAt: next?.toISOString(),
          firstFireGuardUntil: undefined,
        },
      });
      logRuntimeEvent(cron, 'fire_skipped_grace');
      return;
    }

    const startedAt = new Date().toISOString();
    logRuntimeEvent(cron, 'fire_started');
    this.registry.updateCron(cron.id, {
      status: 'running',
      stats: {
        ...cron.stats,
        lastRunAt: startedAt,
      },
    });

    try {
      const handler = this.getPromptHandler(cron);
      if (!handler) {
        throw new MetaError('No cron prompt handler is available');
      }
      await handler(cron);

      const completedAt = new Date().toISOString();
      const latest = this.registry.getCron(cron.id);
      if (!latest) return;
      if (latest.status !== 'running') return;

      if (!latest.schedule.recurring) {
        this.registry.updateCron(cron.id, {
          status: 'expired',
          stats: {
            ...latest.stats,
            fireCount: latest.stats.fireCount + 1,
            lastCompletedAt: completedAt,
            lastError: undefined,
          },
        });
        logRuntimeEvent(latest, 'fire_expired');
      } else {
        const next = Bun.cron.parse(latest.schedule.expression);
        this.registry.updateCron(cron.id, {
          status: 'active',
          schedule: {
            ...latest.schedule,
            nextRunAt: next?.toISOString(),
            firstFireGuardUntil: undefined,
          },
          stats: {
            ...latest.stats,
            fireCount: latest.stats.fireCount + 1,
            lastCompletedAt: completedAt,
            lastError: undefined,
          },
        });
        logRuntimeEvent(latest, 'fire_completed');
      }
    } catch (error) {
      logException(error, '[CronRuntime] Cron fire failed', {
        externalId: cronId,
      });
      const latest = this.registry.getCron(cron.id) ?? cron;
      this.registry.updateCron(cron.id, {
        status: 'error',
        stats: {
          ...latest.stats,
          lastCompletedAt: new Date().toISOString(),
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      logRuntimeEvent(latest, 'fire_failed');
    } finally {
      const existing = this.jobs.get(cron.id);
      if (existing) {
        existing.job.stop();
        this.jobs.delete(cron.id);
      }
      this.sync();
    }
  }
}
