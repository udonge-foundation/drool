import {
  McpServerStatus,
  SessionNotificationType,
  type McpStatusChangedNotification,
} from '@industry/drool-sdk-ext/protocol/drool';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logWarn } from '@industry/logging';
import { McpSettingsManager } from '@industry/runtime/settings';
import {
  canonicalizeMcpServerNameMap,
  normalizeServerName,
  isRemoteMcpServerType,
  toMcpServerType,
} from '@industry/utils/mcp';
import { findGitRoot } from '@industry/utils/shell/node';

import { McpStatusEmitter, McpStatusListenerHandle } from '@/exec/types';
import { McpServiceEventType } from '@/services/mcp/enums';
import { findFirstMcpConfigParseError } from '@/services/mcp/mcpConfigDiagnostics';
import { getMcpService, type McpService } from '@/services/mcp/McpService';

function isAuthenticationRequiredError(error: Error | undefined): boolean {
  return error?.message === 'Authentication required';
}

/**
 * Build MCP status notification from current service state.
 *
 * This is the single source of truth for MCP status. It reads the complete
 * configuration (including disabled servers) and current running state to
 * build an accurate notification.
 *
 * Intentionally does NOT gate on `mcpService.isInitialized()`: while the
 * initial bulk reload is in progress we still want to render every configured
 * server in `Connecting`/`Disabled` state so a slow/unresponsive server
 * cannot hide the rest of the list behind a blank screen.
 *
 * @param mcpService - The MCP service instance
 * @returns MCP status notification
 */
export async function buildMcpStatusNotification(
  mcpService: McpService
): Promise<McpStatusChangedNotification> {
  // Get ALL configured servers (user + project level) and running servers
  const settingsManager = McpSettingsManager.getInstance();
  const allConfigs = canonicalizeMcpServerNameMap(
    await settingsManager.getMcpServers()
  );
  const configError = await findFirstMcpConfigParseError(
    findGitRoot(process.cwd())
  );
  const attribution = await settingsManager.getMcpServerAttribution();
  const runningServers = mcpService.listServers();
  const allNames = Object.keys(allConfigs);
  // Capture state as immutable snapshots for stable lookup during async operations
  const runningServerNames = new Set(
    Object.keys(runningServers).map(normalizeServerName)
  );
  const serverErrors = new Map(
    Array.from((mcpService.getServerErrors?.() ?? new Map()).entries()).map(
      ([serverName, error]) => [normalizeServerName(serverName), error]
    )
  );
  const connectingServerNames = new Set(
    Array.from(mcpService.getConnectingServers?.() ?? new Set<string>()).map(
      normalizeServerName
    )
  );

  // Build server list with correct status
  const servers: McpStatusChangedNotification['servers'] = await Promise.all(
    allNames.map(async (name) => {
      const config = allConfigs[name];
      const normalizedName = normalizeServerName(name);
      const { source, isManaged } = attribution[normalizedName] ?? {
        source: SettingsLevel.User,
        isManaged: false,
      };
      const serverType = toMcpServerType(config.type);
      const isRemoteServer = isRemoteMcpServerType(serverType);
      const pendingAuth = mcpService.getPendingAuth?.(normalizedName);

      // Check if remote server has OAuth tokens
      let hasAuthTokens: boolean | undefined;
      let credentialFingerprint: string | undefined;
      let requiresAuth: boolean | undefined;
      if (isRemoteServer) {
        const [fingerprint, oauthSupport] = await Promise.all([
          mcpService.getValidOAuthCredentialFingerprint(normalizedName),
          mcpService.checkOAuthSupport
            ? mcpService.checkOAuthSupport(normalizedName, {
                useCacheOnly: true,
              })
            : Promise.resolve(undefined),
        ]);
        credentialFingerprint = fingerprint;
        hasAuthTokens = fingerprint !== undefined;
        requiresAuth = oauthSupport?.requiresAuth;
      }

      const buildStatusInfo = (
        status: McpServerStatus,
        error?: string
      ): McpStatusChangedNotification['servers'][number] => ({
        name,
        source,
        isManaged,
        status,
        serverType,
        hasAuthTokens,
        requiresAuth,
        ...(pendingAuth
          ? {
              pendingAuthUrl: pendingAuth.authUrl,
              pendingAuthMessage: pendingAuth.message,
              pendingAuthState: pendingAuth.state,
            }
          : {}),
        ...(error ? { error } : {}),
      });

      // Disabled servers are always shown as disabled (never connecting)
      if (config.disabled) {
        return buildStatusInfo(McpServerStatus.Disabled);
      }

      // Running - use the captured Set for stable lookup
      if (runningServerNames.has(normalizedName)) {
        return buildStatusInfo(McpServerStatus.Connected);
      }

      if (connectingServerNames.has(normalizedName)) {
        return buildStatusInfo(McpServerStatus.Connecting);
      }

      // Check if server has a recorded error from last reload (use captured snapshot)
      const serverError = serverErrors.get(normalizedName);

      if (serverError) {
        if (
          isRemoteServer &&
          !pendingAuth &&
          credentialFingerprint &&
          isAuthenticationRequiredError(serverError)
        ) {
          mcpService.scheduleReconnectWithSharedOAuthCredentials(
            normalizedName,
            credentialFingerprint
          );
          return buildStatusInfo(McpServerStatus.Connecting);
        }

        // Server actually failed to connect
        return buildStatusInfo(
          McpServerStatus.Failed,
          serverError.message || 'Server failed to connect'
        );
      }

      // Enabled but not running and no error = still connecting/starting
      return buildStatusInfo(McpServerStatus.Connecting);
    })
  );

  // Compute summary counts from the actual server statuses to ensure consistency
  const connectedCount = servers.filter(
    (s) => s.status === McpServerStatus.Connected
  ).length;
  const connectingCount = servers.filter(
    (s) => s.status === McpServerStatus.Connecting
  ).length;
  const failedCount = servers.filter(
    (s) => s.status === McpServerStatus.Failed
  ).length;
  const disabledCount = servers.filter(
    (s) => s.status === McpServerStatus.Disabled
  ).length;

  return {
    type: SessionNotificationType.MCP_STATUS_CHANGED,
    servers,
    summary: {
      total: servers.length,
      connected: connectedCount,
      connecting: connectingCount,
      failed: failedCount,
      disabled: disabledCount,
      ...(configError ? { configError } : {}),
    },
  };
}

