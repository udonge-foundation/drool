/**
 * Due-run polling loop for automated execution dispatch.
 *
 * The poller periodically checks for automations that are due to run
 * and dispatches them for execution. It tracks dispatched runs to prevent
 * duplicate triggering within the same due window.
 *
 * Key behaviors:
 * - Polls at configurable intervals (default: 60 seconds)
 * - Skips paused automations
 * - Prevents duplicate dispatch within the same scheduled time slot
 * - Updates run history and status on dispatch
 * - Dispatches due automations SEQUENTIALLY (not parallel) to ensure
 *   dispatch tracking consistency and predictable ordering
 */

import * as fs from 'fs';

import { AutomationStatus } from '@industry/common/api/v0/automations';
import {
  logException,
  logInfo,
  logWarn,
  Metric,
  Metrics,
} from '@industry/logging';
import { buildAutomationRunLabels } from '@industry/utils/automations';

import { readAutomationState, writeAutomationState } from './automation-state';
import { backfillAutomationState } from './backfillAutomationState';
import {
  getPendingRetries,
  listAutomations,
  processRetry,
  runAutomationForScheduler,
} from './control-plane';
import { computeNextRun, scheduleMatchesNow } from './schedule';

import type {
  PollerCheckResult,
  PollerDispatchResult,
  PollerOptions,
} from './types';
import type { AutomationRuntimeState } from '@industry/common/automations';

// =============================================================================
// Constants
// =============================================================================

/** Default polling interval in milliseconds (60 seconds) */
const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** Minimum allowed polling interval in milliseconds (1 second) */
const MIN_POLL_INTERVAL_MS = 1_000;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if an automation is due to run based on its nextRunAt time.
 *
 * @param nextRunAt - ISO timestamp of the next scheduled run (or undefined)
 * @param now - Current time to compare against
 * @returns true if the automation is due (nextRunAt is before or equal to now)
 */
export function isDue(
  nextRunAt: string | undefined | null,
  now: Date = new Date()
): boolean {
  if (!nextRunAt) {
    return false;
  }

  const nextRunDate = new Date(nextRunAt);
  if (Number.isNaN(nextRunDate.getTime())) {
    return false;
  }

  return nextRunDate <= now;
}

/**
 * Check if an automation was already dispatched in the same calendar minute.
 *
 * Cron schedules have minute-level granularity, so we only need to prevent
 * duplicate dispatch within the same minute. This allows automations with
 * `* * * * *` to fire every minute without a fixed grace period blocking them.
 */
function wasDispatchedThisMinute(
  lastDispatchedAt: Date | undefined,
  now: Date
): boolean {
  if (!lastDispatchedAt) {
    return false;
  }

  return (
    lastDispatchedAt.getFullYear() === now.getFullYear() &&
    lastDispatchedAt.getMonth() === now.getMonth() &&
    lastDispatchedAt.getDate() === now.getDate() &&
    lastDispatchedAt.getHours() === now.getHours() &&
    lastDispatchedAt.getMinutes() === now.getMinutes()
  );
}

// =============================================================================
// DueRunPoller Class
// =============================================================================

/**
 * Polling loop for checking and dispatching due automation runs.
 */
export class DueRunPoller {
  private readonly basePath: string;

  private readonly pollIntervalMs: number;

  private readonly onDispatch?: (result: PollerDispatchResult) => void;

  private readonly onError?: (automationId: string, error: Error) => void;

  private readonly onCheckComplete?: (result: PollerCheckResult) => void;

  private readonly dispatchFn?: (
    automationId: string
  ) => Promise<{ sessionId: string } | null>;

  private readonly recordDispatchFailure?: (
    automationId: string,
    reason: 'dispatch_skipped' | 'dispatch_failed' | 'dispatch_exception'
  ) => Promise<void>;

  private intervalId: ReturnType<typeof setInterval> | null = null;

  private running = false;

  private isChecking = false;

  /**
   * Map of automation ID -> last dispatched timestamp.
   * Used to prevent duplicate dispatch within the same due window.
   */
  private lastDispatched: Map<string, Date> = new Map();

