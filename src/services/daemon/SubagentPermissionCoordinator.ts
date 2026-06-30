import type { PendingPermission } from '@industry/daemon-client';

type PermissionRequestHandler = (
  permission: PendingPermission
) => void | Promise<void>;

/**
 * Coordinates subagent (child Task) permission fan-out for the TuiDaemonAdapter.
 */
export class SubagentPermissionCoordinator {
  resolveHandlersForPermission({
    permission,
    sessionPermissionHandlers,
  }: {
    permission: PendingPermission;
    sessionPermissionHandlers: Map<string, Set<PermissionRequestHandler>>;
  }): Set<PermissionRequestHandler> {
    const associatedSessionIds =
      permission.associatedSessionIds.length > 0
        ? permission.associatedSessionIds
        : [permission.sessionId];
    const handlers = new Set<PermissionRequestHandler>();
    for (const sessionId of associatedSessionIds) {
      const sessionHandlers = sessionPermissionHandlers.get(sessionId);
      if (!sessionHandlers) {
        continue;
      }
      for (const handler of sessionHandlers) {
        handlers.add(handler);
      }
    }
    return handlers;
  }
}
