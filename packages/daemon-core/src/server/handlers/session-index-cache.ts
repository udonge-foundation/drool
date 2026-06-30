import * as fs from 'fs';
import * as path from 'path';

import { z } from 'zod';

import { SessionSummaryEventSchema } from '@industry/common/session/summary';
import { logInfo, logWarn } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { isErrnoException } from '@industry/utils/errors';

import type { SessionIndexEntry, PersistedSessionIndex } from './types';
import type { SessionSettings } from '@industry/common/session/settings';

const INDEX_FILE_NAME = 'sessions-index.json';
const FIRST_LINE_READ_BYTES = 4096;
const LINE_COUNT_CHUNK_SIZE = 64 * 1024;
const FILE_READ_CONCURRENCY = 50;
const FS_RETRY_ATTEMPTS = 3;
const FS_RETRY_BASE_DELAY_MS = 10;
const TRANSIENT_FS_ERROR_CODES = new Set([
  'EAGAIN',
  'EBUSY',
  'EINTR',
  'EMFILE',
  'ENFILE',
]);

type BuildEntryResult =
  | { type: 'entry'; entry: SessionIndexEntry }
  | { type: 'skip' }
  | { type: 'read_error'; cause: unknown };

type SessionSettingsMetadata = Pick<SessionSettings, 'archivedAt' | 'tags'>;

/**
 * Permissive schema that extracts only the metadata fields needed for indexing.
 * Uses .catch(undefined) so invalid fields degrade gracefully instead of
 * failing the entire parse.
 */
const PermissiveTagSchema = z.object({
  name: z.string().min(1),
  metadata: z.record(z.string()).optional().catch(undefined),
});

const SettingsMetadataSchema = z.object({
  archivedAt: z.string().optional().catch(undefined),
  tags: z
    .array(z.unknown())
    .optional()
    .catch(undefined)
    .transform((items) =>
      items
        ?.map((item) => PermissiveTagSchema.safeParse(item))
        .filter((r) => r.success)
        .map((r) => r.data)
    ),
});

// Compile-time check: ensure schema output stays compatible with SessionSettings.
// If the inferred type drifts, this line will produce a type error.
function _assertSchemaCompat(
  _: z.infer<typeof SettingsMetadataSchema>
): SessionSettingsMetadata {
  return _;
}

function getSessionSettingsPath(filePath: string): string {
  return filePath.replace('.jsonl', '.settings.json');
}

function mtimesEqual(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return Math.abs(a - b) < 1;
}

function getSessionsDir(): string {
  return path.join(getIndustryHome(), getIndustryDirName(), 'sessions');
}

function getIndexPath(): string {
  return path.join(getIndustryHome(), getIndustryDirName(), INDEX_FILE_NAME);
}

type OptionalStatResult = {
  stats: fs.Stats | null;
  hadReadError: boolean;
};

function isMissingFileError(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOENT';
}

function isTransientFsError(error: unknown): boolean {
  return (
    isErrnoException(error) &&
    typeof error.code === 'string' &&
    TRANSIENT_FS_ERROR_CODES.has(error.code)
  );
}

async function retryOnTransientFsError<T>(
  operation: () => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < FS_RETRY_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientFsError(error) || attempt === FS_RETRY_ATTEMPTS - 1) {
        throw error;
      }
      logWarn('[SessionIndexCache] Transient fs error, retrying', {
        cause: error,
      });
      // Back off briefly to allow in-flight fs operations and fd closes to complete.
      const delayMs = FS_RETRY_BASE_DELAY_MS * (attempt + 1);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
  throw lastError ?? new Error('Unexpected fs retry failure');
}

