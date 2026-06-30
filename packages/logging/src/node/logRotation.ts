import * as fs from 'fs';
import * as fsAsync from 'fs/promises';
import * as path from 'path';

import {
  DEFAULT_MAX_LOG_DAYS,
  DEFAULT_MAX_LOG_FRAGMENT_BYTES,
  DEFAULT_MAX_TOTAL_LOG_BYTES,
} from './constants';
import { RotationSyscall } from './enums';
import { LogRotationOptions, RotationError } from './types';

interface ResolvedRotationOptions {
  filePath: string;
  baseName: string;
  dirName: string;
  archivePattern: RegExp;
  maxBytesPerFragment: number;
  maxDays: number;
  maxTotalBytes: number;
  onError?: (error: RotationError) => void;
}

interface ArchiveEntry {
  date: string;
  fragment: number;
  fullPath: string;
  size: number;
}

function getErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return 'unknown';
  }
  const { code } = error;
  return typeof code === 'string' ? code : 'unknown';
}

function isMissingFileError(error: unknown): boolean {
  return getErrorCode(error) === 'ENOENT';
}

function swallowRotationError(
  syscall: RotationSyscall,
  error: unknown,
  onError: ResolvedRotationOptions['onError']
): void {
  if (!onError) return;
  try {
    onError({ syscall, code: getErrorCode(error) });
  } catch {
    // Observability callbacks must never block rotation.
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveOptions(
  filePath: string,
  options?: LogRotationOptions
): ResolvedRotationOptions {
  const baseName = path.basename(filePath);
  const dirName = path.dirname(filePath);
  // <base>.YYYY-MM-DD optionally followed by .N where N is the within-day
  // fragment index. Anchored so we never match unrelated files in the
  // logs dir.
  const archivePattern = new RegExp(
    `^${escapeForRegExp(baseName)}\\.(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?$`
  );
  return {
    filePath,
    baseName,
    dirName,
    archivePattern,
    maxBytesPerFragment:
      options?.maxBytesPerFragment ?? DEFAULT_MAX_LOG_FRAGMENT_BYTES,
    maxDays: options?.maxDays ?? DEFAULT_MAX_LOG_DAYS,
    maxTotalBytes: options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_LOG_BYTES,
    onError: options?.onError,
  };
}

function toDateStamp(d: Date | undefined | null): string {
  // Local-time YYYY-MM-DD. Local is friendlier for grepping by "today"
  // than UTC; the worst-case mismatch is a single archive that straddles
  // midnight, which is harmless. Falls back to today when the input is
  // unusable so we never throw out of rotation.
  const safe = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
  const y = safe.getFullYear();
  const m = String(safe.getMonth() + 1).padStart(2, '0');
  const day = String(safe.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayStamp(): string {
  return toDateStamp(new Date());
}

function buildArchivePath(
  options: ResolvedRotationOptions,
  date: string,
  fragment: number
): string {
  const suffix = fragment === 0 ? '' : `.${fragment}`;
  return `${options.filePath}.${date}${suffix}`;
}

async function listArchivesAsync(
  options: ResolvedRotationOptions
): Promise<ArchiveEntry[]> {
  let entries: string[] = [];
  try {
    entries = await fsAsync.readdir(options.dirName);
  } catch (error) {
    if (!isMissingFileError(error)) {
      swallowRotationError(RotationSyscall.Readdir, error, options.onError);
    }
    return [];
  }
  const matches: ArchiveEntry[] = [];
  for (const entry of entries) {
    const match = options.archivePattern.exec(entry);
    if (!match) continue;
    const fullPath = path.join(options.dirName, entry);
    let size = 0;
    try {
      const stat = await fsAsync.stat(fullPath);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch (error) {
      if (!isMissingFileError(error)) {
        swallowRotationError(RotationSyscall.Stat, error, options.onError);
      }
      continue;
    }
    matches.push({
      date: match[1],
      fragment: match[2] ? Number.parseInt(match[2], 10) : 0,
      fullPath,
      size,
    });
  }
  return matches;
}

function listArchivesSync(options: ResolvedRotationOptions): ArchiveEntry[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(options.dirName);
  } catch (error) {
    if (!isMissingFileError(error)) {
      swallowRotationError(RotationSyscall.Readdir, error, options.onError);
    }
    return [];
  }
  const matches: ArchiveEntry[] = [];
  for (const entry of entries) {
    const match = options.archivePattern.exec(entry);
    if (!match) continue;
    const fullPath = path.join(options.dirName, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      matches.push({
        date: match[1],
        fragment: match[2] ? Number.parseInt(match[2], 10) : 0,
        fullPath,
        size: stat.size,
      });
    } catch (error) {
      if (!isMissingFileError(error)) {
        swallowRotationError(RotationSyscall.Stat, error, options.onError);
      }
    }
  }
  return matches;
}

function nextFragmentForDate(archives: ArchiveEntry[], date: string): number {
  let next = 0;
  for (const a of archives) {
    if (a.date !== date) continue;
    if (a.fragment >= next) next = a.fragment + 1;
  }
  return next;
}

function groupByDate(archives: ArchiveEntry[]): Map<string, ArchiveEntry[]> {
  const byDate = new Map<string, ArchiveEntry[]>();
  for (const a of archives) {
    const list = byDate.get(a.date);
    if (list) {
      list.push(a);
    } else {
      byDate.set(a.date, [a]);
    }
  }
  return byDate;
}

function sortedDatesAscending(byDate: Map<string, ArchiveEntry[]>): string[] {
  return [...byDate.keys()].sort();
}

async function pruneAsync(
  options: ResolvedRotationOptions,
  archives: ArchiveEntry[],
  activeSize: number
): Promise<void> {
  const byDate = groupByDate(archives);
  let total = activeSize + archives.reduce((sum, a) => sum + a.size, 0);

  const dates = sortedDatesAscending(byDate);
  for (const date of dates) {
    const distinctDays = byDate.size;
    if (distinctDays <= options.maxDays && total <= options.maxTotalBytes) {
      return;
    }
    const group = byDate.get(date);
    if (!group) continue;
    for (const archive of group) {
      try {
        await fsAsync.rm(archive.fullPath, { force: true });
        total -= archive.size;
      } catch (error) {
        swallowRotationError(RotationSyscall.Rm, error, options.onError);
      }
    }
    byDate.delete(date);
  }
}

function pruneSync(
  options: ResolvedRotationOptions,
  archives: ArchiveEntry[],
  activeSize: number
): void {
  const byDate = groupByDate(archives);
  let total = activeSize + archives.reduce((sum, a) => sum + a.size, 0);

  const dates = sortedDatesAscending(byDate);
  for (const date of dates) {
    const distinctDays = byDate.size;
    if (distinctDays <= options.maxDays && total <= options.maxTotalBytes) {
      return;
    }
    const group = byDate.get(date);
    if (!group) continue;
    for (const archive of group) {
      try {
        fs.rmSync(archive.fullPath, { force: true });
        total -= archive.size;
      } catch (error) {
        swallowRotationError(RotationSyscall.Rm, error, options.onError);
      }
    }
    byDate.delete(date);
  }
}

/**
 * Rotate a log file using a daily-primary, size-secondary scheme.
 *
 * Filename layout under the same directory:
 *   <filePath>                    -- the active file being appended to
 *   <filePath>.YYYY-MM-DD         -- archive for that day (single fragment)
 *   <filePath>.YYYY-MM-DD.N       -- additional within-day fragment (N>=1)
 *
 * On every call the engine will, in order:
 *   1. List sibling archives matching `<base>.YYYY-MM-DD[.N]` and prune
 *      the oldest day in full until at most `maxDays` distinct days
 *      remain and total on-disk bytes fit within `maxTotalBytes`. We
 *      prune entire days at a time so the retained window never has
 *      gaps inside a day. Retention is count-based, not age-based: an
 *      old archive survives while fewer than `maxDays` dated days
 *      exist, preserving history for infrequent users.
 *   2. If the active file's mtime falls on a date earlier than today,
 *      rename it to `<base>.<mtimeDate>[.N]` so the new day starts
 *      with a fresh active file.
 *   3. If the (still active) file is at least `maxBytesPerFragment`
 *      bytes, rename it to `<base>.<today>[.N]` so the day's history is
 *      fragmented rather than dropped.
 *
 * Best-effort: every fs error is swallowed and surfaced via the
 * optional `onError` hook; the engine itself never throws so logging
 * cannot crash the host process.
 */
export async function rotateLogFileIfNeeded(
  filePath: string,
  options?: LogRotationOptions
): Promise<void> {
  const resolved = resolveOptions(filePath, options);

  let activeStat: fs.Stats | null = null;
  try {
    activeStat = await fsAsync.stat(resolved.filePath);
    if (!activeStat.isFile()) activeStat = null;
  } catch (error) {
    if (!isMissingFileError(error)) {
      swallowRotationError(RotationSyscall.Stat, error, resolved.onError);
    }
  }

  const archives = await listArchivesAsync(resolved);
  await pruneAsync(resolved, archives, activeStat?.size ?? 0);

  if (!activeStat) return;

  const today = todayStamp();
  const fileDate = toDateStamp(activeStat.mtime);

  if (fileDate !== today) {
    const fragment = nextFragmentForDate(archives, fileDate);
    const target = buildArchivePath(resolved, fileDate, fragment);
    try {
      await fsAsync.rename(resolved.filePath, target);
    } catch (error) {
      if (!isMissingFileError(error)) {
        swallowRotationError(RotationSyscall.Rename, error, resolved.onError);
      }
    }
    return;
  }

  if (activeStat.size < resolved.maxBytesPerFragment) return;

  const fragment = nextFragmentForDate(archives, today);
  const target = buildArchivePath(resolved, today, fragment);
  try {
    await fsAsync.rename(resolved.filePath, target);
  } catch (error) {
    if (!isMissingFileError(error)) {
      swallowRotationError(RotationSyscall.Rename, error, resolved.onError);
    }
  }
}

/**
 * Synchronous variant of {@link rotateLogFileIfNeeded}. Intended for
 * the earliest bootstrap paths (e.g. console patching) that run before
 * the async logging infrastructure is initialized.
 */
export function rotateLogFileIfNeededSync(
  filePath: string,
  options?: LogRotationOptions
): void {
  const resolved = resolveOptions(filePath, options);

  let activeStat: fs.Stats | null = null;
  try {
    activeStat = fs.statSync(resolved.filePath);
    if (!activeStat.isFile()) activeStat = null;
  } catch (error) {
    if (!isMissingFileError(error)) {
      swallowRotationError(RotationSyscall.Stat, error, resolved.onError);
    }
  }

  const archives = listArchivesSync(resolved);
  pruneSync(resolved, archives, activeStat?.size ?? 0);

  if (!activeStat) return;

  const today = todayStamp();
  const fileDate = toDateStamp(activeStat.mtime);

  if (fileDate !== today) {
    const fragment = nextFragmentForDate(archives, fileDate);
    const target = buildArchivePath(resolved, fileDate, fragment);
    try {
      fs.renameSync(resolved.filePath, target);
    } catch (error) {
      if (!isMissingFileError(error)) {
        swallowRotationError(RotationSyscall.Rename, error, resolved.onError);
      }
    }
    return;
  }

  if (activeStat.size < resolved.maxBytesPerFragment) return;

  const fragment = nextFragmentForDate(archives, today);
  const target = buildArchivePath(resolved, today, fragment);
  try {
    fs.renameSync(resolved.filePath, target);
  } catch (error) {
    if (!isMissingFileError(error)) {
      swallowRotationError(RotationSyscall.Rename, error, resolved.onError);
    }
  }
}
