import fs from 'fs/promises';
import path from 'path';

import { logInfo, logWarn } from '@industry/logging';

interface FileTimestampEntry {
  mtime: Date;
  toolCallId: string;
  operation: 'read' | 'edit' | 'create';
}

interface RecentFileOperation {
  filePath: string;
  toolCallId: string;
  operation: 'read' | 'edit' | 'create';
  timestamp: Date;
}

/**
 * Service to track file modification timestamps and detect external changes.
 * Helps prevent editing conflicts when files are modified outside the LLM session.
 */
export class FileTimestampTracker {
  // eslint-disable-next-line no-use-before-define
  private static instance: FileTimestampTracker | undefined;

  // Map of absolute file paths to their last-seen timestamps
  private fileTimestamps: Map<string, FileTimestampEntry> = new Map();

  // Circular buffer of recent file operations (last N operations)
  private recentOperations: RecentFileOperation[] = [];

  private readonly maxRecentOperations = 10;

  static getInstance(): FileTimestampTracker {
    if (!FileTimestampTracker.instance) {
      FileTimestampTracker.instance = new FileTimestampTracker();
    }
    return FileTimestampTracker.instance;
  }

  /**
   * Track a file operation and record its modification time
   */
  private async trackFileOperation(
    filePath: string,
    toolCallId: string,
    operation: 'read' | 'edit' | 'create'
  ): Promise<void> {
    const absolutePath = path.resolve(filePath);

    try {
      const stats = await fs.stat(absolutePath);
      this.fileTimestamps.set(absolutePath, {
        mtime: stats.mtime,
        toolCallId,
        operation,
      });

      this.addToRecentOperations({
        filePath: absolutePath,
        toolCallId,
        operation,
        timestamp: new Date(),
      });
    } catch (error) {
      logWarn('[FileTimestampTracker] Failed to track file operation', {
        filePath: absolutePath,
        error: error instanceof Error ? error.message : 'Unknown error',
        value: `operation: ${operation}`,
      });
    }
  }

  /**
   * Track a file read operation and record its modification time
   */
  async trackFileRead(filePath: string, toolCallId: string): Promise<void> {
    return this.trackFileOperation(filePath, toolCallId, 'read');
  }

  /**
   * Track a file write operation and update its modification time
   */
  async trackFileWrite(
    filePath: string,
    toolCallId: string,
    operation: 'edit' | 'create'
  ): Promise<void> {
    return this.trackFileOperation(filePath, toolCallId, operation);
  }

  /**
   * Check if a file has been modified externally since last tracked
   * @returns true if file was modified externally, false otherwise
   */
  async hasFileChangedExternally(filePath: string): Promise<boolean> {
    const absolutePath = path.resolve(filePath);
    const trackedEntry = this.fileTimestamps.get(absolutePath);

    if (!trackedEntry) {
      // File not tracked, no external change detected
      return false;
    }

    try {
      const currentStats = await fs.stat(absolutePath);
      const hasChanged =
        currentStats.mtime.getTime() !== trackedEntry.mtime.getTime();

      if (hasChanged) {
        logInfo('[FileTimestampTracker] External file change detected', {
          filePath: absolutePath,
          toolCallId: trackedEntry.toolCallId,
          value: `${trackedEntry.operation} - tracked: ${trackedEntry.mtime.toISOString()}, current: ${currentStats.mtime.toISOString()}`,
        });
      }

      return hasChanged;
    } catch (error) {
      logWarn('[FileTimestampTracker] Failed to check file changes', {
        filePath: absolutePath,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // If we can't stat the file, assume no change to avoid false positives
      return false;
    }
  }

  /**
   * Get list of recently accessed files that have been modified externally
   * @returns Array of file paths that were recently accessed and have external changes
   */
  async getRecentlyChangedFiles(): Promise<string[]> {
    const uniqueRecentFiles = new Set(
      this.recentOperations.map((op) => op.filePath)
    );

    const checkPromises = Array.from(uniqueRecentFiles).map(
      async (filePath) => {
        const hasChanged = await this.hasFileChangedExternally(filePath);
        return hasChanged ? filePath : null;
      }
    );

    const results = await Promise.all(checkPromises);
    return results.filter((filePath): filePath is string => filePath !== null);
  }

  /**
   * Get the last tracked timestamp for a file
   */
  getTrackedTimestamp(filePath: string): FileTimestampEntry | undefined {
    const absolutePath = path.resolve(filePath);
    return this.fileTimestamps.get(absolutePath);
  }

  /**
   * Clear all tracked timestamps (useful for testing or session reset)
   */
  clearAll(): void {
    this.fileTimestamps.clear();
    this.recentOperations = [];
    logInfo('[FileTimestampTracker] Cleared all tracked timestamps', {});
  }

  private addToRecentOperations(operation: RecentFileOperation): void {
    this.recentOperations.push(operation);

    // Keep only the last N operations
    if (this.recentOperations.length > this.maxRecentOperations) {
      this.recentOperations.shift();
    }
  }
}

// Export singleton instance getter
export function getFileTimestampTracker(): FileTimestampTracker {
  return FileTimestampTracker.getInstance();
}
