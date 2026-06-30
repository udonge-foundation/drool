import { EventEmitter } from 'eventemitter3';

import { ToolConfirmationOutcome } from '@industry/drool-sdk-ext/protocol/drool';
import { logInfo } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getPermissionToolInputForDisplay } from '@industry/utils/session';

import type {
  PendingPermission,
  PermissionRequestHandlerEvents as PermissionRequestEvents,
} from './types';
import type { DaemonRequestPermission } from '@industry/common/daemon';

// PendingPermission is exported from ./types, consumers should import from there

function normalizeAssociatedSessionIds(
  sessionId: string,
  associatedSessionIds: readonly string[] | undefined
): string[] {
  return Array.from(new Set([sessionId, ...(associatedSessionIds ?? [])]));
}

/**
 * PermissionRequestHandler manages incoming permission requests from the server
 * and tracks pending permissions awaiting user response
 */
export class PermissionRequestHandler extends EventEmitter<PermissionRequestEvents> {
  private pendingPermissions = new Map<string, PendingPermission>();

  private statistics = {
    total: 0,
    approved: 0,
    denied: 0,
    timedOut: 0,
  };

  /**
   * Handle an incoming permission request
   */
  handlePermissionRequest(
    request: DaemonRequestPermission,
    id: string,
    sessionId: string
  ): void {
    logInfo('[PermissionRequestHandler] Handling permission request', {
      requestId: id,
      sessionId,
      toolCount: request.params.toolUses.length,
      options: request.params.options,
    });

    const { options } = request.params;
    const toolUses = request.params.toolUses.map((tool) => ({
      ...tool,
      toolUse: {
        ...tool.toolUse,
        input: getPermissionToolInputForDisplay({
          confirmationType: tool.confirmationType,
          details: tool.details,
          toolInput: tool.toolUse.input,
        }),
      },
    }));
    const requestAssociatedSessionIds = normalizeAssociatedSessionIds(
      sessionId,
      request.params.associatedSessionIds
    );
    const existingPermission = this.pendingPermissions.get(id);
    const associatedSessionIds = existingPermission
      ? normalizeAssociatedSessionIds(sessionId, [
          ...existingPermission.associatedSessionIds,
          ...requestAssociatedSessionIds,
        ])
      : requestAssociatedSessionIds;

    const pendingPermission: PendingPermission = {
      requestId: id,
      sessionId,
      associatedSessionIds,
      toolUses,
      options,
      timestamp: Date.now(),
    };

    if (existingPermission) {
      this.pendingPermissions.set(id, pendingPermission);
      const addedSurface = associatedSessionIds.some(
        (associatedSessionId) =>
          !existingPermission.associatedSessionIds.includes(associatedSessionId)
      );

      logInfo(
        '[PermissionRequestHandler] Duplicate permission request replay',
        {
          requestId: id,
          sessionId,
        }
      );

      if (addedSurface) {
        this.emit('permissionRequested', pendingPermission);
      }
      return;
    }

    const incomingToolUseIds = new Set(
      toolUses.map((toolUse) => toolUse.toolUse.id)
    );
    for (const [pendingId, pending] of this.pendingPermissions.entries()) {
      if (
        pending.toolUses.some((toolUse) =>
          incomingToolUseIds.has(toolUse.toolUse.id)
        )
      ) {
        this.clearPermission(pendingId, { emitResolved: true });
      }
    }

    // Store the pending permission
    this.pendingPermissions.set(id, pendingPermission);
    this.statistics.total++;

    logInfo('[PermissionRequestHandler] Stored pending permission', {
      requestId: id,
      totalCount: this.pendingPermissions.size,
    });

    // Emit event for UI handling (timeout is handled by daemon)
    logInfo('[PermissionRequestHandler] Emitting permissionRequested event', {
      requestId: id,
    });
    this.emit('permissionRequested', pendingPermission);
  }

  /**
   * Resolve a permission request with user's choice
   */
  resolvePermission(id: string, option: ToolConfirmationOutcome): void {
    const pending = this.pendingPermissions.get(id);
    if (!pending) {
      throw new MetaError('No pending permission found', { requestId: id });
    }

    // Validate that the option is one of the allowed options
    const isValidOption = pending.options.some((opt) => opt.value === option);
    if (!isValidOption) {
      const allowedOptions = pending.options.map((opt) => opt.value);
      throw new MetaError(
        `Invalid permission option: ${option}. Allowed: ${allowedOptions.join(', ')}`,
        {
          requestId: id,
        }
      );
    }

    // Clean up
    this.pendingPermissions.delete(id);

    // Update statistics
    if (option !== ToolConfirmationOutcome.Cancel) {
      this.statistics.approved++;
    } else {
      this.statistics.denied++;
    }

    // Emit resolution event
    this.emit('permissionResolved', id, option);
  }

  /**
   * Clear a specific permission without an outcome.
   */
  clearPermission(id: string, options?: { emitResolved?: boolean }): void {
    this.pendingPermissions.delete(id);
    if (options?.emitResolved) {
      this.emit('permissionResolved', id);
    }
  }

  /**
   * Clear all pending permissions for a specific session.
   *
   * With `preserveRelayed`, permissions surfaced on multiple sessions (a
   * relayed subagent permission whose `associatedSessionIds` extend beyond this
   * session) are kept. loadSession uses this so reloading the parent doesn't
   * wipe a child's still-pending prompt that the daemon's parent-session load
   * never returns.
   */
  clearSessionPermissions(
    sessionId: string,
    options?: { emitResolved?: boolean; preserveRelayed?: boolean }
  ): void {
    const permissionsToRemove: string[] = [];

    // Find all permissions for this session
    for (const [id, permission] of this.pendingPermissions.entries()) {
      if (permission.sessionId !== sessionId) {
        continue;
      }
      if (
        options?.preserveRelayed &&
        permission.associatedSessionIds.some(
          (associatedId) => associatedId !== sessionId
        )
      ) {
        continue;
      }
      permissionsToRemove.push(id);
    }

    // Clear them
    for (const id of permissionsToRemove) {
      this.clearPermission(id, options);
    }

    logInfo('[PermissionRequestHandler] Cleared permissions for session', {
      sessionId,
      count: permissionsToRemove.length,
    });
  }

  /**
   * Clear all pending permissions
   */
  clearAllPermissions(): void {
    this.pendingPermissions.clear();
  }

  /**
   * Get all pending permissions
   */
  getPendingPermissions(): PendingPermission[] {
    return Array.from(this.pendingPermissions.values());
  }

  getPendingPermissionsForSession(sessionId: string): PendingPermission[] {
    return this.getPendingPermissions().filter((permission) =>
      permission.associatedSessionIds.includes(sessionId)
    );
  }

  /**
   * Get a specific pending permission
   */
  getPendingPermission(id: string): PendingPermission | undefined {
    return this.pendingPermissions.get(id);
  }

  /**
   * Check if there are any pending permissions
   */
  hasPendingPermissions(): boolean {
    return this.pendingPermissions.size > 0;
  }

  /**
   * Destroy and clean up
   */
  destroy(): void {
    this.clearAllPermissions();
    this.removeAllListeners();
  }
}
