/**
 * WorkOS token refresh logic.
 */

import { MetaError } from '@industry/logging/errors';
import { isNonRetryableHttpStatus } from '@industry/utils/api';

import { getWorkOSApiBaseUrl } from './base-url';
import { getWorkOSClientId } from './constants';
import { TokenRefreshError } from './errors';
import { TokenResponseSchema } from './login/schemas';
import { getCredentialsStorage } from '../../credentials/CredentialsStorage';
import { TokenSourceType } from '../../storage/common/enums';
import { getCachedUser } from '../common/cache';
import { parseJsonResponse } from '../common/parse-response';

import type { StoredCredentials } from '../../storage/common/types';
import type { RuntimeAuthConfig } from '../common/types';

/**
 * Refresh a WorkOS access token using a refresh token.
 *
 * @param refreshToken The refresh token to use
 * @param organizationId Optional organization ID for org-scoped tokens
 * @returns New access and refresh tokens
 * @throws TokenRefreshError on failure (permanent for 400/401, transient for 5xx/network)
 */
export async function refreshWorkOSToken(
  refreshToken: string,
  organizationId?: string,
  config?: RuntimeAuthConfig
): Promise<StoredCredentials> {
  let response: Response;
  try {
    response = await fetch(`${getWorkOSApiBaseUrl(config)}/authenticate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: getWorkOSClientId(),
        ...(organizationId ? { organization_id: organizationId } : {}),
      }),
    });
  } catch (error) {
    throw new TokenRefreshError('Network error during token refresh', false, {
      cause: error,
    });
  }

  if (!response.ok) {
    const errorText = await response.text();
    // 4xx except 429 = permanent (invalid_grant, session expired, token revoked)
    const permanent = isNonRetryableHttpStatus(response.status);
    throw new TokenRefreshError('Failed to refresh access token', permanent, {
      errorMessage: errorText,
      statusCode: response.status,
    });
  }

  const text = await response.text();
  try {
    return parseJsonResponse(
      text,
      TokenResponseSchema,
      'token refresh response'
    );
  } catch (error) {
    throw new TokenRefreshError(
      error instanceof Error ? error.message : 'Invalid token refresh response',
      true,
      { cause: error }
    );
  }
}

/**
 * Refresh the access token scoped to a specific organization.
 *
 * This is used for organization switching in Desktop/Web apps.
 * The new credentials are automatically saved to storage.
 *
 * @param organizationId The organization to switch to
 * @returns The new access token
 * @throws MetaError if no refresh token is available or refresh fails
 */
export async function refreshWithOrganization(
  organizationId: string,
  config?: RuntimeAuthConfig
): Promise<string> {
  const storage = getCredentialsStorage({
    disableKeyring: config?.disableKeyring,
  });
  const credentials = await storage.load();

  if (!credentials?.refresh_token) {
    throw new MetaError('No refresh token available for organization switch');
  }

  const newCredentials = await refreshWorkOSToken(
    credentials.refresh_token,
    organizationId,
    config
  );

  await storage.save({
    ...newCredentials,
    // `organizationId` is a WorkOS org ID for token scoping, while
    // `active_organization_id` stores the Firestore org ID used by
    // X-Industry-Org-Id. Clear it until whoami resolves the Firestore org.
    active_organization_id: null,
  });

  // Warm the user cache + region pin for the new org so sync
  // getCachedRegion() readers see the new org's region from the user's
  // very first action post-switch. The new token's hash mismatches the
  // cached entry, so getCachedUser re-populates (including a fresh
  // eager whoami) rather than short-circuiting on the stale cache.
  if (config) {
    await getCachedUser(
      { type: TokenSourceType.WorkOS, token: newCredentials.access_token },
      config
    );
  }

  return newCredentials.access_token;
}