async function statSessionFile(filePath: string): Promise<fs.Stats | null> {
  try {
    return await retryOnTransientFsError(() => fs.promises.stat(filePath));
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

async function statOptionalFile(filePath: string): Promise<OptionalStatResult> {
  try {
    return {
      stats: await retryOnTransientFsError(() => fs.promises.stat(filePath)),
      hadReadError: false,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { stats: null, hadReadError: false };
    }
    logWarn('[SessionIndexCache] Failed to stat file', {
      filePath,
      errorMessage: isErrnoException(error) ? error.code : undefined,
      cause: error,
    });
    return { stats: null, hadReadError: true };
  }
}

/**
 * Reads the first line of a file and counts total non-empty lines efficiently.
 * Avoids reading the entire file into memory as a string.
 */
async function readSessionFileFast(
  filePath: string
): Promise<{ firstLine: string; lineCount: number } | null> {
  const read = async (): Promise<{
    firstLine: string;
    lineCount: number;
  } | null> => {
    let fd: fs.promises.FileHandle | null = null;
    try {
      fd = await fs.promises.open(filePath, 'r');

      // Read first chunk to extract the summary line
      const headBuf = Buffer.alloc(FIRST_LINE_READ_BYTES);
      const { bytesRead: headBytes } = await fd.read(
        headBuf,
        0,
        headBuf.length
      );
      if (headBytes === 0) return null;

      const headStr = headBuf.toString('utf-8', 0, headBytes);
      const firstNewline = headStr.indexOf('\n');
      if (firstNewline === -1) {
        // Single line file (or very long first line), count as 1 line
        return { firstLine: headStr.trim(), lineCount: 1 };
      }

      const firstLine = headStr.substring(0, firstNewline).trim();

      // Count newlines through the entire file using buffer scanning.
      // Start from the beginning so we get an accurate count.
      let lineCount = 0;
      let lastByteWasContent = false;
      const buf = Buffer.alloc(LINE_COUNT_CHUNK_SIZE);
      let position = 0;

      while (true) {
        const { bytesRead } = await fd.read(buf, 0, buf.length, position);
        if (bytesRead === 0) break;

        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] === 0x0a) {
            if (lastByteWasContent) lineCount++;
            lastByteWasContent = false;
          } else if (buf[i] !== 0x0d && buf[i] !== 0x20 && buf[i] !== 0x09) {
            lastByteWasContent = true;
          }
        }

        position += bytesRead;
        if (bytesRead < buf.length) break;
      }

      // Count last line if file doesn't end with newline
      if (lastByteWasContent) lineCount++;

      return { firstLine, lineCount };
    } finally {
      await fd?.close();
    }
  };

  try {
    return await retryOnTransientFsError(read);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

async function readSettingsFile(
  settingsPath: string
): Promise<SessionSettingsMetadata | null> {
  try {
    const content = await retryOnTransientFsError(() =>
      fs.promises.readFile(settingsPath, 'utf-8')
    );
    return SettingsMetadataSchema.parse(JSON.parse(content));
  } catch (error) {
    if (isErrnoException(error) && error.code !== 'ENOENT') {
      logWarn('[SessionIndexCache] Failed to read settings file', {
        filePath: settingsPath,
        errorMessage: error.code,
        cause: error,
      });
    }
    return null;
  }
}

/**
 * Scans the sessions directory for all .jsonl files.
 * Returns file paths and session IDs without reading content.
 */
function scanSessionFiles(): Array<{
  sessionId: string;
  filePath: string;
}> {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) return [];

  const result: Array<{ sessionId: string; filePath: string }> = [];

  try {
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });

    // Global session files
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        result.push({
          sessionId: entry.name.replace('.jsonl', ''),
          filePath: path.join(sessionsDir, entry.name),
        });
      }
    }

    // Project-specific directories (start with '-')
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('-')) {
        try {
          const projectFiles = fs.readdirSync(
            path.join(sessionsDir, entry.name),
            { withFileTypes: true }
          );
          for (const pf of projectFiles) {
            if (pf.isFile() && pf.name.endsWith('.jsonl')) {
              result.push({
                sessionId: pf.name.replace('.jsonl', ''),
                filePath: path.join(sessionsDir, entry.name, pf.name),
              });
            }
          }
        } catch (err) {
          // skip unreadable directories
          logWarn('[SessionIndexCache] Failed to read session directory', {
            cause: err,
          });
        }
      }
    }
  } catch (error) {
    logWarn('[SessionIndexCache] Failed to scan sessions directory', {
      cause: error,
    });
  }

  return result;
}

/**
 * Reads a single session file and produces an index entry.
 * Only reads the first line for metadata and counts lines efficiently.
 */
