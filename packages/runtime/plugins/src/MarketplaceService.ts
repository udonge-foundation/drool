import * as fs from 'fs';
import * as path from 'path';

import simpleGit, { SimpleGit } from 'simple-git';

import {
  MarketplaceEntry,
  MarketplaceManifest,
  MarketplaceManifestSchema,
  MarketplacePluginEntry,
  MarketplaceSource,
  MarketplaceSourceSchema,
  NpmMarketplacePluginSourceSchema,
} from '@industry/common/settings';
import { logException, logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getProcessEnvironment } from '@industry/utils/environment';
import { expandTilde } from '@industry/utils/shell/node';

import { GitProtocol } from './enums';
import { getGitUrlFromSource } from './getGitUrlFromSource';
import { getMarketplaceNameFromSource } from './getMarketplaceNameFromSource';
import { buildGitCloneArgs } from './gitCloneOptions';
import { PluginRegistry } from './PluginRegistry';
import { MarketplaceOperationResult } from './types';

const GIT_TIMEOUT_MS = 60000;

/**
 * Strip credential userinfo (`user:password@`) and query strings from a URL
 * so we never echo tokens back to the UI, logs, or telemetry. Falls back to
 * the raw input only when it isn't a parseable URL (e.g. SSH `git@host:path`).
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (err) {
    logWarn('redactUrl: not a parseable URL, falling back to regex scrub', {
      cause: err,
    });
    // Best-effort scrub of SSH-style `git@host:path` and any embedded `user:token@`
    return url.replace(/\/\/[^@/]+:[^@/]+@/, '//');
  }
}

/**
 * Scrub a git error message by redacting any URL-looking substrings.
 * Git frequently echoes the clone URL into error text, which for `url` sources
 * may contain credentials — strip them before surfacing the message to callers.
 */
function sanitizeGitErrorMessage(message: string): string {
  const urlPattern = /https?:\/\/\S+|git@[^\s:]+:\S+/g;
  return message.replace(urlPattern, (match) => redactUrl(match));
}

interface CreateGitOptions {
  baseDir?: string;
  // When true, disables interactive prompts (GIT_TERMINAL_PROMPT=0)
  disablePrompts?: boolean;
}

function createGit(options: CreateGitOptions = {}): SimpleGit {
  const { baseDir, disablePrompts = true } = options;

  const git = simpleGit({
    baseDir,
    timeout: { block: GIT_TIMEOUT_MS },
  });

  // Only set env vars when we need to disable prompts.
  // Don't call .env() with an empty object because that clears inherited env vars.
  // simple-git's .env() replaces the active map, so we merge with current values.
  if (disablePrompts) {
    const sshCommand = [
      'ssh',
      '-o',
      'BatchMode=yes',
      // Avoid prompting for host key trust on first contact, but still fail if a host key changes
      '-o',
      'StrictHostKeyChecking=accept-new',
    ].join(' ');

    git.env({
      ...getProcessEnvironment(),
      // Disable interactive prompts to prevent CLI from hanging
      // when user has no auth configured (works cross-platform)
      GIT_TERMINAL_PROMPT: '0',
      // Disable Git Credential Manager interactivity
      GCM_INTERACTIVE: 'never',
      // Ensure SSH auth never prompts (e.g. key passphrase / host key trust)
      GIT_SSH_COMMAND: sshCommand,
      // Disable SSH askpass prompts
      SSH_ASKPASS: '',
      GIT_ASKPASS: '',
    });
  }

  return git;
}

/** Read the optional ref/sha pin off a marketplace source (local has none). */
function getSourceRefSpec(source: MarketplaceSource): {
  ref?: string;
  sha?: string;
} {
  if (source.source === 'local') {
    return {};
  }
  return { ref: source.ref, sha: source.sha };
}

/**
 * Clone a marketplace repo, honoring an optional ref/sha pin. When a SHA is
 * pinned we use a blobless no-checkout clone and `git checkout` the commit;
 * otherwise the clone is shallow and `--branch <ref>` pins a branch or tag.
 */
async function cloneAndCheckout(
  url: string,
  installLocation: string,
  source: MarketplaceSource,
  disablePrompts: boolean
): Promise<void> {
  const refSpec = getSourceRefSpec(source);
  const git = createGit({ disablePrompts });
  await git.clone(url, installLocation, buildGitCloneArgs(refSpec));

  const { sha } = refSpec;
  if (sha) {
    const repoGit = createGit({ baseDir: installLocation, disablePrompts });
    await repoGit.checkout(sha);
  }
}

