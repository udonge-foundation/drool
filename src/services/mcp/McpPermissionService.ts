/**
 * McpPermissionService
 *
 * Manages persistent MCP tool permissions across sessions.
 * Enables users to approve MCP tools once and have that approval persist.
 *
 * Schema (mcp.json `persistentPermissions`):
 *
 *   {
 *     "servers": {
 *       "<serverName>": { approvedAt, impactLevel, serverIdentity? }
 *     },
 *     "tools": {
 *       "<serverName>": {
 *         "<toolName>": { approvedAt, impactLevel, serverIdentity? }
 *       }
 *     }
 *   }
 *
 * Trust gates applied at every `isToolPersistentlyApproved` call:
 *   1. requested impact ≤ approved impact (least-privilege)
 *   2. current server identity matches approved identity (if both set)
 *   3. requested impact ≤ org-managed `maxAutonomyLevel` ceiling (if set)
 *
 * Concurrency: all read-modify-write operations are serialized through
 * an internal Promise-chain mutex so two simultaneous "Always allow"
 * decisions cannot drop each other's writes via the read-modify-write
 * window outside `SettingsService.updateUserMcpSettings`.
 */

import { McpImpactLevel } from '@industry/common/settings';
import { riskLevelToNumber } from '@industry/drool-core/messages/utils';
import { AutonomyLevel } from '@industry/drool-sdk-ext/protocol/shared';
import { RiskLevel } from '@industry/drool-sdk-ext/protocol/tools';
import { logInfo, logWarn } from '@industry/logging';
import { autonomyLevelToNumber } from '@industry/utils';

import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';

import type {
  McpPersistentPermissionEntry,
  McpPersistentPermissions,
} from '@industry/common/settings';

function persistedImpactToNumber(level: string | undefined): number {
  switch (level) {
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    default:
      return 0;
  }
}

function riskLevelToMcpImpactLevel(level: RiskLevel): McpImpactLevel {
  switch (level) {
    case RiskLevel.LOW:
      return McpImpactLevel.Low;
    case RiskLevel.MEDIUM:
      return McpImpactLevel.Medium;
    case RiskLevel.HIGH:
      return McpImpactLevel.High;
    default:
      return McpImpactLevel.None;
  }
}

function autonomyAllows(
  requestedImpact: RiskLevel,
  managedMax: AutonomyLevel | undefined
): boolean {
  if (managedMax === undefined) return true;
  return (
    riskLevelToNumber(requestedImpact) <= autonomyLevelToNumber(managedMax)
  );
}

/**
 * Detect whether a `tools` field uses the legacy flat layout
 * (`tools["serverName___toolName"] = entry`) and migrate it forward to
 * the nested layout. The flat scheme is ambiguous when names contain
 * triple-underscore, so all new writes use the nested shape. This
 * migration is opportunistic — flat entries observed on read are
 * returned in nested form to callers, and the next write persists the
 * normalized layout.
 */
