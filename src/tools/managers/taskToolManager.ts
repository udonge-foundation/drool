import { EventEmitter } from 'events';
import * as fs from 'fs';

import { createTaskCliTool } from '@industry/drool-core/tools/definitions/cli/taskCli';
import { logException, logInfo, logWarn, Metrics } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';

import { getCustomDroolPaths } from '@/services/drools/CustomDroolRegistry';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { getDroolState } from '@/tools/descriptions/taskToolDescription';
import { TaskCliExecutor } from '@/tools/executors/client/task-cli';
import { getTUIToolRegistry } from '@/tools/registry';

/**
 * Manages dynamic registration of the task tool based on available custom drools.
 * Watches custom drool directories and re-registers the tool whenever drools change.
 */
class TaskToolManager extends EventEmitter {
  private isRegistered = false;

  private projectWatcher: fs.FSWatcher | null = null;

  private personalWatcher: fs.FSWatcher | null = null;

  private debounceTimer: NodeJS.Timeout | null = null;

  private isInitialized = false;

  /**
   * Initialize the manager by performing an initial registration check and setting up watchers.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    await this.updateToolRegistration();
    this.setupFileWatching();

    this.isInitialized = true;
  }

  /**
   * Shutdown the manager, disposing watchers and unregistering the tool if necessary.
   */
  async shutdown(): Promise<void> {
    logInfo('[TaskToolManager] Shutting down');

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.projectWatcher) {
      this.projectWatcher.close();
      this.projectWatcher = null;
    }

    if (this.personalWatcher) {
      this.personalWatcher.close();
      this.personalWatcher = null;
    }

    if (this.isRegistered) {
      await this.unregisterTaskTool();
    }

    this.isInitialized = false;
  }

  /**
   * Check current drool availability and register/unregister the tool accordingly.
   */
  private async updateToolRegistration(): Promise<void> {
    try {
      const { count: droolCount, description } = await getDroolState();

      Metrics.addToCounter(Metric.CUSTOM_DROOL_LOADED_COUNT, droolCount, {
        context: 'tool_registry',
      });

      const hasDrools = droolCount > 0;

      if (hasDrools && !this.isRegistered) {
        await this.registerTaskTool(description);
      } else if (!hasDrools && this.isRegistered) {
        await this.unregisterTaskTool();
      } else if (hasDrools && this.isRegistered) {
        await this.updateTaskToolDescription(description);
      }
    } catch (error) {
      logException(
        error,
        '[TaskToolManager] Failed to update task tool registration'
      );
    }
  }

  private async registerTaskTool(description: string | null): Promise<void> {
    if (!description) {
      logWarn(
        '[TaskToolManager] No description available, skipping registration'
      );
      return;
    }

    const tool = createTaskCliTool({
      description,
      enableV2Schema: getExecRuntimeConfig().isSubAgentsV2Enabled(),
    });
    getTUIToolRegistry().register({
      tool,
      executorIndustry: () => new TaskCliExecutor(),
    });

    this.isRegistered = true;
    this.emit('tool-registered');

    logInfo('[TaskToolManager] Task tool registered successfully');
  }

  private async unregisterTaskTool(): Promise<void> {
    getTUIToolRegistry().unregisterTool('task-cli');
    this.isRegistered = false;
    this.emit('tool-unregistered');

    logInfo('[TaskToolManager] Task tool unregistered successfully');
  }

  private async updateTaskToolDescription(
    description: string | null
  ): Promise<void> {
    try {
      if (!description) {
        await this.unregisterTaskTool();
        return;
      }

      await this.unregisterTaskTool();
      await this.registerTaskTool(description);

      this.emit('tool-description-updated');

      logInfo('[TaskToolManager] Task tool description updated');
    } catch (error) {
      logException(
        error,
        '[TaskToolManager] Failed to update task tool description'
      );
    }
  }

  private setupFileWatching(): void {
    const { project, personal } = getCustomDroolPaths();

    if (fs.existsSync(project)) {
      try {
        this.projectWatcher = fs.watch(
          project,
          this.handleFileChange.bind(this, 'project')
        );
        logInfo('[TaskToolManager] Watching project drool directory', {
          path: project,
        });
      } catch (error) {
        logWarn('[TaskToolManager] Failed to watch project drool directory', {
          error,
          path: project,
        });
      }
    }

    if (fs.existsSync(personal)) {
      try {
        this.personalWatcher = fs.watch(
          personal,
          this.handleFileChange.bind(this, 'personal')
        );
        logInfo('[TaskToolManager] Watching personal drool directory', {
          path: personal,
        });
      } catch (error) {
        logWarn('[TaskToolManager] Failed to watch personal drool directory', {
          error,
          path: personal,
        });
      }
    }
  }

  private handleFileChange(
    location: 'project' | 'personal',
    eventType: string,
    filename: string | null
  ): void {
    if (!filename?.endsWith('.md')) {
      return;
    }

    logInfo('[TaskToolManager] Drool file change detected', {
      location,
      eventType,
      fileName: filename,
    });

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.updateToolRegistration().catch((error) => {
        logException(
          error,
          '[TaskToolManager] Failed to update registration after file change'
        );
      });

      this.emit('drools-changed');
    }, 500);
  }

  isTaskToolRegistered(): boolean {
    return this.isRegistered;
  }
}

let managerInstance: TaskToolManager | null = null;
let initializationPromise: Promise<void> | null = null;

function getTaskToolManager(): TaskToolManager {
  if (!managerInstance) {
    managerInstance = new TaskToolManager();
  }
  return managerInstance;
}

export function initializeTaskToolManager(): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = getTaskToolManager()
      .initialize()
      .catch((error) => {
        initializationPromise = null;
        throw error;
      });
  }

  return initializationPromise;
}
