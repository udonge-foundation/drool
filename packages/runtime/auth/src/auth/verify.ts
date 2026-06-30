/**
 * Token verification - dispatches to WorkOS or API key provider.
 */

import { INDUSTRY_API_KEY_PREFIX } from '@industry/common/industryApiKeys/constants';

import { verifyApiKey } from './api-key/verify';
import { AIRGAPPED_USER } from './common/constants';
import { verifyWorkOSJwt } from './workos/verify';

import type { AuthedUser, RuntimeAuthConfig } from './common/types';

/**
 * Verify any token and return authenticated user info.
 *
 * - INDUSTRY_API_KEY (fk-...): Verified via /whoami endpoint
 * - WorkOS JWT: Cryptographically verified using WorkOS JWKS (public keys)
 *
 * @param token - The token to verify (API key or JWT)
 * @returns Authenticated user info
 * @throws MetaError if verification fails
 */
export async function verifyToken(
  token: string,
  config: RuntimeAuthConfig
): Promise<AuthedUser> {
  if (config.airgapEnabled) return AIRGAPPED_USER;

  if (token.startsWith(INDUSTRY_API_KEY_PREFIX)) {
    return verifyApiKey(token, config);
  }
  return verifyWorkOSJwt(token, config);
}
