import { getAuthHeadersOrThrow } from '@/api/config';
import { fetchBackend } from '@/api/fetchBackend';

import type { AgentEffectivenessReportEntitlementResponse } from '@industry/common/api/agent-effectiveness';

const AGENT_EFFECTIVENESS_USAGE_ENDPOINT =
  '/api/organization/agent-effectiveness/usage';

export async function getAgentEffectivenessReportEntitlement(): Promise<AgentEffectivenessReportEntitlementResponse> {
  let headers: Record<string, string>;
  try {
    headers = await getAuthHeadersOrThrow();
  } catch {
    throw new Error('AUTH_REQUIRED');
  }

  const response = await fetchBackend(AGENT_EFFECTIVENESS_USAGE_ENDPOINT, {
    headers,
  });

  if (response.status === 401) {
    throw new Error('AUTH_REQUIRED');
  }

  if (!response.ok) {
    throw new Error('FEATURE_UNAVAILABLE');
  }

  const entitlement =
    (await response.json()) as AgentEffectivenessReportEntitlementResponse;

  if (!entitlement.enabled) {
    throw new Error('FEATURE_UNAVAILABLE');
  }

  return entitlement;
}
