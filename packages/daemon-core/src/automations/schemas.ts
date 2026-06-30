import { z } from 'zod';

/**
 * Schema for automation persistent state.
 *
 * Stored at `<automationPath>/memory/state.json`. Co-owned by the daemon
 * poller (which writes `lastRunAt` + `lastRunId` when it kicks off a run)
 * and the agent first-heartbeat (which overwrites those plus sets
 * `runCount` + `lastRunStatus` when a run completes).
 *
 * All fields are optional so both writers can round-trip safely via
 * `.passthrough()` merge semantics without clobbering the other side's data.
 */
export const AutomationStateSchema = z
  .object({
    /**
     * Stable automation UUID. Written by `ensureAutomationId` in
     * drool-core/loadAutomation.ts. This used to live in HEARTBEAT.md
     * frontmatter but moved here so HEARTBEAT.md can be shared across
     * organizations without colliding Firestore doc IDs.
     */
    id: z.string().optional(),
    lastRunAt: z.string().optional(),
    lastRunId: z.string().optional(),
    /**
     * Drool session id of the last dispatched run. Written by the poller only
     * when the run executed as a real session (dispatchFn path), so clients
     * can deep-link run history entries to their sessions.
     */
    lastRunSessionId: z.string().optional(),
    lastRunStatus: z.string().optional(),
    runCount: z.number().optional(),
  })
  .passthrough();

export type AutomationState = z.infer<typeof AutomationStateSchema>;
