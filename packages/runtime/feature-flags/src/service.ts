import * as fs from 'fs';
import * as path from 'path';

import {
  IndustryFeatureFlag,
  IndustryFeatureFlags,
} from '@industry/common/feature-flags';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getIndustryApiConfig, fetch } from '@industry/utils/api';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import {
  getFeatureFlagConfig,
  _resetFeatureFlagConfigForTesting,
} from './config';

function readFeatureFlagsOverrides(): string | undefined {
  return getFeatureFlagConfig().featureFlagsOverrides;
}

function readFeatureFlagsSnapshotPath(): string | undefined {
  return getFeatureFlagConfig().featureFlagsSnapshotPath;
}

interface FeatureFlagsApiResponse {
  flags?: Record<string, boolean>;
  configs?: Record<string, unknown>;
}

interface DiskCache {
  orgId: string;
  flags: Record<string, boolean>;
  configs: Record<string, unknown>;
}

// OrgId provider — registered once at startup to avoid circular dependencies
type OrgIdProvider = () => string | undefined | Promise<string | undefined>;
let orgIdProvider: OrgIdProvider | null = null;

/**
 * Register a provider that returns the current org ID.
 * Called once at startup (e.g. CLI init) so fetchFeatureFlags can
 * auto-resolve the org without callers passing it explicitly.
 */
export function setOrgIdProvider(provider: OrgIdProvider): void {
  orgIdProvider = provider;
}

// Cache and request management
let flagsCache: Record<string, boolean> | null = null;
let configsCache: Record<string, unknown> | null = null;
let flagsInflight: Promise<Record<string, boolean>> | null = null;
let currentOrgId: string = '';
/** When true, skip SWR and force a synchronous remote fetch */
let forceRefresh: boolean = false;

/**
 * Memoized disk-cache snapshot for synchronous read accessors. `undefined`
 * = not yet attempted, `null` = attempted but no cache exists. Reset when
 * the in-memory cache is invalidated so a new disk read picks up changes
 * (e.g. after `clearFeatureFlagDiskCache` or org-switch).
 */
let diskCacheSnapshot: Record<string, boolean> | null | undefined;

/** Single write path for in-memory caches; keeps `flagsCache`/`configsCache` paired. */
function commitFlagsAndConfigs(
  flags: Record<string, boolean>,
  configs: Record<string, unknown>
): void {
  flagsCache = flags;
  configsCache = configs;
}

function getDiskCachePath(): string {
  return path.join(
    getIndustryHome(),
    getIndustryDirName(),
    'cache',
    'feature-flags.json'
  );
}

