import { formatTokenCount } from '../usage';

import type { TokenUsage } from '@industry/common/session/settings';

type MissionIndustryStandardCreditsInput =
  | Partial<TokenUsage>
  | null
  | undefined;

function getMissionIndustryStandardCredits(
  tokenUsage: MissionIndustryStandardCreditsInput
): number {
  return tokenUsage?.industryCredits ?? 0;
}

export function formatMissionIndustryStandardCredits(
  tokenUsage: MissionIndustryStandardCreditsInput
): string {
  return formatTokenCount(getMissionIndustryStandardCredits(tokenUsage));
}
