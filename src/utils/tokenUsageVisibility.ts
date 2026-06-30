import { IndustryTier } from '@industry/common/organization';

import { getSettingsService } from '@/services/SettingsService';

/**
 * Returns true if Industry Standard Credits / token usage should be shown for
 * the current user. Only shown for enterprise organizations (ENTERPRISE or
 * PAYG_ENTERPRISE); self-serve users (team, pro, max, etc.) should not see it.
 */
export function canViewTokenUsage(): boolean {
  const tier = getSettingsService().getOrgTier();
  return (
    tier === IndustryTier.ENTERPRISE || tier === IndustryTier.PAYG_ENTERPRISE
  );
}
