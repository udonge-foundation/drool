/**
 * Main auth token and user getters.
 */

import { AuthenticationError } from '@industry/logging/errors';

import { getCachedUser, clearUserCache } from './common/cache';
import { AIRGAPPED_USER } from './common/constants';
import { AuthFailureReason } from './common/enums';
import { resolveOrganization } from './resolve-org';
import { getFreshTokenWithSource, getTokenWithSource } from './source';
import { TokenSourceType } from '../storage/common/enums';

import type {
  AuthIdentity,
  AuthedUser,
  RuntimeAuthConfig,
} from './common/types';

/**
 * Get the current authentication token.
 *
 * Priority:
 * 1. INDUSTRY_API_KEY env var (overrides any stored WorkOS session)
 * 2. Stored WorkOS session (auth.v2.<keysource> file), auto-refreshed if
 *    expired, used when no API key is set
 *
 * @returns Bearer token string or null if not authenticated
 */
export async function getAuthToken(
  config: RuntimeAuthConfig
): Promise<string | null> {
  const result = await getFreshTokenWithSource(config);
  return result?.token ?? null;
}

/**
 * Get the current authentication token, throwing if not available.
 *
 * Same as getAuthToken() but throws AuthenticationError instead of returning null.
 * Useful when authentication is required.
 *
 * @returns Bearer token string
 * @throws AuthenticationError if not authenticated
 */
export async function getAuthTokenOrThrow(
  config: RuntimeAuthConfig
): Promise<string> {
  const result = await getFreshTokenWithSource(config);
  if (!result) {
    throw new AuthenticationError('No access token available');
  }
  return result.token;
}

/**
 * Get the current authenticated user (no token refresh).
 *
 * Reads stored credentials and decodes user info locally. Does not refresh
 * expired tokens - user info (userId, orgId, email) doesn't change on refresh.
 *
 * For WorkOS tokens: Decodes user info from stored JWT (works even if expired).
 * For API keys: Returns cached user if available, or fetches via /whoami.
 *
 * Results are cached for fast subsequent reads.
 *
 * Returns null if:
 * - No credentials stored
 * - JWT is malformed
 * - API call fails (for API key auth on first call)
 */
export async function getAuthedUser(
  config: RuntimeAuthConfig
): Promise<AuthedUser | null> {
  if (config.airgapEnabled) return AIRGAPPED_USER;

  const tokenWithSource = await getTokenWithSource(config);
  if (!tokenWithSource) return null;

  const cached = await getCachedUser(tokenWithSource, config);
  return cached?.authedUser ?? null;
}

/**
 * Resolve and validate the active credentials into an auth identity.
 *
 * Verifies the token is usable by attempting a fresh token fetch (which
 * auto-refreshes expired WorkOS tokens) and resolving user info from it. For
 * API keys this hits /whoami, so it is the single place that detects a
 * configured-but-rejected INDUSTRY_API_KEY.
 *
 * If the token is valid but missing an orgId, queries the backend to check if
 * the user has been assigned to an organization. If so, refreshes the token
 * with org context and returns the updated user.
 *
 * Centralizing this here keeps each entrypoint from re-implementing the
 * "is auth actually valid, and if not why" check, and the discriminated-union
 * return forces callers to handle the failure case (fail fast). The failure
 * `reason` is machine-readable so the application layer owns localization.
 */
export async function getAuthIdentity(
  config: RuntimeAuthConfig
): Promise<AuthIdentity> {
  if (config.airgapEnabled) {
    return { authenticated: true, user: AIRGAPPED_USER };
  }

  const tokenWithSource = await getFreshTokenWithSource(config);
  if (!tokenWithSource) {
    // No API key and no (refreshable) WorkOS session.
    return { authenticated: false, reason: AuthFailureReason.Unauthenticated };
  }

  const cached = await getCachedUser(tokenWithSource, config);
  let user = cached?.authedUser ?? null;

  if (user && !user.orgId) {
    // JWT has no org claim -- ask the backend if the user belongs to one.
    // If found, refreshWithOrganization saves new credentials with org context.
    const orgId = await resolveOrganization(tokenWithSource.token, config);
    if (orgId) {
      // Token was refreshed with org -- clear cache so next read picks up the new JWT.
      clearUserCache();
      const refreshed = await getFreshTokenWithSource(config);
      if (refreshed) {
        const updated = await getCachedUser(refreshed, config);
        user = updated?.authedUser ?? null;
      }
    }
  }

  if (!user) {
    // The token resolved but no user came back. For an API key that means the
    // backend rejected the key (or a transient /whoami failure we cannot
    // distinguish); for a WorkOS token the session is no longer usable.
    return {
      authenticated: false,
      reason:
        tokenWithSource.type === TokenSourceType.ApiKey
          ? AuthFailureReason.InvalidApiKey
          : AuthFailureReason.Unauthenticated,
    };
  }

  return { authenticated: true, user };
}

/**
 * Get the authenticated user only if the token is still valid (not expired).
 *
 * Thin wrapper over getAuthIdentity() for callers that only need the user and
 * do not care why validation failed.
 *
 * Returns null if:
 * - No credentials stored
 * - Token is expired and refresh fails
 * - JWT is malformed
 * - A configured API key is rejected
 */
export async function getValidAuthedUser(
  config: RuntimeAuthConfig
): Promise<AuthedUser | null> {
  const identity = await getAuthIdentity(config);
  return identity.authenticated ? identity.user : null;
}
