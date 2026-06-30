import * as fs from 'fs';
import * as path from 'path';

import { logInfo, logWarn } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { getRuntimeAuthConfig } from '@/environment';
import { CHANGELOG_URL } from '@/services/changelog/constants';
import type { ChangelogEntry } from '@/services/changelog/types';
import { getSettingsService } from '@/services/SettingsService';

interface DiskCache {
  cliVersion: string;
  entry: ChangelogEntry;
  viewCount: number;
}

let cachedEntry: ChangelogEntry | null = null;
let changelogSuppressed = false;
let fetchStarted = false;

/** Strip build metadata suffix (e.g. "0.85.1-build0004606" → "0.85.1"). */
function getBaseVersion(version: string): string {
  return version.replace(/-build\d+$/, '');
}

/** Extract major.minor from a version string (e.g. "v0.85.1" → "0.85"). */
function getMajorMinor(version: string): string {
  const stripped = version.replace(/^v/, '');
  const parts = stripped.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : stripped;
}

function getCachePath(): string {
  return path.join(
    getIndustryHome(),
    getIndustryDirName(),
    'cache',
    'changelog.json'
  );
}

function loadDiskCache(): { entry: ChangelogEntry; viewCount: number } | null {
  try {
    const raw = fs.readFileSync(getCachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as DiskCache;
    if (parsed && parsed.entry && parsed.entry.version && parsed.entry.date) {
      const currentBase = getBaseVersion(process.env.CLI_VERSION ?? '0.0.0');
      if (
        parsed.cliVersion &&
        getBaseVersion(parsed.cliVersion) !== currentBase
      ) {
        return null;
      }
      return { entry: parsed.entry, viewCount: parsed.viewCount ?? 0 };
    }
  } catch {
    // file doesn't exist or invalid
  }
  return null;
}

function persistDiskCache(entry: ChangelogEntry, viewCount: number): void {
  try {
    const cachePath = getCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const data: DiskCache = {
      cliVersion: process.env.CLI_VERSION ?? '0.0.0',
      entry,
      viewCount,
    };
    fs.writeFileSync(cachePath, JSON.stringify(data), 'utf-8');
  } catch {
    // non-critical
  }
}

function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const lines = markdown.split('\n');

  let pendingDate: string | null = null;
  let currentVersion: string | null = null;
  let currentDate: string | null = null;
  let currentFeatures: string[] = [];
  let inNewFeatures = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // <Update label="March 19" ...>
    const updateMatch = trimmed.match(/^<Update\s+label="([^"]+)"/);
    if (updateMatch) {
      pendingDate = updateMatch[1];
      continue;
    }

    // </Update> closes current entry
    if (trimmed === '</Update>') {
      if (currentVersion && currentDate) {
        entries.push({
          version: currentVersion,
          date: currentDate,
          features: currentFeatures,
        });
      }
      currentVersion = null;
      currentDate = null;
      currentFeatures = [];
      inNewFeatures = false;
      continue;
    }

    // Version line: `v0.82.0`
    const versionMatch = trimmed.match(/^`(v[\d.]+)`$/);
    if (versionMatch) {
      currentVersion = versionMatch[1];
      currentDate = pendingDate;
      pendingDate = null;
      currentFeatures = [];
      inNewFeatures = false;
      continue;
    }

    // Section header: ## New features
    if (/^#+\s+.*New features/i.test(trimmed)) {
      inNewFeatures = true;
      continue;
    }
    if (/^#+\s+/.test(trimmed) && inNewFeatures) {
      inNewFeatures = false;
      continue;
    }

    // Feature bullet: * **Feature name** - description
    if (inNewFeatures && trimmed.startsWith('*')) {
      const bulletText = trimmed
        .replace(/^\*\s*/, '')
        .replace(/\*\*/g, '')
        .trim();
      if (bulletText) {
        currentFeatures.push(bulletText);
      }
    }
  }

  // Push last entry if file didn't end with </Update>
  if (currentVersion && currentDate) {
    entries.push({
      version: currentVersion,
      date: currentDate,
      features: currentFeatures,
    });
  }

  return entries;
}

function findEntryForVersion(
  entries: ChangelogEntry[],
  cliVersion: string
): ChangelogEntry | null {
  if (entries.length === 0) return null;

  const normalized = cliVersion.startsWith('v') ? cliVersion : `v${cliVersion}`;

  // 1. Exact match on full version
  const exact = entries.find((e) => e.version === normalized);
  if (exact) return exact;

  // 2. Match on base version (strip build suffix)
  const base = getBaseVersion(normalized);
  if (base !== normalized) {
    const baseMatch = entries.find((e) => e.version === base);
    if (baseMatch) return baseMatch;
  }

  // 3. Match on major.minor (e.g. v0.85.1 matches entry v0.85.0)
  const mm = getMajorMinor(normalized);
  const mmMatch = entries.find((e) => getMajorMinor(e.version) === mm);
  if (mmMatch) return mmMatch;

  return null;
}

async function doFetch(): Promise<ChangelogEntry | null> {
  if (getRuntimeAuthConfig().airgapEnabled) {
    logInfo(
      '[ChangelogService] Skipping changelog fetch: Airgap Mode is enabled'
    );
    return null;
  }
  try {
    // eslint-disable-next-line no-restricted-globals -- CHANGELOG_URL is a public CDN, not the Industry backend
    const response = await fetch(CHANGELOG_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const text = await response.text();
    const entries = parseChangelog(text);
    const version = process.env.CLI_VERSION ?? '0.0.0';
    const entry = findEntryForVersion(entries, version);
    if (entry) {
      // Preserve existing viewCount when updating cached entry from network.
      // If no cache exists yet, start at 1 since this fetch will cause the
      // changelog to be shown for the first time in this session.
      const existing = loadDiskCache();
      persistDiskCache(entry, existing?.viewCount ?? 1);
    }
    return entry;
  } catch (err) {
    logWarn('[ChangelogService] Failed to fetch changelog', { cause: err });
    return null;
  }
}

export function initChangelog(): void {
  // Respect persistent "hide changelog" setting
  if (getSettingsService().getHideChangelog()) {
    changelogSuppressed = true;
  }

  if (!cachedEntry && !changelogSuppressed) {
    const cached = loadDiskCache();
    if (cached) {
      cachedEntry = cached.entry;
    }
  }

  // Fire-and-forget network fetch to update disk cache for next launch
  if (!fetchStarted) {
    fetchStarted = true;
    void doFetch().then((entry) => {
      if (entry && !changelogSuppressed) {
        cachedEntry = entry;
      }
    });
  }
}

export function dismissChangelog(): void {
  changelogSuppressed = true;
  cachedEntry = null;
  // Persist so it stays dismissed on next launch
  const cached = loadDiskCache();
  if (cached) {
    persistDiskCache(cached.entry, 2);
  }
}

export function restoreChangelog(): boolean {
  const cached = loadDiskCache();
  if (cached) {
    changelogSuppressed = false;
    cachedEntry = cached.entry;
    return true;
  }
  return false;
}

export function isChangelogDismissed(): boolean {
  return changelogSuppressed;
}

export function hasChangelogCache(): boolean {
  return loadDiskCache() !== null;
}

export function getChangelog(): ChangelogEntry | null {
  if (changelogSuppressed) return null;
  return cachedEntry;
}
