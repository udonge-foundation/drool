import { logWarn } from '@industry/logging';

import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import {
  SQUAD_ORCHESTRATOR_WAKEUP_INTERVAL_MS,
  SQUAD_WAKEUP_HEARTBEAT_STALE_MS,
} from '@/services/squad/constants';
import { SquadRole, SquadStatus } from '@/services/squad/enums';
import {
  clearSquadWakeupHeartbeat,
  getActiveSquadId,
  getSquadState,
  recordSquadWakeupHeartbeat,
} from '@/services/squad/SquadStateService';

function formatPeriodicWakeupMessage(): string {
  return `<system-reminder>
Squad wake-up
Type: periodic check-in
Reason: fixed 5-minute orchestrator progress check
Action: review squad progress, unresolved notifications, quiet workers, overlap, blockers, and next steps; intervene if needed.
</system-reminder>`;
}

class SquadWakeupScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private squadId: string | null = null;

  private orchestratorSessionId: string | null = null;

  private async persistHeartbeat(): Promise<void> {
    if (!this.squadId) {
      return;
    }

    await recordSquadWakeupHeartbeat({
      squadId: this.squadId,
      ownerPid: process.pid,
    });
  }

  start(params: { squadId: string; orchestratorSessionId: string }): void {
    if (
      this.intervalId &&
      this.squadId === params.squadId &&
      this.orchestratorSessionId === params.orchestratorSessionId
    ) {
      void this.persistHeartbeat();
      return;
    }

    this.stop();

    this.squadId = params.squadId;
    this.orchestratorSessionId = params.orchestratorSessionId;
    this.intervalId = setInterval(() => {
      void this.tick();
    }, SQUAD_ORCHESTRATOR_WAKEUP_INTERVAL_MS);

    if (typeof this.intervalId.unref === 'function') {
      this.intervalId.unref();
    }

    void this.persistHeartbeat();
  }

  stop(squadId?: string): void {
    if (squadId && this.squadId !== squadId) {
      return;
    }

    const currentSquadId = this.squadId;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.squadId = null;
    this.orchestratorSessionId = null;

    if (currentSquadId) {
      void clearSquadWakeupHeartbeat({
        squadId: currentSquadId,
        ownerPid: process.pid,
      });
    }
  }

  async tick(): Promise<void> {
    if (!this.squadId || !this.orchestratorSessionId) {
      return;
    }

    const activeSquadId = await getActiveSquadId();
    if (activeSquadId !== this.squadId) {
      this.stop(this.squadId);
      return;
    }

    const squad = await getSquadState(this.squadId);
    if (!squad || squad.status !== SquadStatus.Running) {
      this.stop(this.squadId);
      return;
    }

    const orchestrator = squad.agents.find(
      (agent) => agent.role === SquadRole.Orchestrator
    );
    const sessionId = orchestrator?.sessionId ?? this.orchestratorSessionId;
    if (!sessionId) {
      this.stop(this.squadId);
      return;
    }

    this.orchestratorSessionId = sessionId;

    try {
      await this.persistHeartbeat();
      await getTuiDaemonAdapter().addUserMessage({
        sessionId,
        text: formatPeriodicWakeupMessage(),
      });
    } catch (error) {
      logWarn('[SquadWakeupScheduler] Failed to enqueue periodic wake-up', {
        cause: error,
        teamId: this.squadId,
        sessionId,
      });
    }
  }
}

let singleton: SquadWakeupScheduler | null = null;

export function getSquadWakeupScheduler(): SquadWakeupScheduler {
  if (!singleton) {
    singleton = new SquadWakeupScheduler();
  }

  return singleton;
}

export function formatSquadPeriodicWakeupMessageForTesting(): string {
  return formatPeriodicWakeupMessage();
}

export async function ensureActiveSquadWakeupScheduler(): Promise<boolean> {
  const activeSquadId = await getActiveSquadId();
  const scheduler = getSquadWakeupScheduler();

  if (!activeSquadId) {
    scheduler.stop();
    return false;
  }

  const squad = await getSquadState(activeSquadId);
  if (!squad || squad.status !== SquadStatus.Running) {
    scheduler.stop(activeSquadId);
    return false;
  }

  const orchestratorSessionId = squad.agents.find(
    (agent) => agent.role === SquadRole.Orchestrator
  )?.sessionId;

  if (!orchestratorSessionId) {
    scheduler.stop(activeSquadId);
    return false;
  }

  const heartbeatAt = squad.runtime?.wakeupHeartbeatAt;
  const heartbeatTimestamp = heartbeatAt ? new Date(heartbeatAt).getTime() : 0;
  const heartbeatAgeMs = Number.isFinite(heartbeatTimestamp)
    ? Date.now() - heartbeatTimestamp
    : Number.POSITIVE_INFINITY;
  const ownedByCurrentProcess = squad.runtime?.wakeupOwnerPid === process.pid;
  const shouldTakeOver =
    ownedByCurrentProcess || heartbeatAgeMs > SQUAD_WAKEUP_HEARTBEAT_STALE_MS;

  if (!shouldTakeOver) {
    scheduler.stop(activeSquadId);
    return false;
  }

  scheduler.start({
    squadId: activeSquadId,
    orchestratorSessionId,
  });
  return true;
}

export function _resetSquadWakeupSchedulerForTesting(): void {
  singleton?.stop();
  singleton = null;
}
