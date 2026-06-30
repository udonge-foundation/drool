import { render } from 'ink';

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { BuiltInThemeName } from '@industry/common/settings/enums';
import { DroolMode } from '@industry/common/shared';
import { logException, logInfo, logWarn, Metrics } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';
import { getAuthedUser } from '@industry/runtime/auth';
import { fetchFeatureFlags, getFlag } from '@industry/runtime/feature-flags';

import {
  App,
  displayResumeCommandIfNeeded,
  showFullScreenAnimation,
} from '@/app';
import { ensureSlashCommandsReady } from '@/commands';
import {
  KeypressProvider,
  waitForKeypressProviderShutdown,
} from '@/contexts/KeypressProvider';
import { getEnv, getRuntimeAuthConfig } from '@/environment';
import { SupportedLocale } from '@/i18n/enums';
import { initI18n } from '@/i18n/index';
import { detectLocaleWithConfig } from '@/i18n/localeDetection';
import {
  getCliProfilerService,
  shouldEnableCliProfilerFromEnv,
} from '@/profiling/CliProfilerService';
import { ProfilerMode } from '@/profiling/enums';
import { ProfiledRegion } from '@/profiling/ProfiledRegion';
import { startReactDevToolsIfEnabled } from '@/profiling/reactDevtools';
import { getSettingsService } from '@/services/SettingsService';
import {
  setAwaitingInputSoundPlayer,
  setCompletionSoundPlayer,
} from '@/services/soundCallbacks';
import { getThemeEngine } from '@/theme/ThemeEngine';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';
import { ClientMode, TerminalDisconnectReason } from '@/utils/enums';
import { exitWithCode } from '@/utils/exitWithCode';
import { resolveIncrementalRendering } from '@/utils/inkRendering';
import { detectAndEnableKittyProtocol } from '@/utils/kittyProtocolDetector';
import { playCompletionSound } from '@/utils/soundPlayer';
import {
  getCliRuntimeMetricLabels,
  recordStartupLatency,
} from '@/utils/startupLatency';
import { prefetchSystemInfo } from '@/utils/systemInfo';
import { detectTerminalAppearance } from '@/utils/terminalAppearanceDetector';
import { setTerminalTabTitle } from '@/utils/terminalTitle';

setAwaitingInputSoundPlayer(() => {
  const settings = getSettingsService();
  const sound = settings.getAwaitingInputSound();
  if (sound === 'off') return;
  const focusMode = settings.getSoundFocusMode();
  playCompletionSound(sound, {}, focusMode).catch((error) => {
    logWarn('[AskUser] Failed to play awaiting input sound', { cause: error });
  });
});

setCompletionSoundPlayer(() => {
  const settings = getSettingsService();
  const sound = settings.getCompletionSound();
  if (sound === 'off') return;
  const focusMode = settings.getSoundFocusMode();
  playCompletionSound(sound, {}, focusMode).catch(() => {
    // Silently ignore sound playback errors
  });
});

