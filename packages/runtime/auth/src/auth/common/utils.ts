/**
 * Shared utilities for authentication.
 */

import { logWarn } from '@industry/logging';

/**
 * Check if a JWT access token is expired.
 * Returns true if expired or if the token is invalid/unparseable.
 *
 * @param accessToken JWT access token
 * @param bufferSeconds Seconds before expiry to consider expired (default: 60)
 */
export function isTokenExpired(
  accessToken: string,
  bufferSeconds: number = 60
): boolean {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) {
      return true;
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    const exp = payload.exp;

    if (typeof exp !== 'number') {
      return true;
    }

    // exp is in seconds, Date.now() is in milliseconds
    const expiresAt = exp * 1000;
    const now = Date.now();
    const bufferMs = bufferSeconds * 1000;

    return now >= expiresAt - bufferMs;
  } catch (error) {
    logWarn('Failed to parse token expiry, treating as expired', { error });
    return true;
  }
}
