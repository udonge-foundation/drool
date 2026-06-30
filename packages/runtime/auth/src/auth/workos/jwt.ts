/**
 * WorkOS JWT decoding and user info extraction.
 */

import { TokenSourceType } from '../../storage/common/enums';
import {
  getCachedUser,
  decodeWorkOSUser as decodeFromCache,
} from '../common/cache';
import { getTokenWithSource } from '../source';

import type { WorkOSUserInfo } from '../../storage/common/types';
import type { RuntimeAuthConfig } from '../common/types';

/**
 * Decode full user info from a JWT access token.
 * Returns null if token is invalid or not a JWT.
 *
 * Use this for immediate decoding (e.g., right after login).
 * For cached access, use getWorkOSUser().
 */
export function decodeWorkOSUser(accessToken: string): WorkOSUserInfo | null {
  return decodeFromCache(accessToken);
}

/**
 * Get full WorkOS user info from the current stored token.
 * Results are cached for fast subsequent reads.
 *
 * Returns null if:
 * - Not authenticated
 * - Using API key auth (full user info not available)
 * - Token is invalid
 */
export async function getWorkOSUser(
  config: RuntimeAuthConfig
): Promise<WorkOSUserInfo | null> {
  const tokenWithSource = await getTokenWithSource(config);
  if (!tokenWithSource || tokenWithSource.type !== TokenSourceType.WorkOS) {
    return null;
  }

  const cached = await getCachedUser(tokenWithSource, config);
  return cached?.workosUser ?? null;
}
