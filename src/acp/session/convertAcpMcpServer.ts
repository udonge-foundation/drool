import type { McpServer } from '@agentclientprotocol/sdk';
import type { McpServerConfig } from '@industry/common/settings';

/**
 * Convert an ACP McpServer to a Industry McpServerConfig.
 *
 * ACP transports:
 * - stdio: { name, command, args, env[] }
 * - http: { type: 'http', name, url, headers[] }
 * - sse: { type: 'sse', name, url, headers[] }
 */
export function convertAcpMcpServer(server: McpServer): McpServerConfig {
  if ('command' in server) {
    // Stdio transport (no type field or implicit)
    const envRecord: Record<string, string> = {};
    for (const envVar of server.env || []) {
      envRecord[envVar.name] = envVar.value;
    }

    return {
      type: 'stdio',
      command: server.command,
      args: server.args,
      env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
      disabled: false,
    };
  }

  // Remote HTTP or SSE transport
  const headersRecord: Record<string, string> = {};
  for (const header of server.headers || []) {
    headersRecord[header.name] = header.value;
  }

  return {
    type: server.type,
    url: server.url,
    headers: Object.keys(headersRecord).length > 0 ? headersRecord : undefined,
    disabled: false,
  };
}
