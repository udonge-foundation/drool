/**
 * Sandbox path resolution utilities that require Node.js modules (os, path).
 *
 * Separated from sandbox.ts to avoid pulling Node.js imports into browser
 * bundles (Vite) via the barrel index.
 */
import { realpathSync } from 'fs';
import { resolve, dirname, basename } from 'path';

import { logWarn } from '@industry/logging';

import { expandTilde } from '../shell/paths';

import type { SandboxFilesystemSettings } from '@industry/common/settings';

// =============================================================================
// Path Prefix Resolution
// =============================================================================

/**
 * Resolve a sandbox path using standard Unix conventions:
 *   /   → absolute path (kept as-is)
 *   ~/  → home-relative
 *   ./  or bare → CWD-relative
 *
 * After prefix expansion, symlinks are resolved so that config paths
 * match runtime-resolved file paths (e.g. /tmp → /private/tmp on macOS).
 */
export function resolveSandboxPath(opts: {
  rawPath: string;
  cwd?: string;
}): string {
  const effectiveCwd = opts.cwd ?? process.cwd();

  // expandTilde is a no-op for inputs that don't start with `~` (or `~\`
  // on Windows), and `resolve(cwd, abs)` returns `abs` unchanged when the
  // expanded value is already absolute. So a single composition handles
  // all three cases (`/abs`, `~/...`, and CWD-relative) without explicit
  // prefix branching.
  const absolute = resolve(effectiveCwd, expandTilde(opts.rawPath));

  // Resolve symlinks so config paths match runtime-resolved paths
  try {
    return realpathSync(absolute);
  } catch (err) {
    logWarn('Failed to resolve symlink for sandbox path', { cause: err });
    try {
      return resolve(realpathSync(dirname(absolute)), basename(absolute));
    } catch (parentErr) {
      logWarn('Failed to resolve parent directory for sandbox path', {
        cause: parentErr,
      });
      return absolute;
    }
  }
}

/**
 * Check if a file path matches a deny/allow entry (exact match or subtree).
 * Both paths should already be resolved via resolveSandboxPath.
 */
export function isPathUnderEntry(
  filePath: string,
  resolvedEntry: string
): boolean {
  return filePath === resolvedEntry || filePath.startsWith(`${resolvedEntry}/`);
}

/**
 * Resolve all path arrays in a SandboxFilesystemSettings object.
 */
export function resolveFilesystemPaths(
  filesystem: SandboxFilesystemSettings | undefined,
  cwd?: string
): SandboxFilesystemSettings | undefined {
  if (!filesystem) return undefined;

  const resolvePaths = (paths: string[] | undefined): string[] | undefined => {
    if (!paths) return undefined;
    return paths.map((p) => resolveSandboxPath({ rawPath: p, cwd }));
  };

  return {
    allowWrite: resolvePaths(filesystem.allowWrite),
    allowRead: resolvePaths(filesystem.allowRead),
    denyWrite: resolvePaths(filesystem.denyWrite),
    denyRead: resolvePaths(filesystem.denyRead),
  };
}
