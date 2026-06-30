import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  LoggingMessageNotificationSchema,
  type Implementation,
} from '@modelcontextprotocol/sdk/types.js';

import { McpAuthOutcome } from '@industry/drool-sdk-ext/protocol/drool';
import { MetaError } from '@industry/logging/errors';

import packageJson from '../../../../package.json';
import type {
  ConnectedHttpClient,
  HttpClientTransport,
  OnAuthFlowCompleted,
} from '@/mcp/clients/http/types';
import { MCP_SERVER_CONNECT_TIMEOUT_MS } from '@/mcp/constants';
import type { ILogger } from '@/mcp/types';
import type { McpOAuthDriver } from '@/services/mcp/oauth/core/driver';
import { McpOAuthGuidanceError } from '@/services/mcp/oauth/core/errors';

import type {
  FetchLike,
  Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js';

function isAuthRequiredError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      Number(error.code) === 401
  );
}

function authOutcomeFor(error: unknown): McpAuthOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('cancel')
    ? McpAuthOutcome.Cancelled
    : McpAuthOutcome.Failed;
}

// The MCP manager only appends a completion detail when it is non-generic, so
// pass actionable guidance (e.g. "configure a pre-registered client") verbatim
// instead of a bare "Authentication failed" that the UI would discard.
function authCompletionFailureMessage(
  error: unknown,
  outcome: McpAuthOutcome
): string {
  if (outcome === McpAuthOutcome.Cancelled) {
    return 'Authentication cancelled';
  }
  if (
    error instanceof McpOAuthGuidanceError &&
    typeof error.metadata?.errorMessage === 'string'
  ) {
    return error.metadata.errorMessage;
  }
  return 'Authentication failed';
}

// Granular reason code for telemetry: prefer the driver's specific OAuth reason
// (registration_unsupported, configured_issuer_mismatch, authorization_timeout,
// ...), falling back to the coarse cancelled/failed outcome.
function oauthFailureReason(error: unknown, outcome: McpAuthOutcome): string {
  if (
    error instanceof McpOAuthGuidanceError &&
    typeof error.metadata?.reason === 'string'
  ) {
    return error.metadata.reason;
  }
  return outcome === McpAuthOutcome.Cancelled ? 'cancelled' : 'failed';
}

export function createMcpOAuthFetch({
  oauthDriver,
  onResponse,
}: {
  oauthDriver?: McpOAuthDriver;
  onResponse?: (requestUrl: URL, response: Response) => void;
}): FetchLike {
  return async (input, init) => {
    const requestUrl = new URL(typeof input === 'string' ? input : input.href);
    const fetchImpl = oauthDriver?.createFetch() ?? globalThis.fetch;
    const response = await fetchImpl(input, init);
    oauthDriver?.observeAuthorizationChallenge?.(response);
    onResponse?.(requestUrl, response);
    return response;
  };
}

export function getTransportOptions({
  headers,
}: {
  headers?: Record<string, string>;
}) {
  return {
    requestInit: headers
      ? {
          headers,
        }
      : undefined,
  };
}

function setTransportHandlers<
  TTransport extends {
    onerror?: ((error: Error) => void) | null;
    onclose?: (() => void) | null;
  },
>(
  transport: TTransport,
  logger: ILogger | undefined,
  serverName: string
): void {
  transport.onerror = (error: Error) => {
    logger?.warn(`Error in MCP server`, {
      name: serverName,
      cause: error,
    });
  };

  transport.onclose = () => {
    logger?.info(`MCP server closed`, { name: serverName });
  };
}

function createClient(clientInfo?: Implementation): Client {
  return new Client(
    clientInfo || {
      name: 'industry-cli',
      title: 'Industry CLI',
      version: packageJson.version,
      websiteUrl: 'https://example.com/',
    }
  );
}

function setNotificationHandler(
  client: Client,
  logger: ILogger | undefined,
  serverName: string
): void {
  client.setNotificationHandler(
    LoggingMessageNotificationSchema,
    (notification) => {
      const logData = {
        server: serverName,
        level: notification.params.level,
        logger: notification.params.logger,
        data: notification.params.data,
      };

      const uppercaseLevel = logData.level.toUpperCase();
      switch (logData.level) {
        case 'debug':
          logger?.debug(`[MCP ${uppercaseLevel}]`, logData);
          break;
        case 'info':
        case 'notice':
          logger?.info(`[MCP ${uppercaseLevel}]`, logData);
          break;
        case 'warning':
          logger?.warn(`[MCP ${uppercaseLevel}]`, logData);
          break;
        case 'error':
        case 'critical':
        case 'alert':
        case 'emergency':
          logger?.error(`[MCP ${uppercaseLevel}]`, logData);
          break;
        default:
          logger?.error(`[MCP UNKNOWN (${uppercaseLevel})]`, logData);
      }
    }
  );
}

export function createConnectionMetaError(
  serverName: string,
  error: unknown,
  message = 'Failed to connect to MCP server'
): MetaError {
  return new MetaError(message, {
    name: serverName,
    cause: error,
  });
}

class McpServerConnectTimeoutError extends MetaError {
  constructor(serverName: string, timeoutMs: number) {
    super(`MCP server connection timed out after ${timeoutMs / 1000} seconds`, {
      name: serverName,
      timeout: timeoutMs,
    });
    this.name = 'McpServerConnectTimeoutError';
    Object.setPrototypeOf(this, McpServerConnectTimeoutError.prototype);
  }
}

export function createAuthenticationRequiredError(
  serverName: string,
  error: unknown
): MetaError {
  return new MetaError('Authentication required', {
    name: serverName,
    cause: error,
  });
}

