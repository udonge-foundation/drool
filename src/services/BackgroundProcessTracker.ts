import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import treeKill from 'tree-kill';

import { logInfo, logWarn } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import {
  loadJsonFileWithBackup,
  saveJsonFileAtomic,
} from '@/utils/jsonFileStore';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';

// The Windows liveness fallback shells out to PowerShell, which is expensive
// and synchronous. getProcesses() runs on a 2-second UI poll, so probe results
// are cached per PID and the probe itself is bounded by a timeout.
const WINDOWS_LIVENESS_CACHE_TTL_MS = 10_000;
const WINDOWS_LIVENESS_PROBE_TIMEOUT_MS = 5_000;
const WINDOWS_FORCE_KILL_TIMEOUT_MS = 5_000;

interface BackgroundProcessInfo {
  pid: number;
  command: string;
  cwd: string;
  startTime: number;
  sessionId?: string;
  outputFile?: string;
  parentPid?: number;
}

interface BackgroundProcessStore {
  processes: BackgroundProcessInfo[];
}

function emptyStore(): BackgroundProcessStore {
  return { processes: [] };
}

function isValidStore(data: unknown): data is BackgroundProcessStore {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.processes)) return false;
  // Reject the store if any entry is not a valid process object.
  // A store with null/invalid entries is treated as corrupt → falls back to .bak.
  return obj.processes.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).pid === 'number' &&
      Number.isFinite((entry as Record<string, unknown>).pid) &&
      typeof (entry as Record<string, unknown>).command === 'string'
  );
}

class BackgroundProcessTracker {
  // eslint-disable-next-line no-use-before-define
  private static instance: BackgroundProcessTracker;

  private readonly storePath: string;

  private readonly backupPath: string;

  private readonly windowsLivenessCache = new Map<
    number,
    { alive: boolean; checkedAt: number }
  >();

  private constructor() {
    this.storePath = path.join(
      getIndustryHome(),
      getIndustryDirName(),
      'background-processes.json'
    );
    this.backupPath = `${this.storePath}.bak`;
    this.ensureStoreExists();
    this.registerShutdownHook();
  }

  static getInstance(): BackgroundProcessTracker {
    if (!BackgroundProcessTracker.instance) {
      BackgroundProcessTracker.instance = new BackgroundProcessTracker();
    }
    return BackgroundProcessTracker.instance;
  }

  private registerShutdownHook(): void {
    getShutdownCoordinator().registerHook('background-processes', async () => {
      const killedCount = await this.killAllProcesses();
      if (killedCount > 0) {
        logInfo(
          '[BackgroundProcessTracker] Killed background processes on shutdown',
          {
            forceKilledCount: killedCount,
            pid: process.pid,
          }
        );
      }
    });
  }

  private ensureStoreExists(): void {
    if (!fs.existsSync(this.storePath)) {
      this.saveStore(emptyStore());
    }
  }

  private loadStore(): BackgroundProcessStore {
    return loadJsonFileWithBackup(
      this.storePath,
      this.backupPath,
      isValidStore,
      emptyStore
    );
  }

  private saveStore(store: BackgroundProcessStore): void {
    saveJsonFileAtomic(this.storePath, this.backupPath, store);
  }

  /**
   * Register a new background process
   */
  registerProcess(
    pid: number,
    command: string,
    cwd: string,
    sessionId?: string,
    outputFile?: string
  ): void {
    const store = this.loadStore();

    // Remove if PID already exists (shouldn't happen for active processes)
    const filtered = store.processes.filter((p) => p.pid !== pid);

    filtered.push({
      pid,
      command,
      cwd,
      startTime: Date.now(),
      sessionId,
      outputFile,
      parentPid: process.pid,
    });

    this.saveStore({ processes: filtered });
    logInfo('[BackgroundProcessTracker] Registered process', { pid, command });
  }

  /**
   * Get all tracked processes, optionally filtered by session.
   * Only returns processes owned by the current CLI process (parentPid).
   */
  getProcesses(sessionId?: string): BackgroundProcessInfo[] {
    // Cleanup dead processes and reuse the resulting store (single read)
    const store = this.cleanupDeadProcesses();
    const currentPid = process.pid;

    // Only return processes spawned by this CLI instance
    let results = store.processes.filter((p) => p.parentPid === currentPid);

    if (sessionId) {
      results = results.filter((p) => p.sessionId === sessionId);
    }
    return results;
  }

