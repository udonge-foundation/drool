/**
 * Self-contained entrypoint for `drool daemon`.
 *
 * Owns its entire bootstrap lifecycle. Includes daemon-specific timeout
 * wrappers and progress logging for Electron-launched daemons.
 * Excluded from original: ink/React, kitty protocol, search cache warm,
 * tool manager (daemon spawns child processes that load their own).
 */
import '@/utils/patch-console';
import '@/embed-native-libs';

/* eslint-disable-next-line import/order */
import { config as dotenvConfig } from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/* eslint-disable import/order */
import {
  configureCredentialsStorage,
  getAuthToken,
  getAuthedUser,
} from '@industry/runtime/auth';
import { getEmbeddedKeytar } from '@/utils/keytarEmbedded';

/* eslint-disable import/order */
import {
  CliTelemetryClient,
  setIndustryTierProvider,
  setMissionIdProvider,
} from '@/utils/cliTelemetryClient';

import { EnvironmentVariable } from '@industry/environment';
import { logException, logInfo, logWarn, Metrics } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';
import {
  fetchFeatureFlags,
  setOrgIdProvider,
} from '@industry/runtime/feature-flags';

import {
  initCustomerTelemetry,
  initSubAgentsV2Flag,
} from '@/feature-flags/service';
import { initChangelog } from '@/services/ChangelogService';
import { initSentry } from '@/sentry.config.ts';
import {
  getSessionService,
  ensureSessionEndHookRegistered,
} from '@/services/SessionService';
import {
  clearRuntimeSettingsStartupFailure,
  setRuntimeSettingsStartupFailure,
} from '@/services/diagnostics/RuntimeSettingsFailureStore';
import { settingsService } from '@/services/SettingsService';
import { exitWithCode } from '@/utils/exitWithCode';
import { ShutdownReason } from '@/utils/enums';

import {
  getRuntimeSettingsPathFromEnv,
  resolveRuntimeSettingsPath,
} from '@/utils/runtimeSettingsBootstrap';
import {
  getShutdownCoordinator,
  initShutdownCoordinator,
} from '@/utils/shutdownCoordinator';
import { withBootstrapTimeout } from '@/utils/bootstrapTimeout';
import { writeCriticalErrorBreadcrumb } from '@/utils/criticalErrorBreadcrumb';
import { loadSystemCertificates } from '@/utils/systemCertificates';
import { setupWindowsConsoleEncoding } from '@/utils/windowsConsoleEncoding';
import { initI18n } from '@/i18n';

import {
  getCliRuntimeMetricLabels,
  withStartupLatency,
} from '@/utils/startupLatency';

// ---------------------------------------------------------------------------
// Bootstrap + Run
// ---------------------------------------------------------------------------

import type { DaemonOptions } from '@/entrypoints/daemon/handler';

const __dirDaemon = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirDaemon, '../../..', '.env'), quiet: true });
dotenvConfig({
  path: resolve(__dirDaemon, '../../..', '.env.local'),
  override: true,
  quiet: true,
});
/* eslint-enable import/order */

configureCredentialsStorage({ keytarLoader: getEmbeddedKeytar });

await import('@/api/init');

try {
  CliTelemetryClient.initializeSync();
} catch (error) {
  console.error('Failed to initialize telemetry client', error);
}

try {
  const { SettingsManager } = await import('@industry/runtime/settings');
  setIndustryTierProvider(() => SettingsManager.getInstance().getOrgTier());
} catch {
  // Best-effort
}

// Construct SessionService eagerly so the provider never lazily builds it from
// inside the telemetry hot path (CliTelemetryClient.getAdditionalTags), which
// could re-enter logging during construction.
const missionTagSessionService = getSessionService();
setMissionIdProvider(() => missionTagSessionService.getActiveMissionStateId());

void initSentry().catch(() => {});

// Daemon does NOT init CLI tracing here — it re-initializes inside its action
// with the resolved machine.type.

initShutdownCoordinator();
const shutdownCoordinator = getShutdownCoordinator();

// ---------------------------------------------------------------------------
// Daemon-specific helpers
// ---------------------------------------------------------------------------

const isDaemonDebugMode =
  process.argv.includes('--debug') || process.argv.includes('-d');
const isLaunchedByElectron = process.argv.some(
  (arg) => arg === '--liveness-fd'
);

function daemonBootstrapProgress(step: string): void {
  if (!isLaunchedByElectron && !isDaemonDebugMode) return;
  process.stderr.write(
    `[daemon-bootstrap] ${step} (${new Date().toISOString()})\n`
  );
}

