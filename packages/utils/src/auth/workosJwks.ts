import { createRemoteJWKSet } from 'jose';

// Cache for JWKS instances by client ID
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

interface GetWorkOSJWKSOptions {
  /**
   * WorkOS client ID identifying which JWKS endpoint to fetch. Callers
   * resolve this from their own seeded WorkOS config.
   */
  clientId: string;
  /**
   * Timeout duration in milliseconds for JWKS fetching
   * @default 5000 (5 seconds)
   */
  timeoutDuration?: number;
  /**
   * Maximum age in milliseconds to cache the JWKS
   * @default 3600000 (1 hour)
   */
  cacheMaxAge?: number;
}

/**
 * Get or create a cached JWKS instance for WorkOS token validation
 *
 * @param options - Configuration options for JWKS fetching
 * @returns A cached JWKS instance for jwt verification
 *
 * @example
 * ```ts
 * const jwks = getWorkOSJWKS({ clientId });
 * const { payload } = await jwtVerify(token, jwks);
 * ```
 */
export function getWorkOSJWKS(
  options: GetWorkOSJWKSOptions
): ReturnType<typeof createRemoteJWKSet> {
  const { clientId, timeoutDuration = 5000, cacheMaxAge = 3600000 } = options;

  // Check cache first
  const cached = jwksCache.get(clientId);
  if (cached) {
    return cached;
  }

  // Create new JWKS instance
  const jwksUrl = `https://api.workos.com/sso/jwks/${clientId}`;
  const jwks = createRemoteJWKSet(new URL(jwksUrl), {
    timeoutDuration,
    cacheMaxAge,
  });

  // Cache it
  jwksCache.set(clientId, jwks);

  return jwks;
}
