import fs from 'fs/promises';
import path from 'path';

import { logException, logInfo, logWarn } from '@industry/logging';

import type {
  FileCreation,
  FileDeletion,
  FileSnapshot,
  MessageBoundarySnapshot,
  SessionSnapshotManifestData as ManifestData,
} from '@/services/snapshots/types';

interface ManifestOptions {
  autoSave?: boolean;
}

/**
 * Manages the snapshot manifest for a single session.
 *
 * Tracks which files were modified at each message boundary (rewind point)
 * and maintains eviction state for storage management.
 */
export class SessionSnapshotManifest {
  private baseDir: string;

  private sessionId: string;

  private manifestPath: string;

  private data: ManifestData;

  private options: ManifestOptions;

  private initialized = false;

  // Write queue to serialize saves and prevent race conditions
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    baseDir: string,
    sessionId: string,
    options: ManifestOptions = {}
  ) {
    this.baseDir = baseDir;
    this.sessionId = sessionId;
    this.manifestPath = path.join(baseDir, `${sessionId}.snapshots.json`);
    this.options = options;
    this.data = this.createEmptyManifest();
  }

  private createEmptyManifest(): ManifestData {
    const now = Date.now();
    return {
      sessionId: this.sessionId,
      version: 1,
      createdAt: now,
      lastAccessedAt: now,
      boundaries: [],
      oldestAvailableBoundaryIndex: 0,
      evictedBoundaryCount: 0,
    };
  }

  /**
   * Initialize the manifest, loading existing data if available.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure base directory exists
    await fs.mkdir(this.baseDir, { recursive: true });

    // Load existing manifest or start fresh
    try {
      const content = await fs.readFile(this.manifestPath, 'utf-8');
      this.data = JSON.parse(content) as ManifestData;
      logInfo('[SessionSnapshotManifest] Loaded existing manifest', {
        sessionId: this.sessionId,
        count: this.data.boundaries.length,
      });
    } catch (error) {
      // File doesn't exist or is corrupted - start fresh

      if (
        typeof error === 'object' &&
        (error as NodeJS.ErrnoException)?.code !== 'ENOENT'
      ) {
        logWarn(
          '[SessionSnapshotManifest] Corrupted manifest, starting fresh',
          {
            sessionId: this.sessionId,
            cause: error,
          }
        );
      }
      this.data = this.createEmptyManifest();
    }

    this.initialized = true;
  }

  /**
   * Get the raw manifest data.
   */
  getData(): ManifestData {
    this.ensureInitialized();
    return this.data;
  }

  /**
   * Add a new boundary to the manifest.
   */
  async addBoundary(boundary: MessageBoundarySnapshot): Promise<void> {
    this.ensureInitialized();

    // Calculate totalSize if not set
    if (boundary.totalSize === undefined) {
      boundary.totalSize = boundary.files.reduce((sum, f) => sum + f.size, 0);
    }

    // Ensure deletions array exists
    if (!boundary.deletions) {
      boundary.deletions = [];
    }

    this.data.boundaries.push(boundary);
    this.data.lastAccessedAt = Date.now();

    if (this.options.autoSave) {
      await this.save();
    }
  }

  /**
   * Get a boundary by message ID.
   */
  getBoundaryByMessageId(
    messageId: string
  ): MessageBoundarySnapshot | undefined {
    this.ensureInitialized();
    return this.data.boundaries.find(
      (b: MessageBoundarySnapshot) => b.messageId === messageId
    );
  }

  /**
   * Get a boundary by index.
   */
  getBoundaryByIndex(index: number): MessageBoundarySnapshot | undefined {
    this.ensureInitialized();
    if (index < 0 || index >= this.data.boundaries.length) {
      return undefined;
    }
    return this.data.boundaries[index];
  }

  /**
   * Mark a boundary as evicted.
   * Only updates if this is the next boundary to evict (maintains contiguous eviction).
   */
  markBoundaryEvicted(boundaryIndex: number): void {
    this.ensureInitialized();

    // Only evict if this is the current oldest available boundary
    if (boundaryIndex === this.data.oldestAvailableBoundaryIndex) {
      this.data.oldestAvailableBoundaryIndex = boundaryIndex + 1;
      this.data.evictedBoundaryCount++;
    }
  }

  /**
   * Check if a boundary is still available (not evicted).
   */
  isBoundaryAvailable(boundaryIndex: number): boolean {
    this.ensureInitialized();
    return boundaryIndex >= this.data.oldestAvailableBoundaryIndex;
  }

  /**
   * Get all boundaries that haven't been evicted.
   */
  getAvailableBoundaries(): MessageBoundarySnapshot[] {
    this.ensureInitialized();
    return this.data.boundaries.slice(this.data.oldestAvailableBoundaryIndex);
  }

  /**
   * Get total size across all boundaries.
   */
  getTotalSize(): number {
    this.ensureInitialized();
    return this.data.boundaries.reduce(
      (sum: number, b: MessageBoundarySnapshot) => sum + b.totalSize,
      0
    );
  }

  /**
   * Get total number of boundaries.
   */
  getBoundaryCount(): number {
    this.ensureInitialized();
    return this.data.boundaries.length;
  }

  /**
   * Get number of available (non-evicted) boundaries.
   */
  getAvailableBoundaryCount(): number {
    this.ensureInitialized();
    return this.data.boundaries.length - this.data.oldestAvailableBoundaryIndex;
  }

  /**
   * Get all content hashes referenced by this manifest.
   */
  getAllContentHashes(): Set<string> {
    this.ensureInitialized();
    const hashes = new Set<string>();

    for (const boundary of this.data.boundaries) {
      for (const file of boundary.files) {
        hashes.add(file.contentHash);
      }
    }

    return hashes;
  }

  /**
   * Get content hashes for a specific boundary.
   */
  getContentHashesForBoundary(boundaryIndex: number): string[] {
    this.ensureInitialized();
    const boundary = this.data.boundaries[boundaryIndex];
    if (!boundary) return [];

    return boundary.files.map((f: FileSnapshot) => f.contentHash);
  }

  /**
   * Get the file state at a specific boundary.
   * Returns the latest version of each file up to and including that boundary.
   * Excludes files from evicted boundaries.
   */
  getFileStateAtBoundary(messageId: string): FileSnapshot[] {
    this.ensureInitialized();

    // Find the LAST boundary with this messageId (there may be multiple with immediate writes)
    let targetIndex = -1;
    for (let i = this.data.boundaries.length - 1; i >= 0; i--) {
      if (this.data.boundaries[i].messageId === messageId) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex === -1) return [];

    // Build map of latest file versions (path -> snapshot)
    const fileMap = new Map<string, FileSnapshot>();

    // Start from oldest available boundary
    const startIndex = this.data.oldestAvailableBoundaryIndex;

    for (let i = startIndex; i <= targetIndex; i++) {
      const boundary = this.data.boundaries[i];
      for (const file of boundary.files) {
        fileMap.set(file.filePath, file);
      }
    }

    return Array.from(fileMap.values());
  }

  /**
   * Get deleted files at a specific boundary.
   */
  getDeletedFilesAtBoundary(messageId: string): FileDeletion[] {
    this.ensureInitialized();

    // Find the LAST boundary with this messageId (there may be multiple with immediate writes)
    let targetIndex = -1;
    for (let i = this.data.boundaries.length - 1; i >= 0; i--) {
      if (this.data.boundaries[i].messageId === messageId) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex === -1) return [];

    // Collect deletions from oldest available to target
    const deletions: FileDeletion[] = [];
    const startIndex = this.data.oldestAvailableBoundaryIndex;

    for (let i = startIndex; i <= targetIndex; i++) {
      const boundary = this.data.boundaries[i];
      if (boundary.deletions) {
        deletions.push(...boundary.deletions);
      }
    }

    return deletions;
  }

  /**
   * Get files that were changed AT or AFTER a specific message boundary.
   * Used for rewind to show what files would be undone.
   * Returns the FIRST snapshot for each file starting from the target message.
   * This gives us the state BEFORE the changes were made (since we capture old content).
   */
  getFilesChangedAfterBoundary(messageId: string): FileSnapshot[] {
    this.ensureInitialized();

    // Find the FIRST boundary with this messageId (start of the message's changes)
    let targetIndex = -1;
    for (let i = 0; i < this.data.boundaries.length; i++) {
      if (this.data.boundaries[i].messageId === messageId) {
        targetIndex = i;
        break;
      }
    }
    // If not found, return empty (no files to undo)
    if (targetIndex === -1) return [];

    // Build map of files changed AT or AFTER the target boundary
    // We want the FIRST snapshot for each file (the state before any changes)
    const fileMap = new Map<string, FileSnapshot>();

    // Iterate from targetIndex to the end (include the target message itself)
    for (let i = targetIndex; i < this.data.boundaries.length; i++) {
      const boundary = this.data.boundaries[i];
      for (const file of boundary.files) {
        // Only keep the first occurrence (earliest snapshot = state before changes)
        if (!fileMap.has(file.filePath)) {
          fileMap.set(file.filePath, file);
        }
      }
    }

    return Array.from(fileMap.values());
  }

  /**
   * Get files that were created AT or AFTER a specific message boundary.
   * Used for rewind to show what files would be deleted.
   */
  getFilesCreatedAfterBoundary(messageId: string): FileCreation[] {
    this.ensureInitialized();

    // Find the FIRST boundary with this messageId
    let targetIndex = -1;
    for (let i = 0; i < this.data.boundaries.length; i++) {
      if (this.data.boundaries[i].messageId === messageId) {
        targetIndex = i;
        break;
      }
    }
    // If not found, return empty
    if (targetIndex === -1) return [];

    // Collect all creations from target to end, keeping only unique file paths
    const creationMap = new Map<string, FileCreation>();

    for (let i = targetIndex; i < this.data.boundaries.length; i++) {
      const boundary = this.data.boundaries[i];
      if (boundary.creations) {
        for (const creation of boundary.creations) {
          // Only keep the first creation for each path
          if (!creationMap.has(creation.filePath)) {
            creationMap.set(creation.filePath, creation);
          }
        }
      }
    }

    return Array.from(creationMap.values());
  }

  /**
   * Save the manifest to disk.
   * Uses a write queue to serialize saves and prevent race conditions.
   */
  async save(): Promise<void> {
    this.ensureInitialized();

    // Chain this save onto the write queue to serialize writes
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await fs.writeFile(
          this.manifestPath,
          JSON.stringify(this.data, null, 2)
        );
      } catch (error) {
        logException(
          error,
          '[SessionSnapshotManifest] Failed to save manifest'
        );
      }
    });

    // Wait for this save (and all queued before it) to complete
    await this.writeQueue;
  }

  /**
   * Delete the manifest file.
   */
  async delete(): Promise<void> {
    try {
      await fs.unlink(this.manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logException(
          error,
          '[SessionSnapshotManifest] Failed to delete manifest'
        );
      }
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'SessionSnapshotManifest not initialized. Call initialize() first.'
      );
    }
  }
}
