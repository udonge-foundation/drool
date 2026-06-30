import { MetaError } from '@industry/logging/errors';

import type { ConnectionFailureReason } from './enums';
import type { JsonRpcError } from '@industry/drool-sdk-ext/protocol/shared';

// ---------------------------------------------------------------------------
// ConnectionFailure error class
//
// Structured error carrying a classified reason and transient/permanent flag.
// User-facing message mapping is left to the UI layer (frontend/CLI).
// The classification logic lives in connection-failure.ts.
// ---------------------------------------------------------------------------

export class ConnectionFailureError extends MetaError {
  readonly reason: ConnectionFailureReason;

  readonly retryable: boolean;

  readonly originalError?: Error;

  constructor(
    reason: ConnectionFailureReason,
    opts: { retryable: boolean; cause?: Error; message: string }
  ) {
    super(opts.message, { cause: opts.cause });
    this.name = 'ConnectionFailureError';
    this.reason = reason;
    this.retryable = opts.retryable;
    this.originalError = opts.cause;
    Object.setPrototypeOf(this, ConnectionFailureError.prototype);
  }
}

class SessionError extends MetaError {
  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'SessionError';
    Object.setPrototypeOf(this, SessionError.prototype);
  }
}

export class WebSocketConnectionError extends SessionError {
  constructor(
    message: string,
    public readonly originalError?: Error
  ) {
    super(message, 'WS_CONNECTION_ERROR');
    this.name = 'WebSocketConnectionError';
    Object.setPrototypeOf(this, WebSocketConnectionError.prototype);
  }
}

export class JsonRpcRequestError extends SessionError {
  constructor(
    message: string,
    public readonly rpcError: JsonRpcError,
    public readonly requestId?: string
  ) {
    super(message, `JSON_RPC_${rpcError.code}`);
    this.name = 'JsonRpcRequestError';
    Object.setPrototypeOf(this, JsonRpcRequestError.prototype);
  }
}

export class SessionNotInitializedError extends SessionError {
  constructor() {
    super(
      'Session not initialized. Call initializeSession first.',
      'SESSION_NOT_INITIALIZED'
    );
    this.name = 'SessionNotInitializedError';
    Object.setPrototypeOf(this, SessionNotInitializedError.prototype);
  }
}

export class SessionNotFoundError extends SessionError {
  constructor() {
    super('Session not found', 'SESSION_NOT_FOUND');
    this.name = 'SessionNotFoundError';
    Object.setPrototypeOf(this, SessionNotFoundError.prototype);
  }
}
