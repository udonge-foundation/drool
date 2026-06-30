import * as fs from 'fs';
import * as path from 'path';

import simpleGit from 'simple-git';

import {
  GitSubdirMarketplaceSource,
  InstalledNpmMetadata,
  InstalledPluginEntry,
  MarketplacePluginEntry,
  MarketplaceSourceSchema,
  NpmMarketplacePluginSource,
  NpmMarketplacePluginSourceSchema,
  UrlMarketplaceSource,
} from '@industry/common/settings';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logException, logInfo, logWarn } from '@industry/logging';
import { getProcessEnvironment } from '@industry/utils/environment';

import { buildGitCloneArgs } from './gitCloneOptions';
import { MarketplaceService } from './MarketplaceService';
import { installNpmPluginSource } from './npmPluginInstaller';
import { copyToCache } from './pluginCopy';
import { formatPluginId, parsePluginId } from './pluginId';
import { PluginRegistry } from './PluginRegistry';
import { OnPluginEnabledCallback, PluginInstallResult } from './types';

type ExternalGitMarketplaceSource =
  | UrlMarketplaceSource
  | GitSubdirMarketplaceSource;

function isExternalGitSource(
  source: unknown
): source is ExternalGitMarketplaceSource {
  if (typeof source !== 'object' || source == null) return false;
  const s = source as { source?: string };
  return s.source === 'url' || s.source === 'git-subdir';
}

function isNpmPluginSource(
  source: unknown
): source is NpmMarketplacePluginSource {
  if (typeof source !== 'object' || source == null) return false;
  return (source as { source?: string }).source === 'npm';
}

/**
 * Plugin sources that require fetching from outside the marketplace working
 * copy and therefore can't be resolved via a marketplace-relative path.
 */
function isExternalSource(source: unknown): boolean {
  return isExternalGitSource(source) || isNpmPluginSource(source);
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(dirPath);
    return stats.isDirectory();
  } catch (err) {
    logWarn('Failed to check plugin directory existence', { cause: err });
    return false;
  }
}

function resolvePluginSourcePath(
  marketplaceLocation: string,
  pluginInfo: MarketplacePluginEntry
): string | null {
  if (typeof pluginInfo.source === 'string') {
    // Reject absolute paths to prevent escaping marketplace directory
    if (path.isAbsolute(pluginInfo.source)) {
      logWarn('Absolute plugin source paths are not allowed', {
        name: pluginInfo.name,
      });
      return null;
    }

    const base = path.resolve(marketplaceLocation);
    const resolved = path.resolve(marketplaceLocation, pluginInfo.source);

    // Ensure resolved path stays within marketplace directory
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      logWarn('Plugin source path escapes marketplace directory', {
        name: pluginInfo.name,
      });
      return null;
    }

    return resolved;
  }

  // Handle object-based sources
  if (pluginInfo.source != null && typeof pluginInfo.source === 'object') {
    // External sources (url, git-subdir, npm) require cloning/fetching;
    // they're handled by cloneExternalPluginSource / installNpmPluginSource.
    if (isExternalSource(pluginInfo.source)) {
      return null;
    }

    // Known local source types (github, local) use the marketplace root.
    // Unknown source types return null -- they can't be resolved locally.
    if (MarketplaceSourceSchema.safeParse(pluginInfo.source).success) {
      return marketplaceLocation;
    }

    return null;
  }

  logWarn('External plugin sources not supported', { name: pluginInfo.name });
  return null;
}

const GIT_TIMEOUT_MS = 60000;

function sanitizeUrlForLogging(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch (err) {
    logWarn('Failed to parse plugin URL for sanitization', { cause: err });
    return '<invalid-url>';
  }
}

function sanitizePathComponent(name: string): string {
  return name.replace(/[/\\]/g, '-').replace(/\.\./g, '').replace(/^\.+/, '');
}

export async function getPluginVersion(
  marketplacePath: string
): Promise<string | null> {
  try {
    const git = simpleGit(marketplacePath);
    const result = await git.revparse(['HEAD']);
    return result.trim().substring(0, 12);
  } catch (err) {
    logWarn('Failed to get plugin version from git', { cause: err });
    return null;
  }
}

type PluginInstallOptions = {
  updateEnabledPlugins?: boolean;
};

