import { logInfo } from '@industry/logging';
import { normalizeServerName } from '@industry/utils/mcp';

import { convertAcpMcpServer } from '@/acp/session/convertAcpMcpServer';

import type { McpServer } from '@agentclientprotocol/sdk';
import type { McpServerConfig } from '@industry/common/settings';

/**
 * Merge ACP-provided MCP servers with filesystem-managed configs.
 * Filesystem configs take precedence on name collision.
 *
 * @param acpServers - MCP servers passed via ACP protocol
 * @param filesystemConfigs - MCP servers from ~/.industry/mcp.json (and project config)
 * @returns Merged config with filesystem taking precedence
 */
export function mergeAcpMcpConfigs(
  acpServers: McpServer[],
  filesystemConfigs: Record<string, McpServerConfig>
): Record<string, McpServerConfig> {
  const merged = Object.create(null) as Record<string, McpServerConfig>;

  // First, add all ACP servers (these can be overridden)
  for (const server of acpServers) {
    const name = normalizeServerName(server.name);
    merged[name] = convertAcpMcpServer(server);
  }

  // Then, overlay filesystem configs (these take precedence)
  for (const [name, config] of Object.entries(filesystemConfigs)) {
    const normalizedName = normalizeServerName(name);
    if (Object.hasOwn(merged, normalizedName)) {
      logInfo('[ACP] Filesystem MCP config takes precedence over ACP config', {
        name: normalizedName,
      });
    }
    merged[normalizedName] = config;
  }

  return merged;
}
