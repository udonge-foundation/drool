/**
 * WorkOS JWT verification using JWKS.
 */

import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { validateWorkOsJwt } from './verify-access-token';

import type { AuthedUser, RuntimeAuthConfig } from '../common/types';

/**
 * Cryptographically verify a WorkOS JWT using JWKS.
 * Uses jose's jwtVerify with WorkOS's public keys fetched from their JWKS endpoint.
 *
 * When TESTING_BYPASS_TOKEN_PASSWORD is set in the environment (e2e tests),
 * verification falls back to the bypass shared secret if JWKS fails.
 *
 * @param token - The JWT to verify
 * @returns Authenticated user info
 * @throws MetaError if verification fails
 */
export async function verifyWorkOSJwt(
  token: string,
  config?: RuntimeAuthConfig
): Promise<AuthedUser> {
  try {
    const bypassTokenPassword = config?.testingBypassTokenPassword;
    const payload = await validateWorkOsJwt({ token, bypassTokenPassword });

    if (!payload.external_org_id) {
      throw new MetaError('User is not affiliated with an organization', {
        userId: payload.sub,
      });
    }

    return {
      userId: payload.sub,
      email: payload.email || '',
      orgId: payload.external_org_id,
    };
  } catch (error) {
    logWarn('JWT verification failed (WorkOS token)', { error });
    throw new MetaError('Token verification failed', { cause: error });
  }
}
