/**
 * Self-contained entrypoint for `drool exec`.
 *
 * Owns its entire bootstrap lifecycle — no shared orchestration layer.
 * Excluded from original: ink/React, kitty protocol, search cache warm,
 * auto-update (exec has its own dedicated entrypoint).
 */
import '@/utils/patch-console';
import '@/embed-native-libs';

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { config as dotenvConfig } from 'dotenv';

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
  getFlag,
  setOrgIdProvider,
} from '@industry/runtime/feature-flags';
import { IndustryFeatureFlags } from '@industry/common/feature-flags';

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
import { resolveAppendSystemPromptText } from '@/utils/appendSystemPromptArgs';
import {
  getRuntimeSettingsPathFromEnv,
  resolveRuntimeSettingsPath,
} from '@/utils/runtimeSettingsBootstrap';
import {
  getShutdownCoordinator,
  initShutdownCoordinator,
} from '@/utils/shutdownCoordinator';
import { writeCriticalErrorBreadcrumb } from '@/utils/criticalErrorBreadcrumb';
import { loadSystemCertificates } from '@/utils/systemCertificates';
import { setupWindowsConsoleEncoding } from '@/utils/windowsConsoleEncoding';
import { initI18n } from '@/i18n';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { createSandboxAskCallback } from '@/sandbox/SandboxPermissionPrompt';
import { getSandboxService } from '@/services/SandboxService';
import {
  getCliRuntimeMetricLabels,
  withStartupLatency,
} from '@/utils/startupLatency';

// ---------------------------------------------------------------------------
// Bootstrap + Run
// ---------------------------------------------------------------------------

import type { ExecCommandOptions } from '@/commands/types';

const __dirExec = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirExec, '../../..', '.env'), quiet: true });
dotenvConfig({
  path: resolve(__dirExec, '../../..', '.env.local'),
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

const { initCliTracing, classifyCliClientSurface } = await import(
  '@/telemetry/system/initCliTracing'
);
await initCliTracing({ clientSurface: classifyCliClientSurface() });

initShutdownCoordinator();
const shutdownCoordinator = getShutdownCoordinator();

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

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE') {
    process.exit(0);
  }
  void handleCriticalError(err, 'process.stdout error');
});
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE') {
    process.exit(0);
  }
  process.exit(1);
});

