/**
 * Industry API key verification via /whoami endpoint.
 */

import {
  WhoamiResponseSchema,
  type WhoamiResponse,
} from '@industry/common/api/cli';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { AIRGAPPED_USER } from '../common/constants';
import { parseJsonResponse } from '../common/parse-response';

import type { AuthedUser, RuntimeAuthConfig } from '../common/types';

/**
 * Verify a Industry API key via /whoami endpoint.
 *
 * @param apiKey - The API key to verify (fk-...)
 * @returns Authenticated user info
 * @throws MetaError if verification fails
 */
export async function verifyApiKey(
  apiKey: string,
  config: RuntimeAuthConfig
): Promise<AuthedUser> {
  if (config.airgapEnabled) return AIRGAPPED_USER;

  const baseUrl = config.apiBaseUrl;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/cli/whoami`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    logWarn('INDUSTRY_API_KEY verification network failed', {
      reason: 'network',
      cause: error,
    });
    throw error;
  }

  const text = await response.text();

  if (!response.ok) {
    logWarn('INDUSTRY_API_KEY verification rejected', {
      statusCode: response.status,
    });
    throw new MetaError('API key verification failed', {
      statusCode: response.status,
      body: text,
    });
  }

  let data: WhoamiResponse;
  try {
    data = parseJsonResponse(text, WhoamiResponseSchema, 'whoami response');
  } catch (error) {
    logWarn('INDUSTRY_API_KEY verification parse failed', {
      reason: 'parse',
      cause: error,
    });
    throw error;
  }
  return {
    userId: data.userId,
    email: '',
    orgId: data.orgId,
    region: data.region,
  };
}
