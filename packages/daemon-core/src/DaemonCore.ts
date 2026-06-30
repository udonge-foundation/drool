import { MachineType } from '@industry/common/daemon';
import { logInfo, logWarn } from '@industry/logging';

import { DaemonServer } from './server/daemon-server';
import { ensureManagedLoginShellEnv } from './services/ensureManagedLoginShellEnv';

import type { DaemonConfig } from './server/types';
import type { DaemonCoreConfig } from './types';

/**
 * DaemonCore is the main entry point for running a daemon instance.
 * It orchestrates all daemon components and provides start/stop lifecycle.
 *
 * Usage:
 * ```ts
 * const core = new DaemonCore({
 *   port: 37643,
 *   host: '127.0.0.1',
 *   shell: '/bin/zsh',
 *   homeDir: '/Users/me',
 *   apiBaseUrl: 'https://api.example.com',
 *   deploymentEnv: 'production',
 *   isProductionTier: true,
 * });
 * await core.start();
 * // ... daemon is running
 * await core.stop();
 * ```
 */
export class DaemonCore {
  private readonly config: DaemonCoreConfig;

  private server: DaemonServer | null = null;

  private livenessAbort: AbortController | null = null;

  private livenessReader: ReadableStreamDefaultReader | null = null;

  private parentPidInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: DaemonCoreConfig) {
    this.config = config;
  }

  /**
   * Initialize and start the daemon server.
   */
  async start(): Promise<void> {
    // On managed computers, self-heal the login-shell env hook so interactive
    // `drool` over SSH uses the machine API key instead of prompting a sign-in.
    // Best-effort and non-blocking; existing computers reach this via auto-update.
    if (this.config.machineType === MachineType.Computer) {
      void ensureManagedLoginShellEnv(this.config.homeDir);
    }

    const serverConfig = this.buildServerConfig();

    this.server = new DaemonServer(serverConfig);
    try {
      await this.server.start();
    } catch (err) {
      this.server = null;
      throw err;
    }

    if (this.config.parentPid != null) {
      this.startParentPidMonitor();
    } else {
      this.startLivenessMonitor();
    }

    if (this.config.ipcOnly) {
      logInfo('DaemonCore started on parent IPC', {
        version: this.config.version,
      });
    } else if (this.config.unix) {
      logInfo('DaemonCore started on Unix socket', {
        path: this.config.unix,
        version: this.config.version,
      });
    } else if (this.config.port != null) {
      logInfo('DaemonCore started', {
        port: this.config.port,
        host: this.config.host,
        version: this.config.version,
      });
    } else {
      logInfo('DaemonCore started (no inbound transport)', {
        version: this.config.version,
      });
    }
  }

  /**
   * Stop the daemon server and clean up resources.
   */
  async stop(): Promise<void> {
    this.stopLivenessMonitor();
    this.stopParentPidMonitor();

    if (this.server) {
      await this.server.stop();
      this.server = null;
      logInfo('DaemonCore stopped');
    }
  }

  /**
   * Monitor an inherited file descriptor as a liveness pipe.
   * When the parent process exits (or crashes), the OS closes the pipe
   * and we trigger the onLivenessPipeClosed callback.
   *
   * Uses Bun.file(fd).stream() to read from the inherited pipe. The
   * for-await loop completes when the write end is closed (parent gone).
   */
  private startLivenessMonitor(): void {
    const fd = this.config.livenessFd;
    if (fd == null) return;

    if (fd < 0) {
      logWarn('Invalid livenessFd, skipping liveness monitor', { value: fd });
      return;
    }

    const abort = new AbortController();
    this.livenessAbort = abort;

    const monitor = async () => {
      try {
        const reader = Bun.file(fd).stream().getReader();
        this.livenessReader = reader;
        for (;;) {
          if (abort.signal.aborted) return;
          const { done } = await reader.read();
          if (done) break;
        }
      } catch (err) {
        // Stream error (e.g. reader cancelled during stop)
        logWarn('Liveness pipe stream error', { cause: err });
      }
      if (abort.signal.aborted) return;
      logInfo('Liveness pipe closed, parent process is gone');
      this.config.onLivenessPipeClosed?.();
    };

    void monitor();

    logInfo('Liveness pipe monitoring started', { value: fd });
  }

  private stopLivenessMonitor(): void {
    if (this.livenessAbort) {
      this.livenessAbort.abort();
      this.livenessAbort = null;
    }
    if (this.livenessReader) {
      this.livenessReader.cancel().catch(() => {});
      this.livenessReader = null;
    }
  }

  private static readonly PARENT_PID_POLL_INTERVAL_MS = 2000;

  /**
   * Poll the parent PID to detect when the parent process exits.
   * Uses `process.kill(pid, 0)` which sends no signal but throws if the
   * process doesn't exist. This avoids the Bun.file().stream() code path
   * that triggers bmalloc/libpas GC crashes on Windows.
   */
  private startParentPidMonitor(): void {
    const parentPid = this.config.parentPid;
    if (parentPid == null) return;

    if (parentPid <= 0) {
      logWarn('Invalid parentPid, skipping parent PID monitor', {
        value: parentPid,
      });
      return;
    }

    this.parentPidInterval = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch (err) {
        logWarn('Parent PID check failed; stopping monitor', {
          cause: err,
          value: parentPid,
        });
        this.stopParentPidMonitor();
        logInfo('Parent process gone (PID poll)', { value: parentPid });
        this.config.onParentPidGone?.();
      }
    }, DaemonCore.PARENT_PID_POLL_INTERVAL_MS);

    logInfo('Parent PID monitoring started', { value: parentPid });
  }

  private stopParentPidMonitor(): void {
    if (this.parentPidInterval) {
      clearInterval(this.parentPidInterval);
      this.parentPidInterval = null;
    }
  }

  /**
   * Check if the daemon server is currently running.
   */
  isRunning(): boolean {
    return this.server?.isServerRunning() ?? false;
  }

  private stopAfterParentIpcDisconnect(): void {
    logInfo('Parent IPC channel disconnected, shutting down IPC-only daemon');
    void this.stop().catch((err) => {
      logWarn('Failed to stop daemon after parent IPC disconnect', {
        cause: err,
      });
    });
  }

  private buildServerConfig(): DaemonConfig {
    const base = {
      debug: this.config.debug ?? false,
      droolExecPath: this.config.droolExecPath,
      isProductionTier: this.config.isProductionTier,
      apiBaseUrl: this.config.apiBaseUrl,
      runtimeAuthConfig: this.config.runtimeAuthConfig,
      deploymentEnv: this.config.deploymentEnv,
      homeDir: this.config.homeDir,
      shell: this.config.shell,
      terminalEnv: this.config.terminalEnv,
      version: this.config.version ?? 'unknown',
      machineId: this.config.machineId,
      machineType: this.config.machineType,
      enableChildIpc: this.config.enableChildIpc,
      testingBypassTokenPassword: this.config.testingBypassTokenPassword,
      relay: this.config.relay,
      relayCapable: this.config.relayCapable,
      getHostIdentity: this.config.getHostIdentity,
      onIdleUpdate: this.config.onIdleUpdate,
      sessionTimeoutMsOverride: this.config.sessionTimeoutMsOverride,
    };

    if (this.config.ipcOnly) {
      return {
        ...base,
        ipcOnly: true,
        parentIpc: true,
        onParentIpcDisconnected: () => {
          this.stopAfterParentIpcDisconnect();
        },
      };
    }

    if (this.config.unix) {
      return {
        ...base,
        unix: this.config.unix,
        parentIpc: this.config.parentIpc,
      };
    }

    return {
      ...base,
      port: this.config.port,
      host: this.config.host,
      parentIpc: this.config.parentIpc,
    };
  }
}
