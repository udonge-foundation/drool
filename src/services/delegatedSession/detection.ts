import { DecompSessionType } from '@industry/drool-sdk-ext/protocol/drool';
import { logInfo } from '@industry/logging';
import {
  hasAutomationSessionTag,
  hasSubagentSessionTag,
} from '@industry/utils/session';

import { getSessionService } from '@/services/SessionService';

/**
 * True when the current session was delegated rather than driven by a
 * human at a terminal — mission/squad workers (spawned by an orchestrator),
 * Task-tool subagents, and automation sessions (the setup/run sessions
 * behind a scheduled or QA automation). These sessions routinely have no
 * user at the terminal to approve a permission prompt, so a runner with no
 * other approver must auto-reject instead of hanging or crashing.
 *
 * This is the BROAD predicate. Use it where there is no parent to forward a
 * prompt to (`renderlessExecRunner`'s `drool exec` path) and in
 * `ToolExecutor` to format the per-tool denial message / mark tool ids
 * auto-denied when a delegated prompt resolves to Cancel. Runners that CAN
 * forward to a parent (`sharedAgentRunner`, `streamingJsonRpcExecRunner` —
 * the daemon path behind automations) instead use the narrower
 * {@link isNoApproverDelegatedSession}, so approver-backed subagents forward
 * their prompts rather than auto-reject.
 *
 * Automation sessions default to high autonomy, so most tool calls are
 * auto-approved and never reach the gate; it only fires for the residue
 * that still requires confirmation (e.g. an org `maxAutonomyLevel` cap or
 * always-confirm tools), which is then auto-denied with a nudge toward a
 * safer, reversible approach instead of blocking. Note the gate covers only
 * permission prompts — AskUser is intentionally left available so automation
 * setup can still collect genuinely required input (e.g. QA triage secrets),
 * surfaced by the creation screen's waiting state.
 *
 * Reads the session service on every call so the predicate reflects
 * whatever tags/role the session currently has, not a stale snapshot.
 */
export function isDelegatedAutoRejectSession(): boolean {
  const sessionService = getSessionService();
  let shouldAutoReject = false;
  if (sessionService.getDecompSessionType() === DecompSessionType.Worker) {
    shouldAutoReject = true;
  }
  const tags = sessionService.getCurrentSessionTags() ?? [];
  shouldAutoReject ||=
    hasSubagentSessionTag(tags) || hasAutomationSessionTag(tags);

  if (shouldAutoReject) {
    logInfo(
      'Current session is a delegated session (mission worker, subagent, or automation); permission prompts will auto-reject.',
      {
        sessionTags: JSON.stringify(tags.map((t) => t.name)),
        autoAcceptRiskLevel: sessionService.getAutonomyLevel(),
      }
    );
  }
  return shouldAutoReject;
}

/**
 * True when the current session is a delegated session with NO approver
 * reachable — mission/squad workers (spawned by an orchestrator) and
 * automation sessions (unattended: scheduled, remote, service-account, or
 * left waiting after the user navigates away from the creation screen).
 * Unlike the broader {@link isDelegatedAutoRejectSession}, this deliberately
 * EXCLUDES subagents: a subagent always runs with a parent process
 * connected over JSON-RPC (or ACP) that can be asked to approve, so its
 * permission prompts are forwarded to that parent rather than auto-rejected.
 *
 * Use this in runners that have a forwarding-capable permission handler
 * (`sharedAgentRunner.runAgentWithSession`, `streamingJsonRpcExecRunner` —
 * the daemon path behind automations). Routing automations through here (not
 * just the broad predicate) is what makes their residual permission prompts
 * auto-reject with a nudge instead of forwarding to a parent that may never
 * answer. Runners with no parent to forward to (`renderlessExecRunner`'s
 * `drool exec` path) keep using {@link isDelegatedAutoRejectSession} so
 * subagents there still auto-reject.
 */
export function isNoApproverDelegatedSession(): boolean {
  const sessionService = getSessionService();
  if (sessionService.getDecompSessionType() === DecompSessionType.Worker) {
    return true;
  }
  const tags = sessionService.getCurrentSessionTags() ?? [];
  return hasAutomationSessionTag(tags);
}