function loadDiskCache(): DiskCache | null {
  try {
    const raw = fs.readFileSync(getDiskCachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as DiskCache;
    if (
      parsed &&
      typeof parsed.flags === 'object' &&
      parsed.flags !== null &&
      !Array.isArray(parsed.flags)
    )
      return parsed;
  } catch (error) {
    logWarn('Failed to load feature flags disk cache', { error });
  }
  return null;
}

export function loadCachedFlagsFromDisk(): Record<string, boolean> | null {
  return loadDiskCache()?.flags ?? null;
}

function getDiskCacheSnapshot(): Record<string, boolean> | null {
  if (diskCacheSnapshot === undefined) {
    diskCacheSnapshot = loadCachedFlagsFromDisk();
  }
  return diskCacheSnapshot;
}

function persistCacheToDisk(
  orgId: string,
  flags: Record<string, boolean>,
  configs: Record<string, unknown>
): void {
  try {
    const cachePath = getDiskCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const data: DiskCache = { orgId, flags, configs };
    fs.writeFileSync(cachePath, JSON.stringify(data), 'utf-8');
  } catch (error) {
    logWarn('Failed to persist feature flags to disk cache', { error });
  }
}

export function clearFeatureFlagDiskCache(): void {
  try {
    fs.unlinkSync(getDiskCachePath());
  } catch (err) {
    logWarn('Failed to clear feature flag disk cache', { cause: err });
  }
  // Drop the memoized snapshot so subsequent synchronous getFlag() reads
  // re-load from disk (which is now gone) and fall through to defaults
  // instead of returning stale post-deletion values.
  diskCacheSnapshot = undefined;
}

/**
 * Reset the feature flag and config cache.
 * Called when org changes, after login, or when cache needs to be cleared.
 * Forces next fetchFeatureFlags call to do a synchronous remote fetch
 * (bypasses stale-while-revalidate).
 */
export function resetFeatureFlagCache(): void {
  flagsCache = null;
  configsCache = null;
  flagsInflight = null;
  diskCacheSnapshot = undefined;
  forceRefresh = true;
}

/**
 * Reset all module state to initial values.
 * Intended for test isolation — simulates a fresh process start.
 * @public
 */
export function _resetAllForTesting(): void {
  flagsCache = null;
  configsCache = null;
  flagsInflight = null;
  currentOrgId = '';
  forceRefresh = false;
  diskCacheSnapshot = undefined;
  orgIdProvider = null;
  _resetFeatureFlagConfigForTesting();
}

/**
 * Synchronously read a feature flag's current value with the SWR-friendly
 * fallback chain: in-memory cache (post-fetch) -> disk cache snapshot ->
 * compiled-in `defaultValue`. Always returns a boolean.
 *
 * Use this for reads outside an `await` context (renderers, model
 * availability filters, hot paths). Pair with an explicit
 * `fetchFeatureFlags()` warm-up at startup so the in-memory cache is
 * primed; sync reads remain correct during a Statsig outage as long as a
 * successful fetch was previously persisted to disk.
 */
export function getFlag(flag: IndustryFeatureFlag): boolean {
  const { statsigName, defaultValue } = flag;
  if (flagsCache !== null && flagsCache[statsigName] !== undefined) {
    return flagsCache[statsigName];
  }
  const disk = getDiskCacheSnapshot();
  if (disk && disk[statsigName] !== undefined) return disk[statsigName];
  return defaultValue;
}

/**
 * Bulk version of {@link getFlag}. Returns a `{ statsigName: value }`
 * map using the same fallback chain.
 */
export function getFlagValues(
  flags: IndustryFeatureFlag[]
): Record<string, boolean> {
  const values: Record<string, boolean> = {};
  for (const flag of flags) {
    values[flag.statsigName] = getFlag(flag);
  }
  return values;
}

/**
 * Synchronously read a dynamic config blob populated by the most recent
 * `fetchFeatureFlags()` (which fetches configs as a side effect). Returns
 * `undefined` until the first successful fetch.
 *
 * The returned value is the raw API payload; callers that need a typed
 * shape should run their own schema validation.
 */
export function getDynamicConfig(name: string): unknown {
  return configsCache?.[name];
}

/**
 * Apply JSON overrides from the environment on top of the current flagsCache.
 * Used in E2E tests to pin specific flags on top of a snapshot fixture.
 */
function applyFlagOverrides(flags: Record<string, boolean>): void {
  const raw = readFeatureFlagsOverrides();
  if (!raw) return;
  try {
    const overrides = JSON.parse(raw) as Record<string, boolean>;
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === 'boolean') {
        flags[key] = value;
      }
    }
  } catch (err) {
    logWarn('Failed to parse INDUSTRY_FEATURE_FLAGS_OVERRIDES, ignoring', {
      source: raw,
      cause: err,
    });
  }
}

function buildDefaultFlags(): Record<string, boolean> {
  const defaultFlags: Record<string, boolean> = {};
  Object.entries(IndustryFeatureFlags).forEach(([_key, flag]) => {
    defaultFlags[flag.statsigName] = flag.defaultValue;
  });
  return defaultFlags;
}

/**
 * Merge remote flags with compiled-in defaults so every known flag has a value.
 */
function mergeWithDefaults(
  remoteFlags: Record<string, boolean>
): Record<string, boolean> {
  const mergedFlags: Record<string, boolean> = {};
  Object.entries(IndustryFeatureFlags).forEach(([_key, flag]) => {
    const { statsigName, defaultValue } = flag;
    mergedFlags[statsigName] =
      remoteFlags[statsigName] !== undefined
        ? remoteFlags[statsigName]
        : defaultValue;
  });
  return mergedFlags;
}

/**
 * Fetch flags from the remote API, merge with defaults, and persist to disk.
 * Returns the merged flags record.
 */
function fetchRemoteFlags(orgKey: string): Promise<Record<string, boolean>> {
  return fetch(
    '/api/feature-flags',
    undefined,
    getIndustryApiConfig() ?? undefined
  )
    .then((response) => response.json() as Promise<FeatureFlagsApiResponse>)
    .then((data) => {
      const remoteFlags = data.flags ?? {};
      const remoteConfigs = data.configs ?? {};

      const mergedFlags = mergeWithDefaults(remoteFlags);

      // Persist clean (non-overridden) flags to disk so env-specific
      // overrides don't leak into the shared cache for future processes.
      persistCacheToDisk(orgKey, mergedFlags, remoteConfigs);

      const effectiveFlags = { ...mergedFlags };
      applyFlagOverrides(effectiveFlags);

      // Only update in-memory caches if the org hasn't changed mid-flight
      if (currentOrgId === orgKey) {
        commitFlagsAndConfigs(effectiveFlags, remoteConfigs);
      }

      return effectiveFlags;
    });
}

function getOrStartRemoteRefresh(
  orgKey: string
): Promise<Record<string, boolean>> {
  if (!flagsInflight) {
    const refreshPromise = fetchRemoteFlags(orgKey).finally(() => {
      if (flagsInflight === refreshPromise) {
        flagsInflight = null;
      }
    });
    flagsInflight = refreshPromise;
  }

  return flagsInflight;
}

