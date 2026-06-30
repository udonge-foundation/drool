/**
 * Device code login flow for CLI.
 *
 * This implements the OAuth 2.0 Device Authorization Grant flow for CLI apps
 * that can't easily handle browser redirects.
 */

import { MetaError } from '@industry/logging/errors';
import { sleep } from '@industry/utils/time';

import { getWorkOSApiBaseUrl } from '../base-url';
import { getWorkOSClientId } from '../constants';
import {
  DeviceAuthorizationResponseSchema,
  PollingErrorResponseSchema,
  TokenResponseSchema,
} from './schemas';
import { getCredentialsStorage } from '../../../credentials/CredentialsStorage';
import { TokenSourceType } from '../../../storage/common/enums';
import { getCachedUser } from '../../common/cache';
import { parseJsonResponse } from '../../common/parse-response';

import type { DeviceAuthorizationResponse, DeviceCodeStatus } from './types';
import type { RuntimeAuthConfig } from '../../common/types';

/**
 * Request device authorization from WorkOS.
 *
 * This is also used by ACPAdapter to get a device code to display
 * before the full login flow is started.
 */
export async function requestDeviceAuthorization(
  config?: RuntimeAuthConfig
): Promise<DeviceAuthorizationResponse> {
  const response = await fetch(
    `${getWorkOSApiBaseUrl(config)}/authorize/device`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: getWorkOSClientId(),
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new MetaError('Failed to request device authorization', {
      errorMessage: errorText,
    });
  }

  const text = await response.text();
  return parseJsonResponse(
    text,
    DeviceAuthorizationResponseSchema,
    'device authorization response'
  );
}

/**
 * Poll for tokens after user has authenticated.
 */
async function pollForTokens(
  deviceCode: string,
  expiresIn: number,
  initialInterval: number,
  onStatus: (status: DeviceCodeStatus) => void,
  config?: RuntimeAuthConfig
): Promise<{ access_token: string; refresh_token: string }> {
  const timeout = AbortSignal.timeout(expiresIn * 1000);
  let interval = initialInterval;

  while (true) {
    onStatus({ type: 'polling' });

    const response = await fetch(
      `${getWorkOSApiBaseUrl(config)}/authenticate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: getWorkOSClientId(),
        }),
        signal: timeout,
      }
    );

    const text = await response.text();

    if (response.ok) {
      return parseJsonResponse(text, TokenResponseSchema, 'token response');
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new MetaError('Failed to parse polling response', {
        body: text,
        cause: err,
      });
    }
    const errorResult = PollingErrorResponseSchema.safeParse(json);
    const errorCode = errorResult.success ? errorResult.data.error : 'unknown';

    switch (errorCode) {
      case 'authorization_pending':
        await sleep(interval * 1000);
        break;

      case 'slow_down':
        interval += 1;
        onStatus({ type: 'slow_down', newInterval: interval });
        await sleep(interval * 1000);
        break;

      case 'access_denied':
      case 'expired_token':
        throw new MetaError('Authorization failed or expired');

      default:
        throw new MetaError('Authorization failed', {
          errorMessage: errorCode,
        });
    }
  }
}

/**
 * Login using the device code flow.
 *
 * Usage:
 * ```typescript
 * const flow = loginWithDeviceCode(config);
 * for await (const status of flow) {
 *   if (status.type === 'pending') {
 *     console.log(`Go to: ${status.verificationUri}`);
 *     console.log(`Enter code: ${status.userCode}`);
 *   }
 * }
 * // flow completes with AuthToken
 * ```
 *
 * @yields DeviceCodeStatus updates during the flow
 * @returns Bearer token string when login completes
 */
export async function* loginWithDeviceCode(
  config?: RuntimeAuthConfig,
  existingAuth?: DeviceAuthorizationResponse
): AsyncGenerator<DeviceCodeStatus, string, undefined> {
  const auth = existingAuth ?? (await requestDeviceAuthorization(config));

  // Yield initial pending status with user code
  yield {
    type: 'pending',
    userCode: auth.user_code,
    verificationUri: auth.verification_uri,
    verificationUriComplete: auth.verification_uri_complete,
    expiresIn: auth.expires_in,
    interval: auth.interval,
  };

  // Collector for status updates during polling
  const statusUpdates: DeviceCodeStatus[] = [];
  const onStatus = (status: DeviceCodeStatus) => {
    statusUpdates.push(status);
  };

  // Start polling in background
  const tokenPromise = pollForTokens(
    auth.device_code,
    auth.expires_in,
    auth.interval,
    onStatus,
    config
  );

  // Yield status updates as they come in
  // Check every 100ms for new updates while polling continues
  while (true) {
    // Check if polling completed
    const result = await Promise.race([
      tokenPromise.then((t) => ({ done: true as const, tokens: t })),
      sleep(100).then(() => ({ done: false as const })),
    ]);

    // Yield any accumulated status updates
    while (statusUpdates.length > 0) {
      yield statusUpdates.shift()!;
    }

    if (result.done) {
      // Save credentials (new login → always use v2 format)
      const storage = getCredentialsStorage({
        disableKeyring: config?.disableKeyring,
      });
      await storage.save(
        {
          access_token: result.tokens.access_token,
          refresh_token: result.tokens.refresh_token,
        },
        { forceNew: true }
      );

      // Warm the user cache + region pin so sync getCachedRegion() readers
      // (LLM SDK construction, telemetry tags) see the right region from
      // the user's very first action post-login. Best-effort: a missing
      // config or a failing whoami leaves region undefined and routing
      // falls back to the default host until the next token rotation.
      if (config) {
        await getCachedUser(
          {
            type: TokenSourceType.WorkOS,
            token: result.tokens.access_token,
          },
          config
        );
      }

      return result.tokens.access_token;
    }
  }
}
