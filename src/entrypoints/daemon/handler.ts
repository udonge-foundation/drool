/**
 * `drool daemon` command - runs the Industry daemon server.
 *
 * This allows the CLI to operate in daemon mode, providing the same
 * functionality as the standalone `industryd` binary but integrated
 * into a single `drool` binary.
 */
import path from 'path';

import { CommanderError } from 'commander';

import { LOCAL_MACHINE_ID, MachineType } from '@industry/common/daemon';
import { ServiceName } from '@industry/common/shared';
import { DaemonCore } from '@industry/daemon-core';
import {
  EnvironmentVariable,
  resolveEnvAsPositiveInt,
} from '@industry/environment';
import { logException, logInfo, logWarn } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { loadShellEnvironment } from '@industry/utils/shell/node';

import packageJson from '../../../package.json';
import { DaemonListenMode } from '@/entrypoints/daemon/enums';
import {
  ensureRegisteredHostIdentityForRemoteAccess,
  readHostIdentity,
  resolveRelayConfig,
} from '@/entrypoints/daemon/remoteAccess';
import { getRuntimeAuthConfig, getEnv } from '@/environment';
import { getI18n } from '@/i18n';
import {
  isSystemdNotifyEnabled,
  notifyReady,
  notifyStopping,
} from '@/services/daemon/notifyReady';
import { backfillMissionMetadataToCloud } from '@/services/mission/MissionMetadataBackfillService';
import { getUpdateService } from '@/services/update/getUpdateService';
import { withBootstrapTimeout } from '@/utils/bootstrapTimeout';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';
import { exitWithCode } from '@/utils/exitWithCode';

import type { ResolvedHostIdentity } from '@industry/drool-sdk-ext/protocol/host';

interface DaemonOptions {
  port?: number;
  host: string;
  unix?: string;
  debug: boolean;
  droolPath?: string;
  enableChildIpc: boolean;
  listen: DaemonListenMode;
  livenessFd?: number;
  parentPid?: number;
  remoteAccess: boolean;
}

/** Timeout for blocking daemon bootstrap steps (shell env, host identity, etc.) */
const BOOTSTRAP_STEP_TIMEOUT_MS = 10_000;

const DAEMON_BOOTSTRAP_STEP = {
  loadShellEnvironment: 'loadShellEnvironment',
  readHostIdentity: 'readHostIdentity',
  refreshHostIdentity: 'refreshHostIdentity',
  initCliTracing: 'initCliTracing',
} as const;

// stdout/stderr are best-effort: the parent (Electron on packaged Windows
// builds, or a developer's parent shell) can have already closed the pipe by
// the time we write, in which case Node emits 'error' (EPIPE) on the stream
// and -- absent a listener -- escalates to an uncaughtException that exits
// the daemon with code 1. Swallowing EPIPE here keeps the daemon running.
function writeStdout(message: string): void {
  try {
    process.stdout.write(`${message}\n`);
  } catch {
    // ignore write failures; the message is informational only
  }
}

function writeStderr(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // ignore write failures; stderr is captured to a log file by the
    // desktop spawn, but in environments where the fd is closed we'd
    // rather lose the message than crash the process
  }
}

/**
 * Write a progress marker to stderr for daemon bootstrap diagnostics.
 * When launched by Electron, stderr is piped to daemon-stderr.log and is
 * readable after a crash. When run manually (`drool daemon`), these markers
 * go to the terminal stderr only when --debug is enabled.
 * Always write when launched by a managed parent process, suppress in manual
 * runs unless --debug.
 */
let debugMode = false;
let ipcOnlyMode = false;
let livenessFd: number | undefined;
let parentPid: number | undefined;

function bootstrapProgress(step: string): void {
  // Always log when launched by a managed parent, or when debug mode is enabled.
  // Suppress for manual daemon runs without --debug flag.
  const isLaunchedByManagedParent =
    ipcOnlyMode || livenessFd !== undefined || parentPid !== undefined;
  if (!isLaunchedByManagedParent && !debugMode) return;

  try {
    process.stderr.write(
      `[daemon-bootstrap] ${step} (${new Date().toISOString()})\n`
    );
  } catch {
    // best-effort; see writeStderr for rationale
  }
}

