import fs from 'fs';
import path from 'path';

import { SESSION_TAG_BTW_FORK } from '@industry/common/session';
import { logException, logWarn } from '@industry/logging';
import { sanitizePathToDirectoryName } from '@industry/utils/sessionPaths';

import {
  getDecompSessionTypeFromTags,
  getMissionSessionTagMetadata,
} from '@/services/mission/sessionTags';
import type { SessionMetadata } from '@/services/types';
import {
  setSecureDirectoryPermissionsSync,
  setSecureFilePermissionsSync,
} from '@/utils/filePermissions';

import type { SessionSummaryEvent } from '@industry/common/session/summary';
import type { DecompSessionType } from '@industry/drool-sdk-ext/protocol/drool';
import type { SessionTag } from '@industry/drool-sdk-ext/protocol/session';

interface SessionDiscoveryQueryOptions {
  currentCwd?: string;
  fetchOutsideCWD?: boolean;
  includeArchived?: boolean;
}

interface FileFingerprint {
  mtimeMs: number;
  size: number;
}

interface DirectorySnapshot {
  sessionFiles: string[];
}

interface FavoritesSnapshot {
  exists: boolean;
  fingerprint?: FileFingerprint;
  sessionIds: string[];
}

interface PersistedSessionDiscoveryEntry {
  id: string;
  sessionPath: string;
  directoryPath: string;
  title: string;
  sessionTitle?: string;
  owner: string;
  messageCount: number;
  modifiedTimeMs: number;
  createdTimeMs: number;
  cwd?: string;
  isExec?: boolean;
  isBtwFork?: boolean;
  decompSessionType?: DecompSessionType;
  decompMissionId?: string;
  archivedAt?: string;
  sessionFingerprint: FileFingerprint;
  settingsFingerprint?: FileFingerprint;
}

interface SessionSettingsMetadata {
  archivedAt?: string;
  isExec?: boolean;
  isBtwFork?: boolean;
  decompSessionType?: DecompSessionType;
  decompMissionId?: string;
}

const EXEC_TAG_NAME = 'exec';

interface PersistedSessionDiscoveryIndexState {
  version: 1;
  sessionsDir: string;
  updatedAt: number;
  rootFingerprint?: FileFingerprint;
  projectDirectories: string[];
  directories: Record<string, DirectorySnapshot>;
  entries: Record<string, PersistedSessionDiscoveryEntry>;
  favorites: FavoritesSnapshot;
}

interface IndexedSessionContent {
  summary: SessionSummaryEvent;
  messageCount: number;
}

interface NormalizedStat {
  atime: Date;
  birthtime: Date;
  ctime: Date;
  mtime: Date;
  size: number;
}

function createEmptyState(
  sessionsDir: string
): PersistedSessionDiscoveryIndexState {
  return {
    version: 1,
    sessionsDir,
    updatedAt: Date.now(),
    projectDirectories: [],
    directories: {},
    entries: {},
    favorites: {
      exists: false,
      sessionIds: [],
    },
  };
}

function getFingerprint(stats: NormalizedStat): FileFingerprint {
  return {
    mtimeMs: stats.mtime.getTime(),
    size: stats.size,
  };
}

