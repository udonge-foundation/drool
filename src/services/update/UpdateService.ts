/**
 * UpdateService wrapper for industry-cli
 *
 * This is a thin wrapper around @industry/updater that wires up
 * the terminal spinner UI for the CLI user experience.
 */

import { logException, logInfo, logWarn, Metrics } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';
import {
  Updater,
  UpdaterState,
  UpdaterStateType,
  UpdateOutcome,
} from '@industry/updater';

import { getEnv, getRuntimeAuthConfig } from '@/environment';
import { settingsService } from '@/services/SettingsService';
import { UpdateDrainKind } from '@/services/update/enums';
import {
  getUpdateService,
  getCliRemoteConfig,
  getLastBlockingUpdateError,
  setLastBlockingUpdateError,
} from '@/services/update/getUpdateService';
import type { UpdateDrainOutcome } from '@/services/update/types';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';
import {
  SHUTDOWN_HOOK_PRIORITY,
  UPDATE_DRAIN_TIMEOUT_MS,
} from '@/utils/constants';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';

// Simple state tracker for non-blocking updates only
let nonBlockingUpdateState: UpdaterState | null = null;
const stateListeners = new Set<(state: UpdaterState | null) => void>();

// Track start time for non-blocking update completion metric (reported from async callback)
let nonBlockingUpdateStartTime: number | null = null;
let nonBlockingUpdateInstallStartTime: number | null = null;

/**
 * Retained promise for the currently-running non-blocking update, if any.
 *
 * Keeping this at module scope lets the shutdown drain hook wait for the
 * update to reach a terminal state before the process exits. Without this, a
 * fire-and-forget upgrade that was still downloading when the CLI crashed
 * would be killed mid-flight and the next restart would hit the same bug --
 * defeating the point of auto-update.
 */
let inFlightUpdate: Promise<UpdateOutcome> | null = null;
let drainHookRegistered = false;

const DAEMON_PRE_RESTART_FLUSH_TIMEOUT_MS = 2_000;

interface RunConditionalUpdateOptions {
  /**
   * Whether blocking update paths should restart the current process after a
   * successful install.
   */
  restartBlockingUpdate: boolean;
}

interface RunDaemonStartupConditionalUpdateOptions {
  runWithTimeout: <T>(fn: () => Promise<T>, fallback: T) => Promise<T>;
}

/**
 * Wait for any in-flight non-blocking update to reach a terminal state,
 * bounded by `timeoutMs`. Safe to call when nothing is in flight.
 */
export async function awaitInFlightUpdate(
  timeoutMs: number
): Promise<UpdateDrainOutcome> {
  const pending = inFlightUpdate;
  if (!pending) return { kind: UpdateDrainKind.None };

  const timeoutSentinel = Symbol('update-drain-timeout');
  const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
    const id = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
    id.unref?.();
  });

  const result = await Promise.race([pending, timeoutPromise]);
  return result === timeoutSentinel
    ? { kind: UpdateDrainKind.Timeout }
    : { kind: UpdateDrainKind.Settled, outcome: result };
}

function ensureDrainHookRegistered(): void {
  if (drainHookRegistered) return;
  drainHookRegistered = true;
  getShutdownCoordinator().registerHook(
    'update-drain',
    async () => {
      const outcome = await awaitInFlightUpdate(UPDATE_DRAIN_TIMEOUT_MS);
      if (outcome.kind === UpdateDrainKind.Timeout) {
        logWarn('Exiting while non-blocking update still in progress', {
          timeout: UPDATE_DRAIN_TIMEOUT_MS,
        });
      } else if (outcome.kind === UpdateDrainKind.Settled) {
        logInfo('Drained in-flight update before exit', {
          outcome: outcome.outcome,
        });
      }
    },
    {
      priority: SHUTDOWN_HOOK_PRIORITY.UpdateDrain,
      timeoutMs: UPDATE_DRAIN_TIMEOUT_MS,
    }
  );
}

function emitNonBlockingState(state: UpdaterState | null) {
  nonBlockingUpdateState = state;
  stateListeners.forEach((listener) => listener(state));
}

