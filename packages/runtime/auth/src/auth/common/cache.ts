/**
 * Unified user cache.
 *
 * Caches user info from both WorkOS JWT and API key auth.
 * Cache is keyed by token hash to auto-invalidate on token change.
 */

import { createHash } from 'crypto';

import { decodeJwt } from 'jose';

import {
  WhoamiResponseSchema,
  type WhoamiResponse,
} from '@industry/common/api/cli';
import { IndustryRegion } from '@industry/common/shared';
import { ACTIVE_ORGANIZATION_HEADER } from '@industry/drool-sdk-ext/protocol/drool';
import { logInfo, logWarn } from '@industry/logging';

import { AIRGAPPED_USER } from './constants';
import { parseJsonResponse } from './parse-response';
import { resolveCliApiBaseUrl } from './resolveCliApiBaseUrl';
import { WorkOSJwtPayloadSchema } from '../../credentials/schemas';
import { TokenSourceType } from '../../storage/common/enums';
import {
  getActiveOrganizationId,
  setActiveOrganizationId,
} from '../active-organization';
import { verifyApiKey } from '../api-key/verify';
import { getFreshTokenWithSource } from '../source';

import type { AuthedUser, RuntimeAuthConfig } from './types';
import type {
  TokenWithSource,
  WorkOSUserInfo,
} from '../../storage/common/types';

// Unified cache
interface UserCache {
  tokenHash: string;
  authedUser: AuthedUser;
  workosUser: WorkOSUserInfo | null; // null for API key auth
}

let cache: UserCache | null = null;

/**
 * Hash the token for cache keying. A prefix-based approach doesn't work because
 * JWTs share identical base64-encoded headers (e.g. {"alg":"RS256","typ":"JWT"})
 * so the first N characters are the same across all tokens from the same issuer.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Decode WorkOS user info from JWT.
 */
function decodeWorkOSUserFromJwt(token: string): {
  authedUser: AuthedUser;
  workosUser: WorkOSUserInfo;
} | null {
  try {
    const decoded = decodeJwt(token);
    const result = WorkOSJwtPayloadSchema.safeParse(decoded);

    if (!result.success) {
      logWarn('Invalid JWT payload structure', {
        error: new Error(result.error.message),
      });
      return null;
    }

    const payload = result.data;
    const now = new Date().toISOString();
    // Prefer external_org_id (our Firestore ID), fall back to org_id (WorkOS ID) for legacy tokens
    const orgId = payload.external_org_id ?? payload.org_id;

    return {
      authedUser: {
        userId: payload.sub,
        email: payload.email,
        orgId,
      },
      workosUser: {
        id: payload.sub,
        email: payload.email,
        firstName: payload.first_name,
        lastName: payload.last_name,
        emailVerified: payload.email_verified ?? false,
        profilePictureUrl: payload.profile_picture_url ?? null,
        organizationId: orgId ?? null,
        role: payload.role ?? null,
        createdAt: payload.created_at ?? now,
        updatedAt: payload.updated_at ?? now,
      },
    };
  } catch (error) {
    logWarn('Failed to decode JWT', { error });
    return null;
  }
}

/**
 * Fetch user info from Industry API for API key auth.
 */
async function fetchUserFromApi(
  token: string,
  config: RuntimeAuthConfig
): Promise<AuthedUser | null> {
  try {
    return await verifyApiKey(token, config);
  } catch (error) {
    logWarn('Failed to fetch user from API', { error });
    return null;
  }
}

/**
 * Best-effort GET /api/cli/whoami to read the org's residency region.
 *
 * Used for the WorkOS path because the JWT does not carry a region claim.
 * Errors are logged and swallowed; callers leave region undefined and
 * routing falls back to the default host until the next token rotation
 * forces a fresh populate.
 */
async function fetchRegionFromWhoami(
  token: string,
  config: RuntimeAuthConfig
): Promise<IndustryRegion | undefined> {
  if (config.airgapEnabled) return undefined;
  try {
    const baseUrl = resolveCliApiBaseUrl(
      config,
      cache?.authedUser.region ?? IndustryRegion.Global
    );
    const activeOrganizationId = await getActiveOrganizationId(config);
    const response = await fetch(`${baseUrl}/api/cli/whoami`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(activeOrganizationId && {
          [ACTIVE_ORGANIZATION_HEADER]: activeOrganizationId,
        }),
      },
    });
    if (!response.ok) {
      logWarn('[region] whoami returned non-OK while populating region', {
        statusCode: response.status,
      });
      return undefined;
    }
    const text = await response.text();
    const data: WhoamiResponse = parseJsonResponse(
      text,
      WhoamiResponseSchema,
      'whoami response'
    );
    if (data.orgId !== activeOrganizationId) {
      await setActiveOrganizationId(data.orgId, config);
    }
    return data.region;
  } catch (error) {
    logWarn('[region] Failed to populate region from whoami', {
      cause: error,
    });
    return undefined;
  }
}