/** Convenience wrapper that wires up the daemon bootstrap progress + timeout. */
function daemonBootstrap<T>(
  stepName: string,
  fn: () => Promise<T>,
  fallback: T
): Promise<T> {
  return withBootstrapTimeout(fn, {
    stepName,
    timeoutMs: BOOTSTRAP_STEP_TIMEOUT_MS,
    fallback,
    onProgress: bootstrapProgress,
  });
}

function isParentIpcChannelConnected(): boolean {
  return typeof process.send === 'function' && process.connected !== false;
}

function createParentIpcDisconnectedError(): CommanderError {
  return new CommanderError(
    1,
    'drool.daemon.ipc-disconnected',
    '--listen ipc parent IPC channel disconnected before daemon startup completed'
  );
}

/**
 * Build the daemon's host identity resolver.
 *
 * This is not a "read once" cache: every call attempts a fresh read so auth or
 * registration changes after daemon startup are observed. The cached value is
 * only the last-known-good fallback used when a fresh read fails or times out.
 * A successful read with no computerRegistration still replaces the cache,
 * because that means "not registered for the current auth context."
 */
function createHostIdentityResolver(
  initialHostIdentity: ResolvedHostIdentity | null
): () => Promise<ResolvedHostIdentity | null> {
  let cachedHostIdentity = initialHostIdentity;

  return async () => {
    const hostIdentity = await daemonBootstrap(
      DAEMON_BOOTSTRAP_STEP.refreshHostIdentity,
      () => readHostIdentity(),
      cachedHostIdentity
    );
    cachedHostIdentity = hostIdentity;
    return cachedHostIdentity;
  };
}

export type { DaemonOptions };