export function subscribeToNonBlockingUpdates(
  listener: (state: UpdaterState | null) => void
): () => void {
  stateListeners.add(listener);
  listener(nonBlockingUpdateState); // Immediately call with current state
  return () => stateListeners.delete(listener);
}

export function getNonBlockingUpdateState(): UpdaterState | null {
  return nonBlockingUpdateState;
}

/**
 * Helper to report update latency metric.
 * Centralizes all CLI_STARTUP_UPDATE_LATENCY metric reporting.
 */
function reportUpdateLatency(
  startTime: number,
  outcome: UpdateOutcome,
  error?: Error,
  source?: string
): void {
  Metrics.addToCounter(
    Metric.CLI_STARTUP_UPDATE_LATENCY,
    performance.now() - startTime,
    {
      outcome,
      ...(source && { source }),
      ...(error && { errorMessage: error.message }),
    }
  );
}

function reportUpdateInstallLatency(
  startTime: number,
  outcome: UpdateOutcome,
  source: string
): void {
  Metrics.addToCounter(
    Metric.CLI_STARTUP_UPDATE_INSTALL_LATENCY,
    performance.now() - startTime,
    { outcome, source }
  );
}

function reportNonBlockingUpdateInstallLatency(
  outcome: UpdateOutcome,
  source: string
): void {
  if (nonBlockingUpdateInstallStartTime === null) return;
  reportUpdateInstallLatency(
    nonBlockingUpdateInstallStartTime,
    outcome,
    source
  );
  nonBlockingUpdateInstallStartTime = null;
}

function reportDaemonForcedNoRestartLatency(
  startTime: number,
  outcome: UpdateOutcome
): void {
  reportUpdateLatency(
    startTime,
    outcome === UpdateOutcome.Updated
      ? UpdateOutcome.UpdatedNoRestart
      : outcome,
    undefined,
    'forced-daemon-no-restart'
  );
}

