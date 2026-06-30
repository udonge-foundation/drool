import {
  DaemonHeartbeatRequest,
  DaemonHeartbeatResponse,
} from '@industry/common/api/daemon/types';
import {
  DAEMON_HEARTBEAT_INTERVAL_MS,
  MachineType,
} from '@industry/common/daemon';
import { logException, logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { OtelTracing, SpanName } from '@industry/logging/tracing';

import { IndustryApiClient } from './ApiClient';
import { DroolRegistry } from '../drool/drool-registry';
import { debugLog } from '../utils/debug-log';

import type { ResolvedHostIdentity } from '@industry/drool-sdk-ext/protocol/host';

interface HeartbeatServiceOptions {
  droolRegistry: DroolRegistry;
  apiClient: IndustryApiClient;
  machineId: string;
  machineType?: MachineType;
  debug: boolean;
  intervalMs?: number;
  getLastServerActivityAt?: () => number;
  onIdleUpdate?: () => Promise<void>;
  getHostIdentity?: () => Promise<ResolvedHostIdentity | undefined>;
}

/**
 * HeartbeatService manages periodic pings to the backend API
 * to indicate the daemon is alive and managing active sessions.
 *
 * Ephemeral sandboxes only heartbeat when there is recent daemon activity
 * (drool sessions, terminal I/O, tunnels, proxied connections) so they can
 * expire when unused. Computers always heartbeat and report `idleMs` so the
 * backend can own the idle decision (extend timeout vs. snapshot + pause).
 */
export class HeartbeatService {
  private intervalId: NodeJS.Timeout | null;

  private readonly droolRegistry: DroolRegistry;

  private readonly apiClient: IndustryApiClient;

  private readonly machineId: string;

  private readonly machineType: MachineType;

  private readonly debug: boolean;

  private readonly intervalMs: number;

  private readonly getLastServerActivityAt: (() => number) | undefined;

  private readonly onIdleUpdate: (() => Promise<void>) | undefined;

  private readonly getHostIdentity:
    | (() => Promise<ResolvedHostIdentity | undefined>)
    | undefined;

  private idleUpdateTriggered = false;

  constructor(opts: HeartbeatServiceOptions) {
    this.droolRegistry = opts.droolRegistry;
    this.apiClient = opts.apiClient;
    this.machineId = opts.machineId;
    this.getLastServerActivityAt = opts.getLastServerActivityAt;
    this.onIdleUpdate = opts.onIdleUpdate;
    this.getHostIdentity = opts.getHostIdentity;
    this.machineType = opts.machineType ?? MachineType.Local;
    this.debug = opts.debug;
    this.intervalMs = DAEMON_HEARTBEAT_INTERVAL_MS;
    this.intervalId = null;
  }

  /**
   * Starts the heartbeat interval.
   * Ephemeral sandboxes only heartbeat when there is recent activity;
   * Computers always heartbeat (see `sendHeartbeat`).
   */
  start(): void {
    if (this.intervalId !== null) {
      logException(
        new MetaError('HeartbeatService is already running'),
        'Attempted to start already running HeartbeatService'
      );
      return;
    }

    if (this.debug) {
      debugLog('Starting HeartbeatService');
    }

    this.intervalId = setInterval(() => {
      void this.sendHeartbeat();
    }, this.intervalMs);
  }

  /**
   * Stops the heartbeat interval and cleans up resources.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;

      if (this.debug) {
        debugLog('Stopped HeartbeatService');
      }
    }
  }

  /**
   * Sends a heartbeat to the backend, gated by machine type.
   *
   * Ephemeral sandboxes are gated on a combined activity signal: drool
   * process I/O (SESSION_NOTIFICATION) OR WebSocket activity
   * (open/message/close). If neither signal fires within one heartbeat
   * interval, we skip the heartbeat and let E2B's own 5-minute timeout
   * expire the sandbox, keeping the idle tail at ~5-6 min.
   *
   * Computers always heartbeat and report `idleMs` so the backend can own
   * the idle decision (extend timeout vs. snapshot + pause).
   */
  private async sendHeartbeat(): Promise<void> {
    switch (this.machineType) {
      case MachineType.Local:
        if (this.debug) {
          debugLog('Skipping heartbeat', { machineId: this.machineId });
        }
        return;

      case MachineType.Ephemeral: {
        if (!this.shouldSendRemoteHeartbeat()) {
          return;
        }
        break;
      }

      case MachineType.Computer: {
        // Computers always heartbeat: the backend owns the idle decision
        // (extend the sandbox timeout vs. snapshot + pause), so the daemon
        // must keep reporting `idleMs` even while idle. The existing idle
        // auto-update trigger is preserved.
        this.maybeTriggerComputerIdleUpdate();
        break;
      }

      default: {
        const exhaustiveCheck: never = this.machineType;
        throw new MetaError('Unsupported machine type', {
          value: exhaustiveCheck,
        });
      }
    }

    await this.postHeartbeat();
  }

  /**
   * Determines whether a heartbeat should be sent for an Ephemeral sandbox.
   *
   * Ephemeral sandboxes exist solely for drool sessions, so we gate on a
   * combined activity signal: drool process I/O (SESSION_NOTIFICATION events
   * from stdin/stdout) OR WebSocket activity (open/message/close). If neither
   * fires within one heartbeat interval, we skip the heartbeat so E2B's own
   * 5-minute timeout can expire the sandbox.
   *
   * Computers do NOT use this gate — they always heartbeat (see
   * `sendHeartbeat`) so the backend can own the idle decision.
   */
  private shouldSendRemoteHeartbeat(): boolean {
    if (this.droolRegistry.getDroolClientCount() === 0) {
      if (this.debug) {
        debugLog('Skipping heartbeat - no active drool sessions');
      }
      return false;
    }

    if (this.hasRecentActivity()) {
      return true;
    }

    if (this.debug) {
      debugLog('Skipping heartbeat - no recent drool or WebSocket activity');
    }
    return false;
  }

  /**
   * Checks whether there has been recent drool process I/O or WebSocket
   * activity within the last heartbeat interval.
   *
   * Drool activity comes from the registry's activity clock, which the
   * registry keeps fresh while any session is in an active working state
   * (thinking, streaming, executing a tool, or compacting). This covers
   * long-running, low-chatter work (e.g. a lengthy tool call or an
   * orchestrated mission worker) and remains bounded by the per-session
   * inactivity timeout, which removes silently-stuck sessions.
   */
  private hasRecentActivity(): boolean {
    const now = Date.now();
    const threshold = this.intervalMs;

    const droolIdleMs = now - this.droolRegistry.getLastDroolActivityAt();
    if (droolIdleMs <= threshold) {
      return true;
    }

    if (this.getLastServerActivityAt) {
      const wsIdleMs = now - this.getLastServerActivityAt();
      if (wsIdleMs <= threshold) {
        return true;
      }
    }

    return false;
  }

  /**
   * Preserves the idle auto-update behaviour for Computers without gating
   * the heartbeat: on the first idle tick (no recent activity) it fires
   * `onIdleUpdate` once; any fresh activity re-arms the trigger. The
   * heartbeat itself is always sent regardless.
   */
  private maybeTriggerComputerIdleUpdate(): void {
    if (this.hasRecentActivity()) {
      this.idleUpdateTriggered = false;
      return;
    }

    if (!this.onIdleUpdate) {
      logWarn('Missing onIdleUpdate callback for Computer', {
        machineId: this.machineId,
      });
      return;
    }

    if (this.idleUpdateTriggered) {
      return;
    }

    this.idleUpdateTriggered = true;
    logInfo('Triggering idle update');
    void (async () => {
      try {
        await OtelTracing.trace(SpanName.DAEMON_IDLE_UPDATE, () =>
          this.onIdleUpdate!()
        );
      } catch (error) {
        logException(
          error instanceof Error ? error : new MetaError(String(error)),
          'Idle update failed'
        );
        this.idleUpdateTriggered = false;
      }
    })();
  }

  /**
   * Computes elapsed ms since the daemon last observed activity of any kind
   * (drool process I/O or relay/WebSocket/IPC). Returns `null` when no
   * activity has ever been observed — deliberately NOT process-start, so an
   * idle or crash-looping daemon does not reset the backend's idle baseline.
   */
  private computeIdleMs(): number | null {
    const lastDroolActivityAt = this.droolRegistry.getLastDroolActivityAt();
    const lastServerActivityAt = this.getLastServerActivityAt?.() ?? 0;
    const lastActivityAt = Math.max(lastDroolActivityAt, lastServerActivityAt);
    if (lastActivityAt <= 0) {
      return null;
    }
    return Math.max(0, Date.now() - lastActivityAt);
  }

  private async postHeartbeat(): Promise<void> {
    try {
      const request: DaemonHeartbeatRequest = {
        sandboxId: this.machineId,
        machineType: this.machineType,
      };
      const hostId = await this.getHeartbeatHostId();
      if (hostId) {
        request.hostId = hostId;
      }
      if (this.machineType === MachineType.Computer) {
        request.idleMs = this.computeIdleMs();
      }

      if (this.debug) {
        debugLog('Sending daemon heartbeat');
      }

      const response = await this.apiClient.post<
        DaemonHeartbeatResponse,
        DaemonHeartbeatRequest
      >('/api/daemon/heartbeat', request);

      if (this.debug) {
        debugLog('Heartbeat sent successfully', {
          success: response.data.success,
        });
      }
    } catch (error) {
      logException(
        error instanceof Error ? error : new MetaError(String(error)),
        'Failed to send daemon heartbeat'
      );
    }
  }

  private async getHeartbeatHostId(): Promise<string | undefined> {
    if (
      this.machineType !== MachineType.Computer ||
      this.getHostIdentity === undefined
    ) {
      return undefined;
    }

    try {
      const hostIdentity = await this.getHostIdentity();
      if (!hostIdentity) {
        return undefined;
      }
      // For Computer daemons, machineId is the backend computerId used for
      // routing/heartbeat. Only include hostId when the local registration
      // confirms this daemon is running for that same computer.
      const registration = hostIdentity?.computerRegistration;
      if (registration?.computerId !== this.machineId) {
        return undefined;
      }
      return hostIdentity.hostId;
    } catch (error) {
      logWarn('Failed to resolve host identity for daemon heartbeat', {
        cause: error,
        machineId: this.machineId,
      });
      return undefined;
    }
  }
}
