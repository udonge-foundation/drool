import { trace } from '@opentelemetry/api';

import { JsonRpcBaseRequest } from '@industry/drool-sdk-ext/protocol/shared';
import {
  OtelTracing,
  SpanAttribute,
  SpanName,
  SpanStatusCode,
} from '@industry/logging/tracing';

import type { BaseResponse } from './types';
import type { IAuthedDaemonConnection } from '../types';
import type { Span } from '@opentelemetry/api';

export abstract class BaseRequestHandler {
  protected abstract dispatch(
    context: IAuthedDaemonConnection,
    request: JsonRpcBaseRequest
  ): BaseResponse | Promise<BaseResponse>;

  /**
   * Synchronous teardown for resources the handler owns, run by
   * `core.shutdown()`. Stateless handlers implement it as a no-op.
   */
  abstract shutdown(): void;

  /**
   * Dispatches a JSON-RPC request to the concrete handler implementation
   * and stamps RPC-level attributes on the active envelope span (the
   * `daemon.rpc_request` span owned by `RequestDispatcher`).
   *
   * MUST be called from within the envelope span's trace context — the
   * dispatcher invokes this handler synchronously inside its
   * `OtelTracing.trace(SpanName.DAEMON_RPC_REQUEST, ...)` callback. If
   * the active span is something else (or absent), attribute stamping
   * silently moves to the wrong span.
   */
  async handleRequest(
    context: IAuthedDaemonConnection,
    request: JsonRpcBaseRequest
  ): Promise<BaseResponse> {
    const sessionId = BaseRequestHandler.extractSessionId(request.params);
    const tracing = context.tracingMetadata;
    const envelopeSpan = trace.getActiveSpan();
    if (envelopeSpan) {
      envelopeSpan.setAttributes({
        [SpanAttribute.RPC_METHOD]: request.method,
        [SpanAttribute.RPC_REQUEST_ID]: request.id,
        [SpanAttribute.RPC_INDUSTRY_PROTOCOL_VERSION]:
          request.industryProtocolVersion,
        ...(sessionId && { [SpanAttribute.SESSION_ID]: sessionId }),
        // Client-supplied context from the authenticate handshake.
        // Survives ad-blocker-killed OTLP exports because it travels on
        // the WebSocket frame, not via the browser's trace exporter.
        ...(tracing?.app && {
          [SpanAttribute.INDUSTRY_CLIENT_SURFACE]: tracing.app,
        }),
        ...(tracing?.machineType && {
          [SpanAttribute.INDUSTRY_MACHINE_TYPE]: tracing.machineType,
        }),
        ...(tracing?.machineProvider && {
          [SpanAttribute.INDUSTRY_MACHINE_PROVIDER]: tracing.machineProvider,
        }),
        ...(tracing?.daemonTransport && {
          [SpanAttribute.INDUSTRY_DAEMON_TRANSPORT]: tracing.daemonTransport,
        }),
      });
    }

    const result = await OtelTracing.trace(
      SpanName.DAEMON_RPC_DISPATCH,
      async (dispatchSpan) => {
        const res = await this.dispatch(context, request);
        if (res.error) {
          BaseRequestHandler.markError(dispatchSpan, res.error.code);
        }
        return res;
      }
    );

    if (result.error && envelopeSpan) {
      BaseRequestHandler.markError(envelopeSpan, result.error.code);
    }

    return result;
  }

  private static extractSessionId(params: unknown): string | undefined {
    if (typeof params !== 'object' || params === null) return undefined;
    if (!('sessionId' in params)) return undefined;
    const sessionId: unknown = params.sessionId;
    return typeof sessionId === 'string' ? sessionId : undefined;
  }

  /** Apply JSON-RPC error status + code to a span. */
  private static markError(span: Span, code: number): void {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttributes({
      [SpanAttribute.ERROR_TYPE]: String(code),
      [SpanAttribute.RPC_RESPONSE_STATUS_CODE]: String(code),
    });
  }
}
