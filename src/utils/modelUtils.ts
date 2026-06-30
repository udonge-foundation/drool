import {
  DYNAMIC_CONFIG_SCHEMAS,
  MODEL_DEPRECATIONS,
  type DynamicConfigTypes,
} from '@industry/common/feature-flags';
import { resolveHardDeprecatedModelFallback as resolveHardDeprecatedModelFallbackShared } from '@industry/drool-core/llms/client/model-deprecation';
import {
  ModelProvider,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';
import { MessageContentBlockType } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logWarn } from '@industry/logging';
import { getDynamicConfig } from '@industry/runtime/feature-flags';
import { getCanonicalModelId, getModel } from '@industry/utils/llm';

import { getI18n } from '@/i18n';
import { getAvailableModelIds } from '@/models/availability';
import { getTuiModelConfig } from '@/models/config';

import type { TuiModelConfig } from '@industry/common/cli';
import type { DeprecatedModelFallback } from '@industry/drool-core/llms/client/types';

interface ActiveModelDeps {
  isSpecMode: () => boolean;
  hasSpecModeModel: () => boolean;
  getSpecModeModel: () => string;
  getModel: () => string;
}

interface TurnModelContextDeps extends ActiveModelDeps {
  getReasoningEffort: () => ReasoningEffort;
  getSpecModeReasoningEffort: () => ReasoningEffort;
}

interface TurnModelContext {
  modelSetting: string;
  modelConfig: TuiModelConfig;
  provider: ModelProvider;
  reasoningEffort: ReasoningEffort;
}

type ModelDeprecationsConfig = DynamicConfigTypes[typeof MODEL_DEPRECATIONS];

function modelIdsMatch(left: string, right: string): boolean {
  return getCanonicalModelId(left) === getCanonicalModelId(right);
}

