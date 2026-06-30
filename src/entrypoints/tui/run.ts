/**
 * Self-contained entrypoint for interactive TUI mode and non-exec/daemon subcommands.
 *
 * Owns its entire bootstrap lifecycle. Handles: interactive mode (Ink/React),
 * and subcommands like mcp, plugin, search, update, computer, wiki-*.
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
import { PluginMarketplaceManager } from '@industry/runtime/settings';
import { Metric } from '@industry/logging/metrics/enums';
import { UpdateOutcome } from '@industry/updater';
import { expandTilde } from '@industry/utils/shell/node';
import { sleep } from '@industry/utils/time';

import {
  initCustomerTelemetry,
  initSubAgentsV2Flag,
} from '@/feature-flags/service';
import { initChangelog } from '@/services/ChangelogService';
import { getFolderTrustService } from '@/services/FolderTrustService';

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
import { runConditionalUpdate } from '@/services/update/UpdateService';
import { exitWithCode } from '@/utils/exitWithCode';
import { ShutdownReason } from '@/utils/enums';
import { detectAndEnableKittyProtocol } from '@/utils/kittyProtocolDetector';
import { resolveAppendSystemPromptText } from '@/utils/appendSystemPromptArgs';
import {
  getRuntimeSettingsPathFromEnv,
  resolveRuntimeSettingsPath,
} from '@/utils/runtimeSettingsBootstrap';
import {
  getShutdownCoordinator,
  initShutdownCoordinator,
} from '@/utils/shutdownCoordinator';
import { isBrokenTerminalWriteError } from '@/utils/terminalWriteErrors';
import { writeCriticalErrorBreadcrumb } from '@/utils/criticalErrorBreadcrumb';
import { loadSystemCertificates } from '@/utils/systemCertificates';
import {
  fetchFeatureFlags,
  getFlag,
  setOrgIdProvider,
} from '@industry/runtime/feature-flags';
import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { setupWindowsConsoleEncoding } from '@/utils/windowsConsoleEncoding';
import { getI18n, initI18n } from '@/i18n';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { createSandboxAskCallback } from '@/sandbox/SandboxPermissionPrompt';
import { getSandboxService } from '@/services/SandboxService';
import { setupWorktree } from '@industry/utils/git';

import { DroolInteractionMode } from '@industry/drool-sdk-ext/protocol/shared';

import type { WorktreeSessionInfo } from '@industry/utils/git';
import { parseAutonomyFlag } from '@/entrypoints/tui/autonomyFlag';
import { getForkSessionTitle } from '@/utils/sessionFork';
import {
  changeSessionWorkingDirectory,
  resolveWorkingDirectoryPath,
} from '@/utils/sessionCwd';
import {
  getCliRuntimeMetricLabels,
  withStartupLatency,
} from '@/utils/startupLatency';

// ---------------------------------------------------------------------------
// Bootstrap + Run
// ---------------------------------------------------------------------------

import type { TuiOptions } from '@/entrypoints/tui/types';

const __dirTui = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirTui, '../../..', '.env'), quiet: true });
dotenvConfig({
  path: resolve(__dirTui, '../../..', '.env.local'),
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
    process.exit(isBrokenTerminalWriteError(error) ? 0 : 1);
  }
  isHandlingCriticalError = true;

  const errorObj = error instanceof Error ? error : new Error(String(error));
  if (isBrokenTerminalWriteError(error)) {
    logInfo('[TUI] Broken terminal write detected, exiting', {
      reason: context,
      errorMessage: getErrorMessage(error),
    });
    await shutdownCoordinator.requestExit({
      reason: ShutdownReason.Other,
      exitCode: 0,
    });
    return;
  }

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
process.stdout.on('error', (error) => {
  void handleCriticalError(error, 'process.stdout error');
});
process.stderr.on('error', (error) => {
  void handleCriticalError(error, 'process.stderr error');
});

export async function run(
  tuiPromptParts: string[] | undefined,
  tuiOptions: TuiOptions
): Promise<void> {
  try {
    Metrics.addToCounter(
      Metric.CLI_STARTUP_BOOTSTRAP_LATENCY,
      process.uptime() * 1000,
      getCliRuntimeMetricLabels()
    );

    initI18n();

    const startupTime = performance.now();

    // Resolve --settings (already parsed by Commander, but we need to resolve the path)
    clearRuntimeSettingsStartupFailure();
    const runtimeSettingsPathInput =
      tuiOptions.settings ?? getRuntimeSettingsPathFromEnv();
    if (runtimeSettingsPathInput) {
      try {
        const resolvedRuntimeSettingsPath = await resolveRuntimeSettingsPath(
          runtimeSettingsPathInput
        );
        process.env[EnvironmentVariable.INDUSTRY_RUNTIME_SETTINGS_PATH] =
          resolvedRuntimeSettingsPath;
        clearRuntimeSettingsStartupFailure();
        logInfo('[tui-startup] Runtime settings overlay enabled', {
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
        logWarn('[tui-startup] Runtime settings overlay ignored', {
          path: runtimeSettingsPathInput,
          cause: error,
        });
      }
    }

    // Resolve --append-system-prompt / --append-system-prompt-file
    const appendSystemPromptText =
      (await resolveAppendSystemPromptText({
        appendSystemPrompt: tuiOptions.appendSystemPrompt ?? null,
        appendSystemPromptFile: tuiOptions.appendSystemPromptFile ?? null,
      })) ??
      process.env[EnvironmentVariable.INDUSTRY_APPEND_SYSTEM_PROMPT] ??
      null;
    if (appendSystemPromptText) {
      process.env[EnvironmentVariable.INDUSTRY_APPEND_SYSTEM_PROMPT] =
        appendSystemPromptText;
      getExecRuntimeConfig().setAppendSystemPrompt(appendSystemPromptText);
    }

    const hasPrompt = tuiPromptParts && tuiPromptParts.length > 0;
    const isInteractiveDefault = !hasPrompt;

    // Warm session search cache for interactive mode
    if (isInteractiveDefault) {
      void (async () => {
        try {
          const { warmSearchCache } = await import(
            '@industry/runtime/session-search'
          );
          await warmSearchCache();
        } catch (error) {
          logException(error, '[search] warmSearchCache startup failed');
        }
      })();
    }

    const kittyDetectionPromise = detectAndEnableKittyProtocol().catch(
      () => false
    );

    // Agent-browser daemon cleanup
    void (async () => {
      try {
        const { cleanupAgentBrowserDaemons } = await import(
          '@/utils/agentBrowserCleanup'
        );
        await cleanupAgentBrowserDaemons();
      } catch (error) {
        logException(error, '[agent-browser-cleanup] Startup cleanup failed');
      }
    })();

    // Windows pending update
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
        logInfo('[tui-startup] Applied pending Windows update', {
          version: pendingResult.version,
        });
      } else if (pendingResult.error) {
        logWarn('[tui-startup] Failed to apply pending Windows update', {
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
            '[tui-startup] cleanupStalePreservedBinaries failed'
          );
        });
    }

    // Certs + auth + feature flags
    let preUpdateError: unknown = null;
    let flagsWarmPromise: Promise<unknown> = Promise.resolve();
    try {
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
        logWarn('[tui-startup] Invalid auth');
      } else {
        logInfo('[tui-startup] Valid auth');
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
      logInfo('[tui-startup] Host identity initialized');

      try {
        flagsWarmPromise = withStartupLatency(
          Metric.CLI_STARTUP_FEATURE_FLAGS_WARM_LATENCY,
          () => fetchFeatureFlags()
        ).catch((error) => {
          logWarn(
            '[tui-startup] Failed to eagerly fetch feature flags (async)',
            {
              cause: error,
            }
          );
        });
      } catch (error) {
        logWarn('[tui-startup] Failed to eagerly fetch feature flags (sync)', {
          cause: error,
        });
      }
    } catch (error) {
      preUpdateError = error;
      throw error;
    } finally {
      // Settings init must complete before auto-update so org-level
      // disableAutoUpdate enterprise control is available.
      const settingsInitStart = performance.now();
      let settingsInitOk = true;
      await withStartupLatency(
        Metric.CLI_STARTUP_SETTINGS_INIT_LATENCY,
        async () => {
          await settingsService.initialize();
          // Interactive TUI is the only mode that can show the folder trust
          // prompt; this arms the trust gate (CLI-897) for hook execution
          // until the prompt is resolved.
          const folderTrustService = getFolderTrustService();
          folderTrustService.setInteractiveTuiContext(true);
          // The trust gate reads the folder_trust_prompt flag synchronously
          // when App mounts; on a cold cache getFlag() would fall back to the
          // compiled default and fail open. Only when this workspace would
          // actually need a prompt, wait (bounded) for the in-flight flag
          // warm-up so the gate sees the fetched value.
          if (!folderTrustService.isCurrentFolderTrusted()) {
            await Promise.race([flagsWarmPromise, sleep(3000)]);
          }
          getSessionService().initializeAutonomyFromGlobalDefaults();
          const { ensureBuiltInDrools } = await import(
            '@/services/drools/builtInDrools'
          );
          await ensureBuiltInDrools();
        }
      ).catch((error) => {
        settingsInitOk = false;
        logException(error, '[tui-startup] Failed to initialize settings');
      });
      const settingsInitElapsed = performance.now() - settingsInitStart;
      if (settingsInitOk) {
        logInfo('[tui-startup] Settings init completed', {
          durationMs: Math.round(settingsInitElapsed),
        });
      } else {
        logWarn('[tui-startup] Settings init failed', {
          durationMs: Math.round(settingsInitElapsed),
        });
      }

      const autoUpdateStart = performance.now();
      const updateOutcome = await runConditionalUpdate().catch((error) => {
        logException(error, 'Failed to run auto-update');
        return UpdateOutcome.Error;
      });
      const autoUpdateElapsed = performance.now() - autoUpdateStart;
      logInfo('[tui-startup] Auto-update completed', {
        durationMs: Math.round(autoUpdateElapsed),
        outcome: updateOutcome,
      });

      if (preUpdateError) {
        logWarn(
          'Unexpected error before auto-update could run, but attempted auto-update anyways. Logging update outcome',
          { result: updateOutcome, cause: preUpdateError },
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
            '[tui-startup] Failed to run startup diagnostics'
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
      logWarn('[tui-startup] Failed to initialize sandbox service', {
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
            '[tui-startup] Failed to fetch feature flags before tool init',
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
      { source: hasPrompt ? 'with-prompt' : 'interactive' }
    );

    // Action handler — receives already-parsed options from Commander in index.ts
    // via the exported run() function. No second Commander instance needed.
    {
      const promptArray = Array.isArray(tuiPromptParts)
        ? tuiPromptParts
        : typeof tuiPromptParts === 'string'
          ? [tuiPromptParts]
          : [];
      const initialPrompt = promptArray.join(' ').trim();
      const normalizedPrompt = initialPrompt.length ? initialPrompt : undefined;
      let effectivePrompt = normalizedPrompt;
      const options = tuiOptions;

      const autoFlag = parseAutonomyFlag(options.auto);
      if (!autoFlag.ok) {
        process.stderr.write(
          `${getI18n().t('commands:assertValidOptions.invalidAutoValue')}\n`
        );
        await exitWithCode(1);
        return;
      }

      if (options.resume !== undefined && options.fork !== undefined) {
        process.stderr.write(
          `${getI18n().t('commands:assertValidOptions.resumeAndForkConflict')}\n`
        );
        await exitWithCode(1);
        return;
      }

      if (options.fork !== undefined && options.worktree !== undefined) {
        process.stderr.write(
          `${getI18n().t('commands:assertValidOptions.forkWithWorktree')}\n`
        );
        await exitWithCode(1);
        return;
      }

      if (options.worktree !== undefined && options.cwd !== undefined) {
        process.stderr.write(
          'Error: --worktree and --cwd cannot be used together.\n'
        );
        await exitWithCode(1);
        return;
      }

      // Handle --worktree flag
      let worktreeInfo: WorktreeSessionInfo | undefined;
      if (options.worktree !== undefined) {
        try {
          const worktreeDir =
            options.worktreeDir ?? settingsService.getWorktreeDirectory();
          worktreeInfo = await setupWorktree(options.worktree, {
            worktreeDir,
          });
          process.chdir(worktreeInfo.path);
          getExecRuntimeConfig().setWorktreeInfo(worktreeInfo);
          process.stderr.write(
            worktreeInfo.isNewlyCreated
              ? `Created worktree at ${worktreeInfo.path} (branch: ${worktreeInfo.branch})\n`
              : `Using existing worktree at ${worktreeInfo.path} (branch: ${worktreeInfo.branch})\n`
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          process.stderr.write(`Error: ${errorMessage}\n`);
          logException(error, 'Worktree setup failed');
          await exitWithCode(1);
          return;
        }
      }

      // Handle session startup flags
      let resumeSessionId: string | undefined;
      let originalCwd: string | undefined;
      const sessionService = getSessionService();
      let startupCwdOverride: string | undefined;

      if (options.cwd) {
        try {
          startupCwdOverride = resolveWorkingDirectoryPath(options.cwd);
        } catch (error) {
          console.error(`Error: ${formatStartupError(error)}`);
          await exitWithCode(1);
          return;
        }
      }

      if (options.resume !== undefined) {
        if (typeof options.resume === 'string') {
          resumeSessionId = options.resume;
        } else {
          const session = await sessionService.getMostRecentResumableSession(
            process.cwd()
          );
          if (!session) {
            console.error(getI18n().t('errors:noSessionsFound'));
            await exitWithCode(1);
            return;
          }
          resumeSessionId = session.id;
        }
      } else if (options.fork !== undefined) {
        try {
          resumeSessionId = await sessionService.forkSession(
            options.fork,
            null,
            getForkSessionTitle(options.fork),
            options.fork,
            'fork',
            { cwdOverride: startupCwdOverride }
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error(`Error: ${errorMessage}`);
          await exitWithCode(1);
          return;
        }
      }

      if (resumeSessionId) {
        originalCwd = process.cwd();
        let session: Awaited<ReturnType<typeof sessionService.loadSession>>;
        try {
          session = await sessionService.loadSession(resumeSessionId);
        } catch {
          console.error(
            getI18n().t('errors:agent.sessionNotFound', {
              sessionId: resumeSessionId,
            })
          );
          await exitWithCode(1);
          return;
        }

        if (startupCwdOverride) {
          try {
            await changeSessionWorkingDirectory(startupCwdOverride);
          } catch (error) {
            console.error(`Error: ${formatStartupError(error)}`);
            await exitWithCode(1);
            return;
          }
        } else {
          const effectiveSessionCwd = session.cwd;
          if (effectiveSessionCwd && effectiveSessionCwd !== originalCwd) {
            try {
              process.chdir(expandTilde(effectiveSessionCwd));
            } catch {
              console.error(
                getI18n().t('errors:agent.warningSessionDir', {
                  dir: effectiveSessionCwd,
                })
              );
            }
          }
        }

        if (effectivePrompt) {
          console.warn(getI18n().t('errors:agent.warningPromptIgnored'));
          effectivePrompt = undefined;
        }
      } else if (startupCwdOverride) {
        try {
          await changeSessionWorkingDirectory(startupCwdOverride);
        } catch (error) {
          console.error(`Error: ${formatStartupError(error)}`);
          await exitWithCode(1);
          return;
        }
      }

      // Apply the explicit `--auto <level>` / `--use-spec` overrides after any
      // session resume/load so the flags win for both new and resumed sessions.
      // For a new session there is no current session yet, so this updates the
      // in-memory defaults that the pre-created/daemon session inherits.
      // Set the final interaction mode first so setAutonomyLevel() derives the
      // autonomy mode from it; `--use-spec` forces Spec while the level is
      // retained for when the user toggles back to Auto. Ordering this way
      // avoids persisting a transient mode when resuming a session whose
      // current interaction mode differs (e.g. resuming a Spec session with
      // only `--auto`).
      if (options.useSpec) {
        sessionService.setInteractionMode(DroolInteractionMode.Spec);
      } else if (autoFlag.level) {
        sessionService.setInteractionMode(DroolInteractionMode.Auto);
      }
      if (autoFlag.level) {
        sessionService.setAutonomyLevel(autoFlag.level);
      }

      // Warm readiness-hint cache
      void import('@/utils/getReadinessHint')
        .then(({ primeReadinessHint }) => primeReadinessHint())
        .catch((error) => {
          logException(error, '[readiness-hint] prime failed');
        });

      // Plugin marketplace auto-update (interactive only)
      void (async () => {
        try {
          const { getRuntimeAuthConfig } = await import('@/environment');
          if (getRuntimeAuthConfig().airgapEnabled) {
            // Airgap mode: do not auto-clone, auto-update, or auto-install
            // any plugin marketplace by default. Operators can still run
            // `drool plugin marketplace add ...` explicitly to opt in.
            logInfo(
              '[plugin-marketplace] Airgap Mode is enabled; skipping default marketplace auto-update'
            );
          } else {
            const manager = PluginMarketplaceManager.getInstance();
            await manager.syncConfiguredPlugins();
          }
        } catch (error) {
          logException(
            error,
            'Failed to auto-update/install marketplaces/plugins'
          );
        }
        try {
          const { getDiagnosticsService } = await import(
            '@/services/diagnostics/DiagnosticsService'
          );
          await getDiagnosticsService().refresh();
        } catch {
          // Non-fatal
        }
      })();

      const { main: runInteractive } = await import('@/main');
      await runInteractive(
        effectivePrompt,
        resumeSessionId,
        startupTime,
        originalCwd,
        kittyDetectionPromise
      );
    }
  } catch (error) {
    writeStderr(`Startup failed: ${formatStartupError(error)}`);
    if (process.env.DEBUG === '1' && error instanceof Error && error.stack) {
      writeStderr(error.stack);
    }
    const errorObj = error instanceof Error ? error : new Error(String(error));
    logException(errorObj, 'CLI startup failed');
    await exitWithCode(1);
  }
}