function normalizeToolsMap(raw: unknown):
  | {
      [serverName: string]: {
        [toolName: string]: McpPersistentPermissionEntry;
      };
    }
  | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const result: Record<
    string,
    Record<string, McpPersistentPermissionEntry>
  > = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;

    if (
      'approvedAt' in (value as object) &&
      'impactLevel' in (value as object)
    ) {
      // Legacy flat entry: split on first ___ delimiter.
      const idx = key.indexOf('___');
      if (idx < 0) continue;
      const serverName = key.slice(0, idx);
      const toolName = key.slice(idx + 3);
      if (!serverName || !toolName) continue;
      if (!result[serverName]) result[serverName] = {};
      result[serverName][toolName] = value as McpPersistentPermissionEntry;
    } else {
      // Already-nested entry.
      const nested: Record<string, McpPersistentPermissionEntry> = {};
      for (const [toolName, entry] of Object.entries(
        value as Record<string, unknown>
      )) {
        if (
          entry &&
          typeof entry === 'object' &&
          'approvedAt' in (entry as object) &&
          'impactLevel' in (entry as object)
        ) {
          nested[toolName] = entry as McpPersistentPermissionEntry;
        }
      }
      if (Object.keys(nested).length > 0) {
        result[key] = { ...(result[key] ?? {}), ...nested };
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

type SettingsServiceLike = {
  getUserMcpSettings():
    | {
        persistentPermissions?: McpPersistentPermissions | unknown;
      }
    | undefined;
  updateUserMcpSettings(patch: {
    persistentPermissions?: McpPersistentPermissions;
  }): Promise<void>;
  getMaxAutonomyLevel?: () => AutonomyLevel | undefined;
};

export class McpPermissionService {
  private readonly settingsService: SettingsServiceLike;

  private writeLock: Promise<void> = Promise.resolve();

  constructor(settingsService: SettingsServiceLike) {
    this.settingsService = settingsService;
  }

  /**
   * Check whether a tool is persistently approved at the requested impact
   * level for the active server config.
   *
   * @param serverName - MCP server name (e.g., "linear")
   * @param toolName - Actual tool name without server prefix
   * @param requestedImpactLevel - Impact level of the current invocation
   * @param currentServerIdentity - Identity fingerprint of the currently
   *   configured server. If the persisted entry has a `serverIdentity` and
   *   it does NOT match, auto-approval is denied (re-prompt the user). Pass
   *   `undefined` when identity verification is not available; in that
   *   case the check fails closed (re-prompt). A persisted entry that
   *   itself lacks `serverIdentity` (legacy pre-identity-binding write,
   *   or a write where identity resolution failed) ALSO fails closed —
   *   the user is re-prompted and on approval the new entry carries the
   *   current identity, healing the legacy entry.
   */
  isToolPersistentlyApproved(
    serverName: string,
    toolName: string,
    requestedImpactLevel: RiskLevel,
    currentServerIdentity?: string
  ): boolean {
    const managedMax = this.settingsService.getMaxAutonomyLevel?.();
    if (!autonomyAllows(requestedImpactLevel, managedMax)) {
      logInfo(
        '[McpPermissionService] Auto-approve blocked by managed ceiling',
        {
          // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission-check context consumed as a unit
          value: { serverName, toolName, requestedImpactLevel, managedMax },
        }
      );
      return false;
    }

    const permissions = this.getPersistentPermissions();
    if (!permissions) return false;

    const requestedImpactNumber = riskLevelToNumber(requestedImpactLevel);

    const toolPermission = permissions.tools?.[serverName]?.[toolName];
    if (toolPermission) {
      if (!this.identityMatches(toolPermission, currentServerIdentity)) {
        logInfo(
          '[McpPermissionService] Tool permission denied: server identity changed',
          {
            // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission-check context consumed as a unit
            value: { serverName, toolName, currentServerIdentity },
          }
        );
        return false;
      }
      const approvedImpactNumber = persistedImpactToNumber(
        toolPermission.impactLevel
      );
      const isApproved = requestedImpactNumber <= approvedImpactNumber;
      logInfo('[McpPermissionService] Tool-level permission check', {
        // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission-check context consumed as a unit
        value: {
          serverName,
          toolName,
          requestedImpactLevel,
          approvedImpactLevel: toolPermission.impactLevel,
          isApproved,
        },
      });
      return isApproved;
    }

    const serverPermission = permissions.servers?.[serverName];
    if (serverPermission) {
      if (!this.identityMatches(serverPermission, currentServerIdentity)) {
        logInfo(
          '[McpPermissionService] Server permission denied: server identity changed',
          {
            // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission-check context consumed as a unit
            value: { serverName, currentServerIdentity },
          }
        );
        return false;
      }
      const approvedImpactNumber = persistedImpactToNumber(
        serverPermission.impactLevel
      );
      const isApproved = requestedImpactNumber <= approvedImpactNumber;
      logInfo('[McpPermissionService] Server-level permission check', {
        // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission-check context consumed as a unit
        value: {
          serverName,
          toolName,
          requestedImpactLevel,
          approvedImpactLevel: serverPermission.impactLevel,
          isApproved,
        },
      });
      return isApproved;
    }

    return false;
  }

  async persistToolPermission(
    serverName: string,
    toolName: string,
    impactLevel: RiskLevel,
    serverIdentity?: string
  ): Promise<void> {
    await this.withWriteLock(async () => {
      const permissions = this.getPersistentPermissions() ?? {};
      const entry: McpPersistentPermissionEntry = {
        approvedAt: new Date().toISOString(),
        impactLevel: riskLevelToMcpImpactLevel(impactLevel),
        ...(serverIdentity ? { serverIdentity } : {}),
      };

      const existingServerTools = permissions.tools?.[serverName] ?? {};
      const updated: McpPersistentPermissions = {
        ...permissions,
        tools: {
          ...(permissions.tools ?? {}),
          [serverName]: { ...existingServerTools, [toolName]: entry },
        },
      };

      await this.writePersistentPermissions(updated);

      logInfo('[McpPermissionService] Persisted tool permission', {
        // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission-check context consumed as a unit
        value: {
          serverName,
          toolName,
          impactLevel,
          approvedAt: entry.approvedAt,
          hasIdentity: !!serverIdentity,
        },
      });
    });
  }

  async persistServerPermission(
    serverName: string,
    impactLevel: RiskLevel,
    serverIdentity?: string
  ): Promise<void> {
    await this.withWriteLock(async () => {
      const permissions = this.getPersistentPermissions() ?? {};
      const entry: McpPersistentPermissionEntry = {
        approvedAt: new Date().toISOString(),
        impactLevel: riskLevelToMcpImpactLevel(impactLevel),
        ...(serverIdentity ? { serverIdentity } : {}),
      };

      const updated: McpPersistentPermissions = {
        ...permissions,
        servers: { ...(permissions.servers ?? {}), [serverName]: entry },
      };

      await this.writePersistentPermissions(updated);

      logInfo('[McpPermissionService] Persisted server permission', {
        // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission-check context consumed as a unit
        value: {
          serverName,
          impactLevel,
          approvedAt: entry.approvedAt,
          hasIdentity: !!serverIdentity,
        },
      });
    });
  }

  async revokeToolPermission(
    serverName: string,
    toolName: string
  ): Promise<void> {
    await this.withWriteLock(async () => {
      const permissions = this.getPersistentPermissions();
      const serverTools = permissions?.tools?.[serverName];
      if (!serverTools || !serverTools[toolName]) {
        logWarn('[McpPermissionService] No tool permission to revoke', {
          // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission-check context consumed as a unit
          value: { serverName, toolName },
        });
        return;
      }

      const { [toolName]: _removed, ...remaining } = serverTools;
      const updatedTools = { ...(permissions?.tools ?? {}) };
      if (Object.keys(remaining).length === 0) {
        delete updatedTools[serverName];
      } else {
        updatedTools[serverName] = remaining;
      }

      await this.writePersistentPermissions({
        ...(permissions ?? {}),
        tools: updatedTools,
      });

      logInfo('[McpPermissionService] Revoked tool permission', {
        // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission-check context consumed as a unit
        value: { serverName, toolName },
      });
    });
  }

  /**
   * Revoke a server-level approval AND every persisted tool-level approval
   * for that server. The CLI help text promises "revoke all permissions for
   * server", so we cascade both.
   */
  async revokeServerPermission(serverName: string): Promise<void> {
    await this.withWriteLock(async () => {
      const permissions = this.getPersistentPermissions();
      const hadServer = !!permissions?.servers?.[serverName];
      const hadTools = !!permissions?.tools?.[serverName];
      if (!hadServer && !hadTools) {
        logWarn('[McpPermissionService] No server permission to revoke', {
          // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission-check context consumed as a unit
          value: { serverName },
        });
        return;
      }

      const remainingServers = { ...(permissions?.servers ?? {}) };
      delete remainingServers[serverName];
      const remainingTools = { ...(permissions?.tools ?? {}) };
      delete remainingTools[serverName];

      await this.writePersistentPermissions({
        ...(permissions ?? {}),
        servers: remainingServers,
        tools: remainingTools,
      });

      logInfo('[McpPermissionService] Revoked server permission (cascading)', {
        // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission-check context consumed as a unit
        value: { serverName, hadServer, hadTools },
      });
    });
  }

  async clearAllPermissions(): Promise<void> {
    await this.withWriteLock(async () => {
      await this.writePersistentPermissions({ tools: {}, servers: {} });
      logInfo('[McpPermissionService] Cleared all persistent permissions');
    });
  }

  /**
   * Flatten the nested tools map for display. The CLI rendering layer
   * still groups by server (legacy), so we expose a flat
   * `serverName___toolName` map to keep the call sites unchanged.
   */
  listPersistentPermissions(): {
    servers: Map<string, McpPersistentPermissionEntry>;
    tools: Map<string, McpPersistentPermissionEntry>;
  } {
    const permissions = this.getPersistentPermissions() ?? {};
    const toolsFlat = new Map<string, McpPersistentPermissionEntry>();
    for (const [serverName, perServer] of Object.entries(
      permissions.tools ?? {}
    )) {
      for (const [toolName, entry] of Object.entries(perServer)) {
        toolsFlat.set(`${serverName}___${toolName}`, entry);
      }
    }
    return {
      servers: new Map(Object.entries(permissions.servers ?? {})),
      tools: toolsFlat,
    };
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  /**
   * Strict identity check. An entry without `serverIdentity` (legacy
   * pre-identity-binding write, or a write where identity resolution
   * failed) cannot be auto-approved — the trust-boundary problem that
   * motivated identity binding (#1) is still open for those entries,
   * so we fail closed: re-prompt the user, and on approval the new
   * write will carry the current identity.
   *
   * An entry WITH `serverIdentity` requires the current server's
   * identity to be resolvable AND match — otherwise the server config
   * has drifted (or McpService is unavailable) and we again fail closed.
   */
  private identityMatches(
    entry: McpPersistentPermissionEntry,
    currentIdentity: string | undefined
  ): boolean {
    if (!entry.serverIdentity) return false;
    if (!currentIdentity) return false;
    return entry.serverIdentity === currentIdentity;
  }

  private getPersistentPermissions(): McpPersistentPermissions | undefined {
    const mcpSettings = this.settingsService.getUserMcpSettings();
    const raw = mcpSettings?.persistentPermissions as
      | {
          tools?: unknown;
          servers?: Record<string, McpPersistentPermissionEntry>;
        }
      | undefined;
    if (!raw) return undefined;

    const tools = normalizeToolsMap(raw.tools);
    const servers = raw.servers;

    if (!tools && !servers) return undefined;
    return {
      ...(servers ? { servers } : {}),
      ...(tools ? { tools } : {}),
    };
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeLock.then(fn);
    this.writeLock = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async writePersistentPermissions(
    permissions: McpPersistentPermissions
  ): Promise<void> {
    try {
      await this.settingsService.updateUserMcpSettings({
        persistentPermissions: permissions,
      });

      agentEventBus.emit(AgentEvent.SettingsUpdated, {
        settings: {
          mcp: { persistentPermissions: permissions },
        } as never,
        sessionId: getSessionService().getCurrentSessionId() ?? '',
      });
    } catch (error) {
      logWarn(
        '[McpPermissionService] Failed to update persistent permissions',
        {
          cause: error instanceof Error ? error.message : String(error),
        }
      );
      throw error;
    }
  }
}

// =============================================================================
// Singleton instance getter
// =============================================================================

let instance: McpPermissionService | undefined;

export function getMcpPermissionService(): McpPermissionService {
  if (!instance) {
    instance = new McpPermissionService(getSettingsService());
  }
  return instance;
}
