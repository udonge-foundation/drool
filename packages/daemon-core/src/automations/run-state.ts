/**
 * Run state management for restart-safe recovery.
 *
 * This module provides persistent tracking of in-flight automation runs
 * so that desktop restarts during execution can:
 * 1. Identify interrupted runs
 * 2. Mark them as failed with appropriate diagnostic context
 * 3. Avoid creating duplicate completion records
 *
 * State files are stored in .industry/run-state/<automationId>.json
 */

import * as fs from 'fs';

import { AutomationRunStatus } from '@industry/common/api/v0/automations';
import { logException, logInfo, logWarn } from '@industry/logging';

import {
  InFlightRunStateSchema,
  clearInFlightRun,
  getInFlightRuns,
  getRunStateDirPath,
  getRunStateFilePath,
} from './run-state-helpers';

import type {
  InFlightRunState,
  MarkRunCompletedOptions,
  MarkRunStartedOptions,
  RecoveredRunInfo,
} from './types';

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Mark a run as started by creating a persistent state file.
 *
 * This creates a .industry/run-state/<automationId>.json file that persists
 * across restarts. If the desktop restarts while the run is in progress,
 * this file allows us to detect and recover the interrupted run.
 *
 * @param basePath - Base path containing .industry directory
 * @param options - Run start options
 */
export function markRunStarted(
  basePath: string,
  options: MarkRunStartedOptions
): void {
  const { automationId, runId, startedAt, triggerSource, triggerContext } =
    options;

  const stateDir = getRunStateDirPath(basePath);
  const stateFilePath = getRunStateFilePath(basePath, automationId);

  // Ensure state directory exists
  fs.mkdirSync(stateDir, { recursive: true });

  // Create state object
  const state: InFlightRunState = {
    automationId,
    runId,
    startedAt,
    status: 'in_progress',
    ...(triggerSource && { triggerSource }),
    ...(triggerContext && { triggerContext }),
  };

  // Write state file atomically (write to temp then rename)
  const tempPath = `${stateFilePath}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tempPath, stateFilePath);

    logInfo('[run-state] Marked run started', {
      automationId,
      runId,
    });
  } catch (err) {
    // Clean up temp file if exists
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupErr) {
      // Ignore cleanup errors
      logWarn('[run-state] Failed to clean up temp file', {
        cause: cleanupErr,
      });
    }
    throw err;
  }
}

/**
 * Mark a run as completed by removing the state file.
 *
 * This should be called when a run completes (either success or failure).
 * The state file is removed, indicating the run is no longer in-flight.
 *
 * This operation is idempotent - calling it multiple times or when no
 * state file exists is safe.
 *
 * @param basePath - Base path containing .industry directory
 * @param automationId - Automation ID
 * @param runId - Run ID (used for validation logging)
 * @param options - Optional completion details
 */
export function markRunCompleted(
  basePath: string,
  automationId: string,
  runId: string,
  options?: MarkRunCompletedOptions
): void {
  const stateFilePath = getRunStateFilePath(basePath, automationId);

  try {
    // Check if file exists and validate runId
    if (fs.existsSync(stateFilePath)) {
      try {
        const content = fs.readFileSync(stateFilePath, 'utf-8');
        const state = InFlightRunStateSchema.parse(JSON.parse(content));

        // Warn if runId doesn't match (possible inconsistency)
        if (state.runId !== runId) {
          logWarn('[run-state] RunId mismatch during completion', {
            automationId,
            runId,
            errorMessage: `Expected runId ${state.runId}, got ${runId}`,
          });
        }
      } catch (readErr) {
        // If we can't read the file, just proceed with deletion
        logWarn('[run-state] Failed to read state file during completion', {
          cause: readErr,
        });
      }

      fs.unlinkSync(stateFilePath);

      logInfo('[run-state] Marked run completed', {
        automationId,
        runId,
        state: options?.status ?? AutomationRunStatus.Success,
      });
    }
  } catch (err) {
    // Log but don't throw - completion tracking should not block the run
    logException(err, '[run-state] Failed to remove state file', {
      path: stateFilePath,
    });
  }
}

/**
 * Recover interrupted runs after a restart.
 *
 * This function should be called when the desktop app starts up.
 * It finds any in-flight runs that were interrupted by the restart
 * and marks them as failed with appropriate diagnostic context.
 *
 * @param basePath - Base path containing .industry directory
 * @returns Array of recovered run information
 */
export async function recoverInterruptedRuns(
  basePath: string
): Promise<RecoveredRunInfo[]> {
  const inFlightRuns = getInFlightRuns(basePath);

  if (inFlightRuns.length === 0) {
    return [];
  }

  logInfo('[run-state] Found interrupted runs to recover', {
    count: inFlightRuns.length,
  });

  // Import dynamically to avoid circular dependency (once, not in loop)
  const { recordInterruptedRun } = await import('./control-plane');

  // Process all interrupted runs in parallel
  const recoveryResults = await Promise.all(
    inFlightRuns.map(async (run) => {
      const { automationId, runId, startedAt, triggerSource } = run;

      try {
        await recordInterruptedRun(basePath, {
          automationId,
          runId,
          startedAt,
          interruptedAt: new Date().toISOString(),
          reason: 'Desktop restarted while run was in progress',
        });

        // Clear the state file
        clearInFlightRun(basePath, automationId);

        logInfo('[run-state] Recovered interrupted run', {
          automationId,
          runId,
        });

        return {
          automationId,
          runId,
          startedAt,
          recoveryReason: 'desktop_restart' as const,
          triggerSource,
        };
      } catch (err) {
        logException(err, '[run-state] Failed to recover interrupted run', {
          automationId,
          runId,
        });

        // Still clear the state file to avoid repeated recovery attempts
        clearInFlightRun(basePath, automationId);
        return null;
      }
    })
  );

  // Filter out failed recoveries and return as typed array
  const successfulRecoveries: RecoveredRunInfo[] = [];
  for (const result of recoveryResults) {
    if (result !== null) {
      successfulRecoveries.push(result);
    }
  }
  return successfulRecoveries;
}
