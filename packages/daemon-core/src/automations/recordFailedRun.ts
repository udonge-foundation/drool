/**
 * Record a failed automation run and schedule a retry (or mark degraded
 * on retry failure). Extracted from control-plane.ts so the function has
 * a cross-file production caller (via runAutomationForScheduler in
 * control-plane.ts) and satisfies knip's unused-export check.
 */
import {
  AutomationRunStatus,
  AutomationStatus,
} from '@industry/common/api/v0/automations';
import {
  AutomationErrorCode,
  type AutomationRunRecord,
} from '@industry/common/automations';
import { discoverAllAutomations } from '@industry/drool-core/automations';
import { logWarn } from '@industry/logging';

import { getAutomationById } from './automation-loader';
import {
  getMaxRunHistory,
  getRetryDelayMs,
  notFoundError,
  setAutomationStatus,
  skeletonState,
} from './skeleton-state';

import type { RecordFailedRunRequest, RecordFailedRunResponse } from './types';

/**
 * Record a failed automation run.
 *
 * - First failure: schedules a retry 5 minutes later.
 * - Retry failure: marks the automation as Degraded and clears any
 *   pending retry.
 */
export async function recordFailedRun(
  request: RecordFailedRunRequest,
  basePath: string
): Promise<RecordFailedRunResponse> {
  const { id, runId, errorMessage, failedAt, isRetry, originalRunId } = request;

  try {
    const discoveryResult = await discoverAllAutomations(basePath);
    const automation = getAutomationById(discoveryResult, id);

    if (!automation || !automation.isValid) {
      return {
        success: false,
        retryScheduled: false,
        markedDegraded: false,
        error: notFoundError(id),
      };
    }

    // Record the failed run in history
    const failedRecord: AutomationRunRecord = {
      runId,
      automationId: id,
      status: AutomationRunStatus.Failure,
      startedAt: failedAt,
      completedAt: failedAt,
      errorMessage,
      isRetry: isRetry ?? false,
      originalRunId,
    };

    const runs = skeletonState.runHistory.get(id) ?? [];
    runs.unshift(failedRecord);
    if (runs.length > getMaxRunHistory()) runs.length = getMaxRunHistory();
    skeletonState.runHistory.set(id, runs);

    // If this is already a retry, mark as degraded (no more retries)
    if (isRetry) {
      setAutomationStatus(id, AutomationStatus.Degraded);
      skeletonState.degradedReasons.set(id, errorMessage);
      // Clear any pending retry
      skeletonState.pendingRetries.delete(id);

      return {
        success: true,
        retryScheduled: false,
        markedDegraded: true,
        degradedReason: errorMessage,
      };
    }

    // Schedule a retry 5 minutes later
    const retryAt = new Date(new Date(failedAt).getTime() + getRetryDelayMs());
    skeletonState.pendingRetries.set(id, {
      automationId: id,
      originalRunId: runId,
      retryAt: retryAt.toISOString(),
      errorMessage,
    });

    return {
      success: true,
      retryScheduled: true,
      retryAt: retryAt.toISOString(),
      markedDegraded: false,
    };
  } catch (error) {
    logWarn('[recordFailedRun] Failed to record failed run', { cause: error });
    return {
      success: false,
      retryScheduled: false,
      markedDegraded: false,
      error: {
        code: AutomationErrorCode.InternalError,
        message:
          error instanceof Error
            ? error.message
            : 'Unknown error recording failed run',
      },
    };
  }
}
