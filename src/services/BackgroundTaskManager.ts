import fs from 'fs';
import path from 'path';

import treeKill from 'tree-kill';

import { logException, logInfo, logWarn } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { BackgroundTaskStatus } from '@/hooks/enums';
import {
  loadJsonFileWithBackup,
  saveJsonFileAtomic,
} from '@/utils/jsonFileStore';
import { isProcessAlive } from '@/utils/process-utils';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';

// eslint-disable-next-line industry/types-file-organization
export interface BackgroundTask {
  taskId: string;
  type: 'subagent' | 'shell';
  status: BackgroundTaskStatus;
  pid: number;
  command: string;
  cwd: string;
  startTime: number;
  endTime?: number;
  exitCode?: number;
  parentSessionId: string;
  toolCallId: string;
  outputFile: string;
  description?: string;
  subagentType?: string;
  sessionId: string;
  parentPid?: number;
}

interface BackgroundTaskStore {
  tasks: BackgroundTask[];
}

function emptyTaskStore(): BackgroundTaskStore {
  return { tasks: [] };
}

function isValidTaskStore(data: unknown): data is BackgroundTaskStore {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.tasks)) return false;
  // Reject the store if any entry is not a valid task object.
  // A store with null/invalid entries is treated as corrupt → falls back to .bak.
  return obj.tasks.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).taskId === 'string' &&
      typeof (entry as Record<string, unknown>).pid === 'number' &&
      Number.isFinite((entry as Record<string, unknown>).pid) &&
      typeof (entry as Record<string, unknown>).status === 'string'
  );
}

interface BackgroundTaskFilters {
  parentSessionId?: string;
  parentPid?: number;
}

function matchesTask(
  task: BackgroundTask,
  filters: BackgroundTaskFilters
): boolean {
  if (
    filters.parentSessionId !== undefined &&
    task.parentSessionId !== filters.parentSessionId
  ) {
    return false;
  }

  if (filters.parentPid !== undefined && task.parentPid !== filters.parentPid) {
    return false;
  }

  return true;
}

class BackgroundTaskManagerImpl {
  // eslint-disable-next-line no-use-before-define
  private static instance: BackgroundTaskManagerImpl;

  private readonly storePath: string;

  private readonly backupPath: string;

  private constructor() {
    this.storePath = path.join(
      getIndustryHome(),
      getIndustryDirName(),
      'background-tasks.json'
    );
    this.backupPath = `${this.storePath}.bak`;
    this.ensureStoreExists();
    this.registerShutdownHook();
  }

  static getInstance(): BackgroundTaskManagerImpl {
    if (!BackgroundTaskManagerImpl.instance) {
      BackgroundTaskManagerImpl.instance = new BackgroundTaskManagerImpl();
    }
    return BackgroundTaskManagerImpl.instance;
  }

  private ensureStoreExists(): void {
    if (!fs.existsSync(this.storePath)) {
      this.saveStore(emptyTaskStore());
    }
  }

  private registerShutdownHook(): void {
    getShutdownCoordinator().registerHook('background-tasks', async () => {
      const killedCount = await this.killAllTasks(undefined, process.pid);

      if (killedCount > 0) {
        logInfo('[BackgroundTaskManager] Killed background tasks on shutdown', {
          forceKilledCount: killedCount,
          pid: process.pid,
        });
      }
    });
  }

  private loadStore(): BackgroundTaskStore {
    return loadJsonFileWithBackup(
      this.storePath,
      this.backupPath,
      isValidTaskStore,
      emptyTaskStore
    );
  }

  private saveStore(store: BackgroundTaskStore): void {
    saveJsonFileAtomic(this.storePath, this.backupPath, store);
  }

  registerTask(task: BackgroundTask): void {
    const store = this.loadStore();
    const normalizedTask: BackgroundTask = {
      ...task,
      parentPid: task.parentPid ?? process.pid,
    };
    const filtered = store.tasks.filter(
      (t) => t.taskId !== normalizedTask.taskId
    );
    filtered.push(normalizedTask);
    this.saveStore({ tasks: filtered });
    logInfo('[BackgroundTaskManager] Registered task', {
      taskId: normalizedTask.taskId,
      type: normalizedTask.type,
      pid: normalizedTask.parentPid,
    });
  }

  getTask(taskId: string): BackgroundTask | null {
    const store = this.cleanupDeadTasks();
    return store.tasks.find((t) => t.taskId === taskId) ?? null;
  }

  getTasks(parentSessionId?: string, parentPid?: number): BackgroundTask[] {
    const store = this.loadStore();
    let changed = false;
    for (const task of store.tasks) {
      if (
        task.status === BackgroundTaskStatus.Running &&
        !this.isProcessRunning(task.pid)
      ) {
        task.status = BackgroundTaskStatus.Error;
        task.endTime = Date.now();
        changed = true;
      }
    }
    if (changed) {
      this.saveStore(store);
    }

    return store.tasks.filter((task) =>
      matchesTask(task, { parentSessionId, parentPid })
    );
  }

  getRunningTasks(
    parentSessionId?: string,
    parentPid?: number
  ): BackgroundTask[] {
    return this.getTasks(parentSessionId, parentPid).filter(
      (t) => t.status === BackgroundTaskStatus.Running
    );
  }

  updateTaskStatus(
    taskId: string,
    status: BackgroundTaskStatus,
    exitCode?: number
  ): void {
    const store = this.loadStore();
    const task = store.tasks.find((t) => t.taskId === taskId);
    if (task) {
      task.status = status;
      if (exitCode !== undefined) {
        task.exitCode = exitCode;
      }
      if (status !== BackgroundTaskStatus.Running) {
        task.endTime = Date.now();
      }
      this.saveStore(store);
      logInfo('[BackgroundTaskManager] Updated task status', {
        taskId,
        state: status,
        exitCode,
      });
    }
  }

