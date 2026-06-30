import { jwtVerify } from 'jose';

import { logInfo, logWarn } from '@industry/logging';
import { ResponseError503ServiceUnavailable } from '@industry/logging/errors';
import { getWorkOSJWKS } from '@industry/utils/auth/workosJwks';

import { getWorkOSClientId } from './constants';

import type {
  ValidateWorkOsJwtParams,
  WorkOSTokenPayload,
} from '@industry/common/workos';

/**
 * Verifies a WorkOS access token and returns the raw payload.
 *
 * When a bypassTokenPassword is provided, it first attempts verification using
 * that secret (for tests); on failure it falls back to JWKS verification.
 */
export async function validateWorkOsJwt({
  token,
  bypassTokenPassword,
}: ValidateWorkOsJwtParams): Promise<WorkOSTokenPayload> {
  if (bypassTokenPassword) {
    const secret = new TextEncoder().encode(bypassTokenPassword);
    try {
      const { payload } = await jwtVerify<WorkOSTokenPayload>(token, secret);
      logInfo('Using test bypass token verification');
      return payload;
    } catch (error) {
      logWarn('Bypass token verification failed, falling back to JWKS', {
        cause: error,
      });
    }
  }

  try {
    const jwks = getWorkOSJWKS({ clientId: getWorkOSClientId() });
    const { payload } = await jwtVerify<WorkOSTokenPayload>(token, jwks);
    return payload;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Request timeout')) {
      throw new ResponseError503ServiceUnavailable(
        'WorkOS JWKS request timed out. Try again later.',
        { cause: error }
      );
    }
    throw error;
  }
}