export async function main(
  initialPrompt?: string,
  resumeSessionId?: string,
  startupTime?: number,
  originalCwd?: string,
  kittyDetectionPromise?: Promise<boolean>
) {
  logInfo('[Main] Starting Industry CLI TUI application');

  setTerminalTabTitle('Drool');

  // Set Sentry tag and telemetry to indicate the drool mode
  CliTelemetryClient.getInstance().setDroolMode(DroolMode.TerminalUI);
  CliTelemetryClient.getInstance().setClientMode(ClientMode.TUI);

  const profiler = getCliProfilerService();
  if (shouldEnableCliProfilerFromEnv()) {
    profiler.startRun({ mode: ProfilerMode.Interactive });
    profiler.startResourceSampling();
    void startReactDevToolsIfEnabled();
  }

  // Re-ensure tool manager init (no-op if already done by index.ts).
  void import('@/tools/tui')
    .then(({ ensureTaskToolManagerInitialized }) =>
      ensureTaskToolManagerInitialized()
    )
    .catch((error) => {
      logException(error, '[Main] tool manager re-ensure failed');
    });

  // Await kitty protocol detection that was started early in index.ts.
  // Must complete before render() to avoid escape sequences leaking into TUI input.
  if (kittyDetectionPromise) {
    await kittyDetectionPromise;
  } else {
    try {
      await detectAndEnableKittyProtocol();
    } catch (error) {
      logException(error, '[Main] Failed to enable Kitty protocol');
    }
  }

  // On Windows, defer systemInfo collection until the user sends the first
  // message. AV-scanned cold module loads + git probes here would contend
  // with first-paint and the user typing. AgentLoop's cache-miss path
  // collects on demand. POSIX fires-and-forgets so the work overlaps with
  // i18n / theme / feature-flag fetches.
  if (!resumeSessionId && process.platform !== 'win32') {
    void prefetchSystemInfo().catch(() => undefined);
  }

  // Fire-and-forget: warm auth + daemon adapter caches in background.
  void getAuthedUser(getRuntimeAuthConfig()).catch(() => undefined);

  void (async () => {
    try {
      const { getTuiDaemonAdapter } = await import(
        '@/services/daemon/TuiDaemonAdapter'
      );
      await getTuiDaemonAdapter().ensureConnectedAndGetController();
    } catch (error) {
      logException(error, '[Main] Failed to pre-connect in-process adapter');
    }
  })();

  // Initialize i18n before render to avoid flash of untranslated content.
  const settingsService = getSettingsService();
  const configLocale = settingsService.getLanguagePreference() as
    | SupportedLocale
    | undefined;
  const detectedLocale = detectLocaleWithConfig(configLocale);
  initI18n(detectedLocale);

  // Load persisted theme before render.
  const engine = getThemeEngine();
  const savedTheme = settingsService.getSettings().general?.theme;
  engine.setOverrideTerminalColors(settingsService.getOverrideTerminalColors());

  // Auto-detect terminal background to pick light/dark when the user
  // hasn't picked a theme yet (built-in default is Auto), or has explicitly
  // chosen the Auto entry. Run sequentially after kitty detection (already
  // awaited above) — both probes use raw mode + a one-shot stdin listener
  // and cannot run concurrently without interleaving responses.
  const wantsAutoTheme = !savedTheme || savedTheme === BuiltInThemeName.Auto;
  if (wantsAutoTheme) {
    try {
      const appearance = await detectTerminalAppearance();
      if (appearance !== 'unknown') {
        engine.setDetectedAppearance(appearance);
      }
    } catch (error) {
      logWarn('[Main] Terminal appearance detection failed', { cause: error });
    }
    engine.loadTheme(BuiltInThemeName.Auto);
  } else {
    engine.loadTheme(savedTheme);
  }

  if (process.stdout.isTTY) {
    engine.applyTheme();
  }

  // Show full-screen animation if enabled (before TUI renders)
  // Only show for fresh sessions, not when resuming
  const shouldShowAnimation =
    !resumeSessionId && settingsService.shouldShowLogoAnimation();

  if (shouldShowAnimation) {
    await showFullScreenAnimation();
    // Mark animation as shown (auto-toggles ONCE -> OFF)
    settingsService.markLogoAnimationShown();
  }

  // Log total startup latency before render().
  Metrics.addToCounter(
    Metric.CLI_STARTUP_TOTAL_LATENCY,
    process.uptime() * 1000,
    getCliRuntimeMetricLabels()
  );

  const idleRssTimer = setTimeout(() => {
    Metrics.addToCounter(
      Metric.CLI_STARTUP_IDLE_RSS_MB,
      process.memoryUsage().rss / 1024 / 1024,
      getCliRuntimeMetricLabels()
    );
  }, 20_000);
  idleRssTimer.unref?.();

  // Fetch feature flags before render so sync flag reads use a primed cache.
  await fetchFeatureFlags();

  try {
    await ensureSlashCommandsReady();
  } catch (error) {
    logException(error, '[Main] Failed to register slash commands');
  }

  const incrementalRendering = resolveIncrementalRendering({
    disabled: getEnv().extras.disableIncrementalRendering,
    deploymentEnv: getEnv().deploymentEnv,
    featureFlagEnabled: getFlag(IndustryFeatureFlags.CliIncrementalRendering),
  });

  const renderStart = performance.now();
  const app = render(
    <KeypressProvider>
      <ProfiledRegion id="AppRoot">
        <App
          initialPrompt={initialPrompt}
          resumeSessionId={resumeSessionId}
          originalCwd={originalCwd}
          daemonStartupFailed={false}
        />
      </ProfiledRegion>
    </KeypressProvider>,
    {
      exitOnCtrlC: false, // Prevent TTY suspension when spawning shell subprocesses
      incrementalRendering: incrementalRendering.enabled,
      patchConsole: false,
      onRender: (metrics) => profiler.recordInkRender(metrics),
    }
  );
  recordStartupLatency(Metric.CLI_TUI_RENDER_CALL_LATENCY, renderStart, {
    incrementalRendering: String(incrementalRendering.enabled),
    incrementalRenderingReason: incrementalRendering.reason,
  });

  void (async () => {
    try {
      const { startResourceMonitoring } = await import(
        '@/services/ResourceMonitorService'
      );
      startResourceMonitoring();
    } catch (error) {
      logException(error, '[Main] Failed to start resource monitoring');
    }
  })();

  void (async () => {
    try {
      const { ensureAllSecurePermissions } = await import(
        '@/utils/filePermissions'
      );
      await ensureAllSecurePermissions();
    } catch (error) {
      logException(
        error,
        '[Security] Failed to secure file permissions on startup',
        {}
      );
    }
  })();

  void (async () => {
    try {
      const { logTerminalCapabilities } = await import(
        '@/utils/terminalCapabilities'
      );
      await logTerminalCapabilities();
    } catch (error) {
      logException(error, '[Main] Failed to log terminal capabilities');
    }
  })();

  let disconnectCleanup: (() => void) | null = null;
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;
  let exiting = false;

  const handleTerminalDisconnect = (reason: TerminalDisconnectReason) => {
    if (exiting) return;
    exiting = true;

    logInfo('[Main] Terminal disconnected, exiting', { reason });

    // Best-effort: pause any running mission before exiting.
    void (async () => {
      try {
        const { gracefulMissionExit } = await import(
          '@/services/mission/gracefulMissionExit'
        );
        await gracefulMissionExit();
      } catch (error) {
        logException(error, '[Main] Failed to gracefully exit mission');
      }
    })();

    // Restore terminal palette before unmount (best-effort)
    getThemeEngine().restoreTheme();

    // Try to unmount Ink cleanly first.
    try {
      app.unmount();
    } catch (error) {
      logException(error, '[Main] Failed to unmount Ink app');
    }

    // Ensure we don't hang forever if Ink can't unmount due to a broken PTY.
    forceExitTimer = setTimeout(() => {
      void exitWithCode(0);
    }, 2000);

    if (typeof forceExitTimer.unref === 'function') {
      forceExitTimer.unref();
    }
  };

  const { registerExitOnTerminalDisconnect } = await import(
    '@/utils/exitOnTerminalDisconnect'
  );
  disconnectCleanup = registerExitOnTerminalDisconnect({
    enabled: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    onDisconnect: handleTerminalDisconnect,
  });

  await app.waitUntilExit();
  await waitForKeypressProviderShutdown();

  if (disconnectCleanup) {
    disconnectCleanup();
    disconnectCleanup = null;
  }
  if (forceExitTimer) {
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
  }

  try {
    const { stopResourceMonitoring } = await import(
      '@/services/ResourceMonitorService'
    );
    stopResourceMonitoring();
  } catch (error) {
    logException(error, '[Main] Failed to stop resource monitoring');
  }
  await profiler.stopRun().catch((error) => {
    logException(error, '[Profiler] Failed to stop profiler cleanly');
  });

  // Restore terminal palette before returning to the shell
  getThemeEngine().restoreTheme();

  try {
    const { restoreShellTerminalState } = await import(
      '@/utils/interactiveTerminalState'
    );
    await restoreShellTerminalState();
  } catch (error) {
    logException(error, '[Main] Failed to restore shell terminal state');
  }

  // Display resume message after Ink has stopped rendering
  displayResumeCommandIfNeeded();

  // Exit process after flushing logs
  await exitWithCode(0);
}