  private isProcessRunning(pid: number): boolean {
    return isProcessAlive(pid);
  }

  /**
   * Mark dead running tasks as errored.
   * Returns the current store to avoid redundant re-reads.
   */
  cleanupDeadTasks(): BackgroundTaskStore {
    const store = this.loadStore();
    const initialCount = store.tasks.length;
    let changed = false;

    for (const task of store.tasks) {
      if (
        task.status === BackgroundTaskStatus.Running &&
        !this.isProcessRunning(task.pid)
      ) {
        task.status = BackgroundTaskStatus.Error;
        task.endTime = Date.now();
        changed = true;
      }
    }

    if (changed) {
      this.saveStore(store);
      const erroredCount = store.tasks.filter(
        (t) => t.status === BackgroundTaskStatus.Error
      ).length;
      logInfo('[BackgroundTaskManager] Cleaned up dead tasks', {
        totalCount: initialCount,
        errorCount: erroredCount,
      });
    }

    return store;
  }

  async killTask(taskId: string): Promise<boolean> {
    const task = this.getTask(taskId);
    if (!task) {
      return false;
    }

    if (task.status !== BackgroundTaskStatus.Running) {
      return false;
    }

    if (!this.isProcessRunning(task.pid)) {
      this.updateTaskStatus(taskId, BackgroundTaskStatus.Error);
      return false;
    }

    return new Promise((resolve) => {
      treeKill(task.pid, 'SIGTERM', (err) => {
        if (err) {
          const errCode = (err as NodeJS.ErrnoException).code;
          if (errCode === 'ESRCH' || errCode === 'ENOENT') {
            this.updateTaskStatus(taskId, BackgroundTaskStatus.Stopped);
            resolve(true);
            return;
          }
          logWarn('[BackgroundTaskManager] Failed to send SIGTERM', {
            taskId,
            pid: task.pid,
            error: err.message,
          });
          this.updateTaskStatus(taskId, BackgroundTaskStatus.Stopped);
          resolve(false);
          return;
        }

        setTimeout(() => {
          if (this.isProcessRunning(task.pid)) {
            treeKill(task.pid, 'SIGKILL', (killErr) => {
              if (killErr) {
                const killErrCode = (killErr as NodeJS.ErrnoException).code;
                if (killErrCode === 'ESRCH' || killErrCode === 'ENOENT') {
                  this.updateTaskStatus(taskId, BackgroundTaskStatus.Stopped);
                  resolve(true);
                  return;
                }
                logWarn('[BackgroundTaskManager] Failed to send SIGKILL', {
                  taskId,
                  pid: task.pid,
                  error: killErr.message,
                });
                this.updateTaskStatus(taskId, BackgroundTaskStatus.Stopped);
                resolve(false);
              } else {
                this.updateTaskStatus(taskId, BackgroundTaskStatus.Stopped);
                resolve(true);
              }
            });
          } else {
            this.updateTaskStatus(taskId, BackgroundTaskStatus.Stopped);
            resolve(true);
          }
        }, 5000);
      });
    });
  }

  async killAllTasks(
    parentSessionId?: string,
    parentPid?: number
  ): Promise<number> {
    const tasks = this.getRunningTasks(parentSessionId, parentPid);
    let killedCount = 0;

    await Promise.all(
      tasks.map(async (t) => {
        const success = await this.killTask(t.taskId);
        if (success) killedCount++;
      })
    );

    return killedCount;
  }

  getOutputFilePath(taskId: string): string {
    const industryHome = getIndustryHome();
    const outputDir = path.join(
      industryHome,
      getIndustryDirName(),
      'subagent-outputs'
    );
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    }
    return path.join(outputDir, `${taskId}.jsonl`);
  }

  readTaskOutput(taskId: string): string | null {
    const task = this.getTask(taskId);
    if (!task) {
      return null;
    }

    try {
      if (!fs.existsSync(task.outputFile)) {
        return null;
      }
      const content = fs.readFileSync(task.outputFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      let lastAssistantMessage = '';
      const errors: string[] = [];
      const plainTextLines: string[] = [];
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as {
            type: string;
            finalText?: string;
            role?: string;
            text?: string;
            message?: string;
          };
          if (
            event.type === 'completion' &&
            typeof event.finalText === 'string'
          ) {
            lastAssistantMessage = event.finalText;
          } else if (
            event.type === 'message' &&
            event.role === 'assistant' &&
            typeof event.text === 'string'
          ) {
            lastAssistantMessage = event.text;
          } else if (
            event.type === 'error' &&
            typeof event.message === 'string'
          ) {
            errors.push(event.message);
          }
        } catch {
          plainTextLines.push(line.trim());
          continue;
        }
      }

      if (lastAssistantMessage) {
        return lastAssistantMessage;
      }
      if (errors.length > 0) {
        return `Error: ${errors[errors.length - 1]}`;
      }
      if (plainTextLines.length > 0) {
        return plainTextLines.join('\n');
      }
      return null;
    } catch (error) {
      logException(error, 'Failed to read task output');
      return null;
    }
  }

  getTaskProgress(taskId: string): {
    toolCount: number;
  } | null {
    const task = this.getTask(taskId);
    if (!task) {
      return null;
    }

    try {
      if (!fs.existsSync(task.outputFile)) {
        return { toolCount: 0 };
      }
      const content = fs.readFileSync(task.outputFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      let toolCount = 0;

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { type: string };
          if (event.type === 'tool_call') {
            toolCount++;
          }
        } catch {
          continue;
        }
      }

      return { toolCount };
    } catch {
      return { toolCount: 0 };
    }
  }
}

export const backgroundTaskManager = BackgroundTaskManagerImpl.getInstance();