/**
 * Setup MCP status listeners and return a handle for cleanup and manual emission.
 *
 * All MCP status emissions (both event-driven and manual) go through a single
 * dedup path so identical consecutive notifications are never emitted.
 *
 * @param emitNotification - Callback to emit notifications
 * @param mcpService - Optional MCP service instance (defaults to singleton)
 * @returns Handle with cleanup and emitCurrentStatus methods
 */
export function setupMcpStatusListeners(
  emitNotification: McpStatusEmitter,
  mcpService: McpService = getMcpService()
): McpStatusListenerHandle {
  let lastEmittedJson: string | null = null;
  let pendingEmit: Promise<void> = Promise.resolve();
  // Coalesce bursts of settle events (N per-server SERVER_STARTED during a
  // bulk reload) into a single buildMcpStatusNotification call per tick.
  // buildMcpStatusNotification performs disk/keyring reads per remote
  // server, so collapsing the burst avoids O(N^2) work.
  let coalesceQueued = false;

  // Helper to emit status with deduplication.
  // Serialized via promise-chaining so overlapping async calls
  // cannot resolve out of order and emit stale state.
  const emitStatusWithDedup = (): Promise<void> => {
    if (coalesceQueued) {
      return pendingEmit;
    }
    coalesceQueued = true;
    pendingEmit = pendingEmit
      .then(async () => {
        coalesceQueued = false;
        const notification = await buildMcpStatusNotification(mcpService);
        const json = JSON.stringify(notification);
        if (json !== lastEmittedJson) {
          lastEmittedJson = json;
          emitNotification(notification);
        }
      })
      .catch((error) => {
        logWarn('[McpStatus] Failed to build MCP status notification', {
          cause: error,
        });
      })
      .finally(() => {
        coalesceQueued = false;
      });
    return pendingEmit;
  };

  // All non-error MCP events funnel into the same dedup/coalesce path.
  // SERVERS_RELOADING lets us paint the full Connecting list early;
  // SERVER_STARTED/STOPPED/OAUTH_SUPPORT_UPDATED fire incrementally as
  // servers settle; SERVERS_RELOADED is the tail signal.
  const scheduleEmit = () => {
    void emitStatusWithDedup();
  };

  // Handler for MCP errors - emit immediately without debounce
  const handleError = (_error: Error) => {
    const notification: McpStatusChangedNotification = {
      type: SessionNotificationType.MCP_STATUS_CHANGED,
      servers: [],
      summary: {
        total: 0,
        connected: 0,
        connecting: 0,
        failed: 1,
        disabled: 0,
      },
    };
    const json = JSON.stringify(notification);
    if (json !== lastEmittedJson) {
      lastEmittedJson = json;
      emitNotification(notification);
    }
  };

  // Subscribe to MCP events. SERVERS_RELOADING is subscribed so the UI can
  // paint the full list (with slow/remote servers shown as Connecting)
  // before the bulk reload completes.
  const dedupedEvents: readonly McpServiceEventType[] = [
    McpServiceEventType.SERVERS_RELOADING,
    McpServiceEventType.SERVERS_RELOADED,
    McpServiceEventType.OAUTH_SUPPORT_UPDATED,
    McpServiceEventType.SERVER_STARTED,
    McpServiceEventType.SERVER_STOPPED,
  ];
  for (const event of dedupedEvents) {
    mcpService.on(event, scheduleEmit);
  }
  mcpService.on(McpServiceEventType.ERROR, handleError);

  return {
    cleanup: () => {
      for (const event of dedupedEvents) {
        mcpService.off(event, scheduleEmit);
      }
      mcpService.off(McpServiceEventType.ERROR, handleError);
    },
    emitCurrentStatus: emitStatusWithDedup,
  };
}
