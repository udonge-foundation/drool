import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

import {
  connectHttpClientWithOAuthDriver,
  createMcpOAuthFetch,
  getTransportOptions,
} from '@/mcp/clients/http/shared';
import type {
  ConnectedHttpClient,
  SseConnectionArgs,
} from '@/mcp/clients/http/types';
import type { McpOAuthDriver } from '@/services/mcp/oauth/core/driver';

function createSseTransport({
  url,
  headers,
  oauthDriver,
}: {
  url: URL;
  headers?: Record<string, string>;
  oauthDriver?: McpOAuthDriver;
}): SSEClientTransport {
  return new SSEClientTransport(url, {
    ...getTransportOptions({
      headers,
    }),
    fetch: createMcpOAuthFetch({ oauthDriver }),
  });
}

export async function initializeSseClientConnection({
  serverArgs,
  logger,
  clientInfo,
  oauthDriver,
  onAuthFlowCompleted,
  connectionUrl,
}: SseConnectionArgs): Promise<ConnectedHttpClient<SSEClientTransport>> {
  const { name: serverName, url, headers } = serverArgs;
  logger?.info('Using SSE MCP transport', {
    name: serverName,
    url,
  });

  const transport = createSseTransport({
    url: connectionUrl,
    headers,
    oauthDriver,
  });

  return connectHttpClientWithOAuthDriver({
    transport,
    logger,
    serverName,
    clientInfo,
    oauthDriver,
    onAuthFlowCompleted,
    reconnect: () =>
      initializeSseClientConnection({
        serverArgs,
        logger,
        clientInfo,
        oauthDriver,
        onAuthFlowCompleted,
        connectionUrl,
      }),
  });
}