export async function runDaemonAction(options: DaemonOptions): Promise<void> {
  const ipcOnly = options.listen === DaemonListenMode.Ipc;
  let parentIpcDisconnected = false;
  let removeParentIpcDisconnectListener: (() => void) | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  const assertParentIpcChannelConnected = (): void => {
    if (!ipcOnly) {
      return;
    }
    if (parentIpcDisconnected || !isParentIpcChannelConnected()) {
      throw createParentIpcDisconnectedError();
    }
  };

  const shutdownAfterParentIpcDisconnect = (): void => {
    parentIpcDisconnected = true;
    logInfo('Parent IPC channel disconnected, shutting down...');
    if (shutdown) {
      void shutdown();
      return;
    }
    void exitWithCode(0);
  };

  // Enable debug mode for bootstrap progress logs
  debugMode = options.debug;
  ipcOnlyMode = ipcOnly;
  livenessFd = options.livenessFd;
  parentPid = options.parentPid;

  const env = getEnv();
  const runtimeAuthConfig = getRuntimeAuthConfig();
  const industryDir = path.join(getIndustryHome(), getIndustryDirName());
  const logsDir = path.join(industryDir, 'logs');

  if (ipcOnly) {
    if (typeof process.send !== 'function') {
      throw new CommanderError(
        1,
        'drool.daemon.ipc-unavailable',
        '--listen ipc requires the daemon to be spawned with an inherited IPC channel'
      );
    }
    if (process.connected === false) {
      throw createParentIpcDisconnectedError();
    }
    if (options.remoteAccess) {
      throw new CommanderError(
        1,
        'drool.daemon.ipc-remote-access',
        '--listen ipc cannot be combined with --remote-access'
      );
    }
    process.once('disconnect', shutdownAfterParentIpcDisconnect);
    removeParentIpcDisconnectListener = () => {
      process.removeListener('disconnect', shutdownAfterParentIpcDisconnect);
    };
  }

  logInfo('[daemon] Starting daemon action', {
    port: options.port,
    host: options.host,
    platform: process.platform,
    pid: process.pid,
    // eslint-disable-next-line industry/no-nested-log-metadata -- daemon IPC/listen startup flags consumed as a unit
    value: {
      parentPid: options.parentPid,
      livenessFd: options.livenessFd,
      enableChildIpc: options.enableChildIpc,
      listen: options.listen,
      ipcOnly,
    },
  });

  // Load shell environment to get full PATH and env vars.
  // Critical on machines started by systemd where SHELL may be unset or /bin/sh.
  // Use the resolved shell from env extras (Linux default: /bin/bash) so shell init
  // paths like nvm in bash profiles are discovered reliably.
  const shellEnv = await daemonBootstrap(
    DAEMON_BOOTSTRAP_STEP.loadShellEnvironment,
    () => loadShellEnvironment(env.extras.shell),
    { ...process.env }
  );
  assertParentIpcChannelConnected();

  const hostIdentity = await daemonBootstrap(
    DAEMON_BOOTSTRAP_STEP.readHostIdentity,
    () => readHostIdentity(),
    null
  );
  assertParentIpcChannelConnected();
  const getHostIdentity = createHostIdentityResolver(hostIdentity);

  // Resolve relay config only when --remote-access is explicitly requested
  let relay: Awaited<ReturnType<typeof resolveRelayConfig>> = null;
  if (options.remoteAccess) {
    try {
      const registeredHostIdentity =
        await ensureRegisteredHostIdentityForRemoteAccess({
          getHostIdentity,
        });
      relay = await resolveRelayConfig(
        registeredHostIdentity.computerRegistration
      );
      if (!relay) {
        throw new CommanderError(
          1,
          'drool.daemon.remote-access',
          getI18n().t('commands:daemon.remoteAccessRelayUrlRequired')
        );
      }
    } catch (error) {
      if (error instanceof CommanderError) {
        writeStderr(error.message);
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      writeStderr(message);
      throw new CommanderError(1, 'drool.daemon.remote-access', message);
    }
  }

  const machineId = env.extras.remoteMachineId ?? LOCAL_MACHINE_ID;
  const machineType =
    env.extras.machineType ??
    (env.extras.remoteMachineId ? MachineType.Ephemeral : MachineType.Local);

  CliTelemetryClient.getInstance().setMachineContext(machineId, machineType);

  // Replace the CLI tracing client with industry.app=daemon. The daemon
  // does NOT stamp industry.machine.type — it doesn't know whether the
  // client considers this connection local vs BYOM vs managed. That
  // classification lives on the client's web.rpc_request spans via
  // DaemonClient.machineTraceAttributes.
  await daemonBootstrap(
    DAEMON_BOOTSTRAP_STEP.initCliTracing,
    async () => {
      const { initCliTracing } = await import(
        '@/telemetry/system/initCliTracing'
      );
      await initCliTracing({ serviceNameOverride: ServiceName.Daemon });
    },
    undefined
  );
  assertParentIpcChannelConnected();

  // Shutdown resolver - allows the keep-alive promise to resolve on signal
  let shutdownResolver: (() => void) | undefined;
  let isShuttingDown = false;

  const daemon = new DaemonCore({
    port: options.port,
    host: options.host,
    unix: options.unix,
    ipcOnly,
    debug: options.debug,
    enableChildIpc: options.enableChildIpc,
    // When --drool-path is explicitly provided, use it. Otherwise, let
    // DroolProcessManager.spawn() resolve the command via resolveDroolCommand().
    droolExecPath: options.droolPath,

    // From CLI environment extras (properly resolved via @industry/environment)
    shell: env.extras.shell,
    homeDir: env.extras.homeDir,
    machineId,
    machineType,
    terminalEnv: Object.fromEntries(
      Object.entries(shellEnv).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),

    // From CLI base environment
    isProductionTier: env.isProductionTier,
    apiBaseUrl: env.apiBaseUrl,
    runtimeAuthConfig,
    deploymentEnv: env.deploymentEnv,

    // CLI version as daemon version
    version: packageJson.version,

    // Relay config (only for the explicit --remote-access path)
    relay: relay
      ? {
          relayUrl: relay.relayUrl,
          computerId: relay.computerId,
          resolveCredential: relay.resolveCredential,
        }
      : undefined,
    // Keep relay RPC methods available from the local daemon even when it
    // starts without auto-connecting. Plain `drool daemon` never connects
    // to relay unless a client explicitly calls startRelay().
    relayCapable: true,
    getHostIdentity,

    // E2E testing: allow bypass token authentication
    testingBypassTokenPassword: runtimeAuthConfig.testingBypassTokenPassword,

    // E2E testing: let the host app resolve an optional drool-session
    // timeout override so daemon-core itself stays env-agnostic. Applies
    // to both Local and Computer machine types.
    sessionTimeoutMsOverride: resolveEnvAsPositiveInt({
      name: EnvironmentVariable.OVERRIDE_DROOL_SESSION_TIMEOUT_MS,
    }),

    // On Computers, trigger auto-update when the daemon goes idle
    onIdleUpdate:
      machineType === MachineType.Computer
        ? async () => {
            await getUpdateService().runAutoUpdate();
          }
        : undefined,

    // Liveness pipe: daemon-core monitors the inherited fd and calls back
    // when the pipe closes (parent exited or crashed)
    livenessFd:
      options.livenessFd != null && options.livenessFd >= 0
        ? options.livenessFd
        : undefined,
    onLivenessPipeClosed: () => {
      logInfo('Parent process gone (liveness pipe closed), shutting down...');
      void shutdown?.();
    },

    // Parent PID polling: alternative to liveness pipe for platforms where
    // the pipe-based monitor triggers Bun runtime crashes (Windows).
    parentPid:
      options.parentPid != null && options.parentPid > 0
        ? options.parentPid
        : undefined,
    onParentPidGone: () => {
      logInfo('Parent process gone (PID no longer exists), shutting down...');
      void shutdown?.();
    },
  });

  logInfo('[daemon] DaemonCore created');

  shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    removeParentIpcDisconnectListener?.();
    removeParentIpcDisconnectListener = undefined;

    logInfo('Shutting down daemon...');

    // Tell systemd we're shutting down so it doesn't treat the imminent
    // exit as a crash (relevant under Type=notify).
    if (isSystemdNotifyEnabled()) {
      await notifyStopping();
    }

    // Resolve the keep-alive promise first
    if (shutdownResolver) {
      const resolver = shutdownResolver;
      shutdownResolver = undefined;
      resolver();
    }

    try {
      await daemon.stop();
    } catch (error) {
      logException(error, 'Error stopping daemon');
    } finally {
      await exitWithCode(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  // Catch unhandled errors in daemon mode to ensure cleanup runs.
  // Write crash details to stderr synchronously so the desktop-side
  // stderr log capture can read them even if telemetry fails to flush.
  process.on('uncaughtException', (error) => {
    writeStderr(
      `[daemon] Uncaught exception: ${error.message}\n${error.stack ?? ''}`
    );
    logException(error, '[daemon] Uncaught exception in daemon');
    try {
      void CliTelemetryClient.getInstance()
        .forceFlush()
        .catch(() => {})
        .then(() => shutdown());
    } catch {
      void shutdown();
    }
  });
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    writeStderr(
      `[daemon] Unhandled rejection: ${error.message}\n${error.stack ?? ''}`
    );
    logException(error, '[daemon] Unhandled rejection in daemon');
    try {
      void CliTelemetryClient.getInstance()
        .forceFlush()
        .catch(() => {})
        .then(() => shutdown());
    } catch {
      void shutdown();
    }
  });

  // Telemetry around `daemon.start()` so we can verify in Axiom that
  // (a) `daemon.start()` resolves only after the relay handshake
  // completes when `--remote-access` is on, and (b) `notifyReady()`
  // fires after that. Pairing the start/end timestamps with whether
  // we have a `NOTIFY_SOCKET` makes it trivial to confirm the
  // `Type=notify` gate is actually engaged in production.
  const daemonStartBeganAt = Date.now();
  logInfo('[daemon] daemon.start() begin', {
    isEnabled: !!options.remoteAccess,
    hasState: !!process.env.NOTIFY_SOCKET,
  });

  bootstrapProgress('daemon.start() calling');
  try {
    assertParentIpcChannelConnected();
    await daemon.start();
  } catch (err) {
    removeParentIpcDisconnectListener?.();
    removeParentIpcDisconnectListener = undefined;
    if (ipcOnly && (parentIpcDisconnected || process.connected === false)) {
      logInfo(
        'Parent IPC channel disconnected before daemon startup completed, exiting'
      );
      await exitWithCode(0);
      return;
    }
    const error = err instanceof Error ? err : new Error(String(err));
    writeStderr(
      `[daemon] daemon.start() failed: ${error.message}\n${error.stack ?? ''}`
    );
    logException(err, '[daemon] daemon.start() failed');
    await exitWithCode(1);
    return;
  }
  const daemonStartDurationMs = Date.now() - daemonStartBeganAt;
  bootstrapProgress(
    ipcOnly
      ? 'daemon.start() completed -- ipc transport ready'
      : 'daemon.start() completed -- health endpoint live'
  );
  if (ipcOnly) {
    if (!isParentIpcChannelConnected()) {
      logInfo(
        'Parent IPC channel disconnected before daemon ready message, shutting down...'
      );
      await shutdown();
      return;
    }
    try {
      const sentReadyMessage = process.send?.({
        type: 'industry.daemon.ready',
        pid: process.pid,
        version: packageJson.version,
      });
      if (sentReadyMessage === false && process.connected === false) {
        logInfo(
          'Parent IPC channel disconnected while sending daemon ready message, shutting down...'
        );
        await shutdown();
        return;
      }
    } catch (error) {
      if (process.connected === false) {
        await shutdown();
        logException(
          error,
          '[daemon] Failed to send IPC ready message after parent disconnect'
        );
        return;
      }
      logException(error, '[daemon] Failed to send IPC ready message');
    }
  }
  logInfo('[daemon] daemon.start() complete', {
    durationMs: daemonStartDurationMs,
    isEnabled: !!options.remoteAccess,
    hasState: !!process.env.NOTIFY_SOCKET,
  });

  // Signal systemd that the daemon is ready to accept work. With
  // `Type=notify` in the unit file, `systemctl start` blocks until
  // this fires, gating provisioning steps (e.g. install-deps) on
  // the daemon being actually registered with the relay rather
  // than just having been forked.
  const notifyBeganAt = Date.now();
  if (isSystemdNotifyEnabled()) {
    await notifyReady();
  }
  logInfo('[daemon] notifyReady() complete', {
    durationMs: Date.now() - notifyBeganAt,
    lifetimeMs: Date.now() - daemonStartBeganAt,
    hasState: !!process.env.NOTIFY_SOCKET,
  });

  const t = getI18n().t;
  writeStdout(t('commands:daemon.running'));
  writeStdout(t('commands:daemon.version', { version: packageJson.version }));
  writeStdout(t('commands:daemon.pid', { pid: process.pid }));
  writeStdout(t('commands:daemon.logs', { path: logsDir }));
  if (ipcOnly) {
    writeStdout('IPC transport: parent process');
  } else if (options.unix) {
    writeStdout(t('commands:daemon.unixSocket', { path: options.unix }));
  } else if (options.port != null) {
    writeStdout(
      t('commands:daemon.wsEndpoint', {
        host: options.host,
        port: options.port,
      })
    );
  }
  if (relay) {
    writeStdout(
      t('commands:daemon.relayNamed', {
        url: relay.relayUrl,
        name: relay.computerName,
        id: relay.computerId,
      })
    );
  }
  writeStdout(t('commands:daemon.pressCtrlCToStop'));

  logInfo('Daemon started', {
    host: ipcOnly ? 'ipc' : (options.unix ?? options.host),
    port: ipcOnly || options.unix ? undefined : options.port,
    version: packageJson.version,
  });
  void backfillMissionMetadataToCloud().catch((error) => {
    logWarn('Mission metadata backfill failed', {
      cause: error,
    });
  });

  // Wait for shutdown signal (resolved by shutdown handler)
  await new Promise<void>((resolve) => {
    shutdownResolver = resolve;
  });
}
