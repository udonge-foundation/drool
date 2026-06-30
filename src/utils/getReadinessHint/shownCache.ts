import * as fs from 'fs';
import * as path from 'path';

import { logWarn } from '@industry/logging';

import { getUserIndustryDir } from '@/utils/industryPaths';
import type { CachedReadinessHintState } from '@/utils/getReadinessHint/types';

/**
 * Per-user, per-git-root state for the welcome-screen CLI hints.
 * Persisted as a small JSON file under `~/.industry/cli-hints.json` (or
 * `~/.industry-dev/...` in dev) so we don't pollute settings.json or the
 * client/daemon protocol surface.
 *
 * Keying on the local git root path (rather than origin URL) keeps the read
 * path off any synchronous git-config parsing. A repo cloned at two paths
 * gets independent suppression markers, which is fine for a UX nudge.
 *
 * All disk I/O is best-effort: failures degrade to "no hint" rather than
 * crashing the CLI.
 */

const HINTS_FILE_NAME = 'cli-hints.json';

interface PerPathEntry {
  /** Epoch ms when readiness hint data was last successfully primed. */
  lastPrimedAt?: number;
  /** Epoch ms when the no-report nudge was last surfaced for this git root. */
  noReportShownAt?: number;
  /** True once a successful prime found a report for this git root. */
  hasPreviousReport?: boolean;
  /** Failing L1 criterion IDs from the last successful prime, in canonical order. */
  lastSeenGaps?: string[];
  /** criterionId → epoch ms when that L1 hint was surfaced. */
  gapsShown?: Record<string, number>;
}

type PerPathMap = Record<string, PerPathEntry>;

function getHintsFilePath(): string {
  return path.join(getUserIndustryDir(), HINTS_FILE_NAME);
}

function readPerPath(): PerPathMap {
  try {
    const raw = fs.readFileSync(getHintsFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as { perPath?: PerPathMap };
    return parsed?.perPath ?? {};
  } catch (error) {
    // Treat ENOENT (first launch) as a benign empty state without log noise;
    // surface anything else (corrupt JSON, EACCES, etc.) so it's debuggable.
    if (
      !(error instanceof Error) ||
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      logWarn('Failed to read cli-hints.json; resetting to empty', {
        error,
      });
    }
    return {};
  }
}

function writePerPath(perPath: PerPathMap): void {
  const filePath = getHintsFilePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify({ perPath }), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    logWarn('Failed to persist cli-hints.json', { error });
  }
}

/**
 * Read-modify-write a single per-path entry. No cross-process lock: two
 * `drool` processes racing on different git roots can clobber each other's
 * entry. Worst case is a one-shot marker is lost and the hint surfaces a
 * second time — acceptable for a UX nudge.
 */
function mutatePerPathEntry(
  gitRoot: string,
  mutate: (entry: PerPathEntry) => void
): void {
  if (!gitRoot) return;
  const perPath = readPerPath();
  const entry: PerPathEntry = { ...(perPath[gitRoot] ?? {}) };
  mutate(entry);
  perPath[gitRoot] = entry;
  writePerPath(perPath);
}

/** True when the no-report nudge has already been shown for this git root. */
export function wasNoReportHintShown(gitRoot: string): boolean {
  if (!gitRoot) return false;
  return readPerPath()[gitRoot]?.noReportShownAt !== undefined;
}

/** Marks the no-report nudge as shown for this (user, git root). Idempotent. */
export function markNoReportHintShown(gitRoot: string): void {
  if (!gitRoot) return;
  mutatePerPathEntry(gitRoot, (entry) => {
    if (entry.noReportShownAt === undefined) {
      entry.noReportShownAt = Date.now();
    }
  });
}

/** Marks the given L1 gap hint as shown. Idempotent. */
export function markGapHintShown(gitRoot: string, criterionId: string): void {
  if (!gitRoot) return;
  mutatePerPathEntry(gitRoot, (entry) => {
    const next = { ...(entry.gapsShown ?? {}) };
    if (next[criterionId] === undefined) {
      next[criterionId] = Date.now();
    }
    entry.gapsShown = next;
  });
}

/** Cached hint state for this git root, or `null` when none exists yet. */
export function getCachedHintState(
  gitRoot: string
): CachedReadinessHintState | null {
  if (!gitRoot) return null;
  const entry = readPerPath()[gitRoot];
  if (!entry) return null;
  return {
    hasPreviousReport: entry.hasPreviousReport,
    lastSeenGaps: entry.lastSeenGaps ?? null,
    gapsShown: entry.gapsShown ?? {},
  };
}

/** True when this git root was successfully primed at or after `cutoffMillis`. */
export function wasPrimeResultRefreshedAfter(
  gitRoot: string,
  cutoffMillis: number
): boolean {
  if (!gitRoot) return false;
  const lastPrimedAt = readPerPath()[gitRoot]?.lastPrimedAt;
  return typeof lastPrimedAt === 'number' && lastPrimedAt >= cutoffMillis;
}

/**
 * Persists a successful prime: failing L1 IDs (empty when no report or no
 * failing L1). `gapsShown` is never cleared; stale entries are harmless
 * because the criterion no longer appears in `lastSeenGaps`.
 */
export function persistPrimeResult(
  gitRoot: string,
  failingL1Ids: readonly string[],
  hasPreviousReport: boolean
): void {
  if (!gitRoot) return;
  mutatePerPathEntry(gitRoot, (entry) => {
    entry.lastPrimedAt = Date.now();
    entry.hasPreviousReport = hasPreviousReport;
    entry.lastSeenGaps = [...failingL1Ids];
  });
}