const DAEMON_BOOTSTRAP_TIMEOUT_MS = 15_000;

function withDaemonTimeout<T>(
  stepName: string,
  fn: () => Promise<T>,
  fallback?: T
): Promise<T> {
  const hasFallback = arguments.length >= 3;
  return withBootstrapTimeout(fn, {
    stepName,
    timeoutMs: DAEMON_BOOTSTRAP_TIMEOUT_MS,
    ...(hasFallback ? { fallback } : {}),
    onProgress: daemonBootstrapProgress,
  });
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

let isHandlingCriticalError = false;

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function formatStartupError(error: unknown): string {
  if (error instanceof MetaError) {
    return error.metadata?.path
      ? `${error.message}: ${error.metadata.path}`
      : error.message;
  }
  if (error instanceof Error) return error.message;
  if (typeof ErrorEvent !== 'undefined' && error instanceof ErrorEvent) {
    return error.message;
  }
  return String(error);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleCriticalError(
  error: unknown,
  context: string
): Promise<void> {
  if (isHandlingCriticalError) {
    process.exit(1);
  }
  isHandlingCriticalError = true;

  const errorObj = error instanceof Error ? error : new Error(String(error));
  writeCriticalErrorBreadcrumb({
    context,
    message: formatStartupError(error),
    stack: errorObj.stack,
  });

  writeStderr(`Critical error: ${formatStartupError(error)}`);
  if (error instanceof Error && error.stack) {
    writeStderr(error.stack);
  }
  console.error('An unexpected critical error occurred', { error, context });
  logException(errorObj, context);
  await shutdownCoordinator.requestExit({
    reason: ShutdownReason.Other,
    exitCode: 1,
    error: errorObj,
  });
}

process.on('uncaughtException', (error) => {
  void handleCriticalError(error, 'Uncaught exception');
});
process.on('unhandledRejection', (reason) => {
  void handleCriticalError(reason, 'Unhandled promise rejection');
});

export async function run(daemonOptions: DaemonOptions): Promise<void> {
  try {
    Metrics.addToCounter(
      Metric.CLI_STARTUP_BOOTSTRAP_LATENCY,
      process.uptime() * 1000,
      getCliRuntimeMetricLabels()
    );

    daemonBootstrapProgress('starting bootstrap');

    initI18n();

    clearRuntimeSettingsStartupFailure();

    const runtimeSettingsPathInput = getRuntimeSettingsPathFromEnv();
    if (runtimeSettingsPathInput) {
      try {
        const resolvedRuntimeSettingsPath = await resolveRuntimeSettingsPath(
          runtimeSettingsPathInput
        );
        process.env[EnvironmentVariable.INDUSTRY_RUNTIME_SETTINGS_PATH] =
          resolvedRuntimeSettingsPath;
        clearRuntimeSettingsStartupFailure();
        logInfo('[daemon-startup] Runtime settings overlay enabled', {
          path: resolvedRuntimeSettingsPath,
        });
      } catch (error) {
        delete process.env[EnvironmentVariable.INDUSTRY_RUNTIME_SETTINGS_PATH];
        setRuntimeSettingsStartupFailure(
          error instanceof MetaError && typeof error.metadata?.path === 'string'
            ? error.metadata.path
            : runtimeSettingsPathInput,
          getErrorMessage(error)
        );
        logWarn('[daemon-startup] Runtime settings overlay ignored', {
          path: runtimeSettingsPathInput,
          cause: error,
        });
      }
    }

    // Agent-browser daemon cleanup
    void (async () => {
      try {
        const { cleanupAgentBrowserDaemons } = await import(
          '@/utils/agentBrowserCleanup'
        );
        await cleanupAgentBrowserDaemons();
      } catch (error) {
        logException(error, '[daemon-startup] agent-browser cleanup failed');
      }
    })();

    // Windows pending update (with daemon timeout)
    if (process.platform === 'win32') {
      const { Updater } = await import('@industry/updater');
      const pendingResult = await withStartupLatency(
        Metric.CLI_STARTUP_PENDING_UPDATE_APPLY_LATENCY,
        () =>
          withDaemonTimeout(
            'applyPendingWindowsUpdate',
            () => Updater.applyPendingWindowsUpdate(),
            { applied: false, error: undefined, version: undefined }
          ),
        (result) => ({
          status: result.applied
            ? 'applied'
            : result.error
              ? 'error'
              : 'skipped',
        })
      );
      if (pendingResult.applied) {
        logInfo('[daemon-startup] Applied pending Windows update', {
          version: pendingResult.version,
        });
      } else if (pendingResult.error) {
        logWarn('[daemon-startup] Failed to apply pending Windows update', {
          cause: pendingResult.error,
        });
      }
    } else {
      void import('@industry/updater')
        .then(({ cleanupStalePreservedBinaries }) =>
          cleanupStalePreservedBinaries()
        )
        .catch((error) => {
          logException(
            error,
            '[daemon-startup] cleanupStalePreservedBinaries failed'
          );
        });
    }

    // Certs + auth + feature flags (with daemon timeouts)
    // Wrapped in try/catch/finally so auto-update still runs even if auth fails
    // (the update might fix the auth issue).
    let preUpdateError: unknown = null;
    try {
      await withStartupLatency(Metric.CLI_STARTUP_CERTIFICATES_LATENCY, () =>
        withDaemonTimeout(
          'loadSystemCertificates',
          () => loadSystemCertificates(),
          undefined
        )
      );

      ensureSessionEndHookRegistered();

      try {
        CliTelemetryClient.getInstance().setAuthTokenGetter(async () => {
          const { getRuntimeAuthConfig } = await import('@/environment');
          return getAuthToken(getRuntimeAuthConfig());
        });
      } catch {
        // Best-effort: telemetry client not initialized.
      }

      const token = await withStartupLatency(
        Metric.CLI_STARTUP_AUTH_TOKEN_LATENCY,
        () =>
          withDaemonTimeout('getAuthToken', () =>
            import('@/environment').then(({ getRuntimeAuthConfig }) =>
              getAuthToken(getRuntimeAuthConfig())
            )
          ),
        (result) => ({ status: result ? 'present' : 'missing' })
      );
      if (!token) {
        logWarn('[daemon-startup] Invalid auth');
      } else {
        logInfo('[daemon-startup] Valid auth');
      }

      // A raw token check accepts a INDUSTRY_API_KEY as-is without hitting
      // /whoami, so an invalid key would start the daemon silently. Validate it
      // and surface a clear error. Warn-and-continue (not abort) preserves the
      // daemon's resilience: auto-update still runs, and a transient network
      // failure can't strand the box.
      const apiKeyError = await withDaemonTimeout(
        'validateApiKey',
        async () => {
          const { getInvalidApiKeyError } = await import(
            '@/commands/authHelpers'
          );
          return getInvalidApiKeyError();
        },
        null
      );
      if (apiKeyError) {
        writeStderr(apiKeyError);
        logWarn('[daemon-startup] INDUSTRY_API_KEY validation failed', {
          reason: 'api_key_rejected_or_unverifiable',
        });
      }

      setOrgIdProvider(async () => {
        const { getRuntimeAuthConfig } = await import('@/environment');
        return (await getAuthedUser(getRuntimeAuthConfig()))?.orgId;
      });

      // Host identity must be initialized for every CLI invocation so every
      // local runtime has a stable host.json before reading or writing
      // computer registration.
      await withDaemonTimeout('initHostIdentity', async () => {
        const { initializeCliHostIdentity } = await import(
          '@/utils/initializeCliHostIdentity'
        );
        await initializeCliHostIdentity();
        logInfo('[daemon-startup] Host identity initialized');
      });

      try {
        void withStartupLatency(
          Metric.CLI_STARTUP_FEATURE_FLAGS_WARM_LATENCY,
          () => fetchFeatureFlags()
        ).catch((error) => {
          logWarn('[daemon-startup] Failed to eagerly fetch feature flags', {
            cause: error,
          });
        });
      } catch {
        // Best-effort
      }
    } catch (error) {
      preUpdateError = error;
      throw error;
    } finally {
      // Settings init must complete before auto-update so org-level
      // disableAutoUpdate enterprise control is available.
      const { runConditionalUpdate, runDaemonConditionalUpdateRestart } =
        await import('@/services/update/UpdateService');
      const { UpdateOutcome } = await import('@industry/updater');

      // No fallback argument: with a fallback, withDaemonTimeout resolves on
      // any failure and the .catch below would never observe the error.
      const settingsInitStart = performance.now();
      let settingsInitOk = true;
      await withDaemonTimeout('settings init', () =>
        withStartupLatency(
          Metric.CLI_STARTUP_SETTINGS_INIT_LATENCY,
          async () => {
            await settingsService.initialize();
            getSessionService().initializeAutonomyFromGlobalDefaults();
            const { ensureBuiltInDrools } = await import(
              '@/services/drools/builtInDrools'
            );
            await ensureBuiltInDrools();
          }
        )
      ).catch((error) => {
        settingsInitOk = false;
        logException(error, '[daemon-startup] Failed to initialize settings');
      });
      const settingsInitElapsed = performance.now() - settingsInitStart;
      if (settingsInitOk) {
        logInfo('[daemon-startup] Settings init completed', {
          durationMs: Math.round(settingsInitElapsed),
        });
      } else {
        logWarn('[daemon-startup] Settings init failed', {
          durationMs: Math.round(settingsInitElapsed),
        });
      }

      // Sync configured marketplaces/plugins as a best-effort background task,
      // decoupled from the settings-init timeout. syncConfiguredPlugins() does
      // network/install work, so running it inside the bootstrap timeout could
      // mark settings init failed on a slow sync while the uncancelled sync
      // kept mutating plugin state. Fire-and-forget here mirrors the TUI
      // startup sync path.
      if (settingsInitOk) {
        void (async () => {
          try {
            const { getRuntimeAuthConfig } = await import('@/environment');
            if (getRuntimeAuthConfig().airgapEnabled) {
              logInfo(
                '[daemon-startup] Airgap Mode is enabled; skipping plugin sync'
              );
              return;
            }
            const { PluginMarketplaceManager } = await import(
              '@industry/runtime/settings'
            );
            await PluginMarketplaceManager.getInstance().syncConfiguredPlugins();
            await settingsService.refreshFromSettingsManager();
          } catch (error) {
            logException(
              error,
              '[daemon-startup] Failed to sync configured plugins'
            );
          }
        })();
      }

      const autoUpdateStart = performance.now();
      const updateOutcome =
        process.env.DROOL_FORCE_BLOCKING_UPDATE === 'true'
          ? await runDaemonConditionalUpdateRestart({
              runWithTimeout: (fn, fallback) =>
                withDaemonTimeout('forced update', fn, fallback),
            }).catch((error) => {
              logException(
                error,
                '[daemon-startup] Failed to run managed forced auto-update'
              );
              return UpdateOutcome.Error;
            })
          : await withDaemonTimeout('auto-update', () =>
              runConditionalUpdate()
            ).catch((error) => {
              logException(error, '[daemon-startup] Failed to run auto-update');
              return UpdateOutcome.Error;
            });
      const autoUpdateElapsed = performance.now() - autoUpdateStart;
      logInfo('[daemon-startup] Auto-update completed', {
        durationMs: Math.round(autoUpdateElapsed),
        outcome: updateOutcome,
      });

      if (preUpdateError) {
        logWarn(
          'Unexpected error before auto-update could run, but attempted auto-update anyways',
          { cause: preUpdateError },
          { skipWebTelemetry: true }
        );
      }

      // Diagnostics
      void (async () => {
        try {
          const { getDiagnosticsService } = await import(
            '@/services/diagnostics/DiagnosticsService'
          );
          const diagnosticsService = getDiagnosticsService();
          diagnosticsService.attachSettingsListener();
          await diagnosticsService.refresh();
        } catch (error) {
          logException(
            error,
            '[daemon-startup] Failed to run startup diagnostics'
          );
        }
      })();
    }

    setupWindowsConsoleEncoding();
    void initCustomerTelemetry();
    initSubAgentsV2Flag();
    initChangelog();

    // Sandbox
    try {
      const { createSandboxAskCallback } = await import(
        '@/sandbox/SandboxPermissionPrompt'
      );
      const { getSandboxService } = await import('@/services/SandboxService');
      const sandboxSettings = settingsService.getSettings().general?.sandbox;
      const sandboxAskCallback = createSandboxAskCallback();
      await getSandboxService().initialize(sandboxSettings, sandboxAskCallback);
    } catch (error) {
      const sandboxSettings = settingsService.getSettings().general?.sandbox;
      if (
        sandboxSettings?.enabled &&
        sandboxSettings.mode === 'whole-process'
      ) {
        throw error;
      }
      logWarn('[daemon-startup] Failed to initialize sandbox service', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    daemonBootstrapProgress('bootstrap complete, starting daemon');

    const { runDaemonAction } = await import('@/entrypoints/daemon/handler');
    await runDaemonAction(daemonOptions);
  } catch (error) {
    writeStderr(`Startup failed: ${formatStartupError(error)}`);
    if (process.env.DEBUG === '1' && error instanceof Error && error.stack) {
      writeStderr(error.stack);
    }
    const errorObj = error instanceof Error ? error : new Error(String(error));
    logException(errorObj, 'CLI daemon startup failed');
    await exitWithCode(1);
  }
}