function buildRefreshFailureFallback(
  error: unknown,
  orgKey: string
): Record<string, boolean> {
  // Re-read disk cache at catch time (not the snapshot from before the fetch)
  // in case another process or background SWR updated it while we were waiting.
  const freshDiskCached = loadDiskCache();
  let fallbackFlags: Record<string, boolean>;
  let fallbackConfigs: Record<string, unknown>;
  if (freshDiskCached && (freshDiskCached.orgId ?? '') === orgKey) {
    logWarn('Failed to fetch feature flags, using locally cached values', {
      error,
    });
    fallbackFlags = { ...freshDiskCached.flags };
    fallbackConfigs = freshDiskCached.configs ?? {};
  } else {
    logWarn('Failed to fetch feature flags, using default values', {
      error,
    });
    fallbackFlags = buildDefaultFlags();
    fallbackConfigs = {};
  }
  applyFlagOverrides(fallbackFlags);
  commitFlagsAndConfigs(fallbackFlags, fallbackConfigs);
  return fallbackFlags;
}

/**
 * Fetch feature flags with stale-while-revalidate caching.
 *
 * Behavior:
 * 1. If in-memory flags are cached, return immediately.
 * 2. If a valid disk cache exists for the current org, load it into memory,
 *    return immediately, and fire-and-forget a background refresh.
 * 3. If no cache exists (first-ever startup), fetch synchronously.
 * 4. Org switch invalidates all caches.
 * 5. Corrupt disk cache falls back to defaults + fresh synchronous fetch.
 *
 * @returns Record of feature flag names to their boolean values
 */
export async function fetchFeatureFlags(): Promise<Record<string, boolean>> {
  // Snapshot override: when INDUSTRY_FEATURE_FLAGS_SNAPSHOT_PATH is set,
  // load flags from the committed snapshot file instead of the remote API.
  // Used in E2E tests to isolate from live Statsig flag changes.
  const snapshotPath = readFeatureFlagsSnapshotPath();
  if (snapshotPath) {
    if (!flagsCache) {
      let snapshotFlags: Record<string, boolean>;
      let snapshotConfigs: Record<string, unknown>;
      try {
        const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as {
          flags?: Record<string, boolean>;
          configs?: Record<string, unknown>;
        };
        snapshotFlags = mergeWithDefaults(raw.flags ?? {});
        snapshotConfigs = raw.configs ?? {};
      } catch (error) {
        logWarn('Failed to load feature flags snapshot, using defaults', {
          error,
          path: snapshotPath,
        });
        snapshotFlags = buildDefaultFlags();
        snapshotConfigs = {};
      }
      applyFlagOverrides(snapshotFlags);
      commitFlagsAndConfigs(snapshotFlags, snapshotConfigs);
    }
    return flagsCache!;
  }

  // Resolve orgId from the registered provider
  if (!orgIdProvider) {
    throw new MetaError(
      'fetchFeatureFlags called before setOrgIdProvider was registered'
    );
  }
  const nextOrgKey = (await orgIdProvider()) ?? '';
  if (currentOrgId !== nextOrgKey) {
    resetFeatureFlagCache();
    currentOrgId = nextOrgKey;
  }

  // Return in-memory cached flags if available
  if (flagsCache) return flagsCache;

  // --- Stale-while-revalidate: check disk cache ---
  // Skip SWR if a manual reset was requested (e.g. after login, explicit reset)
  const diskCached = loadDiskCache();
  if (!forceRefresh && diskCached && (diskCached.orgId ?? '') === nextOrgKey) {
    // Populate in-memory caches from disk
    const swrFlags = { ...diskCached.flags };
    applyFlagOverrides(swrFlags);
    commitFlagsAndConfigs(swrFlags, diskCached.configs ?? {});

    // Fire-and-forget background refresh
    getOrStartRemoteRefresh(nextOrgKey).catch((error) => {
      logWarn('Background feature flags refresh failed', { error });
    });

    return flagsCache!;
  }

  // --- No valid cache: synchronous fetch (first-ever startup, org mismatch, or forced) ---
  forceRefresh = false;

  // Handle concurrent requests - reuse in-flight promise
  return getOrStartRemoteRefresh(nextOrgKey).catch((error) =>
    buildRefreshFailureFallback(error, nextOrgKey)
  );
}

/**
 * Fetch dynamic configs with caching
 * Ensures feature flags are fetched first (which populates the configs cache)
 *
 * @returns Record of config names to their values
 */
export async function fetchDynamicConfigs(): Promise<Record<string, unknown>> {
  await fetchFeatureFlags(); // Ensures cache is populated
  return configsCache ?? {};
}
