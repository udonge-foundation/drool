import { sendCompletion } from '@industry/drool-core/llms/client/sendMessage';
import {
  IndustryRouterUnavailableError,
  ClassifierSource,
  Router,
  TaskClassifier,
  buildFallbackOptions,
  defaultModelSelector,
} from '@industry/drool-core/model-router';
import { logInfo } from '@industry/logging';

import {
  getAllowedIndustryRouterCandidates,
  pickClassifierModelId,
} from '@/models/industryRouterAvailability';
import { createOneShotSendMessageClient } from '@/services/llmStreamingClient';
import { getSettingsService } from '@/services/SettingsService';

import type {
  ClassifierSignals,
  ModelRouter,
  RoutingDecision,
} from '@industry/drool-core/model-router';

async function routeIndustryRouterTurn(
  signals: ClassifierSignals
): Promise<RoutingDecision> {
  const allowedCandidates = getAllowedIndustryRouterCandidates();
  const [first] = allowedCandidates;
  if (!first) {
    throw new IndustryRouterUnavailableError(
      'No Auto Model candidate models are allowed for this user',
      { sessionId: signals.sessionId }
    );
  }

  const classifierModelId = pickClassifierModelId();
  if (classifierModelId === undefined) {
    logInfo(
      '[Model-Router] No classifier model allowed; using deterministic fallback',
      { sessionId: signals.sessionId, modelId: first.modelId }
    );
    return {
      options: buildFallbackOptions(
        'No classifier model allowed by policy; using first allowed candidate',
        first
      ),
      classifierResult: {
        scores: [],
        latencyMs: 0,
        source: ClassifierSource.Fallback,
      },
      sessionId: signals.sessionId,
    };
  }

  const router = new Router({
    classifier: new TaskClassifier({
      sendMessageClient: createOneShotSendMessageClient(),
      sendCompletion,
      modelId: classifierModelId,
      customGuidance: getSettingsService().getIndustryRouterGuidance(),
      customRules: getSettingsService().getIndustryRouterRules(),
    }),
    selector: defaultModelSelector,
    candidates: allowedCandidates,
  });
  return await router.route(signals);
}

export const cliIndustryRouter: ModelRouter = Object.freeze({
  route: routeIndustryRouterTurn,
});
