import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { DeploymentEnv } from '@industry/environment';
import { logWarn } from '@industry/logging';

import { IncrementalRenderingReason } from '@/utils/enums';
import type { IncrementalRenderingDecision } from '@/utils/types';

interface IncrementalRenderingOptions {
  deploymentEnv: DeploymentEnv;
  featureFlagEnabled: boolean;
  disabled?: boolean;
  platform?: NodeJS.Platform;
  inkPatched?: boolean;
}

interface ClearInkOutputOptions {
  clearTerminalSequence: string;
  writeToStdout: (data: string) => void;
  invalidateOutput?: (resetStaticOutput?: boolean) => void;
  /**
   * Also reset Ink's accumulated Static bookkeeping. Set this when a
   * different Static surface takes ownership of the screen after the clear
   * (for example entering the detailed-transcript view); otherwise Ink keeps
   * the previous surface's Static output and replays it on tall-frame
   * redraws, duplicating content.
   */
  resetStaticOutput?: boolean;
}

interface RefreshInkStaticOutputOptions extends ClearInkOutputOptions {
  resetStaticHeader: () => void;
  bumpStaticKey: () => void;
}

const INK_PHYSICAL_ROW_CLEAR_FINGERPRINT =
  'rowsToErase = previousOutput.length === 0 ? 0 : previousMetrics.cursorLineCount';

let cachedInkPatchPresent: boolean | undefined;

export function hasInkIncrementalPatchFingerprint(source: string): boolean {
  return (
    source.includes('render.invalidate') &&
    source.includes('getOutputMetrics') &&
    source.includes(INK_PHYSICAL_ROW_CLEAR_FINGERPRINT)
  );
}

/**
 * Detect at runtime whether the Industry Ink patch is present.
 *
 * Source runs (bun/vitest resolving ink from node_modules) read the installed
 * log-update build and look for the same patch fingerprint that
 * apps/cli/scripts/apply-patches.mjs verifies at install time. Compiled
 * binaries bundle Ink at build time, after postinstall has already failed
 * loudly on an unpatched install, so an unreadable module resolves as
 * patched.
 */
function isInkIncrementalPatchPresent(): boolean {
  if (cachedInkPatchPresent !== undefined) {
    return cachedInkPatchPresent;
  }

  try {
    const require = createRequire(import.meta.url);
    const logUpdateSource = readFileSync(
      join(dirname(require.resolve('ink')), 'log-update.js'),
      'utf8'
    );
    cachedInkPatchPresent = hasInkIncrementalPatchFingerprint(logUpdateSource);
  } catch {
    cachedInkPatchPresent = true;
  }

  return cachedInkPatchPresent;
}

/**
 * Decide whether Ink incremental rendering should be enabled for this run.
 *
 * Rules, in order: an explicit `disabled` override wins, Windows is always
 * forced off, an unpatched Ink runtime is always forced off (incremental
 * rendering without the Industry patch produces stale/duplicate rows),
 * development/localhost deployments are always on, and production follows
 * the `cli_incremental_rendering` feature flag. The returned reason is
 * emitted as a metric label so dashboards can distinguish "flag on and
 * actually incremental" from "flag on but forced off".
 */
export function resolveIncrementalRendering({
  deploymentEnv,
  disabled = false,
  featureFlagEnabled,
  platform = process.platform,
  inkPatched,
}: IncrementalRenderingOptions): IncrementalRenderingDecision {
  if (disabled) {
    return {
      enabled: false,
      reason: IncrementalRenderingReason.DisabledOverride,
    };
  }

  if (platform === 'win32') {
    return { enabled: false, reason: IncrementalRenderingReason.Windows };
  }

  if (!(inkPatched ?? isInkIncrementalPatchPresent())) {
    logWarn(
      '[InkRendering] Industry Ink patch missing at runtime; forcing incremental rendering off'
    );
    return { enabled: false, reason: IncrementalRenderingReason.UnpatchedInk };
  }

  if (
    deploymentEnv === DeploymentEnv.Development ||
    deploymentEnv === DeploymentEnv.Localhost
  ) {
    return {
      enabled: true,
      reason: IncrementalRenderingReason.DevelopmentDefault,
    };
  }

  return featureFlagEnabled
    ? { enabled: true, reason: IncrementalRenderingReason.FeatureFlagOn }
    : { enabled: false, reason: IncrementalRenderingReason.FeatureFlagOff };
}

/**
 * Clear the terminal while an Ink app is mounted.
 *
 * Invalidates Ink's incremental-rendering (log-update) cache before writing
 * the clear sequence so the next render repaints every row instead of
 * assuming previously rendered lines are still on screen. Use this for
 * Industry-owned clears that do not replay Static output (overlay open/close,
 * resize refreshes, post-auth cleanup). For clears that must also re-render
 * Static content, use {@link refreshInkStaticOutput}.
 */
export function clearInkOutput({
  clearTerminalSequence,
  writeToStdout,
  invalidateOutput,
  resetStaticOutput = false,
}: ClearInkOutputOptions): void {
  invalidateOutput?.(resetStaticOutput);
  writeToStdout(clearTerminalSequence);
}

/**
 * Clear the terminal and force a full Static output replay.
 *
 * Invalidates Ink's incremental cache (including its Static bookkeeping),
 * writes the clear sequence, then resets Industry's Static header state and
 * bumps the Static key so the transcript is re-emitted from scratch. Use this
 * for paths that intentionally rebuild the transcript (`/clear`, `/new`,
 * working-directory changes); for plain clears use {@link clearInkOutput}.
 */
export function refreshInkStaticOutput({
  clearTerminalSequence,
  writeToStdout,
  invalidateOutput,
  resetStaticHeader,
  bumpStaticKey,
}: RefreshInkStaticOutputOptions): void {
  invalidateOutput?.(true);
  writeToStdout(clearTerminalSequence);
  resetStaticHeader();
  bumpStaticKey();
}
