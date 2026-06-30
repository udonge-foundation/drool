import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { logException, logInfo, logWarn } from '@industry/logging';

import type {
  ContentStoreMetadata,
  ContentStoreStats,
} from '@/services/snapshots/types';

const METADATA_FILENAME = '.metadata.json';

// Simple in-memory lock for handling concurrent writes
const locks = new Map<string, Promise<unknown>>();

/**
 * Content-addressable storage for file snapshots.
 *
 * Files are stored by their SHA-256 hash in a sharded directory structure
 * (first 2 characters of hash as subdirectory) for efficient filesystem access.
 *
 * Reference counting enables safe garbage collection of unreferenced content.
 */
export class FileSnapshotStore {
  private baseDir: string;

  private metadata: ContentStoreMetadata;

  private metadataPath: string;

  private initialized = false;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.metadataPath = path.join(baseDir, METADATA_FILENAME);
    this.metadata = this.createEmptyMetadata();
  }

  private createEmptyMetadata(): ContentStoreMetadata {
    return {
      version: 1,
      refCounts: {},
      totalSizeBytes: 0,
      lastGCAt: Date.now(),
    };
  }

  /**
   * Initialize the store, creating directories and loading existing metadata.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure base directory exists
    await fs.mkdir(this.baseDir, { recursive: true });

    // Load existing metadata or start fresh
    try {
      const content = await fs.readFile(this.metadataPath, 'utf-8');
      this.metadata = JSON.parse(content) as ContentStoreMetadata;
      logInfo('[FileSnapshotStore] Loaded existing metadata', {
        fileCount: Object.keys(this.metadata.refCounts).length,
      });
    } catch (error) {
      // File doesn't exist or is corrupted - start fresh
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logWarn('[FileSnapshotStore] Corrupted metadata, starting fresh', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      this.metadata = this.createEmptyMetadata();
    }

    this.initialized = true;
  }

  /**
   * Store content and return its SHA-256 hash.
   * Automatically deduplicates identical content.
   */
  async storeContent(content: string | Buffer): Promise<string> {
    this.ensureInitialized();

    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Use a lock to handle concurrent writes to same content
    return this.withLock(hash, async () => {
      // Check if content already exists (deduplication)
      if (this.metadata.refCounts[hash] !== undefined) {
        // Increment reference count
        this.metadata.refCounts[hash]++;
        await this.saveMetadata();
        return hash;
      }

      // Store new content
      const subdir = hash.slice(0, 2);
      const filename = hash.slice(2);
      const dirPath = path.join(this.baseDir, subdir);
      const filePath = path.join(dirPath, filename);

      await fs.mkdir(dirPath, { recursive: true });
      await fs.writeFile(filePath, buffer);

      // Update metadata
      this.metadata.refCounts[hash] = 1;
      this.metadata.totalSizeBytes += buffer.length;
      await this.saveMetadata();

      return hash;
    });
  }

  /**
   * Retrieve content by its hash.
   * Returns null if content doesn't exist.
   */
  async getContent(hash: string): Promise<string | null> {
    this.ensureInitialized();

    // Validate hash format
    if (!hash || hash.length !== 64 || !/^[a-f0-9]+$/.test(hash)) {
      return null;
    }

    const subdir = hash.slice(0, 2);
    const filename = hash.slice(2);
    const filePath = path.join(this.baseDir, subdir, filename);

    try {
      // Read as buffer first to preserve binary content
      const buffer = await fs.readFile(filePath);
      return buffer.toString('utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Check if content exists in the store.
   */
  async hasContent(hash: string): Promise<boolean> {
    this.ensureInitialized();

    // Validate hash format
    if (!hash || hash.length !== 64 || !/^[a-f0-9]+$/.test(hash)) {
      return false;
    }

    const subdir = hash.slice(0, 2);
    const filename = hash.slice(2);
    const filePath = path.join(this.baseDir, subdir, filename);

    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the reference count for a content hash.
   */
  async getRefCount(hash: string): Promise<number> {
    this.ensureInitialized();
    return this.metadata.refCounts[hash] ?? 0;
  }

  /**
   * Increment the reference count for a content hash.
   */
  async incrementRef(hash: string): Promise<void> {
    this.ensureInitialized();

    if (this.metadata.refCounts[hash] !== undefined) {
      this.metadata.refCounts[hash]++;
      await this.saveMetadata();
    }
    // Silently ignore if hash doesn't exist
  }

  /**
   * Decrement the reference count for a content hash.
   * Does not delete the content - use cleanup() for that.
   */
  async decrementRef(hash: string): Promise<void> {
    this.ensureInitialized();

    if (this.metadata.refCounts[hash] !== undefined) {
      this.metadata.refCounts[hash] = Math.max(
        0,
        this.metadata.refCounts[hash] - 1
      );
      await this.saveMetadata();
    }
    // Silently ignore if hash doesn't exist
  }

  /**
   * Garbage collect content with zero references.
   * Returns the number of files deleted and bytes freed.
   */
  async cleanup(): Promise<{ deletedCount: number; freedBytes: number }> {
    this.ensureInitialized();

    let deletedCount = 0;
    let freedBytes = 0;
    const hashesToDelete: string[] = [];

    // Find all hashes with zero references
    for (const [hash, refCount] of Object.entries(this.metadata.refCounts)) {
      if (refCount === 0) {
        hashesToDelete.push(hash);
      }
    }

    // Delete the content files
    for (const hash of hashesToDelete) {
      const subdir = hash.slice(0, 2);
      const filename = hash.slice(2);
      const filePath = path.join(this.baseDir, subdir, filename);

      try {
        const stats = await fs.stat(filePath);
        freedBytes += stats.size;

        await fs.unlink(filePath);
        deletedCount++;

        // Try to remove empty subdirectory
        const subdirPath = path.join(this.baseDir, subdir);
        try {
          const files = await fs.readdir(subdirPath);
          if (files.length === 0) {
            await fs.rmdir(subdirPath);
          }
        } catch (error) {
          logWarn('Failed to remove subdirectory after deleting content', {
            path: subdirPath,
            cause: error,
          });
        }
      } catch (error) {
        logWarn('[FileSnapshotStore] Failed to delete content', {
          key: hash,
          cause: error,
        });
      }

      // Remove from metadata
      delete this.metadata.refCounts[hash];
    }

    // Update metadata
    this.metadata.totalSizeBytes = Math.max(
      0,
      this.metadata.totalSizeBytes - freedBytes
    );
    this.metadata.lastGCAt = Date.now();
    await this.saveMetadata();

    if (deletedCount > 0) {
      logInfo('[FileSnapshotStore] Garbage collection completed', {
        count: deletedCount,
        sizeBytes: freedBytes,
      });
    }

    return { deletedCount, freedBytes };
  }

  /**
   * Get storage statistics.
   */
  async getStats(): Promise<ContentStoreStats> {
    this.ensureInitialized();

    const uniqueHashes = Object.keys(this.metadata.refCounts).length;

    return {
      totalSizeBytes: this.metadata.totalSizeBytes,
      fileCount: uniqueHashes,
      uniqueHashes,
    };
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'FileSnapshotStore not initialized. Call initialize() first.'
      );
    }
  }

  private async saveMetadata(): Promise<void> {
    try {
      await fs.writeFile(
        this.metadataPath,
        JSON.stringify(this.metadata, null, 2)
      );
    } catch (error) {
      logException(error, '[FileSnapshotStore] Failed to save metadata');
    }
  }

  /**
   * Simple lock mechanism for handling concurrent operations on the same key.
   */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any existing operation on this key
    const existing = locks.get(key);
    if (existing) {
      await existing.catch(() => {});
    }

    // Create new promise for this operation
    const promise = fn();
    locks.set(key, promise);

    try {
      return await promise;
    } finally {
      // Only remove if this is still the current lock
      if (locks.get(key) === promise) {
        locks.delete(key);
      }
    }
  }
}
