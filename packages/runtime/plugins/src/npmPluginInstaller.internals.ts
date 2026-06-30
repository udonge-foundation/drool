import * as fs from 'fs';
import * as path from 'path';

import { NpmMarketplacePluginSource } from '@industry/common/settings';
import { logWarn } from '@industry/logging';

/**
 * Strip everything that can carry a credential or per-request secret from a
 * registry URL before it is logged: userinfo, query string, and fragment.
 * Schema-level validation already forbids these for `registry` fields in
 * marketplace JSON, but the installer is also called directly from tests
 * and may be called from future entry points, so we treat this as
 * defense-in-depth.
 */
export function sanitizeRegistryForLogging(registry: string): string {
  try {
    const parsed = new URL(registry);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (err) {
    logWarn('Failed to parse npm registry URL for sanitization', {
      cause: err,
    });
    return '<invalid-registry>';
  }
}

export function buildNpmInstallSpec(
  source: NpmMarketplacePluginSource
): string {
  const version = source.version?.trim() ?? 'latest';
  return `${source.package}@${version}`;
}

/**
 * Resolve the on-disk root for the installed package inside the scratch
 * directory's `node_modules`. Scoped packages live under a nested directory
 * (`node_modules/@scope/name`), so split on the first `/` only.
 */
export function resolvePackageRoot(scratchDir: string, pkg: string): string {
  if (pkg.startsWith('@')) {
    const slash = pkg.indexOf('/');
    if (slash > 0) {
      return path.join(
        scratchDir,
        'node_modules',
        pkg.slice(0, slash),
        pkg.slice(slash + 1)
      );
    }
  }
  return path.join(scratchDir, 'node_modules', pkg);
}

interface ResolvedNpmPackageMetadata {
  version: string;
  resolved?: string;
  integrity?: string;
}

/**
 * Read npm's resolved metadata for the installed package. Version is read
 * from the package's own `package.json` (always present after a successful
 * install). `resolved` and `integrity` come from npm's hidden lockfile at
 * `node_modules/.package-lock.json`, which npm writes during install even
 * with `--no-save`. The lockfile is best-effort: an older npm or a
 * corrupted write yields `undefined` for those fields.
 */
export async function readResolvedNpmMetadata(
  scratchDir: string,
  pkg: string,
  pluginRoot: string
): Promise<ResolvedNpmPackageMetadata | null> {
  let version: string | undefined;
  try {
    const pkgJson = JSON.parse(
      await fs.promises.readFile(path.join(pluginRoot, 'package.json'), 'utf-8')
    ) as { version?: unknown };
    if (typeof pkgJson.version === 'string' && pkgJson.version.length > 0) {
      version = pkgJson.version;
    }
  } catch (err) {
    logWarn('Failed to read installed package.json for npm metadata', {
      cause: err,
    });
    return null;
  }
  if (!version) return null;

  let resolved: string | undefined;
  let integrity: string | undefined;
  try {
    const lockfile = JSON.parse(
      await fs.promises.readFile(
        path.join(scratchDir, 'node_modules', '.package-lock.json'),
        'utf-8'
      )
    ) as {
      packages?: Record<
        string,
        { resolved?: unknown; integrity?: unknown } | undefined
      >;
    };
    const entry = lockfile.packages?.[`node_modules/${pkg}`];
    if (entry) {
      if (typeof entry.resolved === 'string') resolved = entry.resolved;
      if (typeof entry.integrity === 'string') integrity = entry.integrity;
    }
  } catch (err) {
    logWarn('Failed to read npm lockfile metadata for plugin', { cause: err });
  }

  return { version, resolved, integrity };
}

/**
 * Replace characters that are unsafe inside a single path segment so a
 * resolved npm version (which may contain `+build` or pre-release dots) can
 * be used as a cache directory name on every platform.
 */
export function sanitizeVersionForPath(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]+/g, '_');
}