  constructor(options: PollerOptions) {
    this.basePath = options.basePath;
    this.pollIntervalMs = Math.max(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS
    );
    this.dispatchFn = options.dispatchFn;
    this.recordDispatchFailure = options.recordDispatchFailure;
    this.onDispatch = options.onDispatch;
    this.onError = options.onError;
    this.onCheckComplete = options.onCheckComplete;
  }

  /**
   * Start the polling loop.
   *
   * Calling start() when already running is a no-op (idempotent).
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    logInfo('[poller] Starting due-run poller', {
      pollIntervalMs: this.pollIntervalMs,
      path: this.basePath,
    });

    this.intervalId = setInterval(() => {
      void this.checkDueAutomations({ requireRunning: true });
    }, this.pollIntervalMs);
  }

  /**
   * Stop the polling loop.
   *
   * Calling stop() when already stopped is a no-op (idempotent).
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    logInfo('[poller] Stopped due-run poller');
  }

  /**
   * Check if the poller is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the configured poll interval in milliseconds.
   */
  getPollIntervalMs(): number {
    return this.pollIntervalMs;
  }

  /**
   * Get the last dispatched time for an automation.
   */
  getLastDispatchedTime(automationId: string): Date | undefined {
    return this.lastDispatched.get(automationId);
  }

  /**
   * Clear dispatch tracking for a specific automation.
   *
   * This allows the automation to be dispatched again even if it was
   * recently dispatched (useful for manual re-runs or testing).
   */
  clearDispatchTracking(automationId: string): void {
    this.lastDispatched.delete(automationId);
  }

  /**
   * Clear all dispatch tracking data.
   */
  clearAllDispatchTracking(): void {
    this.lastDispatched.clear();
  }

  /**
   * Check all automations for due runs and dispatch them.
   *
   * This is the core polling function that:
   * 1. Processes any pending retries that are due
   * 2. Lists all active automations
   * 3. Checks each for due status
   * 4. Skips paused or recently dispatched automations
   * 5. Dispatches due automations sequentially
   * 6. Updates tracking to prevent duplicates
   *
   * DISPATCH STRATEGY: Sequential (not parallel)
   * Automations are dispatched one at a time to ensure:
   * - Proper tracking of dispatch times (lastDispatched map updates)
   * - Predictable ordering for debugging and logging
   * - No race conditions between dispatch tracking and duplicate prevention
   *
   * @returns Result of the check cycle
   */
  async checkDueAutomations({
    requireRunning = false,
  }: { requireRunning?: boolean } = {}): Promise<PollerCheckResult> {
    const now = new Date();
    const result: PollerCheckResult = {
      checkedCount: 0,
      dispatchedCount: 0,
      skippedCount: 0,
      dispatches: [],
      timestamp: now,
    };

    if (requireRunning && !this.running) {
      return result;
    }

    // Prevent concurrent check cycles from overlapping
    if (this.isChecking) {
      return result;
    }
    this.isChecking = true;

    try {
      // Process pending retries first
      await this.processPendingRetries({ requireRunning });
      if (requireRunning && !this.running) {
        return result;
      }

      // List all automations
      const listResponse = await listAutomations(this.basePath);
      if (requireRunning && !this.running) {
        return result;
      }

      if (!listResponse.success) {
        logWarn('[poller] Failed to list automations', {
          errorMessage: listResponse.error?.message,
        });
        return result;
      }

      const automations = listResponse.automations;
      result.checkedCount = automations.length;

      // Prune dispatch-tracking entries for automations that no longer
      // exist on disk so the map can't grow without bound across long
      // daemon uptimes (deletes, slug renames, repo cleanups).
      const knownIds = new Set(automations.map((a) => a.id));
      for (const trackedId of this.lastDispatched.keys()) {
        if (!knownIds.has(trackedId)) {
          this.lastDispatched.delete(trackedId);
        }
      }

      // Process each automation sequentially to maintain consistency
      // We use sequential processing to ensure proper tracking of dispatch times
      for (const automation of automations) {
        if (requireRunning && !this.running) {
          return result;
        }

        const dispatchResult = await this.processAutomation(automation, now, {
          requireRunning,
        });
        if (dispatchResult) {
          result.dispatches.push(dispatchResult);
          if (dispatchResult.success) {
            result.dispatchedCount++;
          } else {
            // Dispatch was attempted but failed
            result.skippedCount++;
          }
        } else {
          // Automation was skipped (paused, not due, or recently dispatched)
          result.skippedCount++;
        }
      }

      logInfo('[poller] Check complete', {
        automationCheckedCount: result.checkedCount,
        automationDispatchedCount: result.dispatchedCount,
        automationSkippedCount: result.skippedCount,
      });

      // Invoke callback if provided
      this.onCheckComplete?.(result);
    } catch (err) {
      logException(err, '[poller] Error during check cycle');
    } finally {
      this.isChecking = false;
    }

    return result;
  }

