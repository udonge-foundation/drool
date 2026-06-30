import { QUALITY_THRESHOLD } from './constants';

import type {
  CandidateModel,
  CandidateScore,
  ClassifierResult,
  ClassifierSignals,
  ModelOption,
  ModelSelector,
  ScoredCandidate,
} from './types';

/** Drops scores that reference a modelId not in the catalog. */
function joinScores(
  candidates: readonly CandidateModel[],
  scores: readonly CandidateScore[]
): ScoredCandidate[] {
  const byId = new Map(scores.map((s) => [s.modelId, s.score] as const));
  return candidates.map((candidate) => ({
    candidate,
    score: byId.get(candidate.modelId) ?? 0,
  }));
}

function toOption(
  scored: ScoredCandidate,
  rank: number,
  rationale: string
): ModelOption {
  return {
    modelId: scored.candidate.modelId,
    apiProvider: scored.candidate.apiProvider,
    reasoningEffort: scored.candidate.reasoningEffort,
    rank,
    rationale,
    score: scored.score,
  };
}

/**
 * Caller must hand over a policy-allowed candidate so the agent
 * never lands on an out-of-policy model on a fallback path.
 */
export function buildFallbackOptions(
  reason: string,
  fallback: CandidateModel
): ModelOption[] {
  return [
    {
      modelId: fallback.modelId,
      apiProvider: fallback.apiProvider,
      reasoningEffort: fallback.reasoningEffort,
      rank: 0,
      rationale: reason,
    },
  ];
}

/**
 *  1. Viable (score ≥ QUALITY_THRESHOLD) → pick lowest input cost;
 *     cost ties broken by score (higher wins), then by list order.
 *  2. Otherwise → pick highest score, list order for ties.
 *  3. Remaining candidates become fallbacks (best-score first).
 */
function selectPrimary(
  scored: readonly ScoredCandidate[]
): { primary: ScoredCandidate; fallbacks: ScoredCandidate[] } | undefined {
  if (scored.length === 0) return undefined;

  const viable = scored.filter((s) => s.score >= QUALITY_THRESHOLD);
  if (viable.length > 0) {
    const sortedByCost = [...viable].sort((a, b) => {
      const costDiff = a.candidate.inputCostPer1M - b.candidate.inputCostPer1M;
      if (costDiff !== 0) return costDiff;
      return b.score - a.score;
    });
    const [primary, ...rest] = sortedByCost;
    const nonViable = scored
      .filter((s) => s.score < QUALITY_THRESHOLD && s.score > 0)
      .sort((a, b) => b.score - a.score);
    return {
      primary,
      fallbacks: [...rest, ...nonViable],
    };
  }

  const sortedByScore = [...scored]
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (sortedByScore.length === 0) {
    return undefined;
  }
  const [primary, ...rest] = sortedByScore;
  return { primary, fallbacks: rest };
}

function buildRationale(
  primary: ScoredCandidate,
  viableCount: number,
  totalCount: number
): string {
  if (viableCount > 0) {
    return `Cheapest candidate with score ≥ ${QUALITY_THRESHOLD}: ${primary.candidate.modelId} (score ${primary.score.toFixed(2)}, cost ${primary.candidate.inputCostPer1M}/1M, ${viableCount}/${totalCount} viable)`;
  }
  return `No candidate cleared ${QUALITY_THRESHOLD}; picked highest-scoring: ${primary.candidate.modelId} (score ${primary.score.toFixed(2)})`;
}

class DefaultModelSelector implements ModelSelector {
  select(
    result: ClassifierResult,
    _signals: ClassifierSignals,
    candidates: readonly CandidateModel[]
  ): ModelOption[] {
    const scored = joinScores(candidates, result.scores);
    const picked = selectPrimary(scored);

    if (!picked) {
      const [first] = candidates;
      if (!first) return [];
      return buildFallbackOptions(
        'No candidate met any score — falling back to first candidate',
        first
      );
    }

    const { primary, fallbacks } = picked;
    const viableCount = scored.filter(
      (s) => s.score >= QUALITY_THRESHOLD
    ).length;
    const rationale = buildRationale(primary, viableCount, scored.length);

    const options: ModelOption[] = [toOption(primary, 0, rationale)];
    fallbacks.forEach((fallback, index) => {
      options.push(
        toOption(
          fallback,
          index + 1,
          `Fallback (score ${fallback.score.toFixed(2)}) for retry on upstream errors`
        )
      );
    });

    return options;
  }
}

export const defaultModelSelector = new DefaultModelSelector();