function sameFingerprint(
  left?: FileFingerprint,
  right?: FileFingerprint
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function getSettingsPath(sessionPath: string, sessionId: string): string {
  return path.join(path.dirname(sessionPath), `${sessionId}.settings.json`);
}

function readSessionContent(sessionPath: string): IndexedSessionContent | null {
  try {
    const content = fs.readFileSync(sessionPath, 'utf-8');
    const lines = content
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      return null;
    }

    const summary = JSON.parse(lines[0]) as SessionSummaryEvent;
    if (summary.type !== 'session_start') {
      return null;
    }

    return {
      summary,
      messageCount: Math.max(lines.length - 1, 0),
    };
  } catch {
    return null;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function readSessionSettingsMetadata(
  settingsPath: string
): SessionSettingsMetadata {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      archivedAt?: unknown;
      tags?: unknown;
    };

    const archivedAt =
      typeof settings.archivedAt === 'string' ? settings.archivedAt : undefined;

    const tags = Array.isArray(settings.tags)
      ? (settings.tags as SessionTag[])
      : [];
    const isExec = tags.some((tag) => {
      if (!isObjectRecord(tag)) {
        return false;
      }
      return tag.name === EXEC_TAG_NAME;
    });
    const isBtwFork = tags.some((tag) => {
      if (!isObjectRecord(tag)) {
        return false;
      }
      return tag.name === SESSION_TAG_BTW_FORK;
    });
    const missionTagMetadata = getMissionSessionTagMetadata(tags);

    return {
      archivedAt,
      isExec,
      isBtwFork,
      decompSessionType: getDecompSessionTypeFromTags(tags),
      decompMissionId: missionTagMetadata?.missionId,
    };
  } catch {
    return {};
  }
}

function readDirectoryEntries(directoryPath: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch (error) {
    logWarn('[SessionDiscoveryIndex] Failed to read directory', {
      directory: directoryPath,
      cause: error,
    });
    return null;
  }
}

function toDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date(0);
}

function normalizeStat(value: unknown): NormalizedStat {
  const stats = (value ?? {}) as Partial<fs.Stats>;
  return {
    atime: toDate(stats.atime),
    birthtime: toDate(stats.birthtime ?? stats.ctime),
    ctime: toDate(stats.ctime),
    mtime: toDate(stats.mtime),
    size: typeof stats.size === 'number' ? stats.size : 0,
  };
}

function safeStatSync(filePath: string): NormalizedStat | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return normalizeStat(fs.statSync(filePath));
  } catch {
    return null;
  }
}

function getEffectiveSessionCwd(entry: {
  cwd?: string;
  lastCwd?: string;
}): string | undefined {
  return entry.lastCwd ?? entry.cwd;
}

function isPersistedState(
  value: unknown,
  sessionsDir: string
): value is PersistedSessionDiscoveryIndexState {
  if (!isObjectRecord(value)) {
    return false;
  }

  const state = value as Partial<PersistedSessionDiscoveryIndexState>;
  const favorites = state.favorites as Partial<FavoritesSnapshot> | undefined;
  return (
    state.version === 1 &&
    state.sessionsDir === sessionsDir &&
    typeof state.updatedAt === 'number' &&
    Array.isArray(state.projectDirectories) &&
    isObjectRecord(state.directories) &&
    isObjectRecord(state.entries) &&
    isObjectRecord(favorites) &&
    typeof favorites.exists === 'boolean' &&
    Array.isArray(favorites.sessionIds)
  );
}

export class SessionDiscoveryIndex {
  private readonly sessionsDir: string;

  private readonly cachePath: string;

  private readonly favoritesPath: string;

  private loaded = false;