async function buildEntry(
  sessionId: string,
  filePath: string
): Promise<BuildEntryResult> {
  try {
    const settingsPath = getSessionSettingsPath(filePath);
    const [stats, fileData] = await Promise.all([
      statSessionFile(filePath),
      readSessionFileFast(filePath),
    ]);

    if (!stats || !fileData || fileData.lineCount <= 1) return { type: 'skip' };

    const settingsStatResult = await statOptionalFile(settingsPath);
    const settings =
      settingsStatResult.stats || settingsStatResult.hadReadError
        ? await readSettingsFile(settingsPath)
        : null;

    let title: string | undefined;
    let cwd: string | undefined;
    let hostId: string | undefined;
    let callingSessionId: string | undefined;
    let callingToolUseId: string | undefined;

    try {
      const summary = SessionSummaryEventSchema.parse(
        JSON.parse(fileData.firstLine)
      );
      title =
        summary.sessionTitle && summary.sessionTitle.trim().length > 0
          ? summary.sessionTitle
          : summary.title;
      cwd = summary.cwd;
      hostId = summary.hostId;
      callingSessionId = summary.callingSessionId;
      callingToolUseId = summary.callingToolUseId;
    } catch (err) {
      // parse error -- return entry without title
      logWarn('[SessionIndexCache] Failed to parse session summary', {
        cause: err,
      });
    }

    return {
      type: 'entry',
      entry: {
        sessionId,
        hostId,
        mtime: stats.mtimeMs,
        settingsMtime: settingsStatResult.stats?.mtimeMs,
        title,
        cwd,
        messagesCount: fileData.lineCount - 1,
        archivedAt: settings?.archivedAt,
        callingSessionId,
        callingToolUseId,
        tags: settings?.tags,
      },
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { type: 'skip' };
    }
    logWarn('[SessionIndexCache] Failed to read session entry', {
      cause: error,
    });
    return { type: 'read_error', cause: error };
  }
}

/**
 * In-memory cache for session filesystem metadata.
 *
 * First call: loads from persisted index file if available, then validates
 * mtimes against disk. Falls back to full scan on cache miss.
 *
 * Subsequent calls: only re-reads files whose mtime changed since last scan.
 * New/deleted files detected by comparing directory listing against cache keys.
 */

/**
 * Simple bounded concurrency runner.
 */
async function runPool(
  tasks: Array<() => Promise<void>>,
  concurrency: number
): Promise<void> {
  let i = 0;
  const run = async () => {
    while (i < tasks.length) {
      const task = tasks[i++]!;
      await task();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => run())
  );
}

function logRefreshSessionEntryError(
  sessionId: string,
  filePath: string,
  cause: unknown
): void {
  logWarn('[SessionIndexCache] Failed to refresh session entry', {
    sessionId,
    filePath,
    cause,
  });
}

class SessionIndexCache {
  private cache = new Map<string, SessionIndexEntry>();

  private initialized = false;

  private persistQueued = false;

  async getAll(): Promise<SessionIndexEntry[]> {
    if (!this.initialized) {
      await this.initialize();
    } else {
      await this.refresh();
    }
    return Array.from(this.cache.values());
  }

  /**
   * Invalidate and rebuild a single entry (called when daemon modifies a session).
   * Deletes the stale entry, rebuilds from disk, and queues a persist so the
   * updated entry survives a daemon restart.
   */
  async invalidate(sessionId: string): Promise<void> {
    this.cache.delete(sessionId);

    // Rebuild from disk so refresh() doesn't skip due to unchanged mtime
    const files = scanSessionFiles();
    const file = files.find((f) => f.sessionId === sessionId);
    if (file) {
      const result = await buildEntry(sessionId, file.filePath);
      if (result.type === 'entry') {
        this.cache.set(sessionId, result.entry);
      }
    }

    this.queuePersist();
  }

  private async initialize(): Promise<void> {
    const loaded = this.loadFromDisk();
    if (loaded) {
      await this.refresh();
    } else {
      await this.fullScan();
    }
    this.initialized = true;
    this.queuePersist();
  }

