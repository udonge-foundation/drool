/**
 * WorkOS-specific authentication errors.
 */

import { MetaError } from '@industry/logging/errors';

/**
 * Error thrown when token refresh fails.
 * `permanent` distinguishes unrecoverable failures (invalid/revoked token)
 * from transient ones (network errors, server outages).
 */
export class TokenRefreshError extends MetaError {
  readonly permanent: boolean;

  constructor(
    message: string,
    permanent: boolean,
    details?: Record<string, unknown>
  ) {
    super(message, details);
    Object.setPrototypeOf(this, TokenRefreshError.prototype);
    this.name = 'TokenRefreshError';
    this.permanent = permanent;
  }
}
