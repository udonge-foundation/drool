import fs from 'fs';
import path from 'path';

import { logException } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import type { HistoryEntry } from '@/services/types';
import {
  setSecureDirectoryPermissionsSync,
  setSecureFilePermissions,
} from '@/utils/filePermissions';

/**
 * HistoryService manages command history for the Industry CLI.
 *
 * This service handles:
 * - Persisting command history to disk
 * - Loading history on startup
 * - Managing history size (rotation)
 * - Providing navigation through history
 */
export class HistoryService {
  private history: HistoryEntry[] = [];

  private readonly historyPath: string;

  private readonly maxHistorySize = 1000;

  private currentPosition = -1;

  private tempInput: string | null = null;

  constructor() {
    const industryDir = path.join(getIndustryHome(), getIndustryDirName());
    this.historyPath = path.join(industryDir, 'history.json');
    HistoryService.ensureDirectoryExists(industryDir);
    this.loadHistory();
  }

  private static ensureDirectoryExists(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      setSecureDirectoryPermissionsSync(dir);
    }
  }

  private loadHistory(): void {
    try {
      if (fs.existsSync(this.historyPath)) {
        const data = fs.readFileSync(this.historyPath, 'utf-8');
        const parsed = JSON.parse(data) as Array<{
          command: string;
          timestamp: string;
          type: HistoryEntry['type'];
        }>;
        // Convert timestamp strings back to Date objects
        this.history = parsed.map((entry) => ({
          ...entry,
          timestamp: new Date(entry.timestamp),
        }));
      }
    } catch (error) {
      logException(error, 'Failed to load command history');
      this.history = [];
    }
  }

  private async saveHistory(): Promise<void> {
    try {
      await fs.promises.writeFile(
        this.historyPath,
        JSON.stringify(this.history, null, 2)
      );
      await setSecureFilePermissions(this.historyPath);
    } catch (error) {
      logException(error, 'Failed to save command history');
    }
  }

  /**
   * Adds a command to the history.
   * Automatically manages history size and persists to disk.
   */
  public addCommand(
    command: string,
    type: HistoryEntry['type'] = 'message',
    mode: HistoryEntry['mode'] = 'chat'
  ): void {
    // Don't add empty commands or duplicates of the last command
    if (!command.trim()) return;

    // Check if this is a duplicate of the last entry
    if (this.history.length > 0) {
      const lastEntry = this.history[this.history.length - 1];
      if (lastEntry.command === command) {
        // Update timestamp of existing entry and move to end
        lastEntry.timestamp = new Date();
        void this.saveHistory();
        return;
      }
    }

    const entry: HistoryEntry = {
      command,
      timestamp: new Date(),
      type,
      mode,
    };

    this.history.push(entry);

    // Rotate history if it exceeds max size
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize);
    }

    void this.saveHistory();
    this.resetPosition();
  }

  /**
   * Resets the navigation position.
   * Called after a command is submitted or when starting fresh navigation.
   */
  public resetPosition(): void {
    this.currentPosition = -1;
    this.tempInput = null;
  }

  /**
   * Navigates to the previous command in history.
   * Returns the history entry or null if at the beginning.
   */
  public navigatePrevious(currentInput: string): HistoryEntry | null {
    if (this.history.length === 0) return null;

    // If we're at the start of navigation, save the current input
    if (this.currentPosition === -1) {
      this.tempInput = currentInput;
      this.currentPosition = this.history.length - 1;
      return this.history[this.currentPosition];
    }

    // Navigate to previous item
    if (this.currentPosition > 0) {
      this.currentPosition--;
      return this.history[this.currentPosition];
    }

    // Already at the oldest item
    return null;
  }

  /**
   * Navigates to the next command in history.
   * Returns the history entry, or the original input if at the end.
   */
  public navigateNext(): {
    command: string;
    mode?: HistoryEntry['mode'];
  } | null {
    if (this.history.length === 0 || this.currentPosition === -1) {
      return null;
    }

    // Navigate to next item
    if (this.currentPosition < this.history.length - 1) {
      this.currentPosition++;
      return this.history[this.currentPosition];
    }

    // We're at the end, return to the original input
    const temp = this.tempInput;
    this.resetPosition();
    // Always return the saved draft, even if it's an empty string
    return { command: temp || '' };
  }

  /**
   * Gets the current history for display or debugging.
   */
  public getHistory(): HistoryEntry[] {
    return [...this.history];
  }

  /**
   * Clears all history.
   */
  public clearHistory(): void {
    this.history = [];
    this.resetPosition();
    void this.saveHistory();
  }

  /**
   * Searches history for commands matching a pattern.
   */
  public searchHistory(pattern: string): HistoryEntry[] {
    const lowerPattern = pattern.toLowerCase();
    return this.history.filter((entry) =>
      entry.command.toLowerCase().includes(lowerPattern)
    );
  }
}

let historyServiceInstance: HistoryService | null = null;

/**
 * Gets the singleton HistoryService instance.
 */
export function getHistoryService(): HistoryService {
  if (!historyServiceInstance) {
    historyServiceInstance = new HistoryService();
  }
  return historyServiceInstance;
}