  private loadFromDisk(): boolean {
    try {
      const indexPath = getIndexPath();
      if (!fs.existsSync(indexPath)) return false;

      const raw = fs.readFileSync(indexPath, 'utf-8');
      const parsed: PersistedSessionIndex = JSON.parse(raw);
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        return false;
      }

      for (const entry of parsed.entries) {
        this.cache.set(entry.sessionId, entry);
      }
      logInfo('[SessionIndexCache] Loaded index from disk', {
        count: this.cache.size,
      });
      return true;
    } catch (err) {
      logWarn('[SessionIndexCache] Failed to load index from disk', {
        cause: err,
      });
      return false;
    }
  }

  /**
   * Refresh cache by stat-checking files and only re-reading changed ones.
   */
  private async refresh(): Promise<void> {
    const files = scanSessionFiles();
    const currentIds = new Set(files.map((f) => f.sessionId));

    // Remove deleted sessions
    for (const id of this.cache.keys()) {
      if (!currentIds.has(id)) {
        this.cache.delete(id);
      }
    }

    // Check mtimes and re-read changed/new files
    const tasks: Array<() => Promise<void>> = [];
    for (const { sessionId, filePath } of files) {
      const cached = this.cache.get(sessionId);
      tasks.push(async () => {
        try {
          const settingsPath = getSessionSettingsPath(filePath);
          const [stats, settingsStatResult] = await Promise.all([
            statSessionFile(filePath),
            statOptionalFile(settingsPath),
          ]);
          if (!stats) {
            this.cache.delete(sessionId);
            return;
          }

          const settingsMtime = settingsStatResult.stats?.mtimeMs;
          if (
            cached &&
            !settingsStatResult.hadReadError &&
            mtimesEqual(cached.mtime, stats.mtimeMs) &&
            mtimesEqual(cached.settingsMtime, settingsMtime)
          ) {
            return; // unchanged
          }
          const result = await buildEntry(sessionId, filePath);
          if (result.type === 'entry') {
            this.cache.set(sessionId, result.entry);
          } else if (result.type === 'skip') {
            this.cache.delete(sessionId);
          } else {
            logRefreshSessionEntryError(sessionId, filePath, result.cause);
            if (!cached) {
              this.cache.delete(sessionId);
            }
          }
        } catch (error) {
          logWarn('[SessionIndexCache] Error refreshing session entry', {
            cause: error,
          });
          logRefreshSessionEntryError(sessionId, filePath, error);
          if (!cached) {
            this.cache.delete(sessionId);
          }
        }
      });
    }

    // Run stat checks with bounded concurrency
    await runPool(tasks, FILE_READ_CONCURRENCY);
    this.queuePersist();
  }

  private async fullScan(): Promise<void> {
    const files = scanSessionFiles();
    this.cache.clear();

    const tasks: Array<() => Promise<void>> = files.map(
      ({ sessionId, filePath }) =>
        async () => {
          const result = await buildEntry(sessionId, filePath);
          if (result.type === 'entry') {
            this.cache.set(sessionId, result.entry);
          } else if (result.type === 'read_error') {
            logWarn('[SessionIndexCache] Failed to scan session entry', {
              sessionId,
              filePath,
              cause: result.cause,
            });
          }
        }
    );

    await runPool(tasks, FILE_READ_CONCURRENCY);
    logInfo('[SessionIndexCache] Full scan complete', {
      count: this.cache.size,
    });
  }

  private queuePersist(): void {
    if (this.persistQueued) return;
    this.persistQueued = true;
    // Debounce: write at most once per second
    setTimeout(() => {
      this.persistQueued = false;
      void this.persist();
    }, 1000);
  }

  private async persist(): Promise<void> {
    try {
      const data: PersistedSessionIndex = {
        version: 1,
        entries: Array.from(this.cache.values()),
      };
      const indexPath = getIndexPath();
      await fs.promises.writeFile(indexPath, JSON.stringify(data), 'utf-8');
    } catch (error) {
      logWarn('[SessionIndexCache] Failed to persist index', { cause: error });
    }
  }
}

/** Singleton instance */
export const sessionIndexCache = new SessionIndexCache();
