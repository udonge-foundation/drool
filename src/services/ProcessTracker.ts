import treeKill from 'tree-kill';

import { logInfo, logWarn } from '@industry/logging';

interface ProcessInfo {
  command: string;
  cwd: string;
  startTime: number;
  toolId: string;
}

/**
 * Service to track and manage spawned processes for proper cleanup on cancellation
 */
class ProcessTracker {
  // eslint-disable-next-line no-use-before-define
  private static instance: ProcessTracker;

  // Map of toolId -> Set of process IDs
  private activeProcesses: Map<string, Set<number>> = new Map();

  // Map of pid -> process metadata
  private processMetadata: Map<number, ProcessInfo> = new Map();

  // Singleton pattern - private constructor
  // eslint-disable-next-line no-useless-constructor, no-empty-function
  private constructor() {}

  static getInstance(): ProcessTracker {
    if (!ProcessTracker.instance) {
      ProcessTracker.instance = new ProcessTracker();
    }
    return ProcessTracker.instance;
  }

  /**
   * Register a new process with the tracker
   */
  registerProcess(
    toolId: string,
    pid: number,
    metadata: Omit<ProcessInfo, 'toolId'>
  ): void {
    logInfo('[ProcessTracker] Registering process', {
      toolId,
      pid,
      command: metadata.command,
    });

    // Add to toolId -> pids mapping
    if (!this.activeProcesses.has(toolId)) {
      this.activeProcesses.set(toolId, new Set());
    }
    this.activeProcesses.get(toolId)!.add(pid);

    // Store metadata
    this.processMetadata.set(pid, { ...metadata, toolId });
  }

  /**
   * Unregister a process when it exits naturally
   */
  unregisterProcess(toolId: string, pid: number): void {
    logInfo('[ProcessTracker] Unregistering process', {
      toolId,
      pid,
    });

    // Remove from toolId mapping
    const pids = this.activeProcesses.get(toolId);
    if (pids) {
      pids.delete(pid);
      if (pids.size === 0) {
        this.activeProcesses.delete(toolId);
      }
    }

    // Remove metadata
    this.processMetadata.delete(pid);
  }

  /**
   * Kill all processes associated with a tool
   */
  async killToolProcesses(
    toolId: string,
    signal: NodeJS.Signals = 'SIGTERM'
  ): Promise<void> {
    const pids = this.activeProcesses.get(toolId);
    if (!pids || pids.size === 0) {
      logInfo('[ProcessTracker] No processes to kill for tool', {
        toolId,
      });
      return;
    }

    logInfo('[ProcessTracker] Killing processes for tool', {
      toolId,
      pids: Array.from(pids),
      signal,
    });

    const killPromises: Promise<void>[] = [];

    for (const pid of pids) {
      killPromises.push(this.killProcess(pid, signal));
    }

    await Promise.allSettled(killPromises);

    // Clean up tracking
    this.activeProcesses.delete(toolId);
    for (const pid of pids) {
      this.processMetadata.delete(pid);
    }
  }

  /**
   * Get the PIDs registered for a given tool
   */
  getToolPids(toolId: string): number[] {
    const pids = this.activeProcesses.get(toolId);
    return pids ? Array.from(pids) : [];
  }

  /**
   * Get the number of tools with tracked processes
   */
  getTrackedToolCount(): number {
    return this.activeProcesses.size;
  }

  /**
   * Kill all tracked processes
   */
  async killAllProcesses(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    logInfo('[ProcessTracker] Killing all tracked processes', {
      toolCount: this.activeProcesses.size,
      count: this.processMetadata.size,
    });

    const allToolIds = Array.from(this.activeProcesses.keys());
    const killPromises = allToolIds.map((toolId) =>
      this.killToolProcesses(toolId, signal)
    );

    await Promise.allSettled(killPromises);
  }

  /**
   * Kill a single process with graceful shutdown attempt
   */
  private async killProcess(
    pid: number,
    signal: NodeJS.Signals
  ): Promise<void> {
    const metadata = this.processMetadata.get(pid);

    try {
      // First, check if process is still running
      if (!this.isProcessRunning(pid)) {
        logInfo('[ProcessTracker] Process already exited', {
          pid,
        });
        return;
      }

      const gracefulShutdownTimeout = 500;

      const sendSignal = async (sig: NodeJS.Signals) =>
        new Promise<void>((resolveSignal) => {
          treeKill(pid, sig, (error) => {
            if (error) {
              const err = error as NodeJS.ErrnoException;
              if (err.code === 'ESRCH' || err.code === 'ENOENT') {
                logInfo(
                  '[ProcessTracker] Process already exited before signal',
                  {
                    pid,
                    signal: sig,
                    command: metadata?.command,
                  }
                );
              } else {
                logWarn('[ProcessTracker] Failed to send signal to process', {
                  pid,
                  signal: sig,
                  command: metadata?.command,
                  error: err.message,
                });
              }
            } else {
              logInfo('[ProcessTracker] Sent signal to process', {
                pid,
                signal: sig,
                command: metadata?.command,
              });
            }

            resolveSignal();
          });
        });

      await sendSignal(signal);

      const exited = await this.waitForProcessExit(
        pid,
        gracefulShutdownTimeout
      );

      if (!exited && this.isProcessRunning(pid)) {
        logWarn(
          '[ProcessTracker] Process did not exit gracefully, forcing kill',
          {
            pid,
            command: metadata?.command,
          }
        );

        await sendSignal('SIGKILL');
      }
    } catch (error) {
      // Process might have already exited or we don't have permission
      logWarn('[ProcessTracker] Failed to kill process', {
        pid,
        error: error instanceof Error ? error.message : String(error),
        command: metadata?.command,
      });
    }
  }

  /**
   * Check if a process is still running
   */
  private isProcessRunning(pid: number): boolean {
    try {
      // Sending signal 0 checks if process exists without actually sending a signal
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Wait for a process to exit with timeout
   */
  private async waitForProcessExit(
    pid: number,
    timeoutMs: number
  ): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 100; // Check every 100ms

    while (Date.now() - startTime < timeoutMs) {
      if (!this.isProcessRunning(pid)) {
        return true;
      }
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    return false;
  }

  /**
   * Get active process information for debugging
   */
  getActiveProcessInfo(): {
    toolProcesses: Map<string, number[]>;
    processDetails: Map<number, ProcessInfo>;
  } {
    const toolProcesses = new Map<string, number[]>();

    for (const [toolId, pids] of this.activeProcesses) {
      toolProcesses.set(toolId, Array.from(pids));
    }

    return {
      toolProcesses,
      processDetails: new Map(this.processMetadata),
    };
  }
}

const ProcessTrackerClass = ProcessTracker;
export const processTracker = ProcessTrackerClass.getInstance();
