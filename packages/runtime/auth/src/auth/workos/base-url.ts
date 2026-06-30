import type { RuntimeAuthConfig } from '../common/types';

const DEFAULT_WORKOS_API_BASE_URL = 'https://api.workos.com/user_management';

export function getWorkOSApiBaseUrl(config?: RuntimeAuthConfig): string {
  return config?.workosBaseUrl ?? DEFAULT_WORKOS_API_BASE_URL;
}