async function flushTelemetryBeforeDaemonRestart(): Promise<void> {
  const timeoutSentinel = Symbol('daemon-pre-restart-flush-timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const flushPromise = CliTelemetryClient.getInstance().forceFlush();
    const result = await Promise.race([
      flushPromise.then(() => undefined),
      new Promise<typeof timeoutSentinel>((resolve) => {
        timer = setTimeout(
          () => resolve(timeoutSentinel),
          DAEMON_PRE_RESTART_FLUSH_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);

    if (result === timeoutSentinel) {
      logWarn('[daemon-startup] Pre-restart flush timed out', {
        timeout: DAEMON_PRE_RESTART_FLUSH_TIMEOUT_MS,
      });
      void flushPromise.catch((error) => {
        logWarn('[daemon-startup] Pre-restart flush failed after timeout', {
          cause: error,
        });
      });
    }
  } catch (error) {
    logWarn('[daemon-startup] Pre-restart flush failed', { cause: error });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run conditional update based on update type and ROLLBACK_ENABLED flag:
 * - Upgrades: Always non-blocking (better UX, user restarts when ready)
 * - Rollbacks: Blocking when ROLLBACK_ENABLED=true (safety-critical), skipped when false (production)
 * - Override: DROOL_FORCE_BLOCKING_UPDATE=true forces blocking updates for all types
 */
export async function runConditionalUpdate(
  options: RunConditionalUpdateOptions = { restartBlockingUpdate: true }
): Promise<UpdateOutcome> {
  const { restartBlockingUpdate } = options;
  // Skip if auto-update is disabled via env var or build-time constant
  // (e.g., npm package distributions, bundled in desktop app)
  const environment = getEnv();
  if (!environment.extras.autoUpdateEnabled) {
    logInfo(
      'Auto-update disabled via environment (use npm update -g @industry/cli for npm installs)'
    );
    return UpdateOutcome.Skipped;
  }

  // Auto-update reaches Industry CDN / backend to fetch LATEST and binaries;
  // airgap mode forbids any Industry-controlled outbound traffic.
  if (getRuntimeAuthConfig().airgapEnabled) {
    logInfo('Auto-update skipped: Airgap Mode is enabled');
    return UpdateOutcome.Skipped;
  }

  // Org-level enterprise control. settingsService must be initialized before
  // runConditionalUpdate is called; the startup sequences in tui/run.ts and
  // daemon/run.ts guarantee this ordering.
  const settings = settingsService.getSettings();
  if (settings.general?.disableAutoUpdate === true) {
    logInfo(
      'Auto-update disabled by organization enterprise controls (use npm update -g @industry/cli for manual updates)'
    );
    return UpdateOutcome.Skipped;
  }

  // Track start time for latency metrics
  const startTime = performance.now();

  const updater = getUpdateService();
  const rawRollbackEnv = process.env.ROLLBACK_ENABLED;
  const rollbackEnabled =
    rawRollbackEnv === undefined ? true : String(rawRollbackEnv) === 'true';
  const forceBlockingUpdate =
    process.env.DROOL_FORCE_BLOCKING_UPDATE === 'true';

  const checkStart = performance.now();
  const updateInfo = await updater.checkForUpdates();
  Metrics.addToCounter(
    Metric.CLI_STARTUP_UPDATE_CHECK_LATENCY,
    performance.now() - checkStart
  );

  if (!updateInfo) {
    reportUpdateLatency(startTime, UpdateOutcome.NoUpdate);
    return UpdateOutcome.NoUpdate;
  }

  // Handle rollbacks
  if (updateInfo.isRollback) {
    if (!rollbackEnabled) {
      logInfo(
        'Rollback detected but rollbacks are disabled (CLI update service)',
        {
          version: updateInfo.version.version,
        }
      );
      reportUpdateLatency(startTime, UpdateOutcome.Skipped);
      return UpdateOutcome.Skipped;
    }

    logInfo('Using blocking update for rollback', {
      version: updateInfo.version.version,
    });
    setLastBlockingUpdateError(null);
    const installStart = performance.now();
    const outcome = restartBlockingUpdate
      ? await updater.runAutoUpdate()
      : await updater.performUpdate(updateInfo, {
          launchUpdatedAsChild: false,
        });
    reportUpdateInstallLatency(installStart, outcome, 'rollback');
    reportUpdateLatency(
      startTime,
      outcome,
      outcome === UpdateOutcome.Error
        ? (getLastBlockingUpdateError() ?? undefined)
        : undefined
    );
    return outcome;
  }

  // Force blocking update if environment variable is set
  if (forceBlockingUpdate) {
    logInfo('Using blocking update (forced by DROOL_FORCE_BLOCKING_UPDATE)', {
      version: updateInfo.version.version,
    });
    setLastBlockingUpdateError(null);
    const installStart = performance.now();
    const outcome = restartBlockingUpdate
      ? await updater.runAutoUpdate()
      : await updater.performUpdate(updateInfo, {
          launchUpdatedAsChild: false,
        });
    reportUpdateInstallLatency(installStart, outcome, 'forced');
    reportUpdateLatency(
      startTime,
      outcome,
      outcome === UpdateOutcome.Error
        ? (getLastBlockingUpdateError() ?? undefined)
        : undefined
    );
    return outcome;
  }

  // Handle upgrades - ALWAYS non-blocking for better UX
  logInfo('Using non-blocking update for upgrade', {
    version: updateInfo.version.version,
  });

  // Save start time for completion metric (reported from async callback)
  nonBlockingUpdateStartTime = startTime;
  nonBlockingUpdateInstallStartTime = performance.now();

  const nonBlockingUpdater = new Updater({
    currentVersion: process.env.CLI_VERSION || '',
    binaryName: process.platform === 'win32' ? 'drool.exe' : 'drool',
    remoteConfig: getCliRemoteConfig(),
    deploymentEnv: environment.deploymentEnv,
    onStateChange: (state) => {
      emitNonBlockingState(state); // Track for UI

      // Report latency metric when non-blocking update completes
      if (nonBlockingUpdateStartTime !== null) {
        if (state.type === UpdaterStateType.Complete) {
          Metrics.addToCounter(
            Metric.CLI_STARTUP_UPDATE_LATENCY,
            performance.now() - nonBlockingUpdateStartTime,
            {
              outcome: state.skipped
                ? UpdateOutcome.Skipped
                : UpdateOutcome.Updated,
            }
          );
          reportNonBlockingUpdateInstallLatency(
            state.skipped ? UpdateOutcome.Skipped : UpdateOutcome.Updated,
            'non-blocking-upgrade'
          );
          nonBlockingUpdateStartTime = null;
        } else if (state.type === UpdaterStateType.PendingInstall) {
          // Windows: update staged, will apply on next restart
          Metrics.addToCounter(
            Metric.CLI_STARTUP_UPDATE_LATENCY,
            performance.now() - nonBlockingUpdateStartTime,
            {
              outcome: UpdateOutcome.PendingRestart,
            }
          );
          reportNonBlockingUpdateInstallLatency(
            UpdateOutcome.PendingRestart,
            'non-blocking-upgrade'
          );
          nonBlockingUpdateStartTime = null;
        } else if (state.type === UpdaterStateType.Error) {
          Metrics.addToCounter(
            Metric.CLI_STARTUP_UPDATE_LATENCY,
            performance.now() - nonBlockingUpdateStartTime,
            {
              outcome: UpdateOutcome.Error,
              errorMessage: state.error.message,
            }
          );
          reportNonBlockingUpdateInstallLatency(
            UpdateOutcome.Error,
            'non-blocking-upgrade'
          );
          nonBlockingUpdateStartTime = null;
        }
      }
    },
  });

  // Retain the promise so the shutdown drain can wait for it. The .catch
  // converts rejections into a resolved Error outcome so the drain never
  // sees an unhandled rejection; .finally clears the slot so a subsequent
  // exitWithCode with no in-flight update returns immediately.
  ensureDrainHookRegistered();
  inFlightUpdate = nonBlockingUpdater
    .performUpdate(updateInfo, { launchUpdatedAsChild: false })
    .then((outcome) => {
      reportNonBlockingUpdateInstallLatency(outcome, 'non-blocking-upgrade');
      return outcome;
    })
    .catch((error) => {
      reportNonBlockingUpdateInstallLatency(
        UpdateOutcome.Error,
        'non-blocking-upgrade'
      );
      logException(error, 'Non-blocking update failed');
      return UpdateOutcome.Error;
    })
    .finally(() => {
      inFlightUpdate = null;
    });

  // Report immediate metric for non-blocking update start
  reportUpdateLatency(startTime, UpdateOutcome.BackgroundInProgress);
  return UpdateOutcome.BackgroundInProgress;
}

/**
 * Daemon-specific forced update wrapper.
 *
 * The daemon gives forced blocking updates a short startup deadline: updates
 * that finish in time restart from here, while late completions are only logged
 * so the already-starting daemon cannot be restarted out from under itself.
 */
export async function runDaemonConditionalUpdateRestart({
  runWithTimeout,
}: RunDaemonStartupConditionalUpdateOptions): Promise<UpdateOutcome> {
  if (process.env.DROOL_FORCE_BLOCKING_UPDATE !== 'true') {
    return runConditionalUpdate();
  }

  const noRestartMetricStart = performance.now();
  const updatePromise = runConditionalUpdate({
    restartBlockingUpdate: false,
  }).catch((error) => {
    logException(error, '[daemon-startup] Failed to run forced auto-update');
    return UpdateOutcome.Error;
  });

  const outcome = await runWithTimeout(
    () => updatePromise,
    UpdateOutcome.BackgroundInProgress
  );

  if (outcome === UpdateOutcome.BackgroundInProgress) {
    logWarn(
      '[daemon-startup] Forced auto-update did not finish before startup deadline; continuing without restart'
    );
    void updatePromise
      .then((lateOutcome) => {
        reportDaemonForcedNoRestartLatency(noRestartMetricStart, lateOutcome);
        logInfo('[daemon-startup] Forced auto-update finished after deadline', {
          outcome: lateOutcome,
        });
      })
      .catch((error) => {
        logException(
          error,
          '[daemon-startup] Forced auto-update failed after deadline'
        );
      });
    return outcome;
  }

  if (outcome === UpdateOutcome.Updated) {
    logInfo(
      '[daemon-startup] Forced auto-update completed before startup deadline; restarting daemon'
    );
    await flushTelemetryBeforeDaemonRestart();
    await Updater.launchUpdatedAsChild();
  }

  return outcome;
}