async function connectClientWithTimeout({
  client,
  transport,
  serverName,
}: {
  client: Client;
  transport: HttpClientTransport & Transport;
  serverName: string;
}): Promise<void> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          void transport.close().catch(() => {});
          void client.close().catch(() => {});
          reject(
            new McpServerConnectTimeoutError(
              serverName,
              MCP_SERVER_CONNECT_TIMEOUT_MS
            )
          );
        }, MCP_SERVER_CONNECT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function closeConnectionBeforeRetry({
  client,
  transport,
  logger,
  serverName,
}: {
  client: Client;
  transport: { close(): Promise<void> };
  logger?: ILogger;
  serverName: string;
}): Promise<void> {
  await transport.close();
  const closeResult = await Promise.allSettled([client.close()]);
  if (closeResult[0]?.status === 'rejected') {
    logger?.warn('Error closing old client during OAuth retry', {
      name: serverName,
      cause: closeResult[0].reason,
    });
  }
}

async function maybeAuthenticateAndReconnect<TResult>({
  error,
  oauthDriver,
  onAuthFlowCompleted,
  logger,
  serverName,
  transport,
  client,
  reconnect,
}: {
  error: unknown;
  oauthDriver?: McpOAuthDriver;
  onAuthFlowCompleted?: OnAuthFlowCompleted;
  logger?: ILogger;
  serverName: string;
  transport: { close(): Promise<void> };
  client: Client;
  reconnect: () => Promise<TResult>;
}): Promise<TResult | null> {
  if (!isAuthRequiredError(error) || !oauthDriver?.enableInteractiveAuth) {
    return null;
  }

  logger?.info('Starting MCP OAuth authorization', { name: serverName });

  try {
    await oauthDriver.authenticateAfterUnauthorized();
  } catch (authError) {
    const outcome = authOutcomeFor(authError);
    logger?.warn('MCP OAuth flow failed', {
      name: serverName,
      reason: oauthFailureReason(authError, outcome),
      cause: authError,
    });
    onAuthFlowCompleted?.({
      outcome,
      message: authCompletionFailureMessage(authError, outcome),
    });
    throw authError;
  }

  await closeConnectionBeforeRetry({ client, transport, logger, serverName });

  try {
    const connection = await reconnect();
    onAuthFlowCompleted?.({
      outcome: McpAuthOutcome.Success,
      message: 'Authentication successful',
    });
    return connection;
  } catch (reconnectError) {
    logger?.error('Authenticated reconnect failed', {
      name: serverName,
      error:
        reconnectError instanceof Error
          ? reconnectError.message
          : String(reconnectError),
    });
    onAuthFlowCompleted?.({
      outcome: McpAuthOutcome.Failed,
      message: authCompletionFailureMessage(
        reconnectError,
        McpAuthOutcome.Failed
      ),
    });
    throw reconnectError;
  }
}

export async function connectHttpClientWithOAuthDriver<
  TTransport extends HttpClientTransport,
>({
  transport,
  logger,
  serverName,
  clientInfo,
  oauthDriver,
  onAuthFlowCompleted,
  reconnect,
  createConnectionError,
}: {
  transport: TTransport;
  logger?: ILogger;
  serverName: string;
  clientInfo?: Implementation;
  oauthDriver?: McpOAuthDriver;
  onAuthFlowCompleted?: OnAuthFlowCompleted;
  reconnect: () => Promise<ConnectedHttpClient<TTransport>>;
  createConnectionError?: (error: unknown) => MetaError;
}): Promise<ConnectedHttpClient<TTransport>> {
  setTransportHandlers(transport, logger, serverName);

  const client = createClient(clientInfo);
  let authenticatedBeforeConnect = false;

  try {
    if (oauthDriver?.shouldAuthenticateBeforeConnect()) {
      try {
        await oauthDriver.authenticateBeforeConnect();
        authenticatedBeforeConnect = true;
      } catch (authError) {
        const outcome = authOutcomeFor(authError);
        logger?.warn('MCP OAuth flow failed', {
          name: serverName,
          reason: oauthFailureReason(authError, outcome),
          cause: authError,
        });
        onAuthFlowCompleted?.({
          outcome,
          message: authCompletionFailureMessage(authError, outcome),
        });
        throw authError;
      }
    }

    await connectClientWithTimeout({
      client,
      transport,
      serverName,
    });
  } catch (error) {
    if (error instanceof McpServerConnectTimeoutError) {
      throw error;
    }

    // OAuth misconfigurations (missing client registration, configured-issuer
    // mismatch, authorization timeout, ...) are not transient connect failures.
    // Surface their actionable guidance verbatim instead of collapsing it into
    // "Failed to connect to MCP server".
    if (error instanceof McpOAuthGuidanceError) {
      throw error;
    }

    const oauthRetry = await maybeAuthenticateAndReconnect({
      error,
      oauthDriver,
      onAuthFlowCompleted,
      logger,
      serverName,
      transport,
      client,
      reconnect,
    });

    if (oauthRetry) {
      return oauthRetry;
    }

    if (isAuthRequiredError(error) && oauthDriver) {
      throw createAuthenticationRequiredError(serverName, error);
    }

    throw (
      createConnectionError?.(error) ??
      createConnectionMetaError(serverName, error)
    );
  }

  // A successful pre-connect authorization (user-initiated auth, which forces
  // replaceClientOnConnect) must report completion too; otherwise the TUI never
  // leaves the "authentication required" screen even though auth + connect
  // succeeded. The 401-retry path reports success from maybeAuthenticateAndReconnect.
  if (authenticatedBeforeConnect) {
    onAuthFlowCompleted?.({
      outcome: McpAuthOutcome.Success,
      message: 'Authentication successful',
    });
  }

  setNotificationHandler(client, logger, serverName);
  return { client, transport };
}
