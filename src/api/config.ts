import { ClientType } from '@industry/common/shared';
import { IndustryApiConfig } from '@industry/drool-core/api/types';
import {
  ACTIVE_ORGANIZATION_HEADER,
  INDUSTRY_CLIENT_HEADER,
  INDUSTRY_CLIENT_VERSION,
} from '@industry/drool-sdk-ext/protocol/drool';
import { EnvironmentVariable } from '@industry/environment';
import * as runtimeAuth from '@industry/runtime/auth';

import { getRuntimeAuthConfig, getEnv } from '@/environment';

// When the daemon spawns a worker process on behalf of a web-desktop or
// web-app connection, it sets INDUSTRY_UPSTREAM_CLIENT_TYPE so the worker
// sends the correct X-Industry-Client header to the backend.
const clientType =
  (process.env[EnvironmentVariable.INDUSTRY_UPSTREAM_CLIENT_TYPE] as
    | ClientType
    | undefined) ?? ClientType.CLI;
const CLIENT_HEADER = { [INDUSTRY_CLIENT_HEADER]: clientType };

// Send the installed CLI version so the backend can version-gate feature flags
// via Statsig. Omitted when unset so we never send a non-semver value.
const CLIENT_VERSION_HEADER: Record<string, string> = process.env.CLI_VERSION
  ? { [INDUSTRY_CLIENT_VERSION]: process.env.CLI_VERSION }
  : {};

/**
 * Client headers with auth when available, never throws.
 * Always includes the client-type header. Includes Authorization when logged in.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const runtimeAuthConfig = getRuntimeAuthConfig();
  const token = await runtimeAuth.getAuthToken(runtimeAuthConfig);
  const activeOrganizationId =
    (await runtimeAuth.getActiveOrganizationId?.(runtimeAuthConfig)) ?? null;

  if (token) {
    return {
      Authorization: `Bearer ${token}`,
      ...CLIENT_HEADER,
      ...CLIENT_VERSION_HEADER,
      ...(activeOrganizationId && {
        [ACTIVE_ORGANIZATION_HEADER]: activeOrganizationId,
      }),
    };
  }

  return {
    ...CLIENT_HEADER,
    ...CLIENT_VERSION_HEADER,
    ...(activeOrganizationId && {
      [ACTIVE_ORGANIZATION_HEADER]: activeOrganizationId,
    }),
  };
}

/**
 * Client headers with auth required, throws AuthenticationError if no token.
 * Use this when authentication is mandatory (LLM proxy, session API, bug reports).
 */
export async function getAuthHeadersOrThrow(): Promise<Record<string, string>> {
  const runtimeAuthConfig = getRuntimeAuthConfig();
  const token = await runtimeAuth.getAuthTokenOrThrow(runtimeAuthConfig);
  const activeOrganizationId =
    (await runtimeAuth.getActiveOrganizationId?.(runtimeAuthConfig)) ?? null;
  return {
    Authorization: `Bearer ${token}`,
    ...CLIENT_HEADER,
    ...CLIENT_VERSION_HEADER,
    ...(activeOrganizationId && {
      [ACTIVE_ORGANIZATION_HEADER]: activeOrganizationId,
    }),
  };
}

export function getIndustryApiConfig(): IndustryApiConfig {
  return {
    baseUrl: getEnv().apiBaseUrl,
    getBaseUrl: async () => {
      const runtimeAuthConfig = getRuntimeAuthConfig();
      const region = await runtimeAuth.getRegion(runtimeAuthConfig);
      return runtimeAuth.resolveCliApiBaseUrl(runtimeAuthConfig, region);
    },
    getHeaders: getAuthHeaders,
    airgapEnabled: () => getRuntimeAuthConfig().airgapEnabled === true,
  };
}
