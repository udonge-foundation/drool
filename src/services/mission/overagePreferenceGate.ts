import type { OveragePreferenceStatus } from '@/services/TokenLimitService';

const MISSIONS_REQUIRE_OVERAGE_PREFERENCE_MESSAGE =
  'Missions cannot be used until you select an overage preference in billing settings, accessible via `/limits`';
const MISSIONS_OVERAGE_PROBE_FAILED_MESSAGE =
  "Unable to verify your organization's overage preference. Please retry; if the issue persists, contact your admin.";
const MISSIONS_OVERAGE_NETWORK_FAILED_MESSAGE =
  'Unable to reach Industry to verify mission access. This may be a temporary network issue; please retry.';

export function getMissionOveragePreferenceBlockMessage(
  overageStatus: OveragePreferenceStatus
): string | null {
  if (overageStatus.type === 'not-set') {
    return MISSIONS_REQUIRE_OVERAGE_PREFERENCE_MESSAGE;
  }
  if (overageStatus.type === 'error') {
    return MISSIONS_OVERAGE_PROBE_FAILED_MESSAGE;
  }
  if (overageStatus.type === 'network-error') {
    return MISSIONS_OVERAGE_NETWORK_FAILED_MESSAGE;
  }
  return null;
}
