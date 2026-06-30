import { TimerHandle } from './types';

export class TerminalCleanupScheduler {
  private readonly pending: Map<string, TimerHandle> = new Map();

  private readonly delayMs: number;

  private orphanCleanupHandle: ReturnType<typeof setInterval> | null = null;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  schedule(terminalId: string, cleanup: () => void): void {
    this.cancel(terminalId);

    const handle = setTimeout(() => {
      this.pending.delete(terminalId);
      cleanup();
    }, this.delayMs);

    // Prevent timers from keeping the event loop alive (important for tests)
    handle.unref?.();

    this.pending.set(terminalId, handle);
  }

  cancel(terminalId: string): void {
    const handle = this.pending.get(terminalId);
    if (!handle) {
      return;
    }

    clearTimeout(handle);
    this.pending.delete(terminalId);
  }

  /**
   * Check if a terminal has a pending cleanup scheduled.
   * Used to distinguish "grace period" orphans from "truly orphaned" terminals.
   */
  hasPendingCleanup(terminalId: string): boolean {
    return this.pending.has(terminalId);
  }

  /**
   * Start periodic orphan cleanup at the specified interval.
   * The callback is invoked every intervalMs and should handle the actual cleanup.
   */
  startOrphanCleanup(intervalMs: number, callback: () => void): void {
    if (this.orphanCleanupHandle) return;

    this.orphanCleanupHandle = setInterval(() => {
      callback();
    }, intervalMs);

    // Prevent interval from keeping the event loop alive
    this.orphanCleanupHandle.unref?.();
  }

  stopOrphanCleanup(): void {
    if (this.orphanCleanupHandle) {
      clearInterval(this.orphanCleanupHandle);
      this.orphanCleanupHandle = null;
    }
  }
}
