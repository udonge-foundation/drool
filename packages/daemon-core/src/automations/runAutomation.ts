import { AutomationRunStatus } from '@industry/common/api/v0/automations';
import {
  AutomationErrorCode,
  type AutomationRunRecord,
  type RunAutomationRequest,
  type RunAutomationResponse,
} from '@industry/common/automations';
import { discoverAllAutomations } from '@industry/drool-core/automations';
import { logWarn } from '@industry/logging';

import { getAutomationById } from './automation-loader';
import { executeHeartbeat } from './first-heartbeat';
import { markRunCompleted, markRunStarted } from './run-state';
import {
  descriptorToRuntimeState,
  getMaxRunHistory,
  notFoundError,
  skeletonState,
} from './skeleton-state';

export async function runAutomation(
  request: RunAutomationRequest,
  basePath: string
): Promise<RunAutomationResponse> {
  const { id } = request;
  let runId: string | undefined;
  let startedAt: string | undefined;

  try {
    if (skeletonState.currentRuns.has(id)) {
      return {
        success: false,
        error: {
          code: AutomationErrorCode.RunInProgress,
          message: `Automation '${id}' is already running`,
        },
      };
    }

    runId = `run-${id}-${Date.now()}`;
    startedAt = new Date().toISOString();

    skeletonState.currentRuns.set(id, runId);

    const discoveryResult = await discoverAllAutomations(basePath);
    const automation = getAutomationById(discoveryResult, id);

    if (!automation || !automation.isValid) {
      skeletonState.currentRuns.delete(id);
      return {
        success: false,
        error: notFoundError(id),
      };
    }

    try {
      markRunStarted(basePath, {
        automationId: id,
        runId,
        startedAt,
        triggerSource: 'manual',
      });
    } catch (err) {
      // Non-blocking
      logWarn('[runAutomation] Failed to mark run started', { cause: err });
    }

    const heartbeatResult = await executeHeartbeat({
      automationId: id,
      automationPath: automation.path,
    });

    const actualRunId = heartbeatResult.runId ?? runId;

    const run: AutomationRunRecord = {
      runId: actualRunId,
      automationId: id,
      status: heartbeatResult.status,
      startedAt: heartbeatResult.startedAt ?? startedAt,
      completedAt: heartbeatResult.completedAt,
      durationMs: heartbeatResult.durationMs,
      errorMessage: heartbeatResult.error,
    };

    const runs = skeletonState.runHistory.get(id) ?? [];
    runs.unshift(run);
    if (runs.length > getMaxRunHistory()) runs.length = getMaxRunHistory();
    skeletonState.runHistory.set(id, runs);

    skeletonState.currentRuns.delete(id);

    try {
      markRunCompleted(basePath, id, actualRunId, {
        status: heartbeatResult.status,
        error: heartbeatResult.error,
      });
    } catch (err) {
      // Non-blocking
      logWarn('[runAutomation] Failed to mark run completed', { cause: err });
    }

    if (!heartbeatResult.success) {
      return {
        success: false,
        run,
        automation: descriptorToRuntimeState(automation),
        error: {
          code: AutomationErrorCode.ExecutionFailed,
          message: heartbeatResult.error ?? 'Heartbeat execution failed',
        },
      };
    }

    return {
      success: true,
      run,
      automation: descriptorToRuntimeState(automation),
    };
  } catch (error) {
    skeletonState.currentRuns.delete(id);

    logWarn('[runAutomation] Automation run failed', { cause: error });

    if (runId) {
      try {
        markRunCompleted(basePath, id, runId, {
          status: AutomationRunStatus.Failure,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      } catch (completionErr) {
        // Non-blocking
        logWarn('[runAutomation] Failed to mark run completed after error', {
          cause: completionErr,
        });
      }
    }

    return {
      success: false,
      error: {
        code: AutomationErrorCode.InternalError,
        message:
          error instanceof Error
            ? error.message
            : 'Unknown error running automation',
      },
    };
  }
}
