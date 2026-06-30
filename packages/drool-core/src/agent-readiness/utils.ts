import { READINESS_CRITERIA } from '@industry/common/agentReadiness/constants';
import { ReadinessCriterionScope } from '@industry/common/agentReadiness/enums';
import { ReadinessCriterion } from '@industry/common/agentReadiness/types';

export function getCriteriaByScope(
  scope: ReadinessCriterionScope
): ReadinessCriterion[] {
  return READINESS_CRITERIA.filter((c) => c.scope === scope);
}
