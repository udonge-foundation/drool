/**
 * Mission worker handoff outcome emission.
 *
 * Single source-file location for `Metric.MISSION_WORKER_HANDOFF_RESULT`
 * emissions (VAL-M3A-013). All call sites in MissionRunner — both
 * successful-completion and crash branches — delegate to this helper so the
 * rg-anchored grep "Metric.MISSION_WORKER_HANDOFF_RESULT" returns hits ONLY
 * in this file and its colocated test.
 *
 * Outcome semantics are pinned by the validation contract (Variant B —
 * collapsed): see `deriveCompletionOutcome` for the success-handoff
 * collapse rules and the mission's `library/architecture.md` for KPI
 * shape.
 */

import { Metric, Metrics } from '@industry/logging';

import { HandoffOutcome } from '@/services/mission/enums';
import type { WorkerCompletedEntry } from '@/services/mission/types';

/**
 * Emit exactly one `mission_worker_handoff_result` counter event with the
 * given outcome label.
 *
 * VAL-M3A-013: this is the ONLY production source-file location where
 * `Metric.MISSION_WORKER_HANDOFF_RESULT` may be referenced. Call sites in
 * `MissionRunner.ts` MUST go through this function.
 */
export function emitHandoffOutcome(outcome: HandoffOutcome): void {
  Metrics.addToCounter(Metric.MISSION_WORKER_HANDOFF_RESULT, 1, { outcome });
}

/**
 * Derive the collapsed handoff outcome for a successful WorkerCompletedEntry
 * per Variant B (collapsed) semantics:
 *
 * - `successState === 'success'` AND clean handoff body          → `Success`
 * - `successState === 'success'` AND degenerate handoff body     → `IncompleteHandoff`
 * - `successState === 'partial'`                                  → `Partial` (regardless of body)
 * - `successState === 'failure'`                                  → `Failure` (regardless of body)
 *
 * "Degenerate" handoff body means at least one of:
 *   (a) `whatWasLeftUndone` non-empty AND not literally `'none'` (case-insensitive, trimmed)
 *   (b) `discoveredIssues.length > 0`
 *
 * Crash branches do NOT go through this function — they call
 * `emitHandoffOutcome(HandoffOutcome.Crash)` directly at each WorkerFailed
 * site.
 */
export function deriveCompletionOutcome(
  completed: WorkerCompletedEntry
): Exclude<HandoffOutcome, HandoffOutcome.Crash> {
  if (completed.successState === 'partial') {
    return HandoffOutcome.Partial;
  }
  if (completed.successState === 'failure') {
    return HandoffOutcome.Failure;
  }

  // successState === 'success' — apply Variant B collapse rules.
  const handoff = completed.handoff;
  const whatWasLeftUndoneTrimmed = handoff?.whatWasLeftUndone?.trim() ?? '';
  const hasUndoneWork =
    whatWasLeftUndoneTrimmed.length > 0 &&
    whatWasLeftUndoneTrimmed.toLowerCase() !== 'none';
  const hasDiscoveredIssues = (handoff?.discoveredIssues?.length ?? 0) > 0;

  if (hasUndoneWork || hasDiscoveredIssues) {
    return HandoffOutcome.IncompleteHandoff;
  }
  return HandoffOutcome.Success;
}
