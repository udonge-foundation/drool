import fs from 'fs/promises';
import path from 'path';

import { logException, logInfo, logWarn } from '@industry/logging';

import { DEFAULT_SNAPSHOT_SETTINGS } from '@/services/snapshots/constants';
import { FileSnapshotStore } from '@/services/snapshots/FileSnapshotStore';
import { SessionSnapshotManifest } from '@/services/snapshots/SessionSnapshotManifest';
import type {
  BoundaryQueueEntry,
  EvictionResult,
  GlobalSnapshotIndex,
  SnapshotSettings,
} from '@/services/snapshots/types';

const INDEX_FILENAME = '.index.json';

// Eviction thresholds
const EVICTION_TRIGGER_THRESHOLD = 0.9; // Start evicting at 90%
const EVICTION_TARGET_THRESHOLD = 0.7; // Evict down to 70%

interface EvictionManagerConfig {
  indexDir: string;
  contentStore: FileSnapshotStore;
  manifestDir: string;
  settings?: SnapshotSettings;
}

/**
 * Manages FIFO eviction of snapshot boundaries across all sessions.
 *
 * Maintains a global queue of boundaries ordered by timestamp (oldest first).
 * When storage limits are reached, evicts oldest boundaries while protecting
 * the active session and maintaining minimum boundaries per session.
 */
export class SnapshotEvictionManager {
  private indexDir: string;

  private indexPath: string;

  private contentStore: FileSnapshotStore;

  private manifestDir: string;

  private settings: SnapshotSettings;

  private index: GlobalSnapshotIndex;

  private initialized = false;

  // Cache of loaded manifests
  private manifestCache = new Map<string, SessionSnapshotManifest>();

  constructor(config: EvictionManagerConfig) {
    this.indexDir = config.indexDir;
    this.indexPath = path.join(config.indexDir, INDEX_FILENAME);
    this.contentStore = config.contentStore;
    this.manifestDir = config.manifestDir;
    this.settings = config.settings ?? DEFAULT_SNAPSHOT_SETTINGS;
    this.index = this.createEmptyIndex();
  }

  private createEmptyIndex(): GlobalSnapshotIndex {
    return {
      version: 1,
      lastCleanupAt: Date.now(),
      totalSizeBytes: 0,
      boundaryQueue: [],
    };
  }

  /**
   * Initialize the eviction manager, loading existing index if available.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure index directory exists
    await fs.mkdir(this.indexDir, { recursive: true });

    // Load existing index or start fresh
    try {
      const content = await fs.readFile(this.indexPath, 'utf-8');
      this.index = JSON.parse(content) as GlobalSnapshotIndex;
      logInfo('[SnapshotEvictionManager] Loaded existing index', {
        count: this.index.boundaryQueue.length,
        sizeBytes: this.index.totalSizeBytes,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logWarn('[SnapshotEvictionManager] Corrupted index, starting fresh', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      this.index = this.createEmptyIndex();
    }

    this.initialized = true;
  }

  /**
   * Get the global index data.
   */
  getGlobalIndex(): GlobalSnapshotIndex {
    this.ensureInitialized();
    return this.index;
  }

  /**
   * Get total size of all tracked boundaries.
   */
  getTotalSize(): number {
    this.ensureInitialized();
    return this.index.totalSizeBytes;
  }

  /**
   * Get number of boundaries in the queue.
   */
  getQueueLength(): number {
    this.ensureInitialized();
    return this.index.boundaryQueue.length;
  }

  /**
   * Get number of boundaries for a specific session.
   */
  getSessionBoundaryCount(sessionId: string): number {
    this.ensureInitialized();
    return this.index.boundaryQueue.filter((e) => e.sessionId === sessionId)
      .length;
  }

  /**
   * Add a new boundary to the eviction queue.
   * Triggers eviction if storage threshold is exceeded.
   */
  async addBoundary(entry: BoundaryQueueEntry): Promise<void> {
    this.ensureInitialized();

    // Insert in sorted order by timestamp (oldest first)
    const insertIndex = this.index.boundaryQueue.findIndex(
      (e) => e.timestamp > entry.timestamp
    );

    if (insertIndex === -1) {
      this.index.boundaryQueue.push(entry);
    } else {
      this.index.boundaryQueue.splice(insertIndex, 0, entry);
    }

    this.index.totalSizeBytes += entry.sizeBytes;

    await this.save();

    // Check if eviction needed
    const limitBytes = this.settings.storageLimitMB * 1024 * 1024;
    if (this.index.totalSizeBytes > limitBytes * EVICTION_TRIGGER_THRESHOLD) {
      await this.checkAndEvict();
    }
  }