function logResolvedRegion(
  region: IndustryRegion,
  config: RuntimeAuthConfig
): void {
  logInfo('[region] Resolved residency region', {
    region,
    baseUrl: resolveCliApiBaseUrl(config, region),
  });
}

/**
 * Get cached user for the given token, or populate cache if needed.
 *
 * `config` is required so the WorkOS branch can always run the eager
 * whoami populate. Without it, a first call from `getWorkOSUser`-style
 * paths would warm the cache with `region: undefined`, and the
 * tokenHash fast-path would then short-circuit later callers that DO
 * have config, permanently routing the session to the default host.
 */
export async function getCachedUser(
  tokenWithSource: TokenWithSource,
  config: RuntimeAuthConfig
): Promise<UserCache | null> {
  const { token, type } = tokenWithSource;
  const tokenHash = hashToken(token);

  // Return cached if token hasn't changed
  if (cache && cache.tokenHash === tokenHash) {
    return cache;
  }

  if (config.airgapEnabled) {
    cache = {
      tokenHash,
      authedUser: AIRGAPPED_USER,
      workosUser: null,
    };
    return cache;
  }

  // Populate cache based on auth type
  if (type === TokenSourceType.WorkOS) {
    // JWT auth - decode locally. The JWT carries no region claim, so
    // eagerly hit /whoami (best-effort) to pin region on the cache entry.
    // This is the one and only region resolution per token; if the eager
    // fetch fails, region stays undefined for the cache lifetime and
    // routing falls back to apiBaseUrl until the next token rotation
    // triggers a fresh populate.
    const decoded = decodeWorkOSUserFromJwt(token);
    if (!decoded) return null;

    cache = {
      tokenHash,
      authedUser: decoded.authedUser,
      workosUser: decoded.workosUser,
    };

    if (cache.authedUser.region === undefined) {
      const region = await fetchRegionFromWhoami(token, config);
      // Guard against the cache having been replaced (token rotation,
      // logout) while the fetch was in flight.
      if (region && cache && cache.tokenHash === tokenHash) {
        cache = {
          ...cache,
          authedUser: { ...cache.authedUser, region },
        };
        logResolvedRegion(region, config);
      }
    }
  } else {
    // API key - fetch from API. verifyApiKey hits /whoami, so region is
    // already threaded through into AuthedUser when the org has one.
    const authedUser = await fetchUserFromApi(token, config);
    if (!authedUser) return null;

    cache = {
      tokenHash,
      authedUser,
      workosUser: null, // Full user info not available for API keys
    };

    if (authedUser.region !== undefined) {
      logResolvedRegion(authedUser.region, config);
    }
  }

  return cache;
}

/**
 * Clear the user cache.
 */
export function clearUserCache(): void {
  cache = null;
}

/**
 * Sync read of the pinned residency region for the currently-authed user.
 *
 * Returns whatever `getCachedUser`'s populate path (eager whoami for
 * WorkOS, verifyApiKey for API key) wrote into the cache. Defaults to
 * `IndustryRegion.Global` if nothing has resolved yet or the org has no
 * region pinned. Use this in sync contexts (LLM SDK construction,
 * telemetry tagging) that can't await `getRegion(config)`.
 */
export function getCachedRegion(): IndustryRegion {
  return cache?.authedUser.region ?? IndustryRegion.Global;
}

/**
 * Resolve the org's residency region.
 *
 * Always returns a region — defaults to `IndustryRegion.Global` when the
 * org has none pinned in Firestore, when no auth is available, or when
 * the eager whoami populate inside `getCachedUser` failed. Callers can
 * pass the result straight into `resolveCliApiBaseUrl`.
 *
 * Triggers a `getCachedUser` populate when the cache is missing or pinned
 * to a different token (covers org-switch flows where
 * `refreshWithOrganization` rotates credentials without explicitly
 * refreshing the cache). That populate is the one and only region
 * resolution per token — there is no per-call retry. If whoami fails at
 * populate time, we route to the default host for the cache lifetime; a
 * subsequent token rotation will re-attempt resolution.
 */
export async function getRegion(
  config: RuntimeAuthConfig
): Promise<IndustryRegion> {
  const tokenWithSource = await getFreshTokenWithSource(config);
  if (!tokenWithSource) return IndustryRegion.Global;

  await getCachedUser(tokenWithSource, config);

  return cache?.authedUser.region ?? IndustryRegion.Global;
}

/**
 * Decode WorkOS user from token string (for immediate use after login).
 * Does not use cache - call getCachedUser for cached access.
 */
export function decodeWorkOSUser(accessToken: string): WorkOSUserInfo | null {
  const result = decodeWorkOSUserFromJwt(accessToken);
  return result?.workosUser ?? null;
}
