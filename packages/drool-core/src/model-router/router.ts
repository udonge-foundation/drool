import { logException } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { ClassifierSource } from './constants';
import { buildFallbackOptions } from './selector';

import type {
  CandidateModel,
  ClassifierSignals,
  ModelRouter,
  ModelSelector,
  RouterDeps,
  RoutingDecision,
  TurnClassifier,
} from './types';

/**
 * On any classifier/selector failure, emits a fallback decision
 * pointed at the first caller-supplied candidate. Callers must
 * pre-filter candidates by org policy so the fallback never lands on
 * an out-of-policy model.
 */
export class Router implements ModelRouter {
  private readonly classifier: TurnClassifier;

  private readonly selector: ModelSelector;

  private readonly candidates: readonly [CandidateModel, ...CandidateModel[]];

  constructor(deps: RouterDeps) {
    if (deps.candidates.length === 0) {
      throw new MetaError('Router requires at least one candidate model');
    }
    this.classifier = deps.classifier;
    this.selector = deps.selector;
    this.candidates = deps.candidates as readonly [
      CandidateModel,
      ...CandidateModel[],
    ];
  }

  async route(signals: ClassifierSignals): Promise<RoutingDecision> {
    try {
      const classifierResult = await this.classifier.classify(
        signals,
        this.candidates
      );
      const options = this.selector.select(
        classifierResult,
        signals,
        this.candidates
      );
      return {
        options,
        classifierResult,
        sessionId: signals.sessionId,
      };
    } catch (error) {
      logException(
        error,
        '[Model-Router] Classifier/selector failed; falling back to first candidate',
        { sessionId: signals.sessionId }
      );
      return {
        options: buildFallbackOptions(
          'Classifier unavailable; falling back to first candidate',
          this.candidates[0]
        ),
        classifierResult: {
          scores: [],
          latencyMs: 0,
          source: ClassifierSource.Fallback,
        },
        sessionId: signals.sessionId,
      };
    }
  }
}
