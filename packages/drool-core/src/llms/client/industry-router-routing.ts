import {
  ApiProvider,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';
import { MessageRole } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo, logWarn, Metric, Metrics } from '@industry/logging';
import { getModelConfig, ROUTER_FALLBACK_MODEL } from '@industry/utils/llm';

import { countImagesInMessage } from './image-limits';
import {
  IndustryRouterUnavailableError,
  buildClassifierSignalsFromHistory,
} from '../../model-router';

import type { ModelRoutingDeps, ResolvedIndustryRouterModel } from './types';
import type {
  ClassifierSignals,
  ConversationMessage,
  ModelRouter,
} from '../../model-router';
import type { EffectiveIndustryRouterModel } from '@industry/common/session/settings';
import type {
  ContentBlock,
  IndustryDroolMessage,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

function toConversationRole(role: MessageRole): 'user' | 'assistant' | 'tool' {
  if (role === MessageRole.Assistant) return 'assistant';
  if (role === MessageRole.Tool) return 'tool';
  return 'user';
}

function toConversationContentBlock(
  block: ContentBlock
): ConversationMessage['content'][number] {
  const text = 'text' in block ? block.text : undefined;
  const name = 'name' in block ? block.name : undefined;
  const isError =
    block.type === 'tool_result' && 'isError' in block
      ? block.isError
      : undefined;
  return { type: block.type, text, name, isError };
}

function toConversationMessages(
  history: readonly IndustryDroolMessage[]
): ConversationMessage[] {
  return history.map((m) => ({
    role: toConversationRole(m.role),
    content: Array.isArray(m.content)
      ? m.content.map(toConversationContentBlock)
      : [],
  }));
}

function countAssistantTurns(history: readonly IndustryDroolMessage[]): number {
  let count = 0;
  for (const m of history) {
    if (m.role === MessageRole.Assistant) count += 1;
  }
  return count;
}

function toResolvedOption(
  effective: EffectiveIndustryRouterModel
): ResolvedIndustryRouterModel {
  return {
    modelId: effective.modelId,
    apiProvider: effective.apiProvider,
    reasoningEffort: effective.reasoningEffort,
  };
}

async function classifyAndCache(
  routing: ModelRoutingDeps,
  router: ModelRouter,
  signals: ClassifierSignals
): Promise<ResolvedIndustryRouterModel | undefined> {
  const decision = await router.route(signals);
  const primary = decision.options[0];
  if (!primary) return undefined;

  routing.setEffectiveIndustryRouterModel({
    modelId: primary.modelId,
    apiProvider: primary.apiProvider,
    reasoningEffort: primary.reasoningEffort,
  });

  const hasOrgGuidance = decision.classifierResult.hasCustomGuidance === true;
  Metrics.addToCounter(Metric.ROUTING_DECISION_COUNT, 1, {
    classification: decision.classifierResult.source,
    surface: signals.surface,
    hasOrgGuidance: String(hasOrgGuidance),
  });
  Metrics.recordHistogram(
    Metric.ROUTING_CLASSIFIER_LATENCY,
    decision.classifierResult.latencyMs,
    {
      classification: decision.classifierResult.source,
      surface: signals.surface,
      hasOrgGuidance: String(hasOrgGuidance),
    }
  );

  logInfo('[Model-Router] Routed', {
    modelId: primary.modelId,
    source: decision.classifierResult.source,
    durationMs: decision.classifierResult.latencyMs,
    surface: signals.surface,
    turnCount: signals.turnCount,
    hasImages: signals.hasImages,
    hasFailedToolCalls: signals.hasFailedToolCalls ?? false,
    hasOrgGuidance: String(hasOrgGuidance),
  });

  return {
    modelId: primary.modelId,
    apiProvider: primary.apiProvider,
    reasoningEffort: primary.reasoningEffort,
  };
}

/**
 * Persists the fallback so SessionService.getModel reads the same
 * `(modelId, reasoningEffort, apiProvider)` triple the router would
 * have produced — turns "router failed, falling back" into a
 * one-time event instead of a per-turn warn. Throws
 * IndustryRouterUnavailableError when policy blocks Opus too. Headless hosts
 * (no `routing` deps) skip the policy + persistence steps.
 *
 * Anthropic / High pair tracks Opus 4.8's registry defaults; refresh
 * if ROUTER_FALLBACK_MODEL ever moves.
 */
function buildOpusFallback(
  routing: ModelRoutingDeps | undefined,
  reason: string
): ResolvedIndustryRouterModel {
  if (routing && !routing.isModelAllowed(ROUTER_FALLBACK_MODEL)) {
    throw new IndustryRouterUnavailableError(
      'Auto Model fallback target is blocked by org policy',
      { reason, fallbackModelId: ROUTER_FALLBACK_MODEL }
    );
  }
  const fallback: ResolvedIndustryRouterModel = {
    modelId: ROUTER_FALLBACK_MODEL,
    apiProvider: ApiProvider.ANTHROPIC,
    reasoningEffort: ReasoningEffort.High,
  };
  if (routing && routing.getEffectiveIndustryRouterModel() === undefined) {
    routing.setEffectiveIndustryRouterModel({
      modelId: fallback.modelId,
      apiProvider: fallback.apiProvider,
      reasoningEffort: fallback.reasoningEffort,
    });
  }
  return fallback;
}

/**
 *   routing disabled or deps missing → policy-checked Opus fallback
 *   image present on a non-vision pick → direct upgrade to Opus
 *   cached pick still allowed         → return cached
 *   cached pick now blocked           → invalidate + re-route
 *   no cache yet                      → classify, cache, return
 *   classifier hard-fails             → throw IndustryRouterUnavailableError
 *   classifier transient error        → policy-checked Opus fallback
 */
export async function resolveIndustryRouterModelForMessage({
  routing,
  conversationHistory,
  sessionId,
}: {
  routing: ModelRoutingDeps | undefined;
  conversationHistory: readonly IndustryDroolMessage[];
  sessionId: string;
}): Promise<ResolvedIndustryRouterModel> {
  if (!routing || !routing.isEnabled()) {
    return buildOpusFallback(routing, 'Auto Model disabled');
  }

  // Cache hit. Revalidate against current policy first — orgs can flip model
  // access mid-session, and a stale cached pick must not outlive the policy
  // that allowed it. The isModelAllowed check also gates the getModelConfig
  // lookup below, so a persisted-but-unknown id (e.g. a model removed by a
  // rollout) is cleared and re-routed instead of throwing.
  const cached = routing.getEffectiveIndustryRouterModel();
  if (cached !== undefined) {
    if (routing.isModelAllowed(cached.modelId)) {
      // The routed model can't see images but the conversation has one:
      // upgrade straight to the vision fallback — no reroute, no reclassify.
      // Gated on noImageSupport, so vision picks never scan and it's one-shot.
      if (
        getModelConfig(cached.modelId).noImageSupport &&
        routing.isModelAllowed(ROUTER_FALLBACK_MODEL) &&
        conversationHistory.some((m) => countImagesInMessage(m) > 0)
      ) {
        const upgraded = buildOpusFallback(
          routing,
          'Routed model lacks image support'
        );
        routing.setEffectiveIndustryRouterModel(upgraded);
        logInfo('[Model-Router] Upgraded routed model for image input', {
          sessionId,
          previousModelId: cached.modelId,
          modelId: upgraded.modelId,
        });
        return upgraded;
      }
      return toResolvedOption(cached);
    }
    logInfo('[Model-Router] Cached Router pick no longer allowed; re-routing', {
      sessionId,
      previousModelId: cached.modelId,
    });
    routing.clearEffectiveIndustryRouterModel();
  }

  const signals = buildClassifierSignalsFromHistory({
    conversationHistory: toConversationMessages(conversationHistory),
    surface: routing.getSurface(),
    isSubAgent: routing.isSubAgentSession(),
    turnNumber: countAssistantTurns(conversationHistory),
    sessionId,
  });

  try {
    const routed = await classifyAndCache(
      routing,
      routing.getRouter(),
      signals
    );
    if (routed) return routed;
  } catch (error) {
    // Hard failures (no allowed candidate) bubble up so the engine
    // can surface a user-facing error instead of silently routing
    // around the policy.
    if (error instanceof IndustryRouterUnavailableError) {
      throw error;
    }
    logWarn(
      '[Model-Router] Classifier failed; falling back to Opus safety net',
      { cause: error }
    );
  }

  return buildOpusFallback(
    routing,
    'Auto Model classifier failed and no candidate produced a decision'
  );
}