export async function run(
  execPrompt: string | undefined,
  execOptions: Omit<ExecCommandOptions, 'tag'> & { tag?: string[] }
): Promise<void> {
  try {
    Metrics.addToCounter(
      Metric.CLI_STARTUP_BOOTSTRAP_LATENCY,
      process.uptime() * 1000,
      getCliRuntimeMetricLabels()
    );

    initI18n();

    const startupTime = performance.now();

    // Resolve --settings and --append-system-prompt from already-parsed options
    clearRuntimeSettingsStartupFailure();

    const appendSystemPromptText =
      (await resolveAppendSystemPromptText({
        appendSystemPrompt: execOptions.appendSystemPrompt ?? null,
        appendSystemPromptFile: execOptions.appendSystemPromptFile ?? null,
      })) ??
      process.env[EnvironmentVariable.INDUSTRY_APPEND_SYSTEM_PROMPT] ??
      null;
    if (appendSystemPromptText) {
      process.env[EnvironmentVariable.INDUSTRY_APPEND_SYSTEM_PROMPT] =
        appendSystemPromptText;
      getExecRuntimeConfig().setAppendSystemPrompt(appendSystemPromptText);
    }

    const runtimeSettingsPathInput =
      execOptions.settings ?? getRuntimeSettingsPathFromEnv();
    if (runtimeSettingsPathInput) {
      try {
        const resolvedRuntimeSettingsPath = await resolveRuntimeSettingsPath(
          runtimeSettingsPathInput
        );
        process.env[EnvironmentVariable.INDUSTRY_RUNTIME_SETTINGS_PATH] =
          resolvedRuntimeSettingsPath;
        clearRuntimeSettingsStartupFailure();
        logInfo('[exec-startup] Runtime settings overlay enabled', {
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
        logWarn('[exec-startup] Runtime settings overlay ignored', {
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
        logException(error, '[exec-startup] agent-browser cleanup failed');
      }
    })();

    // Windows/POSIX pending update cleanup
    if (process.platform === 'win32') {
      const { Updater } = await import('@industry/updater');
      const pendingResult = await withStartupLatency(
        Metric.CLI_STARTUP_PENDING_UPDATE_APPLY_LATENCY,
        () => Updater.applyPendingWindowsUpdate(),
        (result) => ({
          status: result.applied
            ? 'applied'
            : result.error
              ? 'error'
              : 'skipped',
        })
      );
      if (pendingResult.applied) {
        logInfo('[exec-startup] Applied pending Windows update', {
          version: pendingResult.version,
        });
      } else if (pendingResult.error) {
        logWarn('[exec-startup] Failed to apply pending Windows update', {
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
            '[exec-startup] cleanupStalePreservedBinaries failed'
          );
        });
    }

    // Certs + auth + feature flags
    await withStartupLatency(Metric.CLI_STARTUP_CERTIFICATES_LATENCY, () =>
      loadSystemCertificates()
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
        import('@/environment').then(({ getRuntimeAuthConfig }) =>
          getAuthToken(getRuntimeAuthConfig())
        ),
      (result) => ({ status: result ? 'present' : 'missing' })
    );
    if (!token) {
      logWarn('[exec-startup] Invalid auth');
    } else {
      logInfo('[exec-startup] Valid auth');
    }

    setOrgIdProvider(async () => {
      const { getRuntimeAuthConfig } = await import('@/environment');
      return (await getAuthedUser(getRuntimeAuthConfig()))?.orgId;
    });

    // Host identity must be initialized for every CLI invocation so every
    // local runtime has a stable host.json before reading or writing
    // computer registration.
    const { initializeCliHostIdentity } = await import(
      '@/utils/initializeCliHostIdentity'
    );
    await initializeCliHostIdentity();
    logInfo('[exec-startup] Host identity initialized');

    try {
      void withStartupLatency(
        Metric.CLI_STARTUP_FEATURE_FLAGS_WARM_LATENCY,
        () => fetchFeatureFlags()
      ).catch((error) => {
        logWarn('[exec-startup] Failed to eagerly fetch feature flags', {
          cause: error,
        });
      });
    } catch {
      // Best-effort
    }

    // Settings init (no auto-update for exec)
    await withStartupLatency(
      Metric.CLI_STARTUP_SETTINGS_INIT_LATENCY,
      async () => {
        await settingsService.initialize();
        getSessionService().initializeAutonomyFromGlobalDefaults();
        const { ensureBuiltInDrools } = await import(
          '@/services/drools/builtInDrools'
        );
        await ensureBuiltInDrools();
      }
    ).catch((error) => {
      logException(error, '[exec-startup] Failed to initialize settings');
    });

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
        logException(error, '[exec-startup] Failed to run startup diagnostics');
      }
    })();

    setupWindowsConsoleEncoding();
    void initCustomerTelemetry();
    initSubAgentsV2Flag();
    initChangelog();

    // Sandbox
    try {
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
      logWarn('[exec-startup] Failed to initialize sandbox service', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    // Tool manager
    await withStartupLatency(
      Metric.CLI_STARTUP_TASK_TOOLS_INIT_LATENCY,
      async () => {
        const {
          ensureTaskToolManagerInitialized,
          registerSubAgentsV2Tools,
          registerConnectorsTools,
        } = await import('@/tools/tui');
        // The startup feature-flag warm-up is fire-and-forget, so on a cold
        // start getFlag() can still read the compiled default. Prime the cache
        // (cheap: returns cached/in-flight result) before gating registration.
        try {
          await fetchFeatureFlags();
        } catch (error) {
          logWarn(
            '[exec-startup] Failed to fetch feature flags before tool init',
            {
              cause: error,
            }
          );
        }
        if (getExecRuntimeConfig().isSubAgentsV2Enabled()) {
          registerSubAgentsV2Tools();
        }
        if (getFlag(IndustryFeatureFlags.Connectors)) {
          registerConnectorsTools();
        }
        const { registerCronTools } = await import('@/tools/cron-tools');
        registerCronTools();
        const { registerAutomationTools } = await import(
          '@/tools/automation-tools'
        );
        registerAutomationTools();
        await ensureTaskToolManagerInitialized();
      },
      { source: 'subcommand' }
    );

    // Call exec action directly — Commander already parsed options in index.ts
    // Parse raw tag strings into SessionTag objects (deferred to avoid eager
    // import of @industry/common/session which has heavy transitive deps)
    const { collectTags } = await import('@/entrypoints/exec/parseTagFlag');
    const parsedTags = (execOptions.tag ?? []).reduce(
      (acc, raw) => collectTags(raw, acc),
      [] as import('@industry/drool-sdk-ext/protocol/session').SessionTag[]
    );

    const { runExecAction } = await import('@/entrypoints/exec/handler');
    await runExecAction(
      execPrompt,
      { ...execOptions, tag: parsedTags },
      startupTime
    );
  } catch (error) {
    writeStderr(`Startup failed: ${formatStartupError(error)}`);
    if (process.env.DEBUG === '1' && error instanceof Error && error.stack) {
      writeStderr(error.stack);
    }
    const errorObj = error instanceof Error ? error : new Error(String(error));
    logException(errorObj, 'CLI exec startup failed');
    await exitWithCode(1);
  }
}