async function cloneExternalPluginSource(
  source: ExternalGitMarketplaceSource,
  pluginName: string,
  destPath: string
): Promise<{ success: boolean; error?: string }> {
  const { url } = source;
  const safeUrl = sanitizeUrlForLogging(url);

  const cloneDir = path.join(destPath, '_clone');

  try {
    await fs.promises.mkdir(destPath, { recursive: true });
    await fs.promises.rm(cloneDir, { recursive: true, force: true });

    const sshCommand = [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
    ].join(' ');

    const git = simpleGit({ timeout: { block: GIT_TIMEOUT_MS } });
    git.env({
      ...getProcessEnvironment(),
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_SSH_COMMAND: sshCommand,
      SSH_ASKPASS: '',
      GIT_ASKPASS: '',
    });

    logInfo('Cloning external plugin source', {
      url: safeUrl,
      name: pluginName,
    });
    await git.clone(url, cloneDir, buildGitCloneArgs(source));

    // A blobless clone leaves the working tree unchecked; check out the pinned
    // commit so its blobs are fetched on demand.
    if (source.sha) {
      const repoGit = simpleGit({
        baseDir: cloneDir,
        timeout: { block: GIT_TIMEOUT_MS },
      });
      repoGit.env({
        ...getProcessEnvironment(),
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_SSH_COMMAND: sshCommand,
        SSH_ASKPASS: '',
        GIT_ASKPASS: '',
      });
      await repoGit.checkout(source.sha);
    }

    // If the source specifies a subdirectory path, navigate into it
    let pluginRoot = cloneDir;
    if (source.source === 'git-subdir') {
      pluginRoot = path.join(cloneDir, source.path);
      if (!(await directoryExists(pluginRoot))) {
        return {
          success: false,
          error: `Subdirectory "${source.path}" not found in cloned repo`,
        };
      }
    }

    // Copy plugin contents from clone to the actual dest
    await copyToCache(pluginRoot, destPath);

    return { success: true };
  } catch (err) {
    logException(err, 'Failed to clone external plugin source', {
      url: safeUrl,
      name: pluginName,
    });
    return {
      success: false,
      error: 'Could not download plugin. Please check the source.',
    };
  } finally {
    await fs.promises
      .rm(cloneDir, { recursive: true, force: true })
      .catch(() => {});
  }
}

export class PluginInstaller {
  private userRegistry: PluginRegistry;

  private projectRegistry: PluginRegistry | null;

  private marketplaceService: MarketplaceService;

  private onPluginEnabled?: OnPluginEnabledCallback;

  constructor(
    userRegistry: PluginRegistry,
    projectRegistry: PluginRegistry | null,
    marketplaceService: MarketplaceService,
    onPluginEnabled?: OnPluginEnabledCallback
  ) {
    this.userRegistry = userRegistry;
    this.projectRegistry = projectRegistry;
    this.marketplaceService = marketplaceService;
    this.onPluginEnabled = onPluginEnabled;
  }

  async install(
    marketplaceName: string,
    pluginName: string,
    scope: SettingsLevel,
    options: PluginInstallOptions = {}
  ): Promise<PluginInstallResult> {
    // Always use user registry for cache and installed_plugins.json
    // Project scope only affects which settings.json gets enabledPlugins
    const registry = this.userRegistry;
    const pluginId = formatPluginId(pluginName, marketplaceName);

    const existingEntry = await registry.getInstalledPlugin(pluginId);
    if (existingEntry) {
      return {
        success: false,
        error: `Plugin "${pluginId}" is already installed at ${existingEntry.scope} scope. Uninstall it first to change scope.`,
      };
    }

    const pluginInfo = await this.marketplaceService.getPluginInfo(
      marketplaceName,
      pluginName
    );

    if (!pluginInfo) {
      return {
        success: false,
        error: `Plugin "${pluginName}" not found in marketplace "${marketplaceName}"`,
      };
    }

    const marketplace = await this.userRegistry.getMarketplace(marketplaceName);
    if (!marketplace) {
      return {
        success: false,
        error: `Marketplace "${marketplaceName}" not found. Run /marketplace add first.`,
      };
    }

    const version =
      (await getPluginVersion(marketplace.installLocation)) ??
      Date.now().toString(36);
    const safeMarketplaceName = sanitizePathComponent(marketplaceName);
    const safePluginName = sanitizePathComponent(pluginName);
    const cacheBaseDir = path.join(
      registry.getPluginsCachePath(),
      safeMarketplaceName,
      safePluginName
    );
    const cachePath = path.join(cacheBaseDir, version);

    // Populated by the npm-source branch so the registry entry's installPath
    // and version reflect the resolved package, not the wrapper marketplace
    // revision. The marketplace-rev `cachePath` above is still used for
    // git/local sources where it is the right cache identity.
    let npmOverride: {
      installPath: string;
      metadata: InstalledNpmMetadata;
    } | null = null;

    const isObjectSource =
      typeof pluginInfo.source === 'object' && pluginInfo.source != null;

    const isKnownObjectSource =
      isObjectSource &&
      (MarketplaceSourceSchema.safeParse(pluginInfo.source).success ||
        NpmMarketplacePluginSourceSchema.safeParse(pluginInfo.source).success);

    if (isObjectSource && !isKnownObjectSource) {
      const sourceType = (pluginInfo.source as { source: string }).source;
      logWarn('Cannot install plugin with unsupported source type', {
        name: pluginName,
        sourceType,
      });
      return {
        success: false,
        error: `Unsupported plugin source type "${sourceType}". Try updating Drool to the latest version.`,
      };
    }

    if (isObjectSource && isNpmPluginSource(pluginInfo.source)) {
      const result = await installNpmPluginSource(
        pluginInfo.source,
        pluginName,
        cacheBaseDir
      );
      if (!result.success) {
        return {
          success: false,
          error: result.error ?? 'Could not install plugin.',
        };
      }
      npmOverride = {
        installPath: result.installPath,
        metadata: result.metadata,
      };
    } else if (isObjectSource && isExternalGitSource(pluginInfo.source)) {
      const result = await cloneExternalPluginSource(
        pluginInfo.source,
        pluginName,
        cachePath
      );
      if (!result.success) {
        return {
          success: false,
          error: result.error ?? 'Could not install plugin.',
        };
      }
    } else {
      const pluginSourcePath = resolvePluginSourcePath(
        marketplace.installLocation,
        pluginInfo
      );

      if (!pluginSourcePath) {
        return {
          success: false,
          error: 'Could not locate plugin in marketplace.',
        };
      }

      try {
        const exists = await directoryExists(pluginSourcePath);
        if (!exists) {
          return {
            success: false,
            error: 'Plugin files not found in marketplace.',
          };
        }
      } catch (err) {
        logException(err, 'Failed to check plugin source', {
          path: pluginSourcePath,
        });
        return {
          success: false,
          error: 'Could not access plugin files.',
        };
      }

      try {
        await copyToCache(pluginSourcePath, cachePath);
      } catch (err) {
        logException(err, 'Failed to copy plugin to cache', {
          name: pluginName,
        });
        return {
          success: false,
          error: 'Could not install plugin. Please try again.',
        };
      }
    }

    const now = new Date().toISOString();
    const entry: InstalledPluginEntry = {
      scope,
      installPath: npmOverride?.installPath ?? cachePath,
      version: npmOverride?.metadata.version ?? version,
      installedAt: now,
      lastUpdated: now,
      source: marketplaceName,
      ...(npmOverride ? { npm: npmOverride.metadata } : {}),
    };

    // Update enabledPlugins in the appropriate settings.json (user or project)
    // This must happen before addInstalledPlugin to avoid partial state on disk
    // if the settings update throws (e.g., no project path when cwd is ~).
    if (options.updateEnabledPlugins !== false) {
      await this.updateEnabledPlugins(pluginId, true, scope);
    }

    // Register in user-level installed_plugins.json with scope field
    await registry.addInstalledPlugin(pluginId, entry);

    return {
      success: true,
      pluginId,
      entry,
    };
  }