  /**
   * Check if a process is actually running (cross-platform)
   */
  private isProcessRunning(pid: number): boolean {
    if (pid <= 0) return false;

    try {
      // Sending signal 0 checks existence without killing
      process.kill(pid, 0);
      return true;
    } catch (_e) {
      if (process.platform !== 'win32') {
        return false;
      }

      return this.isWindowsProcessRunning(pid);
    }
  }

  /**
   * Bun can report a live Start-Process PID as absent on Windows, so fall back
   * to a native PowerShell probe. The result is cached briefly because this is
   * reached from getProcesses() on a 2-second UI poll, and a synchronous
   * PowerShell spawn per PID per refresh would stall the render loop.
   */
  private isWindowsProcessRunning(pid: number): boolean {
    const cached = this.windowsLivenessCache.get(pid);
    if (
      cached &&
      Date.now() - cached.checkedAt < WINDOWS_LIVENESS_CACHE_TTL_MS
    ) {
      return cached.alive;
    }

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$proc = Get-Process -Id ([int]$env:INDUSTRY_BACKGROUND_PID) -ErrorAction SilentlyContinue; if ($null -ne $proc) { exit 0 }; exit 1',
      ],
      {
        env: { ...process.env, INDUSTRY_BACKGROUND_PID: String(pid) },
        stdio: 'ignore',
        windowsHide: true,
        timeout: WINDOWS_LIVENESS_PROBE_TIMEOUT_MS,
      }
    );

    // Only a clean "not found" (the script's `exit 1`) proves the process is
    // dead. A spawn failure or a timeout (status === null), or any other exit
    // code, means the probe could not determine liveness. In that case assume
    // the process is still alive and do NOT cache the inconclusive result, so a
    // transient PowerShell hiccup under CI load can neither drop a live
    // background process from the store (cleanupDeadProcesses) nor cause the
    // shutdown kill path to be skipped (forceKillProcess). The next poll
    // re-probes for a definitive answer.
    if (result.error || result.status === null) {
      return true;
    }
    if (result.status !== 0 && result.status !== 1) {
      return true;
    }

    const alive = result.status === 0;
    this.windowsLivenessCache.set(pid, { alive, checkedAt: Date.now() });
    return alive;
  }

  /**
   * Remove dead processes from the store.
   * Returns the current store to avoid redundant re-reads.
   */
  cleanupDeadProcesses(): BackgroundProcessStore {
    const store = this.loadStore();
    const initialCount = store.processes.length;

    const activeProcesses = store.processes.filter((p) =>
      this.isProcessRunning(p.pid)
    );

    if (activeProcesses.length !== initialCount) {
      const cleaned = { processes: activeProcesses };
      this.saveStore(cleaned);
      logInfo('[BackgroundProcessTracker] Cleaned up dead processes', {
        deletedCount: initialCount - activeProcesses.length,
      });
      return cleaned;
    }

    return store;
  }

  /**
   * Remove a process from the store
   */
  private removeProcessFromStore(pid: number): void {
    this.windowsLivenessCache.delete(pid);
    const store = this.loadStore();
    store.processes = store.processes.filter((p) => p.pid !== pid);
    this.saveStore(store);
  }

  private getProcessFromStore(pid: number): BackgroundProcessInfo | undefined {
    return this.loadStore().processes.find((p) => p.pid === pid);
  }

  private forceKillWindowsProcessFamily(
    pid: number,
    command?: string
  ): boolean {
    if (process.platform !== 'win32') return false;

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          "$ErrorActionPreference = 'SilentlyContinue'",
          '$targetPid = [int]$env:INDUSTRY_BACKGROUND_PID',
          '$command = $env:INDUSTRY_BACKGROUND_COMMAND',
          '$processes = @(Get-CimInstance Win32_Process)',
          '$killIds = New-Object "System.Collections.Generic.HashSet[int]"',
          // $pid is a read-only automatic variable in PowerShell; using it as a
          // parameter name throws (silenced by SilentlyContinue) and the tree walk
          // never runs, so the fallback would kill nothing yet still report success.
          'function Add-Tree([int]$procId) {',
          '  if ($killIds.Add($procId)) {',
          '    $script:processes | Where-Object { $_.ParentProcessId -eq $procId } | ForEach-Object { Add-Tree ([int]$_.ProcessId) }',
          '  }',
          '}',
          'Add-Tree $targetPid',
          'if (![string]::IsNullOrWhiteSpace($command)) {',
          '  $processes | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($command) } | ForEach-Object { [void]$killIds.Add([int]$_.ProcessId) }',
          '}',
          '$killIds | ForEach-Object { Stop-Process -Id $_ -Force }',
          'exit 0',
        ].join('; '),
      ],
      {
        env: {
          ...process.env,
          INDUSTRY_BACKGROUND_PID: String(pid),
          INDUSTRY_BACKGROUND_COMMAND: command ?? '',
        },
        stdio: 'ignore',
        windowsHide: true,
        timeout: WINDOWS_FORCE_KILL_TIMEOUT_MS,
      }
    );

    if (result.error) {
      logWarn('[BackgroundProcessTracker] Windows force-kill fallback failed', {
        pid,
        error: result.error.message,
      });
      return false;
    }
    return true;
  }

  /**
   * Kill a specific process
   * First attempts graceful shutdown with SIGTERM, then escalates to SIGKILL if needed
   */
  async killProcess(pid: number): Promise<boolean> {
    if (!this.isProcessRunning(pid)) {
      // Just cleanup if not running
      this.cleanupDeadProcesses();
      return false;
    }

    return new Promise((resolve) => {
      // First attempt: SIGTERM (graceful)
      treeKill(pid, 'SIGTERM', (err) => {
        if (err) {
          logWarn('[BackgroundProcessTracker] Failed to send SIGTERM', {
            pid,
            error: err.message,
          });
          resolve(false);
          return;
        }

        // The signal may change liveness; drop any cached probe result so the
        // post-SIGTERM check below observes the real state.
        this.windowsLivenessCache.delete(pid);

        // Wait 5 seconds for graceful shutdown, then check if process is still running
        setTimeout(() => {
          // Check if process is still running
          if (this.isProcessRunning(pid)) {
            logWarn(
              '[BackgroundProcessTracker] Process did not respond to SIGTERM, escalating to SIGKILL',
              { pid }
            );

            // Escalate to SIGKILL
            treeKill(pid, 'SIGKILL', (killErr) => {
              if (killErr) {
                logWarn(
                  '[BackgroundProcessTracker] Failed to send SIGKILL after SIGTERM timeout',
                  {
                    pid,
                    error: killErr.message,
                  }
                );
                resolve(false);
              } else {
                this.removeProcessFromStore(pid);
                logInfo(
                  '[BackgroundProcessTracker] Killed process with SIGKILL',
                  {
                    pid,
                  }
                );
                resolve(true);
              }
            });
          } else {
            // Process terminated gracefully
            this.removeProcessFromStore(pid);
            logInfo('[BackgroundProcessTracker] Killed process with SIGTERM', {
              pid,
            });
            resolve(true);
          }
        }, 5000);
      });
    });
  }

  /**
   * Force kill a process immediately with SIGKILL (no graceful shutdown)
   */
  async forceKillProcess(pid: number): Promise<boolean> {
    if (!this.isProcessRunning(pid)) {
      this.cleanupDeadProcesses();
      return false;
    }

    const processInfo = this.getProcessFromStore(pid);

    return new Promise((resolve) => {
      treeKill(pid, 'SIGKILL', (err) => {
        if (err) {
          const fallbackSucceeded = this.forceKillWindowsProcessFamily(
            pid,
            processInfo?.command
          );
          if (!fallbackSucceeded) {
            logWarn(
              '[BackgroundProcessTracker] Failed to send SIGKILL on force kill',
              {
                pid,
                error: err.message,
              }
            );
            resolve(false);
            return;
          }
        } else {
          this.forceKillWindowsProcessFamily(pid, processInfo?.command);
        }

        this.removeProcessFromStore(pid);
        logInfo(
          '[BackgroundProcessTracker] Force killed process with SIGKILL',
          {
            pid,
          }
        );
        resolve(true);
      });
    });
  }

  /**
   * Kill all tracked processes owned by this CLI instance
   */
  async killAllProcesses(): Promise<number> {
    const processes = this.getProcesses();
    let killedCount = 0;

    await Promise.all(
      processes.map(async (p) => {
        const success = await this.forceKillProcess(p.pid);
        if (success) killedCount++;
      })
    );

    return killedCount;
  }

  /**
   * Kill all processes for a specific session
   */
  async killSessionProcesses(sessionId: string): Promise<number> {
    const processes = this.getProcesses(sessionId);
    let killedCount = 0;

    await Promise.all(
      processes.map(async (p) => {
        const success = await this.killProcess(p.pid);
        if (success) killedCount++;
      })
    );

    return killedCount;
  }
}

export const backgroundProcessTracker = BackgroundProcessTracker.getInstance();
