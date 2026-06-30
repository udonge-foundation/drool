import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { HttpStatusCode } from '@industry/logging/errors';

import {
  connectHttpClientWithOAuthDriver,
  createAuthenticationRequiredError,
  createConnectionMetaError,
  createMcpOAuthFetch,
  getTransportOptions,
} from '@/mcp/clients/http/shared';
import type {
  ConnectedHttpClient,
  HttpClientTransport,
  StreamableHttpConnectionArgs,
} from '@/mcp/clients/http/types';
import type { McpOAuthDriver } from '@/services/mcp/oauth/core/driver';

interface StreamableHttpResponseTracker {
  firstFailedResponseStatus?: number;
  authRequiredResponseStatus?: number;
}

function isTrackedConnectionRequest(
  requestUrl: URL,
  connectionUrl: URL
): boolean {
  return (
    requestUrl.origin === connectionUrl.origin &&
    requestUrl.pathname === connectionUrl.pathname
  );
}

function isAuthRequiredStatus(status: number): boolean {
  return (
    status === HttpStatusCode.Unauthorized ||
    status === HttpStatusCode.Forbidden
  );
}

function createStreamableHttpTransport({
  url,
  headers,
  oauthDriver,
}: {
  url: URL;
  headers?: Record<string, string>;
  oauthDriver?: McpOAuthDriver;
}): {
  responseTracker: StreamableHttpResponseTracker;
  transport: StreamableHTTPClientTransport;
} {
  const responseTracker: StreamableHttpResponseTracker = {};

  const wrappedFetch = createMcpOAuthFetch({
    oauthDriver,
    onResponse: (requestUrl, response) => {
      if (
        isTrackedConnectionRequest(requestUrl, url) &&
        !response.ok &&
        responseTracker.firstFailedResponseStatus === undefined
      ) {
        responseTracker.firstFailedResponseStatus = response.status;
      }
      if (
        isTrackedConnectionRequest(requestUrl, url) &&
        isAuthRequiredStatus(response.status) &&
        responseTracker.authRequiredResponseStatus === undefined
      ) {
        responseTracker.authRequiredResponseStatus = response.status;
      }
    },
  });

  return {
    responseTracker,
    transport: new StreamableHTTPClientTransport(url, {
      ...getTransportOptions({
        headers,
      }),
      fetch: wrappedFetch,
    }),
  };
}

function createExplicitSseHintMessage(): string {
  return 'Failed to connect to MCP server. The remote endpoint rejected streamable HTTP. If this server uses SSE, configure it with `type: "sse"` or add it with `--type sse`.';
}

function shouldHintExplicitSseConfiguration(
  responseTracker: StreamableHttpResponseTracker
): boolean {
  return (
    responseTracker.firstFailedResponseStatus ===
    HttpStatusCode.MethodNotAllowed
  );
}

function createStreamableHttpConnectionError({
  serverName,
  error,
  responseTracker,
  oauthDriver,
}: {
  serverName: string;
  error: unknown;
  responseTracker: StreamableHttpResponseTracker;
  oauthDriver?: McpOAuthDriver;
}) {
  if (oauthDriver && responseTracker.authRequiredResponseStatus !== undefined) {
    return createAuthenticationRequiredError(serverName, error);
  }

  return createConnectionMetaError(
    serverName,
    error,
    shouldHintExplicitSseConfiguration(responseTracker)
      ? createExplicitSseHintMessage()
      : undefined
  );
}

export async function initializeStreamableHttpClientConnection({
  serverArgs,
  logger,
  clientInfo,
  oauthDriver,
  onAuthFlowCompleted,
  connectionUrl,
}: StreamableHttpConnectionArgs): Promise<
  ConnectedHttpClient<HttpClientTransport>
> {
  const { name: serverName, headers } = serverArgs;
  const { responseTracker, transport } = createStreamableHttpTransport({
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
      initializeStreamableHttpClientConnection({
        serverArgs,
        logger,
        clientInfo,
        oauthDriver,
        onAuthFlowCompleted,
        connectionUrl,
      }),
    createConnectionError: (error) =>
      createStreamableHttpConnectionError({
        serverName,
        error,
        responseTracker,
        oauthDriver,
      }),
  });
}