const INDUSTRY_PLUGIN_DIR = '.industry-plugin';
const CLAUDE_PLUGIN_DIR = '.claude-plugin';
const MARKETPLACE_MANIFEST = 'marketplace.json';

function isLocalPath(input: string): boolean {
  // Unix absolute path
  if (input.startsWith('/')) return true;
  // Home directory expansion
  if (input.startsWith('~')) return true;
  // Relative paths
  if (input.startsWith('./') || input.startsWith('../')) return true;
  // Windows relative paths with backslash
  if (input.startsWith('.\\') || input.startsWith('..\\')) return true;
  // Windows absolute path (e.g., C:\ or D:\)
  if (/^[A-Za-z]:[/\\]/.test(input)) return true;
  return false;
}

function expandPath(inputPath: string): string {
  const expanded = expandTilde(inputPath);
  return expanded === inputPath ? path.resolve(inputPath) : expanded;
}

interface ParsedRefSpec {
  base: string;
  ref?: string;
  sha?: string;
}

/**
 * Split a marketplace source string into its base URL and an optional pin.
 * A trailing `@<40-hex>` is treated as a commit SHA; a trailing `#<value>` is
 * treated as a branch/tag ref. The 40-hex requirement keeps SSH-style URLs
 * (`git@github.com:owner/repo.git`) from being misread as a SHA pin.
 */
function parseRefSpec(input: string): ParsedRefSpec {
  const shaMatch = input.match(/^(.*)@([0-9a-fA-F]{40})$/);
  if (shaMatch) {
    return { base: shaMatch[1], sha: shaMatch[2].toLowerCase() };
  }

  const hashIndex = input.indexOf('#');
  if (hashIndex !== -1) {
    const ref = input.slice(hashIndex + 1);
    if (ref.length > 0) {
      return { base: input.slice(0, hashIndex), ref };
    }
  }

  return { base: input };
}

export function parseMarketplaceSource(input: string): MarketplaceSource {
  // Mirror Claude Code: `npm:<pkg>` is NOT a marketplace source. npm is a
  // per-plugin source inside a marketplace manifest, so reject the shortcut
  // here with an actionable error instead of silently parsing it as a `url`
  // and failing with a confusing git-clone error downstream.
  if (/^npm:/i.test(input)) {
    throw new MetaError(
      'npm is a plugin source, not a marketplace source. Create a local wrapper marketplace (a folder with .industry-plugin/marketplace.json listing the npm plugin) and add that instead.'
    );
  }

  // Local paths are working directories and never carry a ref/sha pin.
  if (isLocalPath(input)) {
    return {
      source: 'local',
      path: expandPath(input),
    };
  }

  const { base, ref, sha } = parseRefSpec(input);

  const githubMatch = base.match(
    /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/
  );

  if (githubMatch) {
    return {
      source: 'github',
      repo: githubMatch[1],
      ...(ref ? { ref } : {}),
      ...(sha ? { sha } : {}),
    };
  }

  return {
    source: 'url',
    url: base,
    ...(ref ? { ref } : {}),
    ...(sha ? { sha } : {}),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile();
  } catch (err) {
    logWarn('Failed to check marketplace file existence', { cause: err });
    return false;
  }
}

async function readMarketplaceManifestFromPath(
  installLocation: string
): Promise<MarketplaceManifest | null> {
  // Check .industry-plugin/ first, then fall back to .claude-plugin/
  const industryManifestPath = path.join(
    installLocation,
    INDUSTRY_PLUGIN_DIR,
    MARKETPLACE_MANIFEST
  );
  const claudeManifestPath = path.join(
    installLocation,
    CLAUDE_PLUGIN_DIR,
    MARKETPLACE_MANIFEST
  );

  let manifestPath: string;
  if (await fileExists(industryManifestPath)) {
    manifestPath = industryManifestPath;
  } else if (await fileExists(claudeManifestPath)) {
    manifestPath = claudeManifestPath;
  } else {
    logWarn('No marketplace manifest found', {
      path: `${industryManifestPath} or ${claudeManifestPath}`,
    });
    return null;
  }

  try {
    const content = await fs.promises.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(content);
    const validated = MarketplaceManifestSchema.safeParse(parsed);

    if (!validated.success) {
      logWarn('Invalid marketplace manifest', {
        path: manifestPath,
        errorMessage: validated.error.message,
      });
      return null;
    }

    for (const plugin of validated.data.plugins) {
      if (
        typeof plugin.source === 'object' &&
        !MarketplaceSourceSchema.safeParse(plugin.source).success &&
        !NpmMarketplacePluginSourceSchema.safeParse(plugin.source).success
      ) {
        logWarn('Plugin uses unsupported source type and cannot be installed', {
          name: plugin.name,
          sourceType: (plugin.source as { source: string }).source,
          path: manifestPath,
        });
      }
    }

    return validated.data;
  } catch (err) {
    logException(err, 'Failed to read marketplace manifest', {
      path: manifestPath,
    });
    return null;
  }
}