  /**
   * Check storage and evict oldest boundaries if needed.
   * @param activeSessionId - Session ID to protect from eviction (optional)
   */
  async checkAndEvict(activeSessionId?: string): Promise<EvictionResult> {
    this.ensureInitialized();

    const limitBytes = this.settings.storageLimitMB * 1024 * 1024;
    const targetBytes = limitBytes * EVICTION_TARGET_THRESHOLD;

    const result: EvictionResult = {
      evictedCount: 0,
      freedBytes: 0,
      affectedSessions: [],
    };

    // Nothing to evict if under threshold
    if (this.index.totalSizeBytes <= limitBytes * EVICTION_TRIGGER_THRESHOLD) {
      return result;
    }

    const affectedSessionsSet = new Set<string>();
    const sessionBoundaryCounts = new Map<string, number>();

    // Count boundaries per session
    for (const entry of this.index.boundaryQueue) {
      const count = sessionBoundaryCounts.get(entry.sessionId) ?? 0;
      sessionBoundaryCounts.set(entry.sessionId, count + 1);
    }

    // Track which entries to remove
    const indicesToRemove: number[] = [];
    let currentIndex = 0;

    while (
      this.index.totalSizeBytes > targetBytes &&
      currentIndex < this.index.boundaryQueue.length
    ) {
      const entry = this.index.boundaryQueue[currentIndex];

      // Skip active session unless it's the only option
      if (entry.sessionId === activeSessionId) {
        const nonActiveEntries = this.index.boundaryQueue.filter(
          (e, i) =>
            e.sessionId !== activeSessionId && !indicesToRemove.includes(i)
        );
        if (nonActiveEntries.length > 0) {
          currentIndex++;
          continue;
        }
      }

      // Check minimum boundaries protection
      const sessionCount = sessionBoundaryCounts.get(entry.sessionId) ?? 0;
      if (sessionCount <= this.settings.minBoundariesPerSession) {
        // Only skip if there are other sessions we can evict from
        const otherSessions = Array.from(
          sessionBoundaryCounts.entries()
        ).filter(
          ([sid, count]) =>
            sid !== entry.sessionId &&
            count > this.settings.minBoundariesPerSession
        );
        if (otherSessions.length > 0) {
          currentIndex++;
          continue;
        }
      }

      // Mark for eviction
      indicesToRemove.push(currentIndex);
      this.index.totalSizeBytes -= entry.sizeBytes;
      result.freedBytes += entry.sizeBytes;
      result.evictedCount++;
      affectedSessionsSet.add(entry.sessionId);

      // Decrement session boundary count
      sessionBoundaryCounts.set(entry.sessionId, sessionCount - 1);

      // Decrement content references
      for (const hash of entry.contentHashes) {
        await this.contentStore.decrementRef(hash);
      }

      // Update session manifest
      await this.updateManifestEviction(entry.sessionId, entry.boundaryIndex);

      currentIndex++;
    }

    // Remove evicted entries (in reverse order to maintain indices)
    for (let i = indicesToRemove.length - 1; i >= 0; i--) {
      this.index.boundaryQueue.splice(indicesToRemove[i], 1);
    }

    // Run garbage collection on content store
    if (result.evictedCount > 0) {
      await this.contentStore.cleanup();
      this.index.lastCleanupAt = Date.now();
    }

    result.affectedSessions = Array.from(affectedSessionsSet);

    await this.save();

    if (result.evictedCount > 0) {
      logInfo('[SnapshotEvictionManager] Eviction completed', {
        count: result.evictedCount,
        sizeBytes: result.freedBytes,
        sessionIds: result.affectedSessions,
      });
    }

    return result;
  }

  /**
   * Remove all boundaries for a session.
   */
  async removeSession(sessionId: string): Promise<void> {
    this.ensureInitialized();

    const entriesToRemove = this.index.boundaryQueue.filter(
      (e) => e.sessionId === sessionId
    );

    // Decrement content references
    for (const entry of entriesToRemove) {
      for (const hash of entry.contentHashes) {
        await this.contentStore.decrementRef(hash);
      }
      this.index.totalSizeBytes -= entry.sizeBytes;
    }

    // Remove from queue
    this.index.boundaryQueue = this.index.boundaryQueue.filter(
      (e) => e.sessionId !== sessionId
    );

    // Clear from manifest cache
    this.manifestCache.delete(sessionId);

    await this.save();
  }

  /**
   * Save the global index to disk.
   */
  async save(): Promise<void> {
    this.ensureInitialized();

    try {
      await fs.writeFile(this.indexPath, JSON.stringify(this.index, null, 2));
    } catch (error) {
      logException(error, '[SnapshotEvictionManager] Failed to save index');
    }
  }

  private async updateManifestEviction(
    sessionId: string,
    boundaryIndex: number
  ): Promise<void> {
    try {
      let manifest = this.manifestCache.get(sessionId);

      if (!manifest) {
        manifest = new SessionSnapshotManifest(this.manifestDir, sessionId);
        await manifest.initialize();
        this.manifestCache.set(sessionId, manifest);
      }

      manifest.markBoundaryEvicted(boundaryIndex);
      await manifest.save();
    } catch (error) {
      logWarn('[SnapshotEvictionManager] Failed to update manifest eviction', {
        sessionId,
        index: boundaryIndex,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'SnapshotEvictionManager not initialized. Call initialize() first.'
      );
    }
  }
}
