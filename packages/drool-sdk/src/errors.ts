import { MetaError } from '@industry/logging/errors';

import type { LogMetadata } from '@industry/logging';

export class DroolClientError extends MetaError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, metadata);
    this.name = 'DroolClientError';
    Object.setPrototypeOf(this, DroolClientError.prototype);
  }
}

export class ConnectionError extends DroolClientError {
  /** The working directory that was used when spawning the process, if available. */
  readonly cwd?: string;

  /** The executable path that was used when spawning the process, if available. */
  readonly execPath?: string;

  constructor(
    message: string,
    metadata?: LogMetadata & { cwd?: string; execPath?: string }
  ) {
    super(message, metadata);
    this.cwd = metadata?.cwd;
    this.execPath = metadata?.execPath;
    this.name = 'ConnectionError';
    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}

export class TimeoutError extends DroolClientError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, metadata);
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

export class ProtocolError extends DroolClientError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, metadata);
    this.name = 'ProtocolError';
    Object.setPrototypeOf(this, ProtocolError.prototype);
  }
}

export class SessionError extends DroolClientError {
  constructor(message: string, metadata?: LogMetadata) {
    super(message, metadata);
    this.name = 'SessionError';
    Object.setPrototypeOf(this, SessionError.prototype);
  }
}

export class SessionNotFoundError extends SessionError {
  constructor(sessionId: string, metadata?: LogMetadata) {
    super(`Session not found: ${sessionId}`, metadata);
    this.name = 'SessionNotFoundError';
    Object.setPrototypeOf(this, SessionNotFoundError.prototype);
  }
}

/**
 * Thrown when a session is created/loaded with an invalid `cwd` (missing,
 * not a directory, or unreadable). Mapped to JSON-RPC INVALID_PARAMS so
 * callers can surface a 4xx-equivalent error to end users.
 */
export class InvalidSessionCwdError extends SessionError {
  readonly cwd: string;

  constructor(cwd: string, message: string, metadata?: LogMetadata) {
    super(message, { ...metadata, cwd });
    this.cwd = cwd;
    this.name = 'InvalidSessionCwdError';
    Object.setPrototypeOf(this, InvalidSessionCwdError.prototype);
  }
}

export class ProcessExitError extends DroolClientError {
  /** The exit code of the process, if it exited normally. */
  readonly exitCode?: number;

  /** The signal that terminated the process, if it was killed. */
  readonly signal?: string;

  constructor(
    message: string,
    metadata?: LogMetadata & { exitCode?: number; signal?: string }
  ) {
    super(message, metadata);
    this.exitCode = metadata?.exitCode;
    this.signal = metadata?.signal;
    this.name = 'ProcessExitError';
    Object.setPrototypeOf(this, ProcessExitError.prototype);
  }
}
