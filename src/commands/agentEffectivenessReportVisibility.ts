import { fetch } from '@industry/drool-core/api/fetch';

import { getIndustryApiConfig } from '@/api/config';

interface CurrentUserContextResponse {
  capabilities?: {
    canViewAgentEffectivenessReport?: boolean;
  };
}

export async function getAgentEffectivenessReportVisibility(): Promise<boolean> {
  try {
    const response = await fetch(
      '/api/app/auth/me',
      undefined,
      getIndustryApiConfig()
    );
    const currentUser = (await response.json()) as CurrentUserContextResponse;
    return currentUser.capabilities?.canViewAgentEffectivenessReport ?? false;
  } catch {
    return false;
  }
}