  /**
   * Process any pending retries that are due for execution.
   *
   * This is called at the start of each check cycle to ensure
   * retries are processed promptly.
   */
  private async processPendingRetries({
    requireRunning = false,
  }: { requireRunning?: boolean } = {}): Promise<void> {
    try {
      const pendingRetries = await getPendingRetries(this.basePath);

      for (const retryInfo of pendingRetries) {
        if (requireRunning && !this.running) {
          return;
        }

        const { automationId, originalRunId } = retryInfo;

        logInfo('[poller] Processing pending retry', {
          automationId,
          runId: originalRunId,
        });

        try {
          const retryResult = await processRetry(
            { automationId, originalRunId },
            this.basePath
          );

          if (retryResult.success) {
            logInfo('[poller] Retry succeeded', {
              automationId,
              runId: retryResult.run?.runId,
            });
          } else {
            logWarn('[poller] Retry failed, automation marked degraded', {
              automationId,
              errorMessage: retryResult.error?.message,
            });
          }
        } catch (err) {
          logException(err, '[poller] Error processing retry', {
            automationId,
          });
        }
      }
    } catch (err) {
      logException(err, '[poller] Error getting pending retries');
    }
  }

  /**
   * Process a single automation to determine if it should be dispatched.
   *
   * @param automation - The automation to process
   * @param now - Current time
   * @returns Dispatch result if dispatched, null if skipped
   */
  private async processAutomation(
    automation: AutomationRuntimeState,
    now: Date,
    { requireRunning = false }: { requireRunning?: boolean } = {}
  ): Promise<PollerDispatchResult | null> {
    const { id, status, config, isRunning, path: automationPath } = automation;

    // Skip if paused
    if (status === AutomationStatus.Paused) {
      logInfo('[poller] Skipping paused automation', { automationId: id });
      return null;
    }

    // Skip if already running
    if (isRunning) {
      logInfo('[poller] Skipping already running automation', {
        automationId: id,
      });
      return null;
    }

    // Check if schedule matches the current minute
    const matchesNow = scheduleMatchesNow(config.schedule, now);

    if (!matchesNow) {
      // Check for missed runs that need catch-up
      let state = readAutomationState(automationPath);

      // If no state.json exists, try to backfill from session history.
      // Prefer the resolved UUID (config.id, set by ensureAutomationId);
      // fall back to the directory slug when config.id is missing.
      // backfillAutomationState also reads HEARTBEAT.md as a tertiary source.
      if (!state) {
        state = await backfillAutomationState(config.id ?? id, automationPath);
      }

      // Determine the anchor time for catch-up:
      // 1. Prefer lastRunAt from state (or backfilled from sessions)
      // 2. Fall back to the automation directory's birthtime (creation
      //    time) so a newly-created automation whose first scheduled run
      //    was missed while the daemon was down can still catch up.
      //    We use birthtime rather than mtime because loading the
      //    automation can touch mtime (e.g. ensureAutomationId writes
      //    state.json on first discovery).
      let anchor: Date | null = null;
      if (state?.lastRunAt) {
        anchor = new Date(state.lastRunAt);
      } else {
        try {
          const stats = fs.statSync(automationPath);
          // birthtime is 0 on filesystems that don't support it; fall
          // back to mtime in that rare case.
          anchor = stats.birthtimeMs > 0 ? stats.birthtime : stats.mtime;
        } catch (err) {
          logWarn('[poller] Failed to stat automation path for anchor', {
            cause: err,
            automationId: id,
          });
        }
      }

      if (anchor) {
        const nextExpected = computeNextRun(config.schedule, anchor);
        if (nextExpected && nextExpected < now) {
          logInfo('[poller] Catch-up: missed run detected', {
            automationId: id,
            source: state?.lastRunAt ? 'state' : 'dirMtime',
          });
          // Fall through to dispatch catch-up run
        } else {
          return null;
        }
      } else {
        return null;
      }
    }

    // Skip if already dispatched this minute (prevent duplicates within same cron window)
    const lastDispatchedAt = this.lastDispatched.get(id);
    if (wasDispatchedThisMinute(lastDispatchedAt, now)) {
      return null;
    }

    // Dispatch the automation. We persist `lastRunAt` on every dispatch
    // *attempt* that actually reached a run attempt (not just success) so that
    // a failing run does not leave `state.lastRunAt` stale and trigger repeated
    // catch-up dispatches on every subsequent poll. A skipped dispatch (no
    // authenticated connection) is not a run attempt and must remain due so the
    // next poll can retry as soon as a connection is available.
    const dispatchResult = await this.dispatchAutomation(id, now, {
      requireRunning,
    });
    if (dispatchResult?.failureReason === 'dispatch_skipped') {
      return dispatchResult;
    }
    try {
      const patch: Parameters<typeof writeAutomationState>[1] = {
        lastRunAt: now.toISOString(),
      };
      if (dispatchResult?.success && dispatchResult.runId) {
        patch.lastRunId = dispatchResult.runId;
      }
      if (dispatchResult?.success && dispatchResult.sessionId) {
        patch.lastRunSessionId = dispatchResult.sessionId;
      }
      writeAutomationState(automationPath, patch);
    } catch (persistError) {
      logWarn('[poller] Failed to persist automation state', {
        automationId: id,
        cause: persistError,
      });
    }
    return dispatchResult;
  }

