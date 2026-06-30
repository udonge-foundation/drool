import { getRegion, resolveCliApiBaseUrl } from '@industry/runtime/auth';
import { AirgapBlockedError } from '@industry/utils/api';

import { getRuntimeAuthConfig } from '@/environment';

export async function fetchBackend(
  endpoint: string,
  init: RequestInit
): Promise<Response> {
  const config = getRuntimeAuthConfig();
  if (config.airgapEnabled) {
    throw new AirgapBlockedError(endpoint);
  }
  const region = await getRegion(config);
  const baseUrl = resolveCliApiBaseUrl(config, region);
  // eslint-disable-next-line no-restricted-globals
  return fetch(`${baseUrl}${endpoint}`, init);
}
