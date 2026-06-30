import { promises as fs, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { logInfo, logWarn } from '@industry/logging';

import {
  getIndustryDroolBinaryOverride,
  setIndustryDroolBinaryOverride,
} from './environment';

const PRESERVED_BINARY_PREFIX = 'drool-preserved-';
const PRESERVED_BINARY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * On POSIX, before an in-place binary overwrite, copy the currently-running
 * executable to a per-process temp directory and expose it via
 * INDUSTRY_DROOL_BINARY. Subsequent child-process spawns (subagents, daemon,
 * exec runners) done by this TUI will pick up the preserved old binary via
 * `resolveDroolCommand()`/`resolveDroolBinary()` instead of the freshly
 * overwritten one, keeping the running session and its children on a single
 * drool version.
 *
 * Skipped on Windows (updates are deferred to next startup so the running
 * binary is never overwritten) and when INDUSTRY_DROOL_BINARY is already set
 * (explicit override from a wrapper or parent process must win).
 */
export async function preserveCurrentBinary(): Promise<string | null> {
  if (process.platform === 'win32') {
    return null;
  }
  if (getIndustryDroolBinaryOverride()) {
    return null;
  }

  try {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), PRESERVED_BINARY_PREFIX)
    );
    const preservedPath = path.join(dir, path.basename(process.execPath));
    await fs.copyFile(process.execPath, preservedPath);
    try {
      const stats = await fs.stat(process.execPath);
      await fs.chmod(preservedPath, stats.mode);
    } catch (chmodErr) {
      logWarn('Failed to copy mode bits to preserved binary', {
        cause: chmodErr,
      });
    }

    setIndustryDroolBinaryOverride(preservedPath);

    const cleanup = () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (cleanupErr) {
        // Best-effort cleanup: a leftover tmp dir is harmless and will be
        // swept by cleanupStalePreservedBinaries on the next startup.
        logWarn('Failed to cleanup preserved drool binary tmp dir', {
          cause: cleanupErr,
        });
      }
    };
    process.once('exit', cleanup);
    // NOTE: do not register a cleanup on SIGINT. The CLI uses SIGINT to pause
    // running missions (see apps/cli/src/services/mission/MissionRunner.ts)
    // without terminating the process, so deleting the preserved binary on
    // SIGINT would break subsequent subagent/daemon spawns while
    // INDUSTRY_DROOL_BINARY still points at it.
    (['SIGTERM', 'SIGHUP'] as const).forEach((sig) => {
      process.once(sig, () => {
        cleanup();
      });
    });

    logInfo('Preserved current drool binary for in-flight child processes', {
      filePath: preservedPath,
    });
    return preservedPath;
  } catch (err) {
    logWarn(
      'Failed to preserve current drool binary; child processes may use new version',
      { cause: err }
    );
    return null;
  }
}

/**
 * Best-effort sweep of stale preserved-binary temp dirs that were left behind
 * by crashed processes. Safe to call at startup; failures are swallowed.
 */
export async function cleanupStalePreservedBinaries(): Promise<void> {
  try {
    const tmp = os.tmpdir();
    const entries = await fs.readdir(tmp);
    const now = Date.now();
    await Promise.all(
      entries
        .filter((name) => name.startsWith(PRESERVED_BINARY_PREFIX))
        .map(async (name) => {
          const full = path.join(tmp, name);
          try {
            const stat = await fs.stat(full);
            if (now - stat.mtimeMs > PRESERVED_BINARY_MAX_AGE_MS) {
              await fs.rm(full, { recursive: true, force: true });
            }
          } catch (entryErr) {
            // Individual entries may race with other sweepers or get unlinked
            // between readdir and stat; this is best-effort cleanup so we just
            // log at debug level and continue.
            logWarn('Failed to inspect preserved-binary tmp entry', {
              filePath: full,
              cause: entryErr,
            });
          }
        })
    );
  } catch (sweepErr) {
    // Best-effort cleanup: readdir may fail under racing conditions; missing a
    // sweep cycle is harmless.
    logWarn('Failed to sweep stale preserved-binary tmp dirs', {
      cause: sweepErr,
    });
  }
}
