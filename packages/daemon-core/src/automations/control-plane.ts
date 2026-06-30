/**
 * Automation control-plane skeleton implementation.
 *
 * This module provides the daemon-side control-plane actions for automations:
 * - create: Create a new automation scaffold
 * - list: List all automations with runtime state
 * - run: Trigger an automation run
 * - pause: Pause an automation's schedule
 * - resume: Resume a paused automation's schedule
 * - history: Get run history for an automation
 *
 * In the skeleton milestone, these actions return deterministic placeholder
 * responses without triggering destructive side effects.
 */

import * as yaml from 'js-yaml';

import {
  AutomationRunStatus,
  AutomationStatus,
} from '@industry/common/api/v0/automations';
import {
  AutomationErrorCode,
  AutomationsHeartbeatSchema,
  type AutomationsHeartbeat,
  type AutomationRunRecord,
  type AutomationRuntimeState,
  type InvalidAutomationDescriptor,
  type CreateAutomationRequest,
  type CreateAutomationResponse,
  type GetHistoryRequest,
  type GetHistoryResponse,
  type ListAutomationsRequest,
  type ListAutomationsResponse,
  type PauseAutomationRequest,
  type PauseAutomationResponse,
  type ResumeAutomationRequest,
  type ResumeAutomationResponse,
} from '@industry/common/automations';
import { discoverAllAutomations } from '@industry/drool-core/automations';
import { logWarn } from '@industry/logging';

import {
  createAutomationScaffold,
  getAutomationById,
  getValidAutomations,
} from './automation-loader';
import { readAutomationState } from './automation-state';
import { executeFirstHeartbeat, executeHeartbeat } from './first-heartbeat';
import { recordFailedRun } from './recordFailedRun';
import { runAutomation } from './runAutomation';
import { validateSchedule } from './schedule';
import {
  descriptorToRuntimeState,
  getAutomationStatus,
  getMaxRunHistory,
  notFoundError,
  setAutomationStatus,
  skeletonState,
} from './skeleton-state';

import type {
  PendingRetryInfo,
  ProcessRetryRequest,
  ProcessRetryResponse,
  RecordInterruptedRunRequest,
  RunAutomationForSchedulerOptions,
  RunAutomationForSchedulerResponse,
} from './types';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Narrow a raw string (as persisted in state.json) to `AutomationRunStatus`
 * without an `as` type assertion. Returns `undefined` if the value is not
 * a valid enum member.
 */
function toAutomationRunStatus(
  value: unknown
): AutomationRunStatus | undefined {
  if (typeof value !== 'string') return undefined;
  for (const candidate of Object.values(AutomationRunStatus)) {
    if (candidate === value) return candidate;
  }
  return undefined;
}

/**
 * Update a frontmatter field in a HEARTBEAT.md file.
 */
async function updateHeartbeatFrontmatter(
  automationPath: string,
  field: keyof AutomationsHeartbeat,
  value: AutomationsHeartbeat[keyof AutomationsHeartbeat]
): Promise<void> {
  const fs = await import('fs');
  const path = await import('path');
  const { AUTOMATION_HEARTBEAT_FILE } = await import(
    '@industry/common/automations'
  );
  const heartbeatPath = path.join(automationPath, AUTOMATION_HEARTBEAT_FILE);
  const content = await fs.promises.readFile(heartbeatPath, 'utf-8');
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
  const match = frontmatterRegex.exec(content);
  if (!match) return;
  const metadata = AutomationsHeartbeatSchema.parse(yaml.load(match[1]));
  const updated = { ...metadata, [field]: value };
  const newFrontmatter = yaml.dump(updated, { lineWidth: -1 }).trimEnd();
  const body = content.substring(match[0].length);
  const newContent = `---\n${newFrontmatter}\n---${body}`;
  await fs.promises.writeFile(heartbeatPath, newContent, 'utf-8');
}

// =============================================================================
// Control-Plane Actions
// =============================================================================

/**
 * Create a new automation scaffold.
 *
 * In skeleton milestone:
 * - Creates the directory structure if basePath is provided
 * - Returns deterministic response without triggering first run
 */
