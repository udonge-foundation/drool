import fs from 'fs/promises';
import path from 'path';

import { logException, logInfo, logWarn } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { DEFAULT_SNAPSHOT_SETTINGS } from '@/services/snapshots/constants';
import { FileSnapshotStore } from '@/services/snapshots/FileSnapshotStore';
import { SessionSnapshotManifest } from '@/services/snapshots/SessionSnapshotManifest';
import { SnapshotEvictionManager } from '@/services/snapshots/SnapshotEvictionManager';
import type {
  BoundaryQueueEntry,
  BoundaryRestoreInfo,
  FileCreation,
  FileDeletion,
  FileSnapshot,
  RestoreResult,
  SnapshotSettings,
} from '@/services/snapshots/types';

interface FileSnapshotServiceConfig {
  baseDir?: string;
  settings?: SnapshotSettings;
}

/**
 * High-level service for capturing and restoring file snapshots.
 *
 * Orchestrates the content store, session manifests, and eviction manager
 * to provide file state restoration for /rewind-conversation.
 *
 * Snapshots are written immediately when tool changes are captured.
 */
export class FileSnapshotService {
  private baseDir: string;

  private settings: SnapshotSettings;

  private contentStore: FileSnapshotStore;

  private evictionManager: SnapshotEvictionManager;

  private currentSessionId: string | null = null;

  private currentManifest: SessionSnapshotManifest | null = null;

  private initialized = false;

  // Current message context for associating snapshots with user messages
  private currentMessageContext: {
    messageId: string;
    messageIndex: number;
  } | null = null;

  constructor(config: FileSnapshotServiceConfig = {}) {
    this.baseDir =
      config.baseDir ??
      path.join(getIndustryHome(), getIndustryDirName(), 'snapshots');
    this.settings = config.settings ?? DEFAULT_SNAPSHOT_SETTINGS;

    const contentDir = path.join(this.baseDir, 'content');
    const manifestDir = path.join(this.baseDir, 'manifests');

    this.contentStore = new FileSnapshotStore(contentDir);
    this.evictionManager = new SnapshotEvictionManager({
      indexDir: this.baseDir,
      contentStore: this.contentStore,
      manifestDir,
      settings: this.settings,
    });
  }

  /**
   * Check if service is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Initialize the service.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.settings.enabled) {
      this.initialized = true;
      return;
    }

    // Create directory structure
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.mkdir(path.join(this.baseDir, 'content'), { recursive: true });
    await fs.mkdir(path.join(this.baseDir, 'manifests'), { recursive: true });

    await this.contentStore.initialize();
    await this.evictionManager.initialize();

    this.initialized = true;

    logInfo('[FileSnapshotService] Initialized', {
      path: this.baseDir,
      size: this.settings.storageLimitMB,
    });
  }

  /**
   * Start tracking snapshots for a session.
   */
  async startSession(sessionId: string): Promise<void> {
    this.ensureInitialized();

    if (!this.settings.enabled) return;

    this.currentSessionId = sessionId;
    this.currentManifest = new SessionSnapshotManifest(
      path.join(this.baseDir, 'manifests'),
      sessionId,
      { autoSave: true }
    );
    await this.currentManifest.initialize();

    logInfo('[FileSnapshotService] Started session', { sessionId });
  }

  /**
   * Get the current session ID.
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Set the current message context for associating snapshots.
   * Call this when starting to process a user message.
   */
  setMessageContext(messageId: string, messageIndex: number): void {
    this.currentMessageContext = { messageId, messageIndex };
  }

  /**
   * Clear the current message context.
   */
  clearMessageContext(): void {
    this.currentMessageContext = null;
  }

