import {
  McpServerStatus,
  McpServerType,
  type McpServerStatusInfo,
  type McpToolInfo,
} from '@industry/drool-sdk-ext/protocol/drool';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import {
  McpServerAuthUiState,
  getMcpServerAuthUiState,
} from '@industry/utils/mcp';

import { AuthStatus } from '@/commands/mcp/views/enums';
import type { ServerWithStatus, ToolInfo } from '@/commands/mcp/views/types';
import { getI18n } from '@/i18n';

export function buildServerListFromDaemon(
  servers: McpServerStatusInfo[],
  tools: McpToolInfo[]
): ServerWithStatus[] {
  const toolCountByServer = new Map<
    string,
    { total: number; enabled: number }
  >();
  for (const tool of tools) {
    const entry = toolCountByServer.get(tool.serverName) ?? {
      total: 0,
      enabled: 0,
    };
    entry.total++;
    if (tool.isEnabled) entry.enabled++;
    toolCountByServer.set(tool.serverName, entry);
  }

  const result: ServerWithStatus[] = servers.map((server) => {
    const isConnected = server.status === McpServerStatus.Connected;
    const isDisabled = server.status === McpServerStatus.Disabled;
    const authState = getMcpServerAuthUiState(server);
    const authStatus =
      authState === McpServerAuthUiState.Authenticated
        ? AuthStatus.Authenticated
        : authState === McpServerAuthUiState.NeedsAuth
          ? AuthStatus.NeedsAuth
          : AuthStatus.NotApplicable;

    const counts = toolCountByServer.get(server.name) ?? {
      total: server.toolCount ?? 0,
      enabled: isDisabled ? 0 : (server.toolCount ?? 0),
    };

    return {
      name: server.name,
      status: server.status,
      serverType: server.serverType,
      isConnected,
      isDisabled,
      toolCount: counts.total,
      enabledToolCount: counts.enabled,
      authStatus,
      source: server.source,
      isManaged: server.isManaged,
      hasAuthTokens: server.hasAuthTokens,
      requiresAuth: server.requiresAuth,
      error: server.error,
      pendingAuthUrl: server.pendingAuthUrl,
      pendingAuthMessage: server.pendingAuthMessage,
      pendingAuthState: server.pendingAuthState,
    };
  });

  const groupOrder = (server: ServerWithStatus): number => {
    if (server.source === SettingsLevel.Org) return 0;
    if (server.isManaged) return 1;
    return 2;
  };

  return result.sort((a, b) => {
    const groupDiff = groupOrder(a) - groupOrder(b);
    if (groupDiff !== 0) return groupDiff;
    return a.name.localeCompare(b.name);
  });
}

export function formatServerType(serverType: McpServerType): string {
  const t = getI18n().t;
  if (serverType === McpServerType.Http) {
    return t('commands:mcp.views.typeHttp');
  }
  if (serverType === McpServerType.Sse) {
    return t('commands:mcp.views.typeSse');
  }
  return t('commands:mcp.views.typeStdio');
}

export function convertMcpToolInfoToToolInfo(tool: McpToolInfo): ToolInfo {
  return {
    name: tool.name,
    description: tool.description,
    isReadOnly: tool.isReadOnly === true,
    inputSchema: tool.inputSchema,
  };
}
