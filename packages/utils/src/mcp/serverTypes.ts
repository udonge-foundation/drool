import { McpServerType } from '@industry/drool-sdk-ext/protocol/drool';

const MCP_SERVER_TYPE_BY_TRANSPORT = {
  stdio: McpServerType.Stdio,
  http: McpServerType.Http,
  sse: McpServerType.Sse,
} as const;

type McpRemoteServerType = McpServerType.Http | McpServerType.Sse;

export function isRemoteMcpServerType(
  serverType: McpServerType | undefined
): serverType is McpRemoteServerType {
  return serverType === McpServerType.Http || serverType === McpServerType.Sse;
}

export function toMcpServerType(
  serverType?: keyof typeof MCP_SERVER_TYPE_BY_TRANSPORT
): McpServerType {
  return serverType
    ? MCP_SERVER_TYPE_BY_TRANSPORT[serverType]
    : McpServerType.Stdio;
}