  async uninstall(
    pluginId: string,
    scope: SettingsLevel,
    options: PluginInstallOptions = {}
  ): Promise<boolean> {
    // Always use user registry since all caches are at user level
    const registry = this.userRegistry;

    const entry = await registry.getInstalledPlugin(pluginId, scope);
    if (!entry) {
      return false;
    }

    // Verify installPath is under cache directory before deletion
    const cacheRoot = path.resolve(registry.getPluginsCachePath());
    const installPath = path.resolve(entry.installPath);

    // Path must be under cacheRoot (must start with cacheRoot + separator)
    const isUnderCache = installPath.startsWith(cacheRoot + path.sep);

    if (!isUnderCache) {
      logWarn('Refusing to delete path outside cache directory', {
        path: installPath,
      });
      return false;
    }

    const installed = await registry.loadInstalledPlugins();
    const sharedInstallPath = (installed.plugins[pluginId] ?? []).some(
      (candidate) =>
        candidate.scope !== scope &&
        path.resolve(candidate.installPath) === installPath
    );

    if (!sharedInstallPath) {
      try {
        await fs.promises.rm(installPath, {
          recursive: true,
          force: true,
        });
      } catch (err) {
        logException(err, 'Failed to delete plugin cache', {
          path: installPath,
        });
      }
    }

    // Remove from installed_plugins.json
    const removed = await registry.removeInstalledPlugin(pluginId, scope);

    // Remove from enabledPlugins in the appropriate settings.json
    if (options.updateEnabledPlugins !== false) {
      await this.updateEnabledPlugins(pluginId, false, scope);
    }

    return removed;
  }

  async update(
    pluginId: string,
    scope?: SettingsLevel
  ): Promise<PluginInstallResult> {
    // All plugins are in user-level registry (scope is stored in the entry)
    const entry = await this.userRegistry.getInstalledPlugin(pluginId, scope);

    if (!entry) {
      return {
        success: false,
        error: `Plugin "${pluginId}" is not installed${scope ? ` in ${scope} scope` : ''}`,
      };
    }

    const entryScope = entry.scope;

    const parsed = parsePluginId(pluginId);
    if (!parsed) {
      return {
        success: false,
        error: `Invalid plugin ID format: ${pluginId}`,
      };
    }
    const { pluginName, marketplace: marketplaceName } = parsed;

    const updateResults =
      await this.marketplaceService.updateMarketplace(marketplaceName);
    if (updateResults.length > 0 && !updateResults[0].success) {
      return {
        success: false,
        error: updateResults[0].error ?? 'Failed to update marketplace',
      };
    }

    await this.uninstall(pluginId, entryScope, {
      updateEnabledPlugins: false,
    });
    return this.install(marketplaceName, pluginName, entryScope, {
      updateEnabledPlugins: false,
    });
  }

  private async updateEnabledPlugins(
    pluginId: string,
    enabled: boolean,
    scope: SettingsLevel
  ): Promise<void> {
    if (this.onPluginEnabled) {
      await this.onPluginEnabled(pluginId, enabled, scope);
    }
  }
}