export class MarketplaceService {
  private registry: PluginRegistry;

  private strictMarketplaces?: MarketplaceSource[];

  constructor(
    registry: PluginRegistry,
    strictMarketplaces?: MarketplaceSource[]
  ) {
    this.registry = registry;
    this.strictMarketplaces = strictMarketplaces;
  }

  isMarketplaceAllowed(source: MarketplaceSource): boolean {
    if (!this.strictMarketplaces) {
      return true;
    }
    if (this.strictMarketplaces.length === 0) {
      return false;
    }

    return this.strictMarketplaces.some((allowed) => {
      if (allowed.source !== source.source) {
        return false;
      }

      if (source.source === 'github' && allowed.source === 'github') {
        return (
          allowed.repo === source.repo &&
          allowed.ref === source.ref &&
          allowed.sha === source.sha
        );
      }

      if (source.source === 'url' && allowed.source === 'url') {
        return (
          allowed.url === source.url &&
          allowed.ref === source.ref &&
          allowed.sha === source.sha
        );
      }

      if (source.source === 'local' && allowed.source === 'local') {
        return allowed.path === source.path;
      }

      return false;
    });
  }

  async addMarketplace(
    source: MarketplaceSource
  ): Promise<MarketplaceOperationResult> {
    if (!this.isMarketplaceAllowed(source)) {
      return {
        success: false,
        error: 'This marketplace is not approved by your organization.',
      };
    }

    const name = getMarketplaceNameFromSource(source);

    const existing = await this.registry.getMarketplace(name);
    if (existing) {
      return {
        success: false,
        error: `Marketplace "${name}" already exists`,
      };
    }

    // Validate name is safe (prevent path traversal)
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      name.includes('/') ||
      name.includes('\\')
    ) {
      return {
        success: false,
        error: 'Invalid marketplace name derived from input',
      };
    }

    // Handle local marketplace sources
    if (source.source === 'local') {
      return this.addLocalMarketplace(source.path, name, source);
    }

