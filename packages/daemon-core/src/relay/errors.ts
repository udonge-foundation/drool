/**
 * Raised when a subprotocol-bearing connect attempt is closed before the
 * WebSocket reaches OPEN with close code 1002 (protocol error). Bun emits
 * this when the relay does not echo a matching `Sec-WebSocket-Protocol`,
 * i.e. it did not negotiate the `industry-relay.N` subprotocol. Triggers a
 * no-subprotocol retry so a rolled-back relay can still be reached.
 */
export class PreOpenConnectionError extends Error {
  override readonly cause: Error;

  readonly code: number;

  readonly reason: string;

  constructor(cause: Error, code: number, reason: string) {
    super(cause.message);
    this.name = 'PreOpenConnectionError';
    this.cause = cause;
    this.code = code;
    this.reason = reason;
  }
}