export async function createAutomation(
  request: CreateAutomationRequest,
  basePath: string,
  industryDirName?: string
): Promise<CreateAutomationResponse> {
  const {
    id,
    uuid,
    name,
    description,
    instructions,
    schedule,
    model,
    visualDescription,
    memoryStrategy,
    skipFirstRun,
  } = request;

  // Validate ID format
  if (
    !id ||
    id.includes('/') ||
    id.includes('\\') ||
    id === '.' ||
    id === '..'
  ) {
    return {
      success: false,
      error: {
        code: AutomationErrorCode.InvalidId,
        message: `Invalid automation ID: "${id}". IDs cannot contain path separators or be "." or ".."`,
      },
    };
  }

  // Validate schedule format
  const scheduleValidation = validateSchedule(schedule);
  if (!scheduleValidation.isValid) {
    return {
      success: false,
      error: {
        code: AutomationErrorCode.InvalidConfig,
        message: scheduleValidation.error ?? 'Invalid schedule',
      },
    };
  }

  try {
    // Create the scaffold
    const automationPath = await createAutomationScaffold({
      id,
      uuid,
      name,
      description,
      instructions,
      schedule,
      model,
      basePath,
      industryDirName,
      visualDescription,
      memoryStrategy,
    });

    // Scaffold-only path (remote create-time scaffold / run-time ensure): the
    // run is dispatched by the backend workflow, so executing a local heartbeat
    // here would double-run the automation. Return immediately with the
    // scaffold in place and the automation marked Active.
    if (skipFirstRun) {
      setAutomationStatus(id, AutomationStatus.Active);
      return {
        success: true,
        automation: {
          id,
          path: automationPath,
          config: {
            name,
            description,
            schedule: { cadence: schedule },
          },
          status: AutomationStatus.Active,
          isRunning: false,
          structure: {
            hasHeartbeat: true,
            hasVisual: true,
            hasMemoryDir: true,
            hasReportsDir: true,
          },
        },
      };
    }

    // Execute the first heartbeat to initialize the automation
    const firstRunResult = await executeFirstHeartbeat({
      automationId: id,
      automationPath,
    });

    // Set initial status based on first run result
    const initialStatus = firstRunResult.success
      ? AutomationStatus.Active
      : AutomationStatus.Degraded;
    setAutomationStatus(id, initialStatus);

    // Store the first run in history
    if (firstRunResult.runId) {
      const runRecord: AutomationRunRecord = {
        runId: firstRunResult.runId,
        automationId: id,
        status: firstRunResult.status,
        startedAt: firstRunResult.startedAt ?? new Date().toISOString(),
        completedAt: firstRunResult.completedAt,
        durationMs: firstRunResult.durationMs,
        errorMessage: firstRunResult.error,
      };
      const runs = skeletonState.runHistory.get(id) ?? [];
      runs.unshift(runRecord);
      if (runs.length > getMaxRunHistory()) runs.length = getMaxRunHistory();
      skeletonState.runHistory.set(id, runs);
    }

    // Return the created automation state with first run info
    const automation: AutomationRuntimeState = {
      id,
      path: automationPath,
      config: {
        name,
        description,
        schedule: { cadence: schedule },
      },
      status: initialStatus,
      isRunning: false,
      lastRunAt: firstRunResult.startedAt,
      lastRunId: firstRunResult.runId,
      lastRunStatus: firstRunResult.status,
      structure: {
        hasHeartbeat: true,
        hasVisual: true,
        hasMemoryDir: true,
        hasReportsDir: true,
      },
      ...(firstRunResult.error && initialStatus === AutomationStatus.Degraded
        ? { degradedReason: firstRunResult.error }
        : {}),
    };

    return {
      success: true,
      automation,
      firstRun: firstRunResult.success
        ? {
            runId: firstRunResult.runId!,
            status: firstRunResult.status,
            startedAt: firstRunResult.startedAt!,
            completedAt: firstRunResult.completedAt,
            durationMs: firstRunResult.durationMs,
          }
        : undefined,
      firstRunError: firstRunResult.error,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown error creating automation';

    logWarn('[control-plane] Failed to create automation', { cause: error });

    // Check if it's an "already exists" error
    if (message.includes('already exists')) {
      return {
        success: false,
        error: {
          code: AutomationErrorCode.AlreadyExists,
          message,
        },
      };
    }

    return {
      success: false,
      error: {
        code: AutomationErrorCode.InternalError,
        message,
      },
    };
  }
}

/**
 * List all automations with their runtime state.
 *
 * Discovers automations from filesystem and returns:
 * - Valid automations as runtime states
 * - Invalid automations as descriptors (for flagged display)
 */
export async function listAutomations(
  basePath: string,
  _request?: ListAutomationsRequest
): Promise<ListAutomationsResponse> {
  try {
    // Use discoverAllAutomations to find automations in both user-level
    // (~/.industry-dev in dev) and project-level (.industry) directories
    const discoveryResult = await discoverAllAutomations(basePath);
    const validAutomations = getValidAutomations(discoveryResult);

    // Convert valid automations to runtime states, backfilling the persisted
    // last-run anchor from memory/state.json when there is no in-memory run
    // history (e.g. after a daemon or CLI restart).
    const automations = validAutomations.map((descriptor) => {
      const runtimeState = descriptorToRuntimeState(descriptor);
      if (!runtimeState.lastRunAt) {
        const persistedState = readAutomationState(descriptor.path);
        if (persistedState?.lastRunAt) {
          runtimeState.lastRunAt = persistedState.lastRunAt;
        }
      }
      return runtimeState;
    });

    // Apply status filter if requested
    const filteredAutomations = _request?.status
      ? automations.filter((a) => a.status === _request.status)
      : automations;

    // Collect invalid automations (if not explicitly excluded)
    const includeInvalid = _request?.includeInvalid !== false;
    const invalidAutomations = includeInvalid
      ? discoveryResult.automations.filter(
          (a): a is InvalidAutomationDescriptor => !a.isValid
        )
      : [];

    return {
      success: true,
      automations: filteredAutomations,
      invalidAutomations:
        invalidAutomations.length > 0 ? invalidAutomations : undefined,
      validCount: discoveryResult.validCount,
      invalidCount: discoveryResult.invalidCount,
    };
  } catch (error) {
    logWarn('[control-plane] Failed to list automations', { cause: error });
    return {
      success: false,
      automations: [],
      validCount: 0,
      invalidCount: 0,
      error: {
        code: AutomationErrorCode.InternalError,
        message:
          error instanceof Error
            ? error.message
            : 'Unknown error listing automations',
      },
    };
  }
}

/**
 * Pause an automation's schedule.
 *
 * In skeleton milestone:
 * - Validates the automation exists
 * - Updates in-memory status to Paused
 * - Returns updated state
 */
export async function pauseAutomation(
  request: PauseAutomationRequest,
  basePath: string
): Promise<PauseAutomationResponse> {
  const { id } = request;

  try {
    const discoveryResult = await discoverAllAutomations(basePath);
    const automation = getAutomationById(discoveryResult, id);

    if (!automation || !automation.isValid) {
      return {
        success: false,
        error: notFoundError(id),
      };
    }

    const currentStatus = getAutomationStatus(id);

    // Check if already paused
    if (currentStatus === AutomationStatus.Paused) {
      return {
        success: true, // Idempotent: already in desired state
        automation: descriptorToRuntimeState(automation, currentStatus),
      };
    }

    // Update status to Paused (in-memory + persisted)
    setAutomationStatus(id, AutomationStatus.Paused);

    await updateHeartbeatFrontmatter(automation.path, 'paused', true);

    return {
      success: true,
      automation: descriptorToRuntimeState(automation, AutomationStatus.Paused),
    };
  } catch (error) {
    logWarn('[control-plane] Failed to pause automation', { cause: error });
    return {
      success: false,
      error: {
        code: AutomationErrorCode.InternalError,
        message:
          error instanceof Error
            ? error.message
            : 'Unknown error pausing automation',
      },
    };
  }
}

/**
 * Resume a paused automation's schedule.
 *
 * In skeleton milestone:
 * - Validates the automation exists
 * - Updates in-memory status to Active
 * - Returns updated state
 */
export async function resumeAutomation(
  request: ResumeAutomationRequest,
  basePath: string
): Promise<ResumeAutomationResponse> {
  const { id } = request;

  try {
    const discoveryResult = await discoverAllAutomations(basePath);
    const automation = getAutomationById(discoveryResult, id);

    if (!automation || !automation.isValid) {
      return {
        success: false,
        error: notFoundError(id),
      };
    }

    const currentStatus = getAutomationStatus(id);

    // Check if already active
    if (currentStatus === AutomationStatus.Active) {
      return {
        success: true, // Idempotent: already in desired state
        automation: descriptorToRuntimeState(automation, currentStatus),
      };
    }

    // Update status to Active (in-memory + persisted)
    setAutomationStatus(id, AutomationStatus.Active);

    await updateHeartbeatFrontmatter(automation.path, 'paused', undefined);

    return {
      success: true,
      automation: descriptorToRuntimeState(automation, AutomationStatus.Active),
    };
  } catch (error) {
    logWarn('[control-plane] Failed to resume automation', { cause: error });
    return {
      success: false,
      error: {
        code: AutomationErrorCode.InternalError,
        message:
          error instanceof Error
            ? error.message
            : 'Unknown error resuming automation',
      },
    };
  }
}

/**
 * Get run history for an automation.
 * @public
 */
export async function getHistory(
  request: GetHistoryRequest,
  basePath: string
): Promise<GetHistoryResponse> {
  const { id, limit = 50, offset = 0 } = request;

  try {
    const discoveryResult = await discoverAllAutomations(basePath);
    const automation = getAutomationById(discoveryResult, id);

    if (!automation || !automation.isValid) {
      return {
        success: false,
        automationId: id,
        runs: [],
        totalCount: 0,
        error: notFoundError(id),
      };
    }

    let allRuns = skeletonState.runHistory.get(id) ?? [];

    // Preserve the last known run after in-memory history is reset.
    if (allRuns.length === 0 && automation.isValid) {
      const persistedState = readAutomationState(automation.path);
      if (persistedState?.lastRunAt && persistedState.lastRunId) {
        const persistedStatus = toAutomationRunStatus(
          persistedState.lastRunStatus
        );
        allRuns = [
          {
            runId: persistedState.lastRunId,
            automationId: id,
            status: persistedStatus ?? AutomationRunStatus.Success,
            startedAt: persistedState.lastRunAt,
            ...(persistedState.lastRunSessionId === persistedState.lastRunId
              ? { sessionId: persistedState.lastRunSessionId }
              : {}),
          },
        ];
      }
    }

    const paginatedRuns = allRuns.slice(offset, offset + limit);

    return {
      success: true,
      automationId: id,
      runs: paginatedRuns,
      totalCount: allRuns.length,
    };
  } catch (error) {
    logWarn('[control-plane] Failed to get automation history', {
      cause: error,
    });
    return {
      success: false,
      automationId: id,
      runs: [],
      totalCount: 0,
      error: {
        code: AutomationErrorCode.InternalError,
        message:
          error instanceof Error
            ? error.message
            : 'Unknown error getting history',
      },
    };
  }
}

// =============================================================================
// Retry Policy and Degraded State
// =============================================================================

/**
 * Get all pending retries that are due for execution.
 *
 * @param basePath - Base path (for context, not currently used)
 * @returns Array of pending retry info for retries that are due
 */
export async function getPendingRetries(
  _basePath: string
): Promise<PendingRetryInfo[]> {
  const now = new Date();
  const dueRetries: PendingRetryInfo[] = [];

  for (const retryInfo of skeletonState.pendingRetries.values()) {
    const retryTime = new Date(retryInfo.retryAt);
    if (retryTime <= now) {
      dueRetries.push(retryInfo);
    }
  }

  return dueRetries;
}

/**
 * Process a scheduled retry for a failed run.
 *
 * This function:
 * - Executes the heartbeat
 * - Marks the run as a retry in the history
 * - Clears the pending retry entry
 * - On success: clears degraded state if present
 * - On failure: marks automation as degraded
 *
 * @param request - Retry processing request
 * @param basePath - Base path containing .industry directory
 * @returns Response with the retry run result
 */
export async function processRetry(
  request: ProcessRetryRequest,
  basePath: string
): Promise<ProcessRetryResponse> {
  const { automationId, originalRunId } = request;

  try {
    const discoveryResult = await discoverAllAutomations(basePath);
    const automation = getAutomationById(discoveryResult, automationId);

    if (!automation || !automation.isValid) {
      return {
        success: false,
        error: notFoundError(automationId),
      };
    }

    // Execute the heartbeat for the retry
    const heartbeatResult = await executeHeartbeat({
      automationId,
      automationPath: automation.path,
    });

    // Create run record marked as retry
    const retryRun: AutomationRunRecord = {
      runId: heartbeatResult.runId!,
      automationId,
      status: heartbeatResult.status,
      startedAt: heartbeatResult.startedAt!,
      completedAt: heartbeatResult.completedAt,
      durationMs: heartbeatResult.durationMs,
      errorMessage: heartbeatResult.error,
      isRetry: true,
      originalRunId,
    };

    // Store the retry run record
    const runs = skeletonState.runHistory.get(automationId) ?? [];
    runs.unshift(retryRun);
    if (runs.length > getMaxRunHistory()) runs.length = getMaxRunHistory();
    skeletonState.runHistory.set(automationId, runs);

    // Clear the pending retry
    skeletonState.pendingRetries.delete(automationId);

    if (heartbeatResult.success) {
      // Successful retry - clear degraded state if present
      if (getAutomationStatus(automationId) === AutomationStatus.Degraded) {
        setAutomationStatus(automationId, AutomationStatus.Active);
        skeletonState.degradedReasons.delete(automationId);
      }

      return {
        success: true,
        run: retryRun,
        automation: descriptorToRuntimeState(automation),
      };
    }

    // Retry failed - mark as degraded
    setAutomationStatus(automationId, AutomationStatus.Degraded);
    skeletonState.degradedReasons.set(
      automationId,
      heartbeatResult.error ?? 'Retry failed'
    );

    return {
      success: false,
      run: retryRun,
      automation: descriptorToRuntimeState(automation),
      error: {
        code: AutomationErrorCode.ExecutionFailed,
        message: heartbeatResult.error ?? 'Retry execution failed',
      },
    };
  } catch (error) {
    logWarn('[control-plane] Failed to process retry', { cause: error });
    return {
      success: false,
      error: {
        code: AutomationErrorCode.InternalError,
        message:
          error instanceof Error
            ? error.message
            : 'Unknown error processing retry',
      },
    };
  }
}

// =============================================================================
// Recovery Functions
// =============================================================================

/**
 * Record an interrupted run in the history.
 *
 * This is called during recovery when an in-flight run was interrupted
 * by a desktop restart. It creates a failure record with diagnostic context
 * to ensure the history accurately reflects what happened.
 *
 * This function is idempotent - if the run is already recorded in history,
 * it will not create a duplicate.
 *
 * @param basePath - Base path containing .industry directory
 * @param request - Interrupted run details
 */
export async function recordInterruptedRun(
  basePath: string,
  request: RecordInterruptedRunRequest
): Promise<void> {
  const { automationId, runId, startedAt, interruptedAt, reason } = request;

  // Check if this run is already in history (avoid duplicates)
  const existingRuns = skeletonState.runHistory.get(automationId) ?? [];
  const alreadyRecorded = existingRuns.some((r) => r.runId === runId);

  if (alreadyRecorded) {
    // Run already recorded, nothing to do
    return;
  }

  // Create a failure record for the interrupted run
  const interruptedRecord: AutomationRunRecord = {
    runId,
    automationId,
    status: AutomationRunStatus.Failure,
    startedAt,
    completedAt: interruptedAt,
    errorMessage: `Run interrupted: ${reason}`,
  };

  // Add to history
  existingRuns.unshift(interruptedRecord);
  skeletonState.runHistory.set(automationId, existingRuns);

  // Clear any "running" state for this automation
  if (skeletonState.currentRuns.get(automationId) === runId) {
    skeletonState.currentRuns.delete(automationId);
  }
}

// =============================================================================
// Scheduler Integration Functions
// =============================================================================

/**
 * Run an automation triggered by the scheduler (due-run or retry).
 *
 * This function wraps runAutomation with retry policy integration:
 * - On success: clears degraded state if present
 * - On failure (first attempt): schedules a retry 5 minutes later
 * - On failure (retry attempt): marks automation as degraded
 *
 * @param options - Run options including retry context
 * @param basePath - Base path containing .industry directory
 * @returns Response with run result and retry/degraded status
 */
export async function runAutomationForScheduler(
  options: RunAutomationForSchedulerOptions,
  basePath: string
): Promise<RunAutomationForSchedulerResponse> {
  const { id, isRetry = false, originalRunId } = options;

  // Execute the run
  const runResponse = await runAutomation({ id }, basePath);

  if (runResponse.success && runResponse.run) {
    // Success - clear degraded state if present
    const currentStatus = getAutomationStatus(id);
    if (currentStatus === AutomationStatus.Degraded) {
      setAutomationStatus(id, AutomationStatus.Active);
      skeletonState.degradedReasons.delete(id);
    }

    return {
      success: true,
      run: runResponse.run,
      retryScheduled: false,
      markedDegraded: false,
    };
  }

  // Run failed - apply retry policy
  const failedAt = new Date().toISOString();
  const errorMessage =
    runResponse.error?.message ?? 'Unknown execution failure';

  // Record the failure and handle retry policy
  const failureResponse = await recordFailedRun(
    {
      id,
      runId: runResponse.run?.runId ?? `run-${id}-${Date.now()}`,
      errorMessage,
      failedAt,
      isRetry,
      originalRunId,
    },
    basePath
  );

  return {
    success: false,
    run: runResponse.run,
    retryScheduled: failureResponse.retryScheduled,
    retryAt: failureResponse.retryAt,
    markedDegraded: failureResponse.markedDegraded,
    error: runResponse.error,
  };
}

// =============================================================================
// Testing Utilities
// =============================================================================

/**
 * Reset skeleton state (for testing only).
 * @internal
 */
export function _resetSkeletonState(): void {
  skeletonState.statuses.clear();
  skeletonState.runHistory.clear();
  skeletonState.currentRuns.clear();
  skeletonState.degradedReasons.clear();
  skeletonState.pendingRetries.clear();
}