function getModelDeprecationsConfig(): ModelDeprecationsConfig | undefined {
  const raw = getDynamicConfig(MODEL_DEPRECATIONS);
  if (raw === undefined) {
    return undefined;
  }

  const parsed = DYNAMIC_CONFIG_SCHEMAS[MODEL_DEPRECATIONS].safeParse(raw);
  if (!parsed.success) {
    logWarn('[modelUtils] model deprecations config failed validation', {
      error: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return undefined;
  }

  return parsed.data;
}

function getNoticeModelDisplayName(modelId: string): string {
  try {
    return getModel(modelId).name;
  } catch (error) {
    logWarn('[modelUtils] failed to resolve model display name for notice', {
      cause: error,
      modelId,
    });
    return modelId;
  }
}

function buildDeprecatedModelNotice(
  modelId: string,
  deprecationDate?: string
): { message: string } {
  const modelName = getNoticeModelDisplayName(modelId);
  const date = deprecationDate?.trim();
  return {
    message: date
      ? getI18n().t('common:appMessages.modelDeprecatedNoticeWithDate', {
          model: modelName,
          date,
        })
      : getI18n().t('common:appMessages.modelDeprecatedNotice', {
          model: modelName,
        }),
  };
}

/**
 * Resolve the active model ID considering spec mode state.
 *
 * When spec mode is active AND an explicit spec model is configured,
 * returns the spec model. Otherwise returns the main session model.
 *
 * The hasSpecModeModel() guard is critical: getSpecModeModel() has a
 * fallback chain that returns the global default model when no explicit
 * spec model is set, which can silently differ from the session model.
 */
export function resolveActiveModel(deps: ActiveModelDeps): string {
  if (deps.isSpecMode() && deps.hasSpecModeModel()) {
    return deps.getSpecModeModel();
  }
  return deps.getModel();
}

/**
 * Resolve the model, provider, and reasoning effort for a turn in one read.
 * Shared by the agent loop's pre-priming setup and post-priming re-sync so
 * both derive the same fields the same way.
 */
export function resolveTurnModelContext(
  deps: TurnModelContextDeps
): TurnModelContext {
  const modelSetting = resolveActiveModel(deps);
  const modelConfig = getTuiModelConfig(modelSetting);
  const reasoningEffort =
    deps.isSpecMode() && deps.hasSpecModeModel()
      ? deps.getSpecModeReasoningEffort()
      : deps.getReasoningEffort();
  return {
    modelSetting,
    modelConfig,
    provider: modelConfig.modelProvider,
    reasoningEffort,
  };
}

export function getDeprecatedModelNotice(
  modelId: string
): { message: string } | null {
  const deprecationsConfig = getModelDeprecationsConfig();
  if (deprecationsConfig) {
    const deprecation = deprecationsConfig.deprecations.find((entry) =>
      modelIdsMatch(entry.deprecatedModelId, modelId)
    );
    return deprecation
      ? buildDeprecatedModelNotice(modelId, deprecation.deprecationDate)
      : null;
  }

  const config = getTuiModelConfig(modelId);
  if (!config.deprecated) {
    return null;
  }

  return buildDeprecatedModelNotice(modelId, config.deprecationDate);
}

/**
 * Effective token multipliers above this threshold trigger a cost warning
 * notice when the model is activated (e.g. the 12x Opus fast modes).
 */
const EXPENSIVE_MODEL_TOKEN_MULTIPLIER_THRESHOLD = 4;

export function getExpensiveModelNotice(
  modelId: string
): { message: string } | null {
  const config = getTuiModelConfig(modelId);
  if (config.isCustom || config.isUnknownFallback) {
    return null;
  }
  const multiplier = config.tokenMultiplier;
  if (
    multiplier === undefined ||
    multiplier <= EXPENSIVE_MODEL_TOKEN_MULTIPLIER_THRESHOLD
  ) {
    return null;
  }
  return {
    message: getI18n().t('common:appMessages.expensiveModelNotice', {
      model: getNoticeModelDisplayName(modelId),
      multiplier,
    }),
  };
}

export function resolveHardDeprecatedModelFallback(
  modelId: string,
  options?: {
    candidateModelIds?: readonly string[];
    isCandidateAllowed?: (candidateModelId: string) => boolean;
  }
): DeprecatedModelFallback | null {
  return resolveHardDeprecatedModelFallbackShared(modelId, {
    translate: (key, translateOptions) => getI18n().t(key, translateOptions),
    ...(options?.candidateModelIds
      ? { candidateModelIds: options.candidateModelIds }
      : { getCandidateModelIds: getAvailableModelIds }),
    ...(options?.isCandidateAllowed
      ? { isCandidateAllowed: options.isCandidateAllowed }
      : {}),
  });
}

export function isMessageText<
  T extends { content: string | Array<{ type: string; text?: string }> },
>(message: T | undefined, expectedText: string): boolean {
  if (!message) {
    return false;
  }

  const actualText =
    typeof message.content === 'string'
      ? message.content.trim()
      : message.content
          .map((block) =>
            block.type === MessageContentBlockType.Text
              ? (block.text ?? '')
              : ''
          )
          .filter(Boolean)
          .join('\n')
          .trim();

  return actualText === expectedText.trim();
}

export function isLastMessageText<
  T extends { content: string | Array<{ type: string; text?: string }> },
>(messages: readonly T[], expectedText: string): boolean {
  return isMessageText(messages.at(-1), expectedText);
}

/**
 * Clamp a reasoning effort to the supported efforts of the given model.
 * Returns the effort if supported, otherwise the model's default effort.
 */
export function clampReasoningEffortForModel(
  model: string,
  effort: ReasoningEffort
): ReasoningEffort {
  const config = getTuiModelConfig(model);
  if (config.supportedReasoningEfforts.includes(effort)) {
    return effort;
  }
  return config.defaultReasoningEffort;
}

/**
 * Calculate the next reasoning effort in the cycle for a given model.
 *
 * @param model - The model to calculate the cycle for
 * @param currentEffort - The current reasoning effort
 * @returns The next reasoning effort in the cycle
 */
export function calculateNextReasoningEffort(
  model: string,
  currentEffort: ReasoningEffort
): ReasoningEffort {
  const modelConfig = getTuiModelConfig(model);
  const supportedEfforts = modelConfig.supportedReasoningEfforts || [];

  // If model only supports one effort level, return current
  if (supportedEfforts.length <= 1) {
    return currentEffort;
  }

  const currentIndex = supportedEfforts.indexOf(currentEffort);

  // Cycle to next effort, wrapping around
  // If current effort not in supported list (indexOf returns -1), start from first
  const nextIndex =
    currentIndex === -1 ? 0 : (currentIndex + 1) % supportedEfforts.length;
  return supportedEfforts[nextIndex];
}
