import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { getFlag } from '@industry/runtime/feature-flags';

export function isAutomationsFeatureEnabled(options?: {
  isAutomationsEnabled?: boolean;
}): boolean {
  return (
    options?.isAutomationsEnabled ??
    getFlag(IndustryFeatureFlags.SoftwareIndustry)
  );
}
