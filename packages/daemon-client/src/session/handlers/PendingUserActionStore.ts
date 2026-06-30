import { logInfo } from '@industry/logging';

import type { StoredAskUserAction, StoredPermissionAction } from './types';

/**
 * In-memory buffer for prompt responses made while a session is inactive.
 *
 * Permission responses are keyed GLOBALLY by `toolUseId` (the tool-call id),
 * not by session. A relayed subagent permission is answered from the parent
 * surface but must be replayed/suppressed when the worker session reloads, and
 * the same answer may need to be re-applied across several reloads (self-resume
 * plus a manual open) before the daemon confirms resolution. A per-session key
 * stranded the answer on one surface and a single consume let the prompt
 * re-surface on a later reload. The tool-call id is globally unique, so keying
 * by it lets any reload of any associated session recognize the answered
 * permission. Ask-user answers remain session-scoped (no relay/fan-out path).
 */
export class PendingUserActionStore {
  private permissionsByToolUseId = new Map<string, StoredPermissionAction>();

  private askUsersBySession = new Map<
    string,
    Map<string, StoredAskUserAction>
  >();

  savePermission(action: StoredPermissionAction): void {
    this.permissionsByToolUseId.set(action.toolUseId, action);

    logInfo('[PendingUserActionStore] Stored permission for later replay', {
      sessionId: action.sessionId,
      requestId: action.requestId,
      toolUseId: action.toolUseId,
      selectedOptionLabel: action.selectedOption,
    });
  }

  saveAskUser(action: StoredAskUserAction): void {
    let map = this.askUsersBySession.get(action.sessionId);
    if (!map) {
      map = new Map();
      this.askUsersBySession.set(action.sessionId, map);
    }
    map.set(action.toolCallId, action);

    logInfo('[PendingUserActionStore] Stored ask-user for later replay', {
      sessionId: action.sessionId,
      requestId: action.requestId,
      toolCallId: action.toolCallId,
    });
  }

  /** Peek a buffered permission response by its globally-unique tool-use id. */
  getForToolUse(toolUseId: string): StoredPermissionAction | undefined {
    return this.permissionsByToolUseId.get(toolUseId);
  }

  getForToolCall(
    sessionId: string,
    toolCallId: string
  ): StoredAskUserAction | undefined {
    return this.askUsersBySession.get(sessionId)?.get(toolCallId);
  }

  /** Remove and return a buffered permission response by tool-use id. */
  takeForToolUse(toolUseId: string): StoredPermissionAction | undefined {
    const action = this.permissionsByToolUseId.get(toolUseId);
    if (!action) return undefined;
    this.permissionsByToolUseId.delete(toolUseId);
    return action;
  }

  takeForToolCall(
    sessionId: string,
    toolCallId: string
  ): StoredAskUserAction | undefined {
    const map = this.askUsersBySession.get(sessionId);
    if (!map) return undefined;
    const action = map.get(toolCallId);
    if (!action) return undefined;
    map.delete(toolCallId);
    if (map.size === 0) this.askUsersBySession.delete(sessionId);
    return action;
  }

  getPermissionsForSession(sessionId: string): StoredPermissionAction[] {
    return Array.from(this.permissionsByToolUseId.values()).filter(
      (action) => action.sessionId === sessionId
    );
  }

  getAskUsersForSession(sessionId: string): StoredAskUserAction[] {
    const map = this.askUsersBySession.get(sessionId);
    return map ? Array.from(map.values()) : [];
  }

  clearSession(sessionId: string): number {
    let permCount = 0;
    for (const [toolUseId, action] of this.permissionsByToolUseId) {
      if (action.sessionId === sessionId) {
        this.permissionsByToolUseId.delete(toolUseId);
        permCount += 1;
      }
    }
    const askCount = this.askUsersBySession.get(sessionId)?.size ?? 0;
    this.askUsersBySession.delete(sessionId);
    const total = permCount + askCount;
    if (total > 0) {
      logInfo('[PendingUserActionStore] Cleared session', {
        sessionId,
        pendingRequestCount: permCount,
        questionCount: askCount,
      });
    }
    return total;
  }

  clearAll(): void {
    this.permissionsByToolUseId.clear();
    this.askUsersBySession.clear();
  }

  destroy(): void {
    this.clearAll();
  }
}
