/**
 * Embedded ripgrep binary management.
 *
 * This module handles the embedded rg binary that is bundled into the CLI.
 * In dev mode, it symlinks to the system ripgrep for simplicity.
 * In production, it extracts the embedded binary to ~/.industry/bin/.
 *
 * The binary location can be overridden via (in priority order):
 *   1. INDUSTRY_RIPGREP_PATH  -- absolute path to an rg executable
 *   2. INDUSTRY_NPM_MODULES_DIR -- node_modules dir containing @vscode/ripgrep
 * This is intended for environments (e.g. locked-down corporate machines)
 * where executables in ~/.industry/bin are blocked by AV/EDR.
 */

import { execSync } from 'child_process';
// Use a namespace import so partial `fs` mocks in unrelated test suites don't
// fail at module link time when this file is transitively imported. Named
// imports (e.g. `import { accessSync } from 'fs'`) throw a SyntaxError under
// ESM if the mock doesn't enumerate every requested export.
import * as fs from 'fs';
import path from 'path';

import { logInfo, logWarn } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import embeddedRgDarwinArm64Path from '@assets/native/ripgrep/rg-darwin-arm64' with { type: 'file' };
import embeddedRgLinuxX64Path from '@assets/native/ripgrep/rg-linux-x64' with { type: 'file' };
import embeddedRgWin32X64Path from '@assets/native/ripgrep/rg-win32-x64.exe' with { type: 'file' };
import { NpmDepKind } from '@/utils/enums';
import { resolveNpmDep } from '@/utils/npmDepResolver';

// Static import from generated location - always exists after install/build

// Stamp file recording the CLI_VERSION that produced the on-disk rg binary.
// Used to decide when to re-extract after a drool upgrade. Cheaper than
// hashing the multi-MB embedded blob on every CLI startup.
const VERSION_FILE_NAME = '.rg-version';

/**
 * Returns the CLI version that should be stamped alongside the extracted rg
 * binary. Falls back to a sentinel string when CLI_VERSION is not injected
 * (e.g. unbundled test runs) so the stamp comparison still works.
 */
function getCliVersionStamp(): string {
  return process.env.CLI_VERSION || 'unknown';
}

function getEmbeddedRgPath(): string {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return embeddedRgWin32X64Path;
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return embeddedRgLinuxX64Path;
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return embeddedRgDarwinArm64Path;
  }
  throw new Error(
    `No embedded ripgrep binary for platform=${process.platform} arch=${process.arch}`
  );
}

function tryCreateDevSymlink(binDir: string, targetPath: string): boolean {
  // On Windows, 'which' may resolve to Git Bash's which.exe but the returned
  // path (or symlink creation) may not work reliably as a native Windows
  // executable. Skip and always use the embedded binary extraction instead.
  if (process.platform === 'win32') {
    return false;
  }

  try {
    // Use stdio: 'pipe' to capture output and prevent it from corrupting TUI
    const systemRg = execSync('which rg', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (systemRg) {
      fs.mkdirSync(binDir, { recursive: true });
      fs.symlinkSync(systemRg, targetPath);
      logInfo('Created symlink to system ripgrep', {
        path: targetPath,
        targetPath: systemRg,
      });
      return true;
    }
  } catch {
    // System rg not found, fall through to embedded binary
  }
  return false;
}

/**
 * Ensures the ripgrep binary is available at ~/.industry/bin/ and returns its path.
 *
 * Resolution order:
 *   1. INDUSTRY_RIPGREP_PATH per-dep override
 *   2. INDUSTRY_NPM_MODULES_DIR canonical sub-path
 *   3. Dev mode: symlink to system rg if target doesn't exist
 *   4. Production: extract embedded binary, re-extract whenever the on-disk
 *      version stamp doesn't match the running CLI_VERSION
 */
export function ensureRipgrepBinary(): string {
  // Allow opting out of the embedded binary entirely (e.g. corporate machines
  // that block executables under ~/.industry/bin). Checks INDUSTRY_RIPGREP_PATH
  // and INDUSTRY_NPM_MODULES_DIR before falling through to extraction.
  const overridePath = resolveNpmDep(NpmDepKind.Ripgrep);
  if (overridePath) {
    return overridePath;
  }

  const binDir = path.join(getIndustryHome(), getIndustryDirName(), 'bin');
  const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const targetPath = path.join(binDir, rgName);

  // In dev mode, use symlink to system rg if target doesn't exist
  if (process.env.INDUSTRY_ENV !== 'production') {
    if (!fs.existsSync(targetPath)) {
      tryCreateDevSymlink(binDir, targetPath);
    }
    if (fs.existsSync(targetPath)) {
      return targetPath;
    }
  }

  // Production: extract embedded binary, gated on a CLI_VERSION stamp so we
  // only re-extract after a drool upgrade. This avoids hashing the multi-MB
  // embedded blob on every CLI startup.
  const versionPath = path.join(binDir, VERSION_FILE_NAME);
  const cliVersion = getCliVersionStamp();

  let needsExtraction = !fs.existsSync(targetPath);

  if (!needsExtraction) {
    if (fs.existsSync(versionPath)) {
      const existingVersion = fs.readFileSync(versionPath, 'utf8').trim();
      needsExtraction = existingVersion !== cliVersion;
      if (needsExtraction) {
        logInfo('Ripgrep binary version stamp mismatch, updating', {
          currentVersion: existingVersion,
          version: cliVersion,
        });
      }
    } else {
      // Stamp file doesn't exist (older install or manual deletion); rewrite.
      needsExtraction = true;
    }
  }

  if (needsExtraction) {
    // Write to a temp file in the same directory, then atomically rename into
    // place. This avoids ETXTBSY on Linux when a sibling CLI process is still
    // executing the on-disk binary (`writeFileSync` into a busy executable
    // fails; `renameSync` swaps the inode while the kernel keeps the previous
    // file alive for any running process). Empirically this accounts for the
    // majority of "Failed to extract ripgrep binary" events in production.
    const tmpPath = `${targetPath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(tmpPath, fs.readFileSync(getEmbeddedRgPath()), {
        mode: 0o755,
      });
      fs.renameSync(tmpPath, targetPath);
      fs.writeFileSync(versionPath, cliVersion);
      logInfo('Extracted ripgrep binary', {
        path: targetPath,
        version: cliVersion,
      });
    } catch (error) {
      // Best-effort cleanup of the temp file; ignore if it was never created
      // or was already renamed.
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // noop
      }
      logWarn('Failed to extract ripgrep binary', {
        cause: error,
        path: targetPath,
      });
      throw error;
    }
  }

  return targetPath;
}
