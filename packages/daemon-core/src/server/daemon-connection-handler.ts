import { randomUUID } from 'crypto';

import { errors as joseErrors } from 'jose';
import { z } from 'zod';

import {
  type DaemonBroadcastMessage,
  DaemonAuthenticateRequest,
  DaemonAuthenticateRequestSchema,
  DaemonAuthenticateResult,
  DaemonConnectionMethod,
  DaemonConnectionEvent,
  DaemonConnectionStatusNotificationParams,
  DaemonLogoutRequestSchema,
} from '@industry/common/daemon';
import { ClientType, Platform } from '@industry/common/shared';
import {
  INDUSTRY_PROTOCOL_VERSION,
  LEGACY_INDUSTRY_API_VERSION,
  JSONRPC_VERSION,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  JsonRpcBaseResponseSuccess,
  JsonRpcBaseResponseFailure,
  JsonRpcErrorCode,
  JsonRpcProtocolVersionMismatchErrorData,
  BaseResponseSuccess,
  BaseResponseFailure,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logException, logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { OtelTracing, SpanName, SpanAttribute } from '@industry/logging/tracing';
import { inspectJsonRpcEnvelope } from '@industry/utils/protocol';

import { authenticateUser } from './auth/utils';
import { verifyActAsGrantViaBackend } from './auth/verify-act-as-grant';

import type { AuthedDaemonConnection } from './authed-daemon-connection';
import type { DroolRequestHandler } from './handlers/drool-request-handler';
import type { RequestDispatcher } from './request-dispatcher';
import type {
  AuthGateConnection,
  ConnectionCleanupHook,
  CreateAuthedDaemonConnectionParams,
  DaemonActAsReverifyFn,
  DaemonConnectionHandlerConfig,
  UnauthedDaemonConnection,
} from './types';
import type { DroolRegistry } from '../drool/drool-registry';
import type { RuntimeAuthConfig } from '@industry/runtime/auth';

const AuthenticateRequestContextSchema = z
  .object({
    id: z.string().nullable().optional().catch(undefined),
    _meta: z
      .object({
        traceparent: z.string().optional(),
        tracestate: z.string().optional(),
      })
      .optional()
      .catch(undefined),
    params: z
      .object({
        connectionId: z.string().optional(),
      })
      .optional()
      .catch(undefined),
  })
  .passthrough();

export class DaemonConnectionHandler {
  private readonly authenticatedConnections = new WeakMap<
    AuthGateConnection,
    AuthedDaemonConnection
  >();

  private readonly pendingAuthentications = new WeakMap<
    AuthGateConnection,
    Promise<{
      response: string | null;
      authenticatedConnection: AuthedDaemonConnection | null;
    }>
  >();

  /**
   * Tracks all authenticated connections connected to this daemon.
   * A connection is added here ONLY after successful authentication and user verification.
   * Used for broadcasting drool working state notifications to all connections.
   */
  private readonly authenticatedConnectionsSet: Set<AuthedDaemonConnection> =
    new Set();

  private readonly droolRegistry: DroolRegistry;

  private readonly requestDispatcher: RequestDispatcher;

  private readonly droolHandler: DroolRequestHandler;

  private readonly cliVersion: string;

  private readonly homeDir: string;

  private readonly runtimeAuthConfig: RuntimeAuthConfig;

  private readonly connectionLabel: string;

  private connectionCleanup?: ConnectionCleanupHook;

  private readonly actAsReverifyIntervalMs: number;

  private readonly verifyActAsGrant: DaemonActAsReverifyFn;

  /**
   * Per-act-as-connection re-verification timers. Decoupled from the SA/machine
   * heartbeat: each entry re-checks only whether the operator may still drive
   * this SA (revoked / SA-active / operator-role), dropping just that
   * connection on failure. Keyed by the transport connection so cleanup hooks
   * into {@link handleClose}.
   */
  private readonly actAsReverifyTimers = new Map<
    UnauthedDaemonConnection,
    ReturnType<typeof setInterval>
  >();

  /** Guards against overlapping re-verify ticks on a slow backend. */
  private readonly actAsReverifyInFlight = new Set<UnauthedDaemonConnection>();

  private static readonly DEFAULT_ACT_AS_REVERIFY_INTERVAL_MS = 60 * 1000; // 1 minute

  constructor(config: DaemonConnectionHandlerConfig) {
    this.droolRegistry = config.droolRegistry;
    this.cliVersion = config.cliVersion;
    this.homeDir = config.homeDir;
    this.runtimeAuthConfig = config.runtimeAuthConfig;
    this.connectionLabel = config.connectionLabel ?? 'Daemon';
    this.actAsReverifyIntervalMs =
      config.actAsReverifyIntervalMs ??
      DaemonConnectionHandler.DEFAULT_ACT_AS_REVERIFY_INTERVAL_MS;
    this.verifyActAsGrant =
      config.verifyActAsGrant ?? verifyActAsGrantViaBackend;

    this.droolHandler = config.droolHandler;
    this.requestDispatcher = config.requestDispatcher;
  }

  /**
   */
  setConnectionCleanup(hook: ConnectionCleanupHook): void {
    if (this.connectionCleanup) {
      throw new MetaError(
        'setConnectionCleanup called twice: only one capability may own per-connection cleanup'
      );
    }
    this.connectionCleanup = hook;
  }

  shutdown(): Promise<void> {
    for (const timer of this.actAsReverifyTimers.values()) {
      clearInterval(timer);
    }
    this.actAsReverifyTimers.clear();
    this.actAsReverifyInFlight.clear();
    return Promise.resolve();
  }

  getAuthenticatedConnection(
    connection: AuthGateConnection
  ): AuthedDaemonConnection | undefined {
    return this.authenticatedConnections.get(connection);
  }

  getAuthenticatedConnections(): Set<AuthedDaemonConnection> {
    return this.authenticatedConnectionsSet;
  }

  authenticateTrustedConnection(
    connection: AuthGateConnection,
    params: CreateAuthedDaemonConnectionParams,
    { sendConnectionStatus = true }: { sendConnectionStatus?: boolean } = {}
  ): AuthedDaemonConnection {
    const authenticatedConnection =
      connection.createAuthenticatedConnection(params);
    const registeredConnection = this.registerAuthenticatedConnection(
      connection,
      authenticatedConnection
    );

    if (sendConnectionStatus) {
      void this.sendConnectionStatusNotification(registeredConnection);
    }

    return registeredConnection;
  }

  broadcastToAuthenticatedConnections(message: DaemonBroadcastMessage): void {
    const authenticatedConnections = this.getAuthenticatedConnections();
    if (authenticatedConnections.size === 0) {
      return;
    }

    const messageString = JSON.stringify(message);
    for (const connection of authenticatedConnections) {
      try {
        connection.sendMessage(messageString);
      } catch (error) {
        logException(error, 'Failed to send to connection');
      }
    }
  }

  async dispatchAutomationRun(
    automationId: string,
    basePath: string
  ): Promise<{ sessionId: string } | null> {
    const connections = this.getAuthenticatedConnections();
    const context = connections.values().next().value;
    if (!context) {
      logWarn('[Automation] No authenticated connections, cannot dispatch', {
        automationId,
      });
      return null;
    }

    return this.droolHandler.dispatchAutomationRun(
      automationId,
      context,
      basePath
    );
  }

  async recordAutomationDispatchFailure(
    automationId: string,
    reason: 'dispatch_skipped' | 'dispatch_failed' | 'dispatch_exception',
    basePath: string
  ): Promise<void> {
    return this.droolHandler.recordAutomationDispatchFailure(
      automationId,
      reason,
      basePath
    );
  }

  async handleMessage(
    connection: AuthGateConnection,
    data: string
  ): Promise<void> {
    const authenticatedConnection =
      this.authenticatedConnections.get(connection);

    if (authenticatedConnection) {
      try {
        const messageObj = JSON.parse(data);
        const { envelope } = inspectJsonRpcEnvelope(messageObj);
        if (envelope?.method === DaemonConnectionMethod.AUTHENTICATE) {
          logInfo(
            'Re-authentication attempt on already authenticated connection'
          );
          this.sendAuthenticatedIdentityResponse(
            authenticatedConnection,
            messageObj
          );
          return;
        }
        if (envelope?.method === DaemonConnectionMethod.LOGOUT) {
          this.handleLogoutRequest(
            connection,
            authenticatedConnection,
            messageObj
          );
          return;
        }
      } catch (err) {
        // Not a valid JSON message, continue to RPC handler.
        logWarn('[DaemonConnectionHandler] Failed to parse JSON message', {
          cause: err,
        });
      }

      const response = await this.requestDispatcher.handleMessage(
        authenticatedConnection,
        data
      );
      if (response) {
        authenticatedConnection.sendMessage(response);
      }
      return;
    }

    let protocolVersionMismatch: JsonRpcProtocolVersionMismatchErrorData | null =
      null;
    let messageObj: object;
    let envelope: ReturnType<typeof inspectJsonRpcEnvelope>['envelope'];

    try {
      const parsedMessage: unknown = JSON.parse(data);
      if (parsedMessage === null || typeof parsedMessage !== 'object') {
        throw new MetaError('Invalid JSON-RPC message format');
      }
      messageObj = parsedMessage;
      const inspectedEnvelope = inspectJsonRpcEnvelope(messageObj);
      envelope = inspectedEnvelope.envelope;
      protocolVersionMismatch = inspectedEnvelope.protocolVersionMismatch;
    } catch (error) {
      logException(error, 'Failed to parse message in authentication check');
      connection.sendAuthGateResponse({
        type: 'response',
        id: null,
        error: {
          code: JsonRpcErrorCode.PARSE_ERROR,
          message: 'Parse error',
          data: protocolVersionMismatch
            ? { protocolVersionMismatch }
            : undefined,
        },
      });
      return;
    }

    if (envelope?.method === DaemonConnectionMethod.AUTHENTICATE) {
      const pendingAuthentication = this.pendingAuthentications.get(connection);
      if (pendingAuthentication) {
        await pendingAuthentication.catch(() => undefined);
        const existingAuthenticatedConnection =
          this.authenticatedConnections.get(connection);
        if (existingAuthenticatedConnection) {
          this.sendAuthenticatedIdentityResponse(
            existingAuthenticatedConnection,
            messageObj
          );
          return;
        }
      }

      const authenticationPromise = this.handleAuthenticateRequest(
        connection,
        messageObj,
        protocolVersionMismatch
      );
      this.pendingAuthentications.set(connection, authenticationPromise);

      let newAuthedConnection: AuthedDaemonConnection | null = null;
      try {
        const result = await authenticationPromise;
        newAuthedConnection = result.authenticatedConnection;

        if (result.response) {
          if (newAuthedConnection) {
            newAuthedConnection.sendMessage(result.response);
          } else {
            throw new MetaError(
              'Authenticate request returned response without authenticated connection'
            );
          }
        }
      } finally {
        if (
          this.pendingAuthentications.get(connection) === authenticationPromise
        ) {
          this.pendingAuthentications.delete(connection);
        }
      }

      if (newAuthedConnection) {
        void this.sendConnectionStatusNotification(newAuthedConnection);
      }
      return;
    }

    if (protocolVersionMismatch && envelope?.method) {
      logInfo(
        'Received unsupported authentication method with protocol version mismatch',
        {
          method: envelope.method,
          requestId: envelope.id ?? undefined,
          data: protocolVersionMismatch,
        }
      );
      connection.sendAuthGateResponse({
        type: 'response',
        id: envelope.id ?? null,
        error: {
          code: JsonRpcErrorCode.METHOD_NOT_FOUND,
          message: `Method not found: ${envelope.method}`,
          data: { protocolVersionMismatch },
        },
      });
      return;
    }

    if (protocolVersionMismatch) {
      connection.sendAuthGateResponse({
        type: 'response',
        id: null,
        error: {
          code: JsonRpcErrorCode.PARSE_ERROR,
          message: 'Parse error',
          data: { protocolVersionMismatch },
        },
      });
      return;
    }

    const requestId =
      messageObj !== null && typeof messageObj === 'object'
        ? Reflect.get(messageObj, 'id')
        : null;
    connection.sendAuthGateResponse({
      type: 'response',
      id: typeof requestId === 'string' ? requestId : null,
      error: {
        code: JsonRpcErrorCode.AUTHENTICATION_ERROR,
        message:
          'Connection not authenticated. Must call daemon.authenticate first.',
      },
    });
  }

  private sendAuthenticatedIdentityResponse(
    authenticatedConnection: AuthedDaemonConnection,
    request: object
  ): void {
    const requestId = Reflect.get(request, 'id');
    if (typeof requestId !== 'string') {
      logWarn(
        '[DaemonConnectionHandler] Cannot send authenticated identity response without request id'
      );
      return;
    }

    const response = DaemonConnectionHandler.serializeResponse({
      type: 'response',
      id: requestId,
      result: {
        userId: authenticatedConnection.user.userId,
        orgId: authenticatedConnection.user.orgId,
      },
    });
    authenticatedConnection.sendMessage(response);
  }

  private handleLogoutRequest(
    connection: AuthGateConnection,
    authenticatedConnection: AuthedDaemonConnection,
    request: object
  ): void {
    const parsedRequest = DaemonLogoutRequestSchema.safeParse(request);

    if (!parsedRequest.success) {
      const requestId = Reflect.get(request, 'id');
      logException(
        parsedRequest.error,
        'JSON-RPC error handling logout request'
      );
      try {
        authenticatedConnection.sendMessage(
          DaemonConnectionHandler.serializeResponse({
            type: 'response',
            id: typeof requestId === 'string' ? requestId : null,
            error: {
              code: JsonRpcErrorCode.PARSE_ERROR,
              message: 'Parse error',
            },
          })
        );
      } catch (error) {
        logException(error, 'Failed to send logout parse error response');
      }
      return;
    }

    logInfo('Daemon logout method called', {
      caller: authenticatedConnection.caller,
      connectionId: authenticatedConnection.connectionId,
    });

    try {
      authenticatedConnection.sendMessage(
        DaemonConnectionHandler.serializeResponse({
          type: 'response',
          id: parsedRequest.data.id,
          result: { accepted: true },
        })
      );
    } catch (error) {
      logException(error, 'Failed to send logout response');
    } finally {
      this.handleClose(connection);
    }
  }

  private async handleAuthenticateRequest(
    connection: AuthGateConnection,
    request: object,
    protocolVersionMismatch: JsonRpcProtocolVersionMismatchErrorData | null
  ): Promise<{
    response: string | null;
    authenticatedConnection: AuthedDaemonConnection | null;
  }> {
    const requestContext = AuthenticateRequestContextSchema.parse(request);
    const traceContext = requestContext._meta?.traceparent
      ? OtelTracing.extractContext(requestContext._meta)
      : undefined;
    const requestId = requestContext.id;
    const connectionId = requestContext.params?.connectionId;

    try {
      return await OtelTracing.trace(
        SpanName.DAEMON_AUTHENTICATE,
        async () => {
          const validatedRequest =
            DaemonAuthenticateRequestSchema.parse(request);

          const { result, authenticatedConnection } =
            await this.handleAuthenticate(connection, validatedRequest);

          return {
            response: DaemonConnectionHandler.serializeResponse({
              type: 'response',
              id: validatedRequest.id,
              result,
            }),
            authenticatedConnection,
          };
        },
        {
          attributes: {
            [SpanAttribute.RPC_METHOD]: DaemonConnectionMethod.AUTHENTICATE,
            ...(typeof requestId === 'string' && {
              [SpanAttribute.RPC_REQUEST_ID]: requestId,
            }),
            ...(typeof connectionId === 'string' && {
              // TODO(FAC-19618 follow-up): rename this transport-agnostic daemon
              // connection ID attribute once monitors have been updated.
              [SpanAttribute.WEBSOCKET_CONNECTION_ID]: connectionId,
            }),
          },
          parentContext: traceContext,
        }
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        logException(error, 'JSON-RPC error handling authenticate request');
        connection.sendAuthGateResponse({
          type: 'response',
          id: typeof requestId === 'string' ? requestId : null,
          error: {
            code: JsonRpcErrorCode.PARSE_ERROR,
            message: 'Parse error',
            data: protocolVersionMismatch
              ? { protocolVersionMismatch }
              : undefined,
          },
        });
        return {
          response: null,
          authenticatedConnection: null,
        };
      }

      const isJoseError = error instanceof joseErrors.JOSEError;
      logException(
        error,
        isJoseError
          ? 'JWT verification failed'
          : 'JSON-RPC error handling authenticate request'
      );
      connection.sendAuthGateResponse({
        type: 'response',
        id: typeof requestId === 'string' ? requestId : null,
        error: {
          code: JsonRpcErrorCode.AUTHENTICATION_ERROR,
          message: isJoseError
            ? 'Websocket authentication verification failed. Please log out and try again.'
            : 'Internal error',
          data: protocolVersionMismatch
            ? { protocolVersionMismatch }
            : undefined,
        },
      });
      return {
        response: null,
        authenticatedConnection: null,
      };
    }
  }

  private async handleAuthenticate(
    connection: AuthGateConnection,
    request: DaemonAuthenticateRequest
  ): Promise<{
    result: DaemonAuthenticateResult;
    authenticatedConnection: AuthedDaemonConnection;
  }> {
    const {
      token,
      apiKey,
      actAsGrant,
      connectionId: requestedConnectionId,
      caller,
      metadata,
    } = request.params;
    const connectionId = requestedConnectionId ?? randomUUID();

    logInfo('Daemon authenticate method called', {
      caller: caller ?? 'unknown',
      connectionId,
      type: this.connectionLabel,
      actAs: Boolean(actAsGrant),
    });

    const user = await authenticateUser({
      runtimeAuthConfig: this.runtimeAuthConfig,
      apiKey,
      token,
      actAsGrant,
    });

    logInfo('User authenticated successfully', {
      userId: user.userId,
      orgId: user.orgId,
      operatorUserId: user.operator?.userId,
    });

    const interactive = caller !== ClientType.Backend;

    const authenticatedConnection = connection.createAuthenticatedConnection({
      user,
      connectionId,
      tracingMetadata: metadata?.tracing,
      caller,
      interactive,
    });
    const registeredConnection = this.registerAuthenticatedConnection(
      connection,
      authenticatedConnection
    );

    logInfo('Connection authenticated and cached', {
      userId: user.userId,
      orgId: user.orgId,
      operatorUserId: user.operator?.userId,
    });

    // Act-as connections carry an operator; re-verify their standing on the
    // per-connection path (NOT the SA/machine heartbeat) so revocation, SA
    // deactivation, or operator demotion drop just this connection.
    if (registeredConnection.user.operator && actAsGrant) {
      this.startActAsReverify(connection, registeredConnection, actAsGrant);
    }

    return {
      result: {
        userId: user.userId,
        orgId: user.orgId,
      },
      authenticatedConnection: registeredConnection,
    };
  }

  /**
   * Start periodic re-verification for an act-as connection. The grant is held
   * only in memory for the connection's lifetime and is re-checked as the SA
   * (the daemon's own credential); the operator's token never leaves connect.
   * On any verification failure the connection is fully torn down so the
   * operator must re-authenticate.
   */
  private startActAsReverify(
    connection: UnauthedDaemonConnection,
    authenticatedConnection: AuthedDaemonConnection,
    grant: string
  ): void {
    if (this.actAsReverifyTimers.has(connection)) {
      return;
    }

    const timer = setInterval(() => {
      if (this.actAsReverifyInFlight.has(connection)) {
        return;
      }
      this.actAsReverifyInFlight.add(connection);

      void this.verifyActAsGrant({
        grant,
        runtimeAuthConfig: this.runtimeAuthConfig,
        reverify: true,
      })
        .catch((error: unknown) => {
          logWarn('[ActAsGrant] Re-verification failed, dropping connection', {
            connectionId: authenticatedConnection.connectionId,
            operatorUserId: authenticatedConnection.user.operator?.userId,
            cause: error instanceof Error ? error.message : String(error),
          });
          // Full teardown (transport-agnostic) then drop the transport itself.
          this.handleClose(connection);
          try {
            authenticatedConnection.close();
          } catch (closeError) {
            logException(closeError, 'Failed to close re-verified connection');
          }
        })
        .finally(() => {
          this.actAsReverifyInFlight.delete(connection);
        });
    }, this.actAsReverifyIntervalMs);

    this.actAsReverifyTimers.set(connection, timer);
  }

  private stopActAsReverify(connection: UnauthedDaemonConnection): void {
    const timer = this.actAsReverifyTimers.get(connection);
    if (timer) {
      clearInterval(timer);
      this.actAsReverifyTimers.delete(connection);
    }
    this.actAsReverifyInFlight.delete(connection);
  }

  private registerAuthenticatedConnection(
    connection: AuthGateConnection,
    authenticatedConnection: AuthedDaemonConnection
  ): AuthedDaemonConnection {
    const existingConnection = this.authenticatedConnections.get(connection);
    if (existingConnection) {
      return existingConnection;
    }

    this.authenticatedConnections.set(connection, authenticatedConnection);
    this.authenticatedConnectionsSet.add(authenticatedConnection);
    return authenticatedConnection;
  }

  private async sendConnectionStatusNotification(
    authenticatedConnection: AuthedDaemonConnection
  ): Promise<void> {
    try {
      const platformResult = z.nativeEnum(Platform).safeParse(process.platform);
      if (!platformResult.success) {
        throw new MetaError('Unsupported platform', {
          platform: process.platform,
        });
      }
      const platform = platformResult.data;

      const params: DaemonConnectionStatusNotificationParams = {
        isDroolCLIInPath: true,
        droolCLIVersion: this.cliVersion.match(/(\d+\.\d+\.\d+)/)?.[1],
        homedir: this.homeDir,
        platform,
      };

      const notification = {
        jsonrpc: JSONRPC_VERSION,
        industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
        industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
        type: 'notification' as const,
        method: DaemonConnectionEvent.CONNECTION_STATUS,
        params,
      };

      authenticatedConnection.sendMessage(JSON.stringify(notification));

      logInfo('Connection status notification sent');
    } catch (error) {
      logException(error, 'Failed to send connection status notification');
    }
  }

  handleClose(connection: AuthGateConnection): void {
    this.pendingAuthentications.delete(connection);
    this.stopActAsReverify(connection);
    const authenticatedConnection =
      this.authenticatedConnections.get(connection);
    if (!authenticatedConnection) {
      this.authenticatedConnections.delete(connection);
      return;
    }

    try {
      this.connectionCleanup?.(authenticatedConnection);
    } catch (error) {
      logException(error, 'Connection-close cleanup hook failed');
    }

    this.droolRegistry.scheduleCleanupForConnection(authenticatedConnection);
    this.authenticatedConnectionsSet.delete(authenticatedConnection);
    this.authenticatedConnections.delete(connection);
  }

  private static serializeResponse(
    params: BaseResponseSuccess | BaseResponseFailure
  ): string {
    const response: JsonRpcBaseResponseSuccess | JsonRpcBaseResponseFailure = {
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      ...params,
    };
    return JSON.stringify(response);
  }
}
