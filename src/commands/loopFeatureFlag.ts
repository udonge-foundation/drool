import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { getFlag } from '@industry/runtime/feature-flags';

export function isLoopFeatureEnabled(options?: {
  industryEnv?: string;
  isLoopEnabled?: boolean;
}): boolean {
  if ((options?.industryEnv ?? process.env.INDUSTRY_ENV) === 'development') {
    return true;
  }
  return options?.isLoopEnabled ?? getFlag(IndustryFeatureFlags.LoopCommand);
}
