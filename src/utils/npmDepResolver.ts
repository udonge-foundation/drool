/**
 * Shared resolver for packaged CLI dependencies that may be pre-installed
 * in a user-provided node_modules directory.
 *
 * Resolution order for each dependency:
 *   1. Per-dep env var override (e.g. INDUSTRY_RIPGREP_PATH).
 *   2. INDUSTRY_NPM_MODULES_DIR canonical sub-path.
 *   3. Caller falls through to the existing embedded-extraction path.
 */

import * as fs from 'fs';
import path from 'path';

import { EnvironmentVariable, resolveEnv } from '@industry/environment';
import { logInfo, logWarn } from '@industry/logging';

import { NpmDepKind } from '@/utils/enums';

import type { EnvironmentVariableName } from '@industry/environment';

interface DepSpec {
  overrideEnvVar: EnvironmentVariableName;
  /** Sub-path relative to node_modules root that contains the binary/module. */
  subPath: string;
  /** Additional sub-paths to try when the primary sub-path is absent. */
  fallbackSubPaths?: string[];
  /** Whether the resolved file must be executable (POSIX only). */
  requireExecutable: boolean;
}

function getPlatformBinarySuffix(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'win32') return `-win32-${arch}.exe`;
  return `-${platform}-${arch}`;
}

const DEP_SPECS: Record<NpmDepKind, DepSpec> = {
  [NpmDepKind.Ripgrep]: {
    overrideEnvVar: EnvironmentVariable.INDUSTRY_RIPGREP_PATH,
    subPath:
      process.platform === 'win32'
        ? '@vscode/ripgrep/bin/rg.exe'
        : '@vscode/ripgrep/bin/rg',
    requireExecutable: true,
  },
  [NpmDepKind.AgentBrowser]: {
    overrideEnvVar: EnvironmentVariable.INDUSTRY_AGENT_BROWSER_PATH,
    subPath: `agent-browser/bin/agent-browser${getPlatformBinarySuffix()}`,
    // Windows ARM64 can run x64 binaries via emulation. Mirror the fallback in
    // scripts/prepare-agent-browser.ts so the resolver accepts the x64 binary
    // when the native arm64 binary is absent.
    ...(process.platform === 'win32' && process.arch === 'arm64'
      ? { fallbackSubPaths: ['agent-browser/bin/agent-browser-win32-x64.exe'] }
      : {}),
    requireExecutable: process.platform !== 'win32',
  },
  [NpmDepKind.Keytar]: {
    overrideEnvVar: EnvironmentVariable.INDUSTRY_KEYTAR_PATH,
    subPath: 'keytar/build/Release/keytar.node',
    requireExecutable: false,
  },
};

/**
 * Validates an absolute file path: must exist, be a regular file, and
 * (optionally) be executable by the current user on POSIX.
 */
function validateFilePath(
  filePath: string,
  label: string,
  requireExecutable: boolean
): boolean {
  if (!path.isAbsolute(filePath)) {
    logWarn('[npm-dep-resolver] Override must be an absolute path; ignoring', {
      envVar: label,
      path: filePath,
    });
    return false;
  }

  if (!fs.existsSync(filePath)) {
    logWarn(
      '[npm-dep-resolver] Override points to a non-existent file; ignoring',
      {
        envVar: label,
        path: filePath,
      }
    );
    return false;
  }

  try {
    if (!fs.statSync(filePath).isFile()) {
      logWarn(
        '[npm-dep-resolver] Override does not point to a regular file; ignoring',
        {
          envVar: label,
          path: filePath,
        }
      );
      return false;
    }
  } catch (error) {
    logWarn('[npm-dep-resolver] Override could not be stat-ed; ignoring', {
      envVar: label,
      path: filePath,
      cause: error,
    });
    return false;
  }

  if (requireExecutable && process.platform !== 'win32') {
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
    } catch (error) {
      logWarn(
        '[npm-dep-resolver] Override is not executable by the current user; ignoring',
        {
          envVar: label,
          path: filePath,
          cause: error,
        }
      );
      return false;
    }
  }

  return true;
}

let cachedNpmModulesDir: string | null | undefined;

/**
 * Returns the validated INDUSTRY_NPM_MODULES_DIR path, or null if unset/invalid.
 * Cached after the first call.
 */
function getNpmModulesDir(): string | null {
  if (cachedNpmModulesDir !== undefined) return cachedNpmModulesDir;

  const raw = resolveEnv({
    name: EnvironmentVariable.INDUSTRY_NPM_MODULES_DIR,
  })?.trim();

  if (!raw) {
    cachedNpmModulesDir = null;
    return null;
  }

  if (!path.isAbsolute(raw)) {
    logWarn(
      '[npm-dep-resolver] INDUSTRY_NPM_MODULES_DIR must be an absolute path; ignoring',
      {
        path: raw,
      }
    );
    cachedNpmModulesDir = null;
    return null;
  }

  try {
    if (!fs.existsSync(raw) || !fs.statSync(raw).isDirectory()) {
      logWarn(
        '[npm-dep-resolver] INDUSTRY_NPM_MODULES_DIR does not point to an existing directory; ignoring',
        { path: raw }
      );
      cachedNpmModulesDir = null;
      return null;
    }
  } catch (error) {
    logWarn(
      '[npm-dep-resolver] INDUSTRY_NPM_MODULES_DIR could not be stat-ed; ignoring',
      { path: raw, cause: error }
    );
    cachedNpmModulesDir = null;
    return null;
  }

  cachedNpmModulesDir = raw;
  return raw;
}

