import { ToolConfirmationOutcome } from '@industry/drool-sdk-ext/protocol/drool';

import type { ToolConfirmationBatch } from '@/agent/types';
import type { StateAction } from '@/hooks/types';
import { DELEGATED_PERMISSION_AUTO_REJECT_MARKER } from '@/services/delegatedSession/constants';

/**
 * Shape returned by the delegated-session permission gate when it
 * short-circuits a tool permission request. Mirrors the success return
 * of `PermissionRequestHandler.requestPermission` so the gate can be
 * dropped in for real permission handling on mission workers and
 * subagents.
 *
 * Kept internal to this module — callers never need to construct one
 * themselves; they just forward whatever the gate returns to their
 * `requestPermissionFn`.
 */
interface DelegatedPermissionGateResponse {
  approvedToolIds: string[];
  outcome: ToolConfirmationOutcome;
  comment?: string;
  editedSpecContent?: string;
}

interface DelegatedPermissionGateDeps {
  /**
   * Returns true when the current session should auto-reject permission
   * prompts (e.g. mission workers, subagents). Kept as a getter — not a
   * static value — so the gate reads fresh state each time, since
   * session tags may mutate over a session's lifetime.
   */
  shouldAutoReject: () => boolean;
  /**
   * Pushes a state action into the agent's conversation manager. Used
   * here only to inject ADD_SYSTEM_NOTIFICATION messages that the next
   * model turn will see.
   */
  updateAction: (action: StateAction | StateAction[]) => void;
}

function buildSystemReminder(toolNames: string[]): string {
  const names = toolNames.join(', ');
  return (
    `<system-reminder>\n` +
    `${DELEGATED_PERMISSION_AUTO_REJECT_MARKER} Tool call(s) [${names}] were ` +
    `auto-denied because this delegated session has no user available to ` +
    `confirm actions. Do not retry this exact operation. Either find a ` +
    `different, reversible approach, or skip this step and report the blocker ` +
    `back to the caller:\n` +
    `- Prefer scoped file edits over broad shell commands.\n` +
    `- Instead of deleting files or directories, move them to a temp ` +
    `directory (e.g. \`mv <path> /tmp/trash/\`) so nothing is ` +
    `irreversibly destroyed.\n` +
    `- Instead of overwriting a file in place, write to a new path and ` +
    `leave the original untouched.\n` +
    `- Prefer already-approved tooling and read-only investigation over ` +
    `mutating commands.\n` +
    `- If blocked, continue with remaining work where possible and report ` +
    `the blocked step in your final summary to the caller.\n` +
    `</system-reminder>`
  );
}

/**
 * Short-circuit a tool permission request when the current session is a
 * delegated role (mission worker or subagent) that has no human
 * available to approve. Returns a synthetic Cancel PermissionResponse
 * and pushes a <system-reminder> into the conversation so the session
 * learns (on its next turn) *why* the tool call was rejected and is
 * nudged to try an alternative approach that doesn't require approval.
 *
 * The caller supplies `shouldAutoReject` so this gate is agnostic to
 * *how* a session is classified — most callers will want to pass
 * `isDelegatedAutoRejectSession` from `./detection`, but the predicate
 * is parameterised so tests and specialized callers can plug in their
 * own check.
 *
 * Returns null when the request should proceed to the normal permission
 * flow (sessions that should not auto-reject, or empty batches).
 */
export function maybeAutoRejectDelegatedPermission(
  batch: ToolConfirmationBatch,
  deps: DelegatedPermissionGateDeps
): DelegatedPermissionGateResponse | null {
  if (!deps.shouldAutoReject()) {
    return null;
  }

  if (batch.toolUses.length === 0) {
    return null;
  }

  const toolNames = Array.from(new Set(batch.toolUses.map((t) => t.toolName)));

  deps.updateAction({
    type: 'ADD_SYSTEM_NOTIFICATION',
    content: buildSystemReminder(toolNames),
  });

  return {
    outcome: ToolConfirmationOutcome.Cancel,
    approvedToolIds: [],
  };
}

/**
 * Per-tool error string used by ToolExecutor when the auto-reject gate
 * produces a Cancel outcome. Mirrors the wording of the injected
 * `<system-reminder>` so the model sees consistent guidance from both
 * the tool-call result and the next-turn reminder, and reinforces the
 * "do not retry / pick a reversible alternative or skip" instruction
 * at the per-tool level.
 */
export function buildDelegatedDenialMessage(toolUse: {
  name: string;
  input: Record<string, unknown>;
}): string {
  const label =
    toolUse.name === 'Execute' && typeof toolUse.input.command === 'string'
      ? `command "${toolUse.input.command}"`
      : toolUse.name;
  return `Tool blocked in delegated session: ${label} requires confirmation, but this session has no user available to approve it. Do not retry the same tool call; choose a safer alternative or skip this step.`;
}