  private state: PersistedSessionDiscoveryIndexState;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
    this.cachePath = path.join(
      path.dirname(sessionsDir),
      'cache',
      'session-discovery-index.json'
    );
    this.favoritesPath = path.join(sessionsDir, '.favorites');
    this.state = createEmptyState(sessionsDir);
  }

  public querySessions(
    options?: SessionDiscoveryQueryOptions
  ): SessionMetadata[] {
    this.refreshIndex(options);

    return this.buildSessionQuery(options);
  }

  public queryCachedSessions(
    options?: SessionDiscoveryQueryOptions
  ): SessionMetadata[] {
    this.ensureLoaded();

    return this.buildSessionQuery(options);
  }

  private buildSessionQuery(
    options?: SessionDiscoveryQueryOptions
  ): SessionMetadata[] {
    const {
      currentCwd,
      fetchOutsideCWD = false,
      includeArchived = false,
    } = options || {};
    const allEntries = Object.values(this.state.entries);
    const favorites = new Set(this.state.favorites.sessionIds);

    const currentProjectSessions = currentCwd
      ? allEntries.filter(
          (entry) =>
            entry.cwd === currentCwd && (includeArchived || !entry.archivedAt)
        )
      : [];

    const otherSessions = allEntries.filter((entry) => {
      if (!includeArchived && entry.archivedAt) {
        return false;
      }
      if (currentCwd && entry.cwd === currentCwd) {
        return false;
      }
      if (entry.directoryPath === this.sessionsDir) {
        return true;
      }
      if (!fetchOutsideCWD) {
        return false;
      }
      if (currentCwd) {
        return entry.cwd !== currentCwd;
      }
      return true;
    });

    return [...currentProjectSessions, ...otherSessions]
      .filter((entry) => !entry.isBtwFork)
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        sessionTitle: entry.sessionTitle,
        owner: entry.owner,
        messageCount: entry.messageCount,
        modifiedTime: new Date(entry.modifiedTimeMs),
        createdTime: new Date(entry.createdTimeMs),
        isFavorite: favorites.has(entry.id),
        cwd: entry.cwd,
        isCurrentProject: currentCwd !== undefined && entry.cwd === currentCwd,
        ...(entry.isExec ? { isExec: true } : {}),
        ...(entry.isBtwFork ? { isBtwFork: true } : {}),
        decompSessionType: entry.decompSessionType,
        decompMissionId: entry.decompMissionId,
      }))
      .sort((a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime());
  }

  public noteSessionMutation(params: {
    sessionId: string;
    sessionPath: string;
    sessionSummary: SessionSummaryEvent;
    messageCount: number;
    sessionStats?: fs.Stats;
  }): void {
    this.ensureLoaded();

    const sessionStats =
      params.sessionStats ?? safeStatSync(params.sessionPath);
    if (!sessionStats) {
      return;
    }

    const settingsPath = getSettingsPath(params.sessionPath, params.sessionId);
    const settingsStats = safeStatSync(settingsPath);
    const settingsMetadata = settingsStats
      ? readSessionSettingsMetadata(settingsPath)
      : {};

    this.state.entries[params.sessionId] = {
      id: params.sessionId,
      sessionPath: params.sessionPath,
      directoryPath: path.dirname(params.sessionPath),
      title: params.sessionSummary.title,
      sessionTitle: params.sessionSummary.sessionTitle,
      owner: params.sessionSummary.owner,
      messageCount: params.messageCount,
      modifiedTimeMs: sessionStats.mtime.getTime(),
      createdTimeMs: (
        sessionStats.birthtime ||
        sessionStats.ctime ||
        sessionStats.mtime
      ).getTime(),
      cwd: getEffectiveSessionCwd(params.sessionSummary),
      isExec: settingsMetadata.isExec,
      isBtwFork: settingsMetadata.isBtwFork,
      decompSessionType: settingsStats
        ? settingsMetadata.decompSessionType
        : params.sessionSummary.decompSessionType,
      decompMissionId: settingsStats
        ? settingsMetadata.decompMissionId
        : params.sessionSummary.decompMissionId,
      archivedAt: settingsMetadata.archivedAt,
      sessionFingerprint: getFingerprint(sessionStats),
      settingsFingerprint: settingsStats
        ? getFingerprint(settingsStats)
        : undefined,
    };

    this.persistState();
  }

  public noteSessionSettingsMutation(params: {
    sessionId: string;
    sessionPath: string;
  }): void {
    this.ensureLoaded();

    const entry = this.state.entries[params.sessionId];
    if (!entry) {
      return;
    }

    const settingsPath = getSettingsPath(params.sessionPath, params.sessionId);
    const settingsStats = safeStatSync(settingsPath);
    const settingsMetadata = settingsStats
      ? readSessionSettingsMetadata(settingsPath)
      : {};
    const sessionSummary = readSessionContent(params.sessionPath)?.summary;

    entry.archivedAt = settingsMetadata.archivedAt;
    entry.isExec = settingsMetadata.isExec;
    entry.isBtwFork = settingsMetadata.isBtwFork;
    entry.decompSessionType = settingsStats
      ? settingsMetadata.decompSessionType
      : sessionSummary?.decompSessionType;
    entry.decompMissionId = settingsStats
      ? settingsMetadata.decompMissionId
      : sessionSummary?.decompMissionId;
    entry.settingsFingerprint = settingsStats
      ? getFingerprint(settingsStats)
      : undefined;

    this.persistState();
  }

  public noteFavoritesMutation(favoriteIds: Set<string>): void {
    this.ensureLoaded();

    const favoritesStats = safeStatSync(this.favoritesPath);
    this.state.favorites = {
      exists: favoritesStats !== null,
      fingerprint: favoritesStats ? getFingerprint(favoritesStats) : undefined,
      sessionIds: Array.from(favoriteIds),
    };

    this.persistState();
  }

  private refreshIndex(options?: SessionDiscoveryQueryOptions): void {
    this.ensureLoaded();

    if (!fs.existsSync(this.sessionsDir)) {
      this.state = createEmptyState(this.sessionsDir);
      return;
    }

    let didChange = false;
    didChange = this.refreshRootDirectory() || didChange;

    const directoriesToRefresh = new Set<string>([this.sessionsDir]);
    if (options?.currentCwd) {
      directoriesToRefresh.add(this.getSessionsDirectory(options.currentCwd));
    }
    if (options?.fetchOutsideCWD) {
      for (const directoryPath of this.state.projectDirectories) {
        directoriesToRefresh.add(directoryPath);
      }
    }

    for (const directoryPath of directoriesToRefresh) {
      didChange = this.refreshTrackedDirectory(directoryPath) || didChange;
    }

    didChange = this.refreshFavorites() || didChange;

    if (didChange) {
      this.persistState();
    }
  }

  private refreshRootDirectory(): boolean {
    const entries = readDirectoryEntries(this.sessionsDir);
    if (!entries) {
      return false;
    }

    const globalSessionFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name)
      .sort();
    const projectDirectories = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('-'))
      .map((entry) => path.join(this.sessionsDir, entry.name))
      .sort();

    let changed = false;
    const previousDirectories = new Set(this.state.projectDirectories);
    const nextDirectories = new Set(projectDirectories);
    const previousRootSnapshot = this.state.directories[this.sessionsDir];
    const removedRootFiles = new Set(previousRootSnapshot?.sessionFiles ?? []);

    for (const fileName of globalSessionFiles) {
      removedRootFiles.delete(fileName);
    }

    for (const fileName of removedRootFiles) {
      const sessionId = fileName.replace(/\.jsonl$/, '');
      const existingEntry = this.state.entries[sessionId];
      if (
        existingEntry &&
        existingEntry.directoryPath === this.sessionsDir &&
        existingEntry.sessionPath === path.join(this.sessionsDir, fileName)
      ) {
        delete this.state.entries[sessionId];
        changed = true;
      }
    }

    for (const directoryPath of previousDirectories) {
      if (!nextDirectories.has(directoryPath)) {
        this.removeEntriesForDirectory(directoryPath);
        delete this.state.directories[directoryPath];
        changed = true;
      }
    }

    const nextRootSnapshot: DirectorySnapshot = {
      sessionFiles: globalSessionFiles,
    };

    if (
      !previousRootSnapshot ||
      previousRootSnapshot.sessionFiles.join('\n') !==
        nextRootSnapshot.sessionFiles.join('\n')
    ) {
      changed = true;
    }

    this.state.projectDirectories = projectDirectories;
    this.state.directories[this.sessionsDir] = nextRootSnapshot;

    return changed;
  }

  private refreshTrackedDirectory(directoryPath: string): boolean {
    const directoryExists = fs.existsSync(directoryPath);
    const previousSnapshot = this.state.directories[directoryPath];

    if (!directoryExists) {
      if (previousSnapshot || this.hasEntriesForDirectory(directoryPath)) {
        this.removeEntriesForDirectory(directoryPath);
        delete this.state.directories[directoryPath];
        this.state.projectDirectories = this.state.projectDirectories.filter(
          (entry) => entry !== directoryPath
        );
        return true;
      }
      return false;
    }

    const entries = readDirectoryEntries(directoryPath);
    if (!entries) {
      return false;
    }

    const nextSessionFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name)
      .sort();

    let changed = false;

    if (
      !previousSnapshot ||
      previousSnapshot.sessionFiles.join('\n') !== nextSessionFiles.join('\n')
    ) {
      changed = true;
    }

    const removedFiles = new Set(previousSnapshot?.sessionFiles ?? []);
    for (const fileName of nextSessionFiles) {
      removedFiles.delete(fileName);
    }

    for (const fileName of removedFiles) {
      const sessionId = fileName.replace(/\.jsonl$/, '');
      const existingEntry = this.state.entries[sessionId];
      if (
        existingEntry &&
        existingEntry.directoryPath === directoryPath &&
        existingEntry.sessionPath === path.join(directoryPath, fileName)
      ) {
        delete this.state.entries[sessionId];
        changed = true;
      }
    }

    const sessionFiles = nextSessionFiles;
    this.state.directories[directoryPath] = {
      sessionFiles,
    };

    for (const fileName of sessionFiles) {
      const sessionPath = path.join(directoryPath, fileName);
      changed = this.refreshSessionEntry(sessionPath) || changed;
    }

    return changed;
  }

  private refreshSessionEntry(sessionPath: string): boolean {
    const sessionId = path.basename(sessionPath, '.jsonl');
    const existingEntry = this.state.entries[sessionId];
    const sessionStats = safeStatSync(sessionPath);

    if (!sessionStats) {
      if (existingEntry) {
        delete this.state.entries[sessionId];
        return true;
      }
      return false;
    }

    const sessionFingerprint = getFingerprint(sessionStats);
    const settingsPath = getSettingsPath(sessionPath, sessionId);
    const settingsStats = safeStatSync(settingsPath);
    const settingsFingerprint = settingsStats
      ? getFingerprint(settingsStats)
      : undefined;

    const missingExecFlag =
      existingEntry !== undefined &&
      settingsStats !== null &&
      existingEntry.isExec === undefined;

    const sessionChanged =
      !existingEntry ||
      existingEntry.sessionPath !== sessionPath ||
      !sameFingerprint(existingEntry.sessionFingerprint, sessionFingerprint);
    const staleSettingsMetadataCleared =
      !settingsStats &&
      (existingEntry?.archivedAt !== undefined ||
        existingEntry?.isExec === true);
    const settingsChanged =
      !existingEntry ||
      missingExecFlag ||
      staleSettingsMetadataCleared ||
      !sameFingerprint(existingEntry.settingsFingerprint, settingsFingerprint);

    const settingsMetadata = settingsStats
      ? readSessionSettingsMetadata(settingsPath)
      : {};

    if (!sessionChanged && !settingsChanged) {
      return false;
    }

    if (sessionChanged) {
      const indexedContent = readSessionContent(sessionPath);
      if (!indexedContent) {
        if (existingEntry) {
          delete this.state.entries[sessionId];
          return true;
        }
        return false;
      }

      this.state.entries[sessionId] = {
        id: sessionId,
        sessionPath,
        directoryPath: path.dirname(sessionPath),
        title: indexedContent.summary.title,
        sessionTitle: indexedContent.summary.sessionTitle,
        owner: indexedContent.summary.owner,
        messageCount: indexedContent.messageCount,
        modifiedTimeMs: sessionStats.mtime.getTime(),
        createdTimeMs: (
          sessionStats.birthtime ||
          sessionStats.ctime ||
          sessionStats.mtime
        ).getTime(),
        cwd: getEffectiveSessionCwd(indexedContent.summary),
        isExec: settingsMetadata.isExec,
        isBtwFork: settingsMetadata.isBtwFork,
        decompSessionType: settingsStats
          ? settingsMetadata.decompSessionType
          : indexedContent.summary.decompSessionType,
        decompMissionId: settingsStats
          ? settingsMetadata.decompMissionId
          : indexedContent.summary.decompMissionId,
        archivedAt: settingsMetadata.archivedAt,
        sessionFingerprint,
        settingsFingerprint,
      };
      return true;
    }

    if (existingEntry) {
      existingEntry.archivedAt = settingsMetadata.archivedAt;
      existingEntry.isExec = settingsMetadata.isExec;
      existingEntry.isBtwFork = settingsMetadata.isBtwFork;
      existingEntry.decompSessionType = settingsStats
        ? settingsMetadata.decompSessionType
        : existingEntry.decompSessionType;
      existingEntry.decompMissionId = settingsStats
        ? settingsMetadata.decompMissionId
        : existingEntry.decompMissionId;
      existingEntry.settingsFingerprint = settingsFingerprint;
      return true;
    }

    return false;
  }

  private refreshFavorites(): boolean {
    const favoritesStats = safeStatSync(this.favoritesPath);
    const favoritesFingerprint = favoritesStats
      ? getFingerprint(favoritesStats)
      : undefined;

    if (
      this.state.favorites.exists === (favoritesStats !== null) &&
      sameFingerprint(this.state.favorites.fingerprint, favoritesFingerprint)
    ) {
      return false;
    }

    this.state.favorites = {
      exists: favoritesStats !== null,
      fingerprint: favoritesFingerprint,
      sessionIds: favoritesStats ? this.readFavoriteIds() : [],
    };
    return true;
  }

  private readFavoriteIds(): string[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.favoritesPath, 'utf-8'));
      return Array.isArray(raw)
        ? raw.filter((value): value is string => typeof value === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private getSessionsDirectory(cwd?: string): string {
    if (!cwd) {
      return this.sessionsDir;
    }
    return path.join(this.sessionsDir, sanitizePathToDirectoryName(cwd));
  }

  private hasEntriesForDirectory(directoryPath: string): boolean {
    return Object.values(this.state.entries).some(
      (entry) => entry.directoryPath === directoryPath
    );
  }

  private removeEntriesForDirectory(directoryPath: string): void {
    for (const [sessionId, entry] of Object.entries(this.state.entries)) {
      if (entry.directoryPath === directoryPath) {
        delete this.state.entries[sessionId];
      }
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }

    this.loaded = true;

    if (!this.cacheFileExists()) {
      this.state = createEmptyState(this.sessionsDir);
      return;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
      if (!isPersistedState(raw, this.sessionsDir)) {
        this.state = createEmptyState(this.sessionsDir);
        return;
      }
      this.state = raw;
      for (const entry of Object.values(this.state.entries) as Array<
        PersistedSessionDiscoveryEntry & { lastCwd?: string }
      >) {
        entry.cwd = getEffectiveSessionCwd(entry);
        delete entry.lastCwd;
      }
    } catch (error) {
      logException(error, 'Failed to load session discovery index');
      this.state = createEmptyState(this.sessionsDir);
    }
  }

  private cacheFileExists(): boolean {
    const cacheDir = path.dirname(this.cachePath);

    try {
      if (!fs.existsSync(cacheDir)) {
        return false;
      }

      return fs.readdirSync(cacheDir).includes(path.basename(this.cachePath));
    } catch {
      return false;
    }
  }

  private persistState(): void {
    this.state.updatedAt = Date.now();

    try {
      const cacheDir = path.dirname(this.cachePath);
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
        setSecureDirectoryPermissionsSync(cacheDir);
      }

      fs.writeFileSync(this.cachePath, JSON.stringify(this.state, null, 2));
      setSecureFilePermissionsSync(this.cachePath);
    } catch (error) {
      logException(error, 'Failed to persist session discovery index');
    }
  }
}