/**
 * Try to resolve a per-dep override env var. The override value may be either:
 *   - An absolute path to the exact file (binary / .node module).
 *   - An absolute path to the npm package root directory, in which case the
 *     canonical sub-path is appended.
 */
function resolvePerDepOverride(kind: NpmDepKind): string | undefined {
  const spec = DEP_SPECS[kind];
  const raw = resolveEnv({ name: spec.overrideEnvVar })?.trim();
  if (!raw) return undefined;

  if (!path.isAbsolute(raw)) {
    logWarn(
      '[npm-dep-resolver] Per-dep override must be an absolute path; ignoring',
      {
        envVar: spec.overrideEnvVar,
        dep: kind,
        path: raw,
      }
    );
    return undefined;
  }

  // If the path points directly to a valid file, use it.
  let rawStat: ReturnType<typeof fs.statSync> | undefined;
  try {
    if (fs.existsSync(raw)) {
      rawStat = fs.statSync(raw);
    }
  } catch (error) {
    logWarn(
      '[npm-dep-resolver] Per-dep override could not be stat-ed; ignoring',
      { envVar: spec.overrideEnvVar, dep: kind, path: raw, cause: error }
    );
    return undefined;
  }

  if (
    rawStat?.isFile() &&
    validateFilePath(raw, spec.overrideEnvVar, spec.requireExecutable)
  ) {
    logInfo('[npm-dep-resolver] Using dep from per-dep override', {
      dep: kind,
      envVar: spec.overrideEnvVar,
      path: raw,
    });
    return raw;
  }

  // If it points to a directory (package root), append the canonical sub-path's
  // filename portion. E.g. for agent-browser, spec.subPath is
  // "agent-browser/bin/agent-browser-darwin-arm64", so we strip the leading
  // package name segment and join the rest under the user-provided directory.
  if (rawStat?.isDirectory()) {
    const subPaths = [spec.subPath, ...(spec.fallbackSubPaths ?? [])];
    for (const sp of subPaths) {
      const segments = sp.split('/');
      // Remove the first segment (package name or @scope/name) to get the
      // relative path within the package.
      const pkgName = sp.startsWith('@')
        ? segments.slice(0, 2).join('/')
        : segments[0];
      const innerPath = sp.slice(pkgName.length + 1);
      const candidate = path.join(raw, innerPath);

      if (
        validateFilePath(candidate, spec.overrideEnvVar, spec.requireExecutable)
      ) {
        if (sp !== spec.subPath) {
          logInfo(
            '[npm-dep-resolver] Using fallback sub-path for per-dep override (package root)',
            {
              dep: kind,
              reason: `fallback from ${spec.subPath} to ${sp}`,
              path: candidate,
            }
          );
        } else {
          logInfo(
            '[npm-dep-resolver] Using dep from per-dep override (package root)',
            { dep: kind, envVar: spec.overrideEnvVar, path: candidate }
          );
        }
        return candidate;
      }
    }
  }

  logWarn(
    '[npm-dep-resolver] Per-dep override does not resolve to a valid file; ignoring',
    {
      envVar: spec.overrideEnvVar,
      dep: kind,
      path: raw,
    }
  );
  return undefined;
}

/**
 * Try to resolve a dependency from INDUSTRY_NPM_MODULES_DIR.
 */
function resolveFromNpmModulesDir(kind: NpmDepKind): string | undefined {
  const dir = getNpmModulesDir();
  if (!dir) return undefined;

  const spec = DEP_SPECS[kind];
  const subPaths = [spec.subPath, ...(spec.fallbackSubPaths ?? [])];

  for (const sp of subPaths) {
    const candidate = path.join(dir, sp);

    if (
      validateFilePath(
        candidate,
        'INDUSTRY_NPM_MODULES_DIR',
        spec.requireExecutable
      )
    ) {
      if (sp !== spec.subPath) {
        logInfo(
          '[npm-dep-resolver] Using fallback sub-path from INDUSTRY_NPM_MODULES_DIR',
          {
            dep: kind,
            reason: `fallback from ${spec.subPath} to ${sp}`,
            path: candidate,
          }
        );
      } else {
        logInfo('[npm-dep-resolver] Using dep from INDUSTRY_NPM_MODULES_DIR', {
          dep: kind,
          path: candidate,
        });
      }
      return candidate;
    }
  }

  return undefined;
}

/**
 * Attempt to resolve a packaged dependency from user-provided override paths.
 *
 * Returns the absolute path to the binary/module if found via override or
 * npm modules dir, or undefined if the caller should fall through to the
 * embedded-extraction path.
 */
export function resolveNpmDep(kind: NpmDepKind): string | undefined {
  // 1. Per-dep override wins.
  const override = resolvePerDepOverride(kind);
  if (override) return override;

  // 2. INDUSTRY_NPM_MODULES_DIR canonical sub-path.
  const fromDir = resolveFromNpmModulesDir(kind);
  if (fromDir) return fromDir;

  // 3. Caller falls through to embedded extraction.
  return undefined;
}

/** Reset cached state. Exported for unit tests only. */
export function _resetNpmDepResolverCache(): void {
  cachedNpmModulesDir = undefined;
}
