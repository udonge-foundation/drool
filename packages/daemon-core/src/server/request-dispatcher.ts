import { DaemonDroolEvent, DaemonRelayMethod } from '@industry/common/daemon';
import {
  INDUSTRY_PROTOCOL_VERSION,
  LEGACY_INDUSTRY_API_VERSION,
  JSONRPC_VERSION,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  JsonRpcBaseRequest,
  JsonRpcBaseResponse,
  JsonRpcErrorCode,
  JsonRpcMessageType,
  JsonRpcProtocolVersionMismatchErrorData,
  TraceContextMeta,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logError, logException, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { OtelTracing, SpanName } from '@industry/logging/tracing';
import { inspectJsonRpcEnvelope } from '@industry/utils/protocol';

import {
  createInternalErrorResponse,
  createMethodNotFoundResponse,
  parseEnvelope,
} from './envelope-helpers';
import { debugLog } from '../utils/debug-log';

import type { DaemonRequestMethod } from './core/types';
import type { BaseRequestHandler } from './handlers/base-request-handler';
import type { DroolRequestHandler } from './handlers/drool-request-handler';
import type { BaseResponse } from './handlers/types';
import type { DispatchResult, IAuthedDaemonConnection } from './types';
import type { Context } from '@opentelemetry/api';

const DAEMON_RELAY_METHODS: ReadonlySet<string> = new Set(
  Object.values(DaemonRelayMethod)
);

export class RequestDispatcher {
  private readonly byMethod = new Map<string, BaseRequestHandler>();

  private readonly debug: boolean;

  private readonly pendingResponseHandler: DroolRequestHandler;

  constructor(debug: boolean, pendingResponseHandler: DroolRequestHandler) {
    this.debug = debug;
    this.pendingResponseHandler = pendingResponseHandler;
  }

  bind(
    methods: readonly DaemonRequestMethod[],
    handler: BaseRequestHandler
  ): void {
    for (const method of methods) {
      if (this.byMethod.has(method)) {
        throw new MetaError('Duplicate daemon capability method', { method });
      }
      this.byMethod.set(method, handler);
    }
  }

  has(method: string): boolean {
    return this.byMethod.has(method);
  }

  async handleMessage(
    connection: IAuthedDaemonConnection,
    message: string
  ): Promise<string | null> {
    // Peek at the incoming frame once so we can:
    //   1. extract the caller's traceparent and make the envelope span a
    //      proper child of the caller's web.rpc_request span; and
    //   2. skip the envelope entirely for non-request frames (responses to
    //      daemon-initiated permission/ask_user calls and unparseable garbage)
    //      which aren't "server-side RPC handling" and should not inflate
    //      daemon.rpc_request volume.
    //
    // The dispatch path re-parses the message inside the span. That's a cheap
    // extra JSON.parse; the alternative would require threading a pre-parsed
    // object through the response/request discrimination logic.
    const { parentContext, isRequest } = RequestDispatcher.peekFrame(message);

    const serve = async (): Promise<string | null> => {
      const dispatchResult = await this.dispatchMessage(connection, message);
      if (!dispatchResult) {
        return null;
      }
      return RequestDispatcher.serialize(
        dispatchResult.response,
        dispatchResult.traceContext
      );
    };

    if (!isRequest) {
      return serve();
    }

    return OtelTracing.trace(SpanName.DAEMON_RPC_REQUEST, serve, {
      parentContext,
    });
  }

  private async dispatchMessage(
    connection: IAuthedDaemonConnection,
    message: string
  ): Promise<DispatchResult | null> {
    const parsed = parseEnvelope(message);

    if (parsed.kind === 'parse_error') {
      logException(
        new MetaError('Invalid JSON-RPC message format'),
        'Error while parsing message'
      );
      return {
        response: parsed.response,
      };
    }

    if (parsed.kind === 'response') {
      this.handleResponse(parsed.response);
      return null;
    }

    if (parsed.kind === 'notification') {
      return null;
    }

    const { request, protocolVersionMismatch } = parsed;

    if (this.debug) {
      debugLog('JSON-RPC handling method:', { method: request.method });
    }

    const traceContext = OtelTracing.extractContext(request._meta);

    try {
      return await this.routeRequest(
        connection,
        request,
        traceContext,
        protocolVersionMismatch
      );
    } catch (error) {
      logException(error, 'Error while handling JSON-RPC request', {
        method: request.method,
        requestId: request.id,
      });

      return {
        response: createInternalErrorResponse(request.id),
        traceContext,
      };
    }
  }

  private handleResponse(response: JsonRpcBaseResponse): void {
    const requestId = response.id;
    if (requestId === null || requestId === undefined || requestId === '') {
      logError('JSON-RPC response missing request ID', {
        cause: 'error' in response ? response.error : undefined,
      });
      return;
    }

    const method =
      this.pendingResponseHandler.getPendingRequestMethod(requestId);

    switch (method) {
      case DaemonDroolEvent.REQUEST_PERMISSION:
        this.pendingResponseHandler.handlePermissionResponse(response);
        break;
      case DaemonDroolEvent.ASK_USER:
        this.pendingResponseHandler.handleAskUserResponse(response);
        break;
      case DaemonDroolEvent.SESSION_NOTIFICATION:
        break;
      case undefined:
        logError('No pending request found for JSON-RPC response', {
          requestId,
        });
        break;
      default: {
        const exhaustiveCheck: never = method;
        logError('No handler for JSON-RPC response with method', {
          type: exhaustiveCheck,
          requestId,
        });
      }
    }
  }

  private async routeRequest(
    connection: IAuthedDaemonConnection,
    request: JsonRpcBaseRequest,
    traceContext?: Context,
    protocolVersionMismatch?: JsonRpcProtocolVersionMismatchErrorData | null
  ): Promise<DispatchResult> {
    const method = request.method;
    // handleMessage has already started the daemon.rpc_request envelope span
    // with the extracted traceContext as parent, so every code path here
    // (including error fallbacks) runs inside that span's active context.

    let response: BaseResponse;

    const handler = this.byMethod.get(method);

    if (handler) {
      response = await handler.handleRequest(connection, request);
    } else if (DAEMON_RELAY_METHODS.has(method)) {
      response = {
        type: 'response',
        id: request.id,
        error: {
          code: JsonRpcErrorCode.INVALID_REQUEST,
          message:
            'Relay is not available on this daemon instance. Start the daemon with --remote-access to enable relay capability.',
        },
      };
    } else {
      logError('No handler for JSON-RPC request method', {
        data: protocolVersionMismatch,
        method,
        requestId: request.id,
      });

      response = createMethodNotFoundResponse(
        request.id,
        method,
        protocolVersionMismatch
      );
    }

    return { response, traceContext };
  }

  /**
   * Read the incoming frame just enough to decide how to span it. Returns
   * an undefined parentContext / isRequest=false on any parse failure so
   * the caller cleanly falls back to the un-spanned path.
   *
   * Uses the shared `inspectJsonRpcEnvelope` zod peek so both the envelope
   * type check and the _meta extraction are structurally typed.
   */
  private static peekFrame(message: string): {
    parentContext?: Context;
    isRequest: boolean;
  } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch (err) {
      logWarn('Failed to parse daemon message as JSON', { cause: err });
      return { parentContext: undefined, isRequest: false };
    }
    const { envelope } = inspectJsonRpcEnvelope(parsed);
    if (!envelope) {
      return { parentContext: undefined, isRequest: false };
    }
    const isRequest = envelope.type === JsonRpcMessageType.Request;
    const parentContext = OtelTracing.extractContext(envelope._meta);
    return { parentContext, isRequest };
  }

  private static serialize(
    response: BaseResponse,
    traceContext?: Context
  ): string {
    const _meta: TraceContextMeta = {};
    OtelTracing.injectContext(
      _meta,
      traceContext ?? OtelTracing.getCurrentContext()
    );
    return JSON.stringify({
      ...response,
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      _meta: _meta.traceparent ? _meta : undefined,
    });
  }
}
