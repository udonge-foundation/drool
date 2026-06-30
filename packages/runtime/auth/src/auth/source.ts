/**
 * Token source resolution - dispatches to WorkOS or API key provider.
 */

import { logInfo, logWarn } from '@industry/logging';
import { sleep } from '@industry/utils/time';

import { getCredentialsStorage } from '../credentials/CredentialsStorage';
import { AIRGAPPED_TOKEN } from './common/constants';
import { isTokenExpired } from './common/utils';
import { TokenRefreshError } from './workos/errors';
import { refreshWorkOSToken } from './workos/refresh';
import { TokenSourceType } from '../storage/common/enums';

import type { RuntimeAuthConfig } from './common/types';
import type { TokenWithSource } from '../storage/common/types';

const AIRGAPPED_TOKEN_WITH_SOURCE: TokenWithSource = {
  type: TokenSourceType.ApiKey,
  token: AIRGAPPED_TOKEN,
};

const TRANSIENT_RETRY_COUNT = 3;
const TRANSIENT_RETRY_BASE_DELAY_MS = 500;
/**
 * The refresh token that permanently failed. If load() returns the same
 * refresh token, we short-circuit to null. If load() returns a different
 * one (file changed on disk, detected via mtime), we try again.
 */
let deadRefreshToken: string | null = null;

/**
 * Get the current authentication token with its source (no refresh).
 *
 * Priority:
 * 1. INDUSTRY_API_KEY env var -> api-key (overrides any stored WorkOS session)
 * 2. auth.v2.<keysource> file -> workos (returns as-is, even if expired)
 *
 * A configured INDUSTRY_API_KEY always wins (CLI-135): it is how users expect an
 * explicit env-var override to behave, and it stops a stored WorkOS session
 * that later expires from shadowing the durable key and stranding a computer.
 *
 * Use this when you need to read token/credentials without triggering refresh
 * (e.g., for decoding JWT claims which don't change on refresh).
 *
 * @returns Token with source type, or null if not authenticated
 */
export async function getTokenWithSource(
  config: RuntimeAuthConfig
): Promise<TokenWithSource | null> {
  if (config.airgapEnabled) {
    return AIRGAPPED_TOKEN_WITH_SOURCE;
  }

  // 1. A configured API key overrides any stored WorkOS session.
  const apiKey = config.apiKey?.trim();
  if (apiKey) {
    return { type: TokenSourceType.ApiKey, token: apiKey };
  }

  // 2. Load WorkOS credentials from storage (mtime-cached — returns fresh
  // data if the file changed on disk).
  const storage = getCredentialsStorage({
    disableKeyring: config.disableKeyring,
  });
  const credentials = await storage.load();

  if (credentials) {
    return { type: TokenSourceType.WorkOS, token: credentials.access_token };
  }

  logWarn(
    'No authentication credentials available (storage empty, no API key)'
  );
  return null;
}

/**
 * Get a fresh (non-expired) authentication token with its source.
 *
 * Same as getTokenWithSource() but auto-refreshes expired WorkOS tokens.
 * Use this when you need a valid token for API calls.
 *
 * Refresh behavior:
 * - Transient failures (5xx, network): retries up to 3 times with backoff
 * - Permanent failures (400/401): remembers the failed refresh token,
 *   short-circuits future calls until credentials change on disk
 *
 * A configured INDUSTRY_API_KEY takes priority over WorkOS (see
 * getTokenWithSource), so the refresh path below only runs when no API key is
 * set; an expired session that cannot be refreshed resolves to null.
 *
 * @returns Token with source type, or null if not authenticated
 */
export async function getFreshTokenWithSource(
  config: RuntimeAuthConfig
): Promise<TokenWithSource | null> {
  if (config.airgapEnabled) {
    return AIRGAPPED_TOKEN_WITH_SOURCE;
  }

  const tokenWithSource = await getTokenWithSource(config);
  if (!tokenWithSource) return null;

  // API keys are always valid - no refresh needed
  if (tokenWithSource.type === TokenSourceType.ApiKey) {
    return tokenWithSource;
  }

  // WorkOS token - check if refresh needed
  if (!isTokenExpired(tokenWithSource.token)) {
    return tokenWithSource;
  }

  // Token is expired — need to refresh
  const storage = getCredentialsStorage({
    disableKeyring: config.disableKeyring,
  });
  const credentials = await storage.load();
  if (!credentials) {
    return null;
  }

  // Short-circuit if this refresh token already failed permanently
  if (deadRefreshToken && credentials.refresh_token === deadRefreshToken) {
    return null;
  }

  // Capture source and encryption key BEFORE refresh starts.
  // This prevents a race where /login changes the storage state mid-refresh,
  // causing refreshed credentials to be written to the wrong file.
  const sourceAtRefreshStart = storage.getSource();
  const encryptionKeyAtRefreshStart = storage.getEncryptionKey();

  logInfo('WorkOS access token expired; refreshing');

  for (let attempt = 1; attempt <= TRANSIENT_RETRY_COUNT; attempt++) {
    try {
      const refreshed = await refreshWorkOSToken(
        credentials.refresh_token,
        undefined,
        config
      );
      await storage.save(
        {
          ...refreshed,
          active_organization_id: credentials.active_organization_id,
        },
        {
          sourceOverride: sourceAtRefreshStart ?? undefined,
          encryptionKeyOverride: encryptionKeyAtRefreshStart ?? undefined,
        }
      );
      deadRefreshToken = null;
      return { type: TokenSourceType.WorkOS, token: refreshed.access_token };
    } catch (error) {
      if (error instanceof TokenRefreshError && error.permanent) {
        logWarn('WorkOS token refresh failed permanently', {
          cause: error,
          reason: 'session_expired_or_token_revoked',
        });
        deadRefreshToken = credentials.refresh_token;
        return null;
      }

      // Transient failure — retry with backoff
      logWarn('WorkOS token refresh failed transiently', {
        error,
        attempt,
        count: TRANSIENT_RETRY_COUNT,
      });

      if (attempt < TRANSIENT_RETRY_COUNT) {
        await sleep(TRANSIENT_RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }

  return null;
}
