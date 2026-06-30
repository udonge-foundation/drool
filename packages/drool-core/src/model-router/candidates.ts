// Callers must pre-filter through availability + org-policy helpers.
import { ModelID } from '@industry/drool-sdk-ext/protocol/llm';

import { defineCandidate } from './defineCandidate';

import type { CandidateModel } from './types';

const CANDIDATE_CLAUDE_OPUS_4_8: CandidateModel = defineCandidate(
  ModelID.CLAUDE_OPUS_4_8,
  { inputCostPer1M: 15, outputCostPer1M: 75 }
);

const CANDIDATE_KIMI_K2_7: CandidateModel = defineCandidate(
  ModelID.KIMI_K2_7_CODE,
  {
    inputCostPer1M: 0.95,
    outputCostPer1M: 4.0,
  }
);

const CANDIDATE_MINIMAX_M3: CandidateModel = defineCandidate(
  ModelID.MINIMAX_M3,
  {
    inputCostPer1M: 0.3,
    outputCostPer1M: 1.2,
  }
);

export const DEFAULT_CANDIDATES: readonly CandidateModel[] = Object.freeze([
  CANDIDATE_CLAUDE_OPUS_4_8,
  CANDIDATE_KIMI_K2_7,
  CANDIDATE_MINIMAX_M3,
]);
