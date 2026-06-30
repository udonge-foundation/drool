import { COMPUTE_LIMIT_EXCEEDED_MESSAGE } from '@industry/common/api/v0/computers';

import { ConnectionFailureReason } from './enums';
import { ConnectionFailureError } from './errors';

// ---------------------------------------------------------------------------
// Retryable classification
// ---------------------------------------------------------------------------

const PERMANENT_REASONS = new Set<ConnectionFailureReason>([
  ConnectionFailureReason.NoToken,
  ConnectionFailureReason.AuthRejected,
  ConnectionFailureReason.RelayUnauthorized,
  ConnectionFailureReason.IdentityMismatch,
  ConnectionFailureReason.ProtocolMismatch,
  ConnectionFailureReason.ComputeLimitExceeded,
]);

export function isRetryableReason(reason: ConnectionFailureReason): boolean {
  return !PERMANENT_REASONS.has(reason);
}

// ---------------------------------------------------------------------------
// Human-readable messages for each failure reason
// ---------------------------------------------------------------------------

const REASON_MESSAGES: Record<ConnectionFailureReason, string> = {
  [ConnectionFailureReason.NoToken]: 'Authentication required. Please sign in.',
  [ConnectionFailureReason.AuthRejected]:
    'Authentication failed. Please sign in again.',
  [ConnectionFailureReason.IdentityMismatch]:
    'Identity mismatch. Please sign in again.',
  [ConnectionFailureReason.ProtocolMismatch]:
    'Protocol version mismatch. Please update your client.',
  [ConnectionFailureReason.ComputeLimitExceeded]:
    COMPUTE_LIMIT_EXCEEDED_MESSAGE,
  [ConnectionFailureReason.RelayUnreachable]:
    'Relay server is unreachable. Please try again.',
  [ConnectionFailureReason.RelayTimeout]: 'Relay connection timed out.',
  [ConnectionFailureReason.RelayUnauthorized]:
    'Relay authentication failed. Please sign in again.',
  [ConnectionFailureReason.RelayAuthRejected]:
    'Relay authentication failed. Please sign in again.',
  [ConnectionFailureReason.ComputerOffline]:
    'Computer is offline or hibernating.',
  [ConnectionFailureReason.ComputerDisconnected]:
    'Computer disconnected unexpectedly.',
  [ConnectionFailureReason.DaemonUnreachable]:
    'Could not reach the daemon. It may still be starting.',
  [ConnectionFailureReason.DaemonTimeout]: 'Daemon connection timed out.',
  [ConnectionFailureReason.ConnectionLost]: 'Connection lost.',
  [ConnectionFailureReason.Unknown]: 'An unexpected connection error occurred.',
};

// ---------------------------------------------------------------------------
// Industry helper for constructing ConnectionFailure instances
// ---------------------------------------------------------------------------

export function createConnectionFailure(
  reason: ConnectionFailureReason,
  opts?: { cause?: Error }
): ConnectionFailureError {
  const message = REASON_MESSAGES[reason] ?? 'Connection failed';
  return new ConnectionFailureError(reason, {
    retryable: isRetryableReason(reason),
    cause: opts?.cause,
    message,
  });
}
