import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import {
  InstalledNpmMetadata,
  NpmMarketplacePluginSource,
} from '@industry/common/settings';
import { logException, logInfo, logWarn } from '@industry/logging';
import { getProcessEnvironment } from '@industry/utils/environment';

import {
  buildNpmInstallSpec,
  readResolvedNpmMetadata,
  resolvePackageRoot,
  sanitizeRegistryForLogging,
  sanitizeVersionForPath,
} from './npmPluginInstaller.internals.ts';
import { copyToCache } from './pluginCopy';

const execFileAsync = promisify(execFile);

const NPM_TIMEOUT_MS = 60_000;
const SCRATCH_DIR_NAME = '_npm';
const SCRATCH_USER_NPMRC = '.npmrc';
const SCRATCH_GLOBAL_NPMRC = '.npmrc-global';
const NPM_HOST_PACKAGE_JSON = JSON.stringify({
  name: 'industry-plugin-host',
  private: true,
});

interface NpmInstallSuccess {
  success: true;
  installPath: string;
  metadata: InstalledNpmMetadata;
}

interface NpmInstallFailure {
  success: false;
  error: string;
}

type NpmInstallResult = NpmInstallSuccess | NpmInstallFailure;

async function directoryExists(dirPath: string): Promise<boolean> {
  return fs.promises
    .stat(dirPath)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
}

/**
 * Install an npm-source plugin under `cacheBaseDir` by running `npm install`
 * into a per-plugin scratch directory, copying the resolved package root to
 * a version-keyed subdirectory (`npm-<resolved-version>`), and returning the
 * resolved npm metadata so the caller can persist it alongside the registry
 * entry.
 *
 * Hardening choices (chosen for marketplace-supplied package specs):
 *   - `--ignore-scripts` so postinstall lifecycle scripts don't auto-execute
 *     code from arbitrary third-party packages.
 *   - `--no-save`/`--no-audit`/`--no-fund` because the install is throwaway.
 *   - A scratch-scoped `.npmrc` carrying the optional `registry` value;
 *     `--registry` is intentionally not passed on argv so the registry URL
 *     doesn't appear in process listings or shell history. The scratch
 *     `.npmrc` is the only place that value lives during install, and the
 *     whole scratch dir is removed in `finally`.
 *
 * Bundled-runtime limitation: only the resolved package root is copied into
 * the plugin cache. `--ignore-scripts` blocks `prepare`/`postinstall`, and
 * the package's `node_modules` are deliberately discarded with the scratch
 * dir, so npm plugins MUST ship a runnable artifact (bundled deps,
 * pre-built outputs) in the published tarball; pure-source packages that
 * rely on an `npm install` step to be runnable will not work via this
 * source. This mirrors what Claude Code does for its npm plugin source.
 */
