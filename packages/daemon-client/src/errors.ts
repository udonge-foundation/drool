import { DaemonClientErrorCode } from './enums';

import type { ConnectionFailureReason } from './session/enums';

export class DaemonClientError extends Error {
  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'DaemonClientError';
    Object.setPrototypeOf(this, DaemonClientError.prototype);
  }
}

export class WebSocketConnectionError extends DaemonClientError {
  public readonly originalError?: Error;

  public readonly closeCode?: number;

  public readonly closeReason?: string;

  constructor(
    message: string,
    metadata?: {
      originalError?: Error;
      closeCode?: number;
      closeReason?: string;
    }
  ) {
    super(message, DaemonClientErrorCode.WsConnectionError);
    this.name = 'WebSocketConnectionError';
    this.originalError = metadata?.originalError;
    this.closeCode = metadata?.closeCode;
    this.closeReason = metadata?.closeReason;
    this.cause = metadata?.originalError;
    Object.setPrototypeOf(this, WebSocketConnectionError.prototype);
  }
}

/**
 * Thrown when an in-flight JSON-RPC request is rejected because the
 * underlying transport closed before a response arrived. Carries the
 * WebSocket close `code` and `reason` so callers can distinguish
 * benign disconnects (e.g. relay-signalled "computer offline") from
 * unexpected ones without string-matching error messages.
 */
export class ConnectionClosedError extends DaemonClientError {
  constructor(
    public readonly closeCode: number,
    public readonly closeReason: string
  ) {
    super(
      `Connection closed while request pending (code=${closeCode}, reason=${closeReason || 'unknown'})`,
      DaemonClientErrorCode.ConnectionClosed
    );
    this.name = 'ConnectionClosedError';
    Object.setPrototypeOf(this, ConnectionClosedError.prototype);
  }
}

export class RequestTimeoutError extends DaemonClientError {
  constructor(
    public readonly method: string,
    public readonly requestId: string,
    public readonly timeoutMs: number
  ) {
    super(
      `Request timeout after ${timeoutMs}ms: ${method} (${requestId})`,
      DaemonClientErrorCode.RequestTimeout
    );
    this.name = 'RequestTimeoutError';
    Object.setPrototypeOf(this, RequestTimeoutError.prototype);
  }
}

export class ClientDestroyedError extends DaemonClientError {
  constructor() {
    super('Client destroyed', DaemonClientErrorCode.ClientDestroyed);
    this.name = 'ClientDestroyedError';
    Object.setPrototypeOf(this, ClientDestroyedError.prototype);
  }
}

export class JsonRpcRequestError extends DaemonClientError {
  constructor(
    message: string,
    public readonly error: { code: number; message: string; data?: unknown },
    public readonly requestId: string
  ) {
    super(message, DaemonClientErrorCode.JsonRpcError);
    this.name = 'JsonRpcRequestError';
    Object.setPrototypeOf(this, JsonRpcRequestError.prototype);
  }
}

export class InProcessDaemonMethodNotFoundError extends DaemonClientError {
  constructor(public readonly method: string) {
    super(`Method not found: ${method}`, DaemonClientErrorCode.JsonRpcError);
    this.name = 'InProcessDaemonMethodNotFoundError';
    Object.setPrototypeOf(this, InProcessDaemonMethodNotFoundError.prototype);
  }
}

export class RelayConnectionError extends DaemonClientError {
  public readonly reason: ConnectionFailureReason;

  constructor(reason: ConnectionFailureReason, originalError?: Error) {
    super(
      `Relay connection failed: ${reason}`,
      DaemonClientErrorCode.RelayConnection
    );
    this.name = 'RelayConnectionError';
    this.reason = reason;
    this.cause = originalError;
    Object.setPrototypeOf(this, RelayConnectionError.prototype);
  }
}

export class ComputeLimitExceededError extends DaemonClientError {
  constructor(message: string, cause?: Error) {
    super(message, DaemonClientErrorCode.ComputeLimitExceeded);
    this.name = 'ComputeLimitExceededError';
    this.cause = cause;
    Object.setPrototypeOf(this, ComputeLimitExceededError.prototype);
  }
}