  /**
   * Capture a file change from a tool execution (Create/Edit/ApplyPatch).
   * Writes immediately to the manifest (fire-and-forget for performance).
   * Uses the current message context set via setMessageContext().
   *
   * For 'create' operations, we track the creation (for deletion on rewind).
   * For 'edit'/'apply-patch', we store the OLD content (for restoration on rewind).
   */
  async captureToolFileChange(params: {
    filePath: string;
    content: string;
    toolCallId: string;
    operation: 'create' | 'edit' | 'apply-patch';
  }): Promise<void> {
    if (!this.settings.enabled) return;
    // Silently skip if no session or no message context (fire-and-forget pattern)
    if (
      !this.initialized ||
      !this.currentSessionId ||
      !this.currentManifest ||
      !this.currentMessageContext
    ) {
      logInfo(
        '[FileSnapshotService] Skipping capture - not initialized, no session, or no message context',
        {
          filePath: params.filePath,
        }
      );
      return;
    }

    const { messageId, messageIndex } = this.currentMessageContext;

    try {
      const { filePath, content, toolCallId, operation } = params;
      const absolutePath = path.resolve(filePath);
      const timestamp = Date.now();

      // For 'create' operations, track the creation (no content to store)
      if (operation === 'create') {
        const creation: FileCreation = {
          filePath: absolutePath,
          createdAt: timestamp,
          toolCallId,
        };

        const boundary = {
          messageId,
          messageIndex,
          timestamp,
          files: [],
          deletions: [],
          creations: [creation],
          totalSize: 0,
        };

        await this.currentManifest.addBoundary(boundary);

        // Register with eviction manager (no content to track)
        const queueEntry: BoundaryQueueEntry = {
          sessionId: this.currentSessionId,
          boundaryIndex: this.currentManifest.getBoundaryCount() - 1,
          timestamp,
          sizeBytes: 0,
          contentHashes: [],
        };
        await this.evictionManager.addBoundary(queueEntry);

        logInfo('[FileSnapshotService] File creation tracked', {
          sessionId: this.currentSessionId,
          messageId,
          filePath: absolutePath,
        });
        return;
      }

      // For edit/apply-patch operations, store the OLD content
      const contentHash = await this.contentStore.storeContent(content);
      const size = Buffer.byteLength(content);

      const snapshot: FileSnapshot = {
        filePath: absolutePath,
        contentHash,
        size,
        capturedAt: timestamp,
        toolCallId,
      };

      // Write immediately to manifest as a single-file boundary
      const boundary = {
        messageId,
        messageIndex,
        timestamp,
        files: [snapshot],
        deletions: [],
        creations: [],
        totalSize: size,
      };

      await this.currentManifest.addBoundary(boundary);

      // Register with eviction manager
      const queueEntry: BoundaryQueueEntry = {
        sessionId: this.currentSessionId,
        boundaryIndex: this.currentManifest.getBoundaryCount() - 1,
        timestamp,
        sizeBytes: size,
        contentHashes: [contentHash],
      };
      await this.evictionManager.addBoundary(queueEntry);

      logInfo('[FileSnapshotService] Snapshot captured', {
        sessionId: this.currentSessionId,
        messageId,
        filePath: absolutePath,
        size,
      });
    } catch (error) {
      logWarn('[FileSnapshotService] Failed to capture tool file change', {
        filePath: params.filePath,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get snapshot information for a specific boundary.
   */
  async getSnapshotsForBoundary(
    sessionId: string,
    messageId: string
  ): Promise<BoundaryRestoreInfo> {
    this.ensureInitialized();

    const emptyResult: BoundaryRestoreInfo = {
      messageId,
      availableFiles: [],
      evictedFiles: [],
      createdFiles: [],
      hasEvictedContent: false,
    };

    if (!this.settings.enabled) return emptyResult;

    try {
      // Load manifest for the session
      const manifest = new SessionSnapshotManifest(
        path.join(this.baseDir, 'manifests'),
        sessionId
      );
      await manifest.initialize();

      // Get file state at boundary
      const files = manifest.getFileStateAtBoundary(messageId);

      // Check which files are still available in content store
      const availableFiles: FileSnapshot[] = [];
      const evictedFiles: Array<{ filePath: string; reason: string }> = [];

      for (const file of files) {
        const hasContent = await this.contentStore.hasContent(file.contentHash);
        if (hasContent) {
          availableFiles.push(file);
        } else {
          evictedFiles.push({
            filePath: file.filePath,
            reason: 'Content evicted due to storage limits',
          });
        }
      }

      return {
        messageId,
        availableFiles,
        evictedFiles,
        createdFiles: [], // Not applicable for single boundary query
        hasEvictedContent: evictedFiles.length > 0,
      };
    } catch (error) {
      logWarn('[FileSnapshotService] Failed to get snapshots for boundary', {
        sessionId,
        messageId,
        cause: error,
      });
      return emptyResult;
    }
  }

  /**
   * Get files that were modified AFTER a specific message boundary.
   * Used for rewind: when rewinding to message A, we want to show files
   * that were changed in messages B, C, etc. (after A) that would be undone.
   */
  async getSnapshotsAfterBoundary(
    sessionId: string,
    messageId: string
  ): Promise<BoundaryRestoreInfo> {
    this.ensureInitialized();

    const emptyResult: BoundaryRestoreInfo = {
      messageId,
      availableFiles: [],
      evictedFiles: [],
      createdFiles: [],
      hasEvictedContent: false,
    };

    if (!this.settings.enabled) return emptyResult;

    try {
      // Load manifest for the session
      const manifest = new SessionSnapshotManifest(
        path.join(this.baseDir, 'manifests'),
        sessionId
      );
      await manifest.initialize();

      // Get files changed after boundary (edits with previous content to restore)
      const files = manifest.getFilesChangedAfterBoundary(messageId);

      // Get files created after boundary (to delete on rewind)
      const createdFiles = manifest.getFilesCreatedAfterBoundary(messageId);

      // Build a set of created file paths for quick lookup
      // Files that were created in this scope should NOT be shown as "restore"
      // because they didn't exist before - they should only be shown as "delete"
      const createdFilePaths = new Set(
        createdFiles.map((creation) => creation.filePath)
      );

      // Check which files are still available in content store
      // Exclude files that were also created (those should only show as "delete")
      const availableFiles: FileSnapshot[] = [];
      const evictedFiles: Array<{ filePath: string; reason: string }> = [];

      for (const file of files) {
        // Skip files that were created in this scope - they should only be deleted
        if (createdFilePaths.has(file.filePath)) {
          continue;
        }

        const hasContent = await this.contentStore.hasContent(file.contentHash);
        if (hasContent) {
          availableFiles.push(file);
        } else {
          evictedFiles.push({
            filePath: file.filePath,
            reason: 'Content evicted due to storage limits',
          });
        }
      }

      return {
        messageId,
        availableFiles,
        evictedFiles,
        createdFiles,
        hasEvictedContent: evictedFiles.length > 0,
      };
    } catch (error) {
      logWarn('[FileSnapshotService] Failed to get snapshots after boundary', {
        sessionId,
        messageId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return emptyResult;
    }
  }

  /**
   * Get deleted files for a specific boundary.
   */
  async getDeletedFilesForBoundary(
    sessionId: string,
    messageId: string
  ): Promise<FileDeletion[]> {
    this.ensureInitialized();

    if (!this.settings.enabled) return [];

    try {
      const manifest = new SessionSnapshotManifest(
        path.join(this.baseDir, 'manifests'),
        sessionId
      );
      await manifest.initialize();

      return manifest.getDeletedFilesAtBoundary(messageId);
    } catch {
      return [];
    }
  }

  /**
   * Get content for a snapshot by hash.
   */
  async getSnapshotContent(contentHash: string): Promise<string | null> {
    this.ensureInitialized();

    if (!this.settings.enabled) return null;

    return this.contentStore.getContent(contentHash);
  }

  /**
   * Restore files to disk.
   */
  async restoreFiles(
    snapshots: FileSnapshot[],
    options?: { dryRun?: boolean }
  ): Promise<RestoreResult> {
    this.ensureInitialized();

    const result: RestoreResult = {
      restored: [],
      failed: [],
      skipped: [],
    };

    if (!this.settings.enabled) {
      return result;
    }

    for (const snapshot of snapshots) {
      if (options?.dryRun) {
        result.skipped.push({
          filePath: snapshot.filePath,
          reason: 'Dry run mode',
        });
        continue;
      }

      try {
        // Get content from store
        const content = await this.contentStore.getContent(
          snapshot.contentHash
        );

        if (content === null) {
          result.failed.push({
            filePath: snapshot.filePath,
            error: 'Content not found in store',
          });
          continue;
        }

        // Ensure parent directory exists
        const parentDir = path.dirname(snapshot.filePath);
        await fs.mkdir(parentDir, { recursive: true });

        // Write file
        await fs.writeFile(snapshot.filePath, content);

        result.restored.push({
          filePath: snapshot.filePath,
          size: snapshot.size,
        });
      } catch (error) {
        result.failed.push({
          filePath: snapshot.filePath,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    if (result.restored.length > 0) {
      logInfo('[FileSnapshotService] Files restored', {
        count: result.restored.length,
        errorCount: result.failed.length,
      });
    }

    return result;
  }

  /**
   * Delete files that were created (for rewind).
   */
  async deleteCreatedFiles(
    creations: FileCreation[],
    options?: { dryRun?: boolean }
  ): Promise<{
    deleted: string[];
    failed: Array<{ filePath: string; error: string }>;
  }> {
    this.ensureInitialized();

    const result: {
      deleted: string[];
      failed: Array<{ filePath: string; error: string }>;
    } = {
      deleted: [],
      failed: [],
    };

    if (!this.settings.enabled) {
      return result;
    }

    for (const creation of creations) {
      if (options?.dryRun) {
        continue;
      }

      try {
        await fs.unlink(creation.filePath);
        result.deleted.push(creation.filePath);
      } catch (error) {
        // ENOENT is ok - file already doesn't exist
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          result.failed.push({
            filePath: creation.filePath,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }

    if (result.deleted.length > 0) {
      logInfo('[FileSnapshotService] Files deleted', {
        count: result.deleted.length,
        errorCount: result.failed.length,
      });
    }

    return result;
  }

  /**
   * Clean up all snapshots for a session.
   */
  async cleanupSession(sessionId: string): Promise<void> {
    this.ensureInitialized();

    if (!this.settings.enabled) return;

    try {
      // Remove from eviction manager (handles content ref counting)
      await this.evictionManager.removeSession(sessionId);

      // Delete manifest file
      const manifest = new SessionSnapshotManifest(
        path.join(this.baseDir, 'manifests'),
        sessionId
      );
      await manifest.delete();

      // Run garbage collection
      await this.contentStore.cleanup();

      logInfo('[FileSnapshotService] Session cleaned up', { sessionId });
    } catch (error) {
      logException(error, '[FileSnapshotService] Failed to cleanup session');
    }
  }

  /**
   * Clean up stale snapshots older than retention period.
   */
  async cleanupStaleSnapshots(retentionDays: number): Promise<void> {
    this.ensureInitialized();

    if (!this.settings.enabled) return;

    // TODO: Implement stale snapshot cleanup
    // This would scan manifest files, find sessions with lastAccessedAt
    // older than retention period, and clean them up
    logInfo('[FileSnapshotService] Stale snapshot cleanup', {
      days: retentionDays,
    });
  }

  /**
   * Get storage statistics.
   */
  getStorageStats(): {
    totalSizeBytes: number;
    totalBoundaries: number;
    uniqueContents: number;
  } {
    this.ensureInitialized();

    if (!this.settings.enabled) {
      return { totalSizeBytes: 0, totalBoundaries: 0, uniqueContents: 0 };
    }

    return {
      totalSizeBytes: this.evictionManager.getTotalSize(),
      totalBoundaries: this.evictionManager.getQueueLength(),
      uniqueContents: 0, // Would need to query content store
    };
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'FileSnapshotService not initialized. Call initialize() first.'
      );
    }
  }
}

// Singleton instance
let serviceInstance: FileSnapshotService | null = null;

/**
 * Get the singleton FileSnapshotService instance.
 */
export function getFileSnapshotService(): FileSnapshotService {
  if (!serviceInstance) {
    serviceInstance = new FileSnapshotService();
  }
  return serviceInstance;
}