  /**
   * Dispatch a single automation run.
   *
   * Uses runAutomationForScheduler to integrate retry policy handling:
   * - On success: run completes, degraded state cleared if present
   * - On first failure: retry scheduled for ~5 minutes later
   * - On retry failure: automation marked as degraded
   *
   * @param automationId - ID of the automation to dispatch
   * @param now - Current time (used for tracking)
   * @returns Result of the dispatch attempt
   */
  private async dispatchAutomation(
    automationId: string,
    now: Date,
    { requireRunning = false }: { requireRunning?: boolean } = {}
  ): Promise<PollerDispatchResult> {
    if (requireRunning && !this.running) {
      return {
        automationId,
        success: false,
        timestamp: now,
        error: 'Poller stopped before dispatch',
      };
    }

    logInfo('[poller] Dispatching automation', { automationId });
    const scheduledRunLabels = buildAutomationRunLabels({
      executionLocation: 'local',
      triggerSource: 'scheduled',
    });
    // An "attempt" means a run actually ran (it reached success or a terminal
    // failure), so attempted stays a clean denominator: attempted = succeeded +
    // failed. A no-connection skip is a deferral, not an attempt, and is counted
    // by AUTOMATION_RUN_SKIPPED instead. Idempotent so the catch handler can
    // safely emit without double-counting a path that already counted.
    let attemptCounted = false;
    const emitAttempted = (): void => {
      if (attemptCounted) {
        return;
      }
      attemptCounted = true;
      Metrics.addToCounter(
        Metric.AUTOMATION_RUN_ATTEMPTED,
        1,
        scheduledRunLabels
      );
    };
    const emitFailure = async (
      reason: 'dispatch_failed' | 'dispatch_exception'
    ): Promise<void> => {
      Metrics.addToCounter(Metric.AUTOMATION_RUN_FAILED, 1, {
        ...scheduledRunLabels,
        reason,
      });
      // Persist the failure as a run record so it stays in the Firestore /
      // BigQuery denominator. Best-effort: a metric must never be blocked by a
      // failed/absent persistence path.
      if (this.recordDispatchFailure) {
        try {
          await this.recordDispatchFailure(automationId, reason);
        } catch (recordError) {
          logWarn('[poller] Failed to persist dispatch failure run record', {
            automationId,
            reason,
            cause: recordError,
          });
        }
      }
    };

    // A skip is a transient deferral, not an execution failure: the run could
    // not be dispatched yet and is retried on the next poll. Emit a metric only
    // and never persist a run record -- persisting would re-fire every poll
    // (~once/minute) and flood the success-rate denominator with phantom
    // failures.
    const emitSkipped = (): void => {
      Metrics.addToCounter(Metric.AUTOMATION_RUN_SKIPPED, 1, {
        ...scheduledRunLabels,
        reason: 'dispatch_skipped',
      });
    };

    const result: PollerDispatchResult = {
      automationId,
      success: false,
      timestamp: now,
    };

    try {
      if (this.dispatchFn) {
        // Use the provided dispatch function (spawns a real drool session)
        const dispatchResult = await this.dispatchFn(automationId);

        if (dispatchResult) {
          // Only track dispatch time on success to allow retry on next poll
          this.lastDispatched.set(automationId, now);
          emitAttempted();
          result.success = true;
          result.runId = dispatchResult.sessionId;
          result.sessionId = dispatchResult.sessionId;
          logInfo('[poller] Automation dispatched via session', {
            automationId,
            sessionId: dispatchResult.sessionId,
          });
        } else {
          result.success = false;
          result.error = 'No authenticated connection available';
          result.failureReason = 'dispatch_skipped';
          emitSkipped();
          logWarn('[poller] Automation dispatch skipped - no connection', {
            automationId,
          });
          // Don't record as failed run or track dispatch time --
          // let the next poll cycle retry when a connection is available.
        }
      } else {
        // Fallback: use control-plane (skeleton/test mode)
        const runResponse = await runAutomationForScheduler(
          { id: automationId },
          this.basePath
        );

        this.lastDispatched.set(automationId, now);
        emitAttempted();

        if (runResponse.success && runResponse.run) {
          result.success = true;
          result.runId = runResponse.run.runId;

          logInfo('[poller] Automation dispatched successfully', {
            automationId,
            runId: result.runId,
          });
        } else {
          result.success = false;
          result.error = runResponse.error?.message ?? 'Unknown error';
          result.failureReason = 'dispatch_failed';
          await emitFailure('dispatch_failed');

          if (runResponse.retryScheduled) {
            logInfo('[poller] Automation failed, retry scheduled', {
              automationId,
              timestamp: runResponse.retryAt,
            });
          } else if (runResponse.markedDegraded) {
            logWarn('[poller] Automation marked degraded after retry failure', {
              automationId,
            });
          } else {
            logWarn('[poller] Automation dispatch failed', {
              automationId,
              errorMessage: result.error,
            });
          }
        }
      }

      // Invoke callback
      this.onDispatch?.(result);
    } catch (err) {
      // Treat a thrown dispatch as a terminal failure for this due window
      // (mirroring the control-plane dispatch_failed path): record it at most
      // once per minute so a sub-60s poll interval can't re-fire and persist
      // duplicate dispatch_exception records within the same cron minute. The
      // next scheduled minute still retries. (Skips deliberately do NOT set
      // this, since they are transient deferrals that should retry immediately.)
      this.lastDispatched.set(automationId, now);
      result.success = false;
      result.error = err instanceof Error ? err.message : 'Unknown error';
      result.failureReason = 'dispatch_exception';
      emitAttempted();
      await emitFailure('dispatch_exception');

      logException(err, '[poller] Exception during dispatch', {
        automationId,
      });

      // Invoke error callback
      if (err instanceof Error) {
        this.onError?.(automationId, err);
      }
    }

    return result;
  }
}
