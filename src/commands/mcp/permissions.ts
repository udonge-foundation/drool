/**
 * MCP Permissions CLI Commands
 *
 * Commands for managing persistent MCP tool permissions:
 * - list: Show all persistent permissions
 * - revoke: Revoke specific tool or server permission
 * - clear: Clear all persistent permissions
 */

import { logException } from '@industry/logging';

import type { McpCommandResult } from '@/commands/mcp/types';
import { getMcpPermissionService } from '@/services/mcp/McpPermissionService';

/**
 * List all persistent MCP permissions (tools and servers)
 */
export async function handleListPermissionsCommand(): Promise<McpCommandResult> {
  try {
    const mcpPermissionService = getMcpPermissionService();
    const { servers, tools } = mcpPermissionService.listPersistentPermissions();

    if (servers.size === 0 && tools.size === 0) {
      return {
        success: true,
        message: 'No persistent MCP permissions configured.',
      };
    }

    let output = '\n═══ MCP Persistent Permissions ═══\n';

    // Server-level permissions
    if (servers.size > 0) {
      output += '\n📦 Server-Level Permissions:\n';
      output += '  (All tools from these servers are auto-approved)\n\n';

      const serverEntries = Array.from(servers.entries()).sort(([a], [b]) =>
        a.localeCompare(b)
      );

      for (const [serverName, permission] of serverEntries) {
        const approvedDate = new Date(permission.approvedAt).toLocaleString();
        output += `  • ${serverName}\n`;
        output += `    Impact Level: ${permission.impactLevel}\n`;
        output += `    Approved: ${approvedDate}\n\n`;
      }
    }

    // Tool-level permissions
    if (tools.size > 0) {
      output += '🔧 Tool-Level Permissions:\n';
      output += '  (Specific tools that are auto-approved)\n\n';

      const toolEntries = Array.from(tools.entries()).sort(([a], [b]) =>
        a.localeCompare(b)
      );

      // Group by server for better readability
      const byServer = new Map<
        string,
        Array<[string, (typeof toolEntries)[0][1]]>
      >();
      for (const [fullToolName, permission] of toolEntries) {
        const [serverName] = fullToolName.split('___');
        if (!byServer.has(serverName)) {
          byServer.set(serverName, []);
        }
        byServer.get(serverName)!.push([fullToolName, permission]);
      }

      const sortedServers = Array.from(byServer.keys()).sort();

      for (const serverName of sortedServers) {
        const toolsForServer = byServer.get(serverName)!;
        output += `  Server: ${serverName}\n`;

        for (const [fullToolName, permission] of toolsForServer) {
          const [, toolName] = fullToolName.split('___');
          const approvedDate = new Date(permission.approvedAt).toLocaleString();
          output += `    • ${toolName}\n`;
          output += `      Impact Level: ${permission.impactLevel}\n`;
          output += `      Approved: ${approvedDate}\n`;
        }
        output += '\n';
      }
    }

    output += 'To revoke a permission:\n';
    output += '  drool mcp permissions revoke <server> [tool]\n';
    output += '  Example: drool mcp permissions revoke linear list_issues\n';
    output +=
      '  Example: drool mcp permissions revoke linear  (revoke all linear tools)\n\n';
    output += 'To clear all permissions:\n';
    output += '  drool mcp permissions clear\n';

    return {
      success: true,
      message: output,
    };
  } catch (error) {
    logException(error, 'Failed to list MCP permissions');
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Revoke a specific tool or server permission
 *
 * @param server - Server name (e.g., "linear")
 * @param tool - Optional tool name (e.g., "list_issues"). If omitted, revokes server-level permission.
 */
export async function handleRevokePermissionCommand(
  server: string,
  tool?: string
): Promise<McpCommandResult> {
  try {
    const mcpPermissionService = getMcpPermissionService();

    if (tool) {
      // Revoke tool-level permission
      await mcpPermissionService.revokeToolPermission(server, tool);

      return {
        success: true,
        message: `✓ Revoked permission for tool: ${server}___${tool}`,
      };
    }

    // Revoke server-level permission
    await mcpPermissionService.revokeServerPermission(server);

    return {
      success: true,
      message: `✓ Revoked all permissions for server: ${server}`,
    };
  } catch (error) {
    logException(error, 'Failed to revoke MCP permission');
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Clear all persistent MCP permissions (both tools and servers)
 *
 * @param confirm - Confirmation flag to prevent accidental clears
 */
export async function handleClearPermissionsCommand(
  confirm: boolean = false
): Promise<McpCommandResult> {
  try {
    const mcpPermissionService = getMcpPermissionService();
    const { servers, tools } = mcpPermissionService.listPersistentPermissions();

    const totalCount = servers.size + tools.size;

    if (totalCount === 0) {
      return {
        success: true,
        message: 'No persistent MCP permissions to clear.',
      };
    }

    if (!confirm) {
      return {
        success: false,
        error: `This will clear ${totalCount} persistent permission(s).\nTo confirm, run: drool mcp permissions clear --confirm`,
      };
    }

    await mcpPermissionService.clearAllPermissions();

    return {
      success: true,
      message: `✓ Cleared ${totalCount} persistent MCP permission(s)`,
    };
  } catch (error) {
    logException(error, 'Failed to clear MCP permissions');
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
