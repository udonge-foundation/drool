import { McpRemoteTransport } from '@/mcp/clients/http/enums';
import { initializeSseClientConnection } from '@/mcp/clients/http/sse';
import { initializeStreamableHttpClientConnection } from '@/mcp/clients/http/streamableHttp';
import type {
  HttpClientTransport,
  InitializeHttpClientArgs,
} from '@/mcp/clients/http/types';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export async function initializeHttpClient({
  serverArgs,
  logger,
  clientInfo,
  oauthDriver,
  onAuthFlowCompleted,
  transportKind,
}: InitializeHttpClientArgs): Promise<{
  client: Client;
  transport: HttpClientTransport;
}> {
  const connectionUrl = new URL(serverArgs.url);
  const resolvedTransportKind =
    transportKind ?? McpRemoteTransport.StreamableHttp;

  if (!transportKind) {
    logger?.debug('No MCP transport specified; defaulting to streamable HTTP', {
      name: serverArgs.name,
      url: connectionUrl.toString(),
    });
  }

  if (resolvedTransportKind === McpRemoteTransport.Sse) {
    return initializeSseClientConnection({
      serverArgs,
      logger,
      clientInfo,
      oauthDriver,
      onAuthFlowCompleted,
      connectionUrl,
    });
  }

  return initializeStreamableHttpClientConnection({
    serverArgs,
    logger,
    clientInfo,
    oauthDriver,
    onAuthFlowCompleted,
    connectionUrl,
  });
}