export async function installNpmPluginSource(
  source: NpmMarketplacePluginSource,
  pluginName: string,
  cacheBaseDir: string
): Promise<NpmInstallResult> {
  const scratchDir = path.join(cacheBaseDir, SCRATCH_DIR_NAME);
  const safeRegistry = source.registry
    ? sanitizeRegistryForLogging(source.registry)
    : undefined;

  if (source.authTokenEnvVar && !source.registry) {
    logWarn(
      'authTokenEnvVar has no effect without a registry and will be ignored',
      { envVar: source.authTokenEnvVar, name: pluginName }
    );
  }

  if (source.authTokenEnvVar && source.registry) {
    const token = getProcessEnvironment()[source.authTokenEnvVar];
    if (!token) {
      logWarn(
        'authTokenEnvVar is configured but the environment variable is not set',
        {
          envVar: source.authTokenEnvVar,
          name: pluginName,
        }
      );
      return {
        success: false,
        error: `Private registry requires authentication but environment variable "${source.authTokenEnvVar}" is not set. Export it in your shell profile and restart Drool.`,
      };
    }
  }

  try {
    await fs.promises.mkdir(cacheBaseDir, { recursive: true });
    await fs.promises.rm(scratchDir, { recursive: true, force: true });
    await fs.promises.mkdir(scratchDir, { recursive: true });

    await fs.promises.writeFile(
      path.join(scratchDir, 'package.json'),
      NPM_HOST_PACKAGE_JSON
    );

    // Always create both scratch npmrc files so npm_config_userconfig and
    // npm_config_globalconfig point at distinct, real paths. npm 9+ refuses
    // to load the same npmrc as both "user" and "global", and an unset
    // globalconfig would otherwise fall back to system-wide npm config.
    let npmrcContent = source.registry ? `registry=${source.registry}\n` : '';

    if (source.authTokenEnvVar && source.registry) {
      const token = getProcessEnvironment()[source.authTokenEnvVar] ?? '';
      const sanitizedToken = token.replace(/[\r\n]/g, '');
      const parsed = new URL(source.registry);
      const registryScope = parsed.host + parsed.pathname.replace(/\/$/, '');
      npmrcContent += `//${registryScope}/:_authToken=${sanitizedToken}\n`;
    }

    await fs.promises.writeFile(
      path.join(scratchDir, SCRATCH_USER_NPMRC),
      npmrcContent
    );
    await fs.promises.writeFile(
      path.join(scratchDir, SCRATCH_GLOBAL_NPMRC),
      ''
    );

    const spec = buildNpmInstallSpec(source);
    const args = [
      'install',
      spec,
      '--no-audit',
      '--no-fund',
      '--no-save',
      '--ignore-scripts',
      '--loglevel',
      'error',
    ];

    logInfo('Installing npm plugin source', {
      dep: source.package,
      version: source.version ?? 'latest',
      url: safeRegistry,
      name: pluginName,
    });

    try {
      await execFileAsync('npm', args, {
        cwd: scratchDir,
        env: {
          ...getProcessEnvironment(),
          // Confine the install to the scratch dir so the user's global
          // `~/.npmrc` (and any home-scoped config) is not consulted or
          // mutated for this throwaway install.
          npm_config_userconfig: path.join(scratchDir, SCRATCH_USER_NPMRC),
          npm_config_globalconfig: path.join(scratchDir, SCRATCH_GLOBAL_NPMRC),
          npm_config_prefix: scratchDir,
        },
        timeout: NPM_TIMEOUT_MS,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const exitCode =
        (
          err as
            | (NodeJS.ErrnoException & { code?: string | number })
            | undefined
        )?.code ?? null;
      if (code === 'ENOENT') {
        logException(
          new Error('npm executable not found'),
          'npm executable not found on PATH',
          {
            name: pluginName,
          }
        );
        return {
          success: false,
          error:
            'Could not install plugin: npm is not installed or not on PATH.',
        };
      }
      // Log a synthetic Error so the raw npm command stdout/stderr (which
      // can echo the package spec and tarball URLs) is not captured by the
      // logger. The structured fields below are enough for triage.
      logException(
        new Error('npm install failed'),
        'npm install failed for plugin source',
        {
          dep: source.package,
          version: source.version ?? 'latest',
          url: safeRegistry,
          name: pluginName,
          exitCode: typeof exitCode === 'number' ? exitCode : null,
        }
      );
      return {
        success: false,
        error: 'Could not install plugin from npm. Please check the source.',
      };
    }

    const pluginRoot = resolvePackageRoot(scratchDir, source.package);
    try {
      const stat = await fs.promises.stat(pluginRoot);
      if (!stat.isDirectory()) {
        return {
          success: false,
          error: `npm install completed but package directory was not found for "${source.package}".`,
        };
      }
    } catch (err) {
      logException(err, 'Installed npm package directory missing', {
        dep: source.package,
        path: pluginRoot,
      });
      return {
        success: false,
        error: `npm install completed but package directory was not found for "${source.package}".`,
      };
    }

    const resolved = await readResolvedNpmMetadata(
      scratchDir,
      source.package,
      pluginRoot
    );
    if (!resolved) {
      return {
        success: false,
        error: `Could not read resolved version for "${source.package}".`,
      };
    }

    const installPath = path.join(
      cacheBaseDir,
      `npm-${sanitizeVersionForPath(resolved.version)}`
    );

    // The install path is keyed by the resolved version, so installing the
    // same plugin@version at another settings scope targets the same
    // directory. Copy into a unique staging dir first and only move it into
    // place once the copy succeeds, so a failed reinstall can never delete a
    // cache that another scope still references. If a complete install is
    // already present (another scope, or a prior install), reuse it rather
    // than recreating it.
    const stagingPath = path.join(
      cacheBaseDir,
      `.staging-npm-${sanitizeVersionForPath(resolved.version)}-${process.pid}-${Date.now()}`
    );
    try {
      await copyToCache(pluginRoot, stagingPath);
      // Only move the freshly staged copy into place when nothing is there
      // yet. If a complete install already exists (another scope, or a prior
      // install of this same version), reuse it rather than recreating it.
      if (!(await directoryExists(installPath))) {
        await fs.promises.rename(stagingPath, installPath);
      }
    } catch (err) {
      logException(err, 'Failed to copy npm plugin to cache', {
        name: pluginName,
      });
      return {
        success: false,
        error: 'Could not install plugin. Please try again.',
      };
    } finally {
      await fs.promises
        .rm(stagingPath, { recursive: true, force: true })
        .catch(() => {});
    }

    const metadata: InstalledNpmMetadata = {
      spec: source.version?.trim() ?? 'latest',
      version: resolved.version,
      ...(resolved.resolved ? { resolved: resolved.resolved } : {}),
      ...(resolved.integrity ? { integrity: resolved.integrity } : {}),
    };

    return { success: true, installPath, metadata };
  } finally {
    await fs.promises
      .rm(scratchDir, { recursive: true, force: true })
      .catch(() => {});
  }
}
