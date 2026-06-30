/**
 * Resolve organization membership for a user whose JWT is missing orgId.
 *
 * Calls GET /api/cli/org which uses the WorkOS admin API to look up
 * the user's org memberships server-side.
 */

import { z } from 'zod';

import { logWarn } from '@industry/logging';

import { parseJsonResponse } from './common/parse-response';
import { refreshWithOrganization } from './workos/refresh';

import type { RuntimeAuthConfig } from './common/types';

const OrgResponseSchema = z.object({
  workosOrgIds: z.array(z.string()),
});

/**
 * Check if the user belongs to an organization by querying the backend.
 * If an org is found, refreshes the token so the JWT includes the org claim.
 *
 * @param token - The current bearer token
 * @returns The org's WorkOS ID if found, or null if the user has no org
 */
export async function resolveOrganization(
  token: string,
  config: RuntimeAuthConfig
): Promise<string | null> {
  try {
    const baseUrl = config.apiBaseUrl;
    const response = await fetch(`${baseUrl}/api/cli/org`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      logWarn('Org membership check returned non-OK status', {
        statusCode: response.status,
      });
      return null;
    }

    const text = await response.text();
    const result = parseJsonResponse(text, OrgResponseSchema, 'org response');
    if (result.workosOrgIds.length > 0) {
      await refreshWithOrganization(result.workosOrgIds[0], config);
      return result.workosOrgIds[0];
    }
  } catch (error) {
    logWarn('Failed to resolve org membership', { error });
  }

  return null;
}
