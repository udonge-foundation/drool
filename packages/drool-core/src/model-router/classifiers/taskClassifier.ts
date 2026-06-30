import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { normalizeIndustryRouterRules } from '@industry/utils/settings';

import {
  CLASSIFIER_MAX_COMPLETION_TOKENS,
  CLASSIFIER_TIMEOUT_MS,
  DEFAULT_TASK_CLASSIFIER_MODEL_ID,
} from '../constants';
import { clampScore } from './clampScore';
import { parseTaskClassifierResponse } from './parseTaskClassifierResponse';
import {
  buildDynamicTaskUserPrompt,
  buildStaticClassifierSystemPrompt,
} from './prompt';

import type { SendMessageClient } from '../../llms/client/types';
import type {
  CandidateModel,
  CandidateScore,
  ClassifierResult,
  ClassifierSignals,
  TaskClassifierDeps,
  TurnClassifier,
} from '../types';

/**
 * The `onTimeout` hook is required for cancellation: without it,
 * `sendCompletion` keeps the SSE stream + retry pipeline running long
 * after the router has fallen back, burning tokens against the user.
 */
function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch (abortError) {
        // Timeout is the primary signal; a flaky abort hook must not mask it.
        logWarn('[TaskClassifier] timeout abort hook threw', {
          cause: abortError,
        });
      }
      reject(
        new MetaError('Task classifier timed out', { timeout: timeoutMs })
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Missing scores default to 0. Image-blind candidates score 0 on
 * image turns even if the LLM forgot to do it itself.
 */
function assembleScores(
  candidates: readonly CandidateModel[],
  signals: ClassifierSignals,
  rawScores: Record<string, number>
): CandidateScore[] {
  return candidates.map((candidate) => {
    if (signals.hasImages && !candidate.supportsImages) {
      return { modelId: candidate.modelId, score: 0 };
    }
    const raw = rawScores[candidate.modelId];
    return {
      modelId: candidate.modelId,
      score: typeof raw === 'number' ? clampScore(raw) : 0,
    };
  });
}

/**
 * Throws on any failure (parse, timeout, upstream error); the Router
 * converts it into a safe fallback decision.
 */
export class TaskClassifier implements TurnClassifier {
  private readonly sendMessageClient: SendMessageClient;

  private readonly sendCompletion: TaskClassifierDeps['sendCompletion'];

  private readonly modelId: string;

  private readonly now: () => number;

  private readonly customGuidance: string | undefined;

  private readonly customRules: TaskClassifierDeps['customRules'];

  constructor(deps: TaskClassifierDeps) {
    this.sendMessageClient = deps.sendMessageClient;
    this.sendCompletion = deps.sendCompletion;
    this.modelId = deps.modelId ?? DEFAULT_TASK_CLASSIFIER_MODEL_ID;
    this.now = deps.now ?? (() => performance.now());
    const trimmed = deps.customGuidance?.trim();
    this.customGuidance = trimmed || undefined;
    this.customRules = normalizeIndustryRouterRules(deps.customRules);
  }

  async classify(
    signals: ClassifierSignals,
    candidates: readonly CandidateModel[]
  ): Promise<ClassifierResult> {
    if (candidates.length === 0) {
      throw new MetaError(
        'TaskClassifier requires at least one candidate model'
      );
    }
    const started = this.now();
    const result = await this.callClassifier(signals, candidates);
    return {
      ...result,
      latencyMs: this.now() - started,
      // The actual id used (ClassifierSource.Llm is the *default* id
      // and would mislabel telemetry when pickClassifierModelId falls
      // through to e.g. Haiku for orgs that block gpt-5.4-mini).
      source: this.modelId,
      hasCustomGuidance:
        this.customGuidance !== undefined || this.customRules !== undefined,
    };
  }

  private async callClassifier(
    signals: ClassifierSignals,
    candidates: readonly CandidateModel[]
  ): Promise<Omit<ClassifierResult, 'latencyMs' | 'source'>> {
    const systemPrompt = buildStaticClassifierSystemPrompt(candidates, {
      customGuidance: this.customGuidance,
      customRules: this.customRules,
    });
    const userContent = buildDynamicTaskUserPrompt(signals);

    const text = await raceWithTimeout(
      this.sendCompletion(this.sendMessageClient, {
        sessionId: signals.sessionId,
        modelId: this.modelId,
        // GPT-5.4-mini rejects 'minimal'; temperature=0 is rejected
        // when reasoning_effort is set, so 'low' is the cheapest knob.
        reasoningEffort: ReasoningEffort.Low,
        maxTokensOverride: CLASSIFIER_MAX_COMPLETION_TOKENS,
        systemPrompt,
        userContent,
      }),
      CLASSIFIER_TIMEOUT_MS,
      () => this.sendMessageClient.abortStreaming()
    );

    const payload = parseTaskClassifierResponse(text);
    return {
      scores: assembleScores(candidates, signals, payload.scores),
      reasoning: payload.reasoning,
    };
  }
}
