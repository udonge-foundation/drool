import { IndustryRegion } from '@industry/common/shared';

import type { RuntimeAuthConfig } from './types';

/**
 * Resolve the backend API base URL the CLI should hit for the given region.
 *
 * Falls back to the global `apiBaseUrl` when the region is not EU or when
 * no EU URL is configured.
 */
export function resolveCliApiBaseUrl(
  config: Pick<RuntimeAuthConfig, 'apiBaseUrl' | 'apiBaseUrlEu'>,
  region: IndustryRegion
): string {
  return (
    (region === IndustryRegion.Eu && config.apiBaseUrlEu) || config.apiBaseUrl
  );
}
