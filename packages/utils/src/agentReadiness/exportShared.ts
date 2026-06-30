import {
  READINESS_CATEGORIES,
  READINESS_CRITERIA,
} from '@industry/common/agentReadiness/constants';

import { CriterionStatus } from './enums';
import { getCriterionStatus, getEvaluationRatio } from './utils';

import type { CategoryExportData } from './types';
import type { ReadinessCategoryId } from '@industry/common/agentReadiness/enums';
import type { IndustryAgentReadinessReport } from '@industry/common/agentReadiness/types';

export function getLevelDifficulty(level: number): string {
  switch (level) {
    case 1:
      return 'Basic';
    case 2:
      return 'Intermediate';
    case 3:
    case 4:
    case 5:
      return 'Advanced';
    default:
      return 'Basic';
  }
}

export function getStatusLabel(status: CriterionStatus): string {
  switch (status) {
    case CriterionStatus.Passed:
      return 'Passed';
    case CriterionStatus.Failed:
      return 'Failed';
    case CriterionStatus.Skipped:
      return 'Skipped';
    default:
      return 'Unknown';
  }
}

export function getCategoryDisplayName(
  categoryId: ReadinessCategoryId
): string {
  const category = READINESS_CATEGORIES.find((c) => c.id === categoryId);
  return category?.name || categoryId;
}

export function computeCategoriesData(
  report: IndustryAgentReadinessReport
): CategoryExportData[] {
  const criteriaByCategory = READINESS_CRITERIA.reduce(
    (acc, criterion) => {
      if (!acc[criterion.category]) acc[criterion.category] = [];
      acc[criterion.category].push(criterion);
      return acc;
    },
    {} as Record<ReadinessCategoryId, typeof READINESS_CRITERIA>
  );

  return READINESS_CATEGORIES.map((category) => {
    const criteria = criteriaByCategory[category.id] || [];

    const criteriaWithEvaluations = criteria.map((criterion) => {
      const evaluation = report.report[criterion.id];
      const status = evaluation
        ? getCriterionStatus(evaluation)
        : CriterionStatus.Failed;
      return { criterion, evaluation, status };
    });

    let ratioSum = 0;
    let signalCount = 0;
    for (const { evaluation, status } of criteriaWithEvaluations) {
      if (status === CriterionStatus.Skipped) continue;
      const ratio = getEvaluationRatio(evaluation);
      if (ratio !== null) {
        ratioSum += ratio;
        signalCount++;
      }
    }
    const percentage =
      signalCount > 0 ? Math.round((ratioSum / signalCount) * 100) : 0;

    const mappedCriteria = criteriaWithEvaluations
      .map(({ criterion, evaluation, status }) => ({
        id: criterion.id,
        name: criterion.name,
        description: criterion.description,
        score: evaluation
          ? evaluation.numerator === null
            ? 'N/A'
            : `${evaluation.numerator}/${evaluation.denominator}`
          : 'N/A',
        status,
        level: criterion.level,
        difficulty: getLevelDifficulty(criterion.level),
        rationale: evaluation?.rationale,
        percentage: getEvaluationRatio(evaluation) ?? 0,
      }))
      .sort((a, b) => {
        if (
          a.status === CriterionStatus.Skipped &&
          b.status !== CriterionStatus.Skipped
        )
          return 1;
        if (
          a.status !== CriterionStatus.Skipped &&
          b.status === CriterionStatus.Skipped
        )
          return -1;
        return a.percentage - b.percentage;
      });

    return {
      categoryId: category.id,
      categoryName: category.name,
      percentage,
      criteria: mappedCriteria,
    };
  });
}