    // Handle git-based marketplace sources (github, url)
    return this.addGitMarketplace(name, source);
  }

  private async addLocalMarketplace(
    localPath: string,
    name: string,
    source: MarketplaceSource
  ): Promise<MarketplaceOperationResult> {
    // Verify local directory exists
    try {
      const stats = await fs.promises.stat(localPath);
      if (!stats.isDirectory()) {
        return {
          success: false,
          error: `Path is not a directory: ${localPath}`,
        };
      }
    } catch (err) {
      logWarn('Failed to stat local marketplace path', { cause: err });
      return {
        success: false,
        error: `Directory not found: ${localPath}`,
      };
    }

    // Validate marketplace manifest exists
    const manifest = await readMarketplaceManifestFromPath(localPath);
    if (!manifest) {
      return {
        success: false,
        error: "This doesn't appear to be a valid marketplace.",
      };
    }

    const entry: MarketplaceEntry = {
      source,
      installLocation: localPath,
      lastUpdated: new Date().toISOString(),
      autoUpdate: true,
    };

    await this.registry.addMarketplace(name, entry);

    return { success: true, name };
  }

  private async addGitMarketplace(
    name: string,
    source: MarketplaceSource
  ): Promise<MarketplaceOperationResult> {
    const marketplacesPath = this.registry.getMarketplacesPath();
    const installLocation = path.join(marketplacesPath, name);

    // Ensure installLocation stays under marketplacesPath
    const resolvedMarketplacesPath = path.resolve(marketplacesPath);
    const resolvedInstallLocation = path.resolve(installLocation);
    if (
      !resolvedInstallLocation.startsWith(resolvedMarketplacesPath + path.sep)
    ) {
      return {
        success: false,
        error: 'Invalid marketplace location',
      };
    }

    await fs.promises.mkdir(marketplacesPath, { recursive: true });

    // Clean up any leftover directory from a previous failed attempt
    await fs.promises.rm(installLocation, { recursive: true, force: true });

    const httpsUrl = getGitUrlFromSource(source, GitProtocol.HTTPS);
    const sshUrl = getGitUrlFromSource(source, GitProtocol.SSH);

    // Always disable prompts to avoid TTY hijacking during marketplace operations
    const disablePrompts = true;

    const safeHttpsUrl = redactUrl(httpsUrl);
    const safeSshUrl = redactUrl(sshUrl);

    logInfo('Starting git clone', {
      url: safeHttpsUrl,
      path: installLocation,
      repoUrl: safeSshUrl,
      isEnabled: !disablePrompts,
    });

    let httpsError: unknown;
    let sshError: unknown;
    try {
      await cloneAndCheckout(httpsUrl, installLocation, source, disablePrompts);
      logInfo('Git clone succeeded', { url: safeHttpsUrl });
    } catch (error) {
      httpsError = error;
      // Clean up partial clone before SSH fallback
      await fs.promises.rm(installLocation, { recursive: true, force: true });

      // Try SSH fallback if HTTPS fails
      logWarn('Git clone failed with HTTPS, trying SSH fallback', {
        url: safeHttpsUrl,
        repoUrl: safeSshUrl,
        error,
      });
      try {
        await cloneAndCheckout(sshUrl, installLocation, source, disablePrompts);
        logInfo('Git clone succeeded with SSH fallback', { url: safeSshUrl });
      } catch (fallbackErr) {
        sshError = fallbackErr;
        // Clean up partial clone so next retry starts clean
        await fs.promises.rm(installLocation, { recursive: true, force: true });

        logException(fallbackErr, 'Failed to clone marketplace repository', {
          url: safeSshUrl,
        });
        const httpsMsg = sanitizeGitErrorMessage(
          httpsError instanceof Error
            ? httpsError.message
            : String(httpsError ?? 'unknown')
        );
        const sshMsg = sanitizeGitErrorMessage(
          sshError instanceof Error
            ? sshError.message
            : String(sshError ?? 'unknown')
        );
        return {
          success: false,
          error: `Could not download marketplace. HTTPS (${safeHttpsUrl}): ${httpsMsg.slice(0, 300)} | SSH (${safeSshUrl}): ${sshMsg.slice(0, 300)}`,
        };
      }
    }

    const manifest = await readMarketplaceManifestFromPath(installLocation);
    if (!manifest) {
      await fs.promises.rm(installLocation, { recursive: true, force: true });
      return {
        success: false,
        error: "This doesn't appear to be a valid marketplace.",
      };
    }

    const entry: MarketplaceEntry = {
      source,
      installLocation,
      lastUpdated: new Date().toISOString(),
      autoUpdate: true,
    };

    await this.registry.addMarketplace(name, entry);

    return { success: true, name };
  }

  async removeMarketplace(name: string): Promise<MarketplaceOperationResult> {
    const entry = await this.registry.getMarketplace(name);

    if (!entry) {
      return {
        success: false,
        error: `Marketplace "${name}" not found`,
      };
    }

    // Only delete directory for git-based marketplaces (not local ones)
    if (entry.source.source !== 'local') {
      try {
        await fs.promises.rm(entry.installLocation, {
          recursive: true,
          force: true,
        });
      } catch (err) {
        logWarn('Failed to remove marketplace directory', { cause: err });
      }
    }

    await this.registry.removeMarketplace(name);

    return { success: true, name };
  }

  async updateMarketplace(
    name?: string
  ): Promise<MarketplaceOperationResult[]> {
    if (name) {
      const result = await this.updateSingleMarketplace(name);
      return [result];
    }

    const marketplaces = await this.registry.listMarketplaces();
    const results = await Promise.all(
      marketplaces.map(({ name: marketplaceName }) =>
        this.updateSingleMarketplace(marketplaceName)
      )
    );

    return results;
  }

  private async updateSingleMarketplace(
    name: string
  ): Promise<MarketplaceOperationResult> {
    const entry = await this.registry.getMarketplace(name);

    if (!entry) {
      return {
        success: false,
        name,
        error: `Marketplace "${name}" not found`,
      };
    }

    // Check if marketplace is still allowed by org policy
    if (!this.isMarketplaceAllowed(entry.source)) {
      return {
        success: false,
        name,
        error: 'This marketplace is not approved by your organization.',
      };
    }

    // Local marketplaces are always "live" - just update timestamp
    if (entry.source.source === 'local') {
      // Re-check if marketplace still exists (could have been removed)
      const currentEntry = await this.registry.getMarketplace(name);
      if (!currentEntry) {
        return { success: false, name, error: 'Marketplace was removed' };
      }
      // Re-validate org policy in case source was modified concurrently
      if (!this.isMarketplaceAllowed(currentEntry.source)) {
        return {
          success: false,
          name,
          error: 'This marketplace is not approved by your organization.',
        };
      }
      const updatedEntry: MarketplaceEntry = {
        ...currentEntry,
        lastUpdated: new Date().toISOString(),
      };
      await this.registry.addMarketplace(name, updatedEntry);
      return { success: true, name };
    }

    // Git-based marketplaces need git pull
    try {
      const { ref, sha } = getSourceRefSpec(entry.source);
      const git = createGit({
        baseDir: entry.installLocation,
        disablePrompts: true,
      });
      if (sha) {
        // A SHA pin is immutable; nothing to fetch. Just refresh the timestamp.
      } else if (ref) {
        // Re-pin to the latest commit reachable by the branch/tag. Fetching the
        // ref into FETCH_HEAD then hard-resetting works for both branches
        // (advances the tip) and tags (detached HEAD has no upstream to pull).
        await git.fetch('origin', ref);
        await git.reset(['--hard', 'FETCH_HEAD']);
      } else {
        await git.pull();
      }

      // Re-check if marketplace still exists after pull (could have been removed during update)
      const currentEntry = await this.registry.getMarketplace(name);
      if (!currentEntry) {
        return { success: false, name, error: 'Marketplace was removed' };
      }
      // Re-validate org policy in case source was modified concurrently
      if (!this.isMarketplaceAllowed(currentEntry.source)) {
        return {
          success: false,
          name,
          error: 'This marketplace is not approved by your organization.',
        };
      }

      const updatedEntry: MarketplaceEntry = {
        ...currentEntry,
        lastUpdated: new Date().toISOString(),
      };
      await this.registry.addMarketplace(name, updatedEntry);

      return { success: true, name };
    } catch (err) {
      logException(err, 'Failed to update marketplace (marketplace service)', {
        name,
      });
      return {
        success: false,
        name,
        error: 'Could not update marketplace. Please check the source.',
      };
    }
  }

  async getMarketplaceManifest(
    name: string
  ): Promise<MarketplaceManifest | null> {
    const entry = await this.registry.getMarketplace(name);

    if (!entry) {
      return null;
    }

    return readMarketplaceManifestFromPath(entry.installLocation);
  }

  async listAllPlugins(): Promise<
    Array<MarketplacePluginEntry & { marketplace: string }>
  > {
    const marketplaces = await this.registry.listMarketplaces();

    const pluginLists = await Promise.all(
      marketplaces.map(async ({ name }) => {
        const manifest = await this.getMarketplaceManifest(name);
        if (!manifest?.plugins) return [];
        return manifest.plugins.map((plugin) => ({
          ...plugin,
          marketplace: name,
        }));
      })
    );

    return pluginLists.flat();
  }

  async searchPlugins(
    query: string
  ): Promise<Array<MarketplacePluginEntry & { marketplace: string }>> {
    const allPlugins = await this.listAllPlugins();
    const lowerQuery = query.toLowerCase();

    return allPlugins.filter(
      (plugin) =>
        plugin.name.toLowerCase().includes(lowerQuery) ||
        plugin.description?.toLowerCase().includes(lowerQuery) ||
        plugin.category?.toLowerCase().includes(lowerQuery) ||
        plugin.tags?.some((tag) => tag.toLowerCase().includes(lowerQuery))
    );
  }

  async getPluginInfo(
    marketplace: string,
    pluginName: string
  ): Promise<MarketplacePluginEntry | null> {
    const manifest = await this.getMarketplaceManifest(marketplace);

    if (!manifest) {
      return null;
    }

    return manifest.plugins.find((p) => p.name === pluginName) ?? null;
  }

  async setAutoUpdate(
    name: string,
    enabled: boolean
  ): Promise<MarketplaceOperationResult> {
    const entry = await this.registry.getMarketplace(name);

    if (!entry) {
      return {
        success: false,
        error: `Marketplace "${name}" not found`,
      };
    }

    const updatedEntry: MarketplaceEntry = {
      ...entry,
      autoUpdate: enabled,
    };

    await this.registry.addMarketplace(name, updatedEntry);

    return { success: true, name };
  }

  async getMarketplacesWithAutoUpdate(): Promise<
    Array<{ name: string; entry: MarketplaceEntry }>
  > {
    const marketplaces = await this.registry.listMarketplaces();
    // Treat missing autoUpdate as enabled for backward compatibility
    return marketplaces.filter(({ entry }) => entry.autoUpdate !== false);
  }
}
