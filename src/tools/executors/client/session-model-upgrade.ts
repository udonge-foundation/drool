import { ToolExecutionErrorType } from '@industry/common/session';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  INDUSTRY_ROUTER_MODEL_ID,
  ApiProvider,
} from '@industry/drool-sdk-ext/protocol/llm';
import { ToolAbortError } from '@industry/logging/errors';
import { getModel, getSessionModelUpgradeTarget } from '@industry/utils/llm';

import { getSessionController } from '@/controllers/SessionController';
import { getAvailableModelsForResponse } from '@/models/availability';
import {
  getModelDefaultReasoningEffort,
  getTuiModelConfig,
} from '@/models/config';
import { resolveConcreteTurnModelId } from '@/models/sessionModelUpgrade';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { UpgradeFailureReason } from '@/tools/executors/client/enums';
import type {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

import type { SessionModelUpgradeToolInput } from '@industry/drool-core/tools/definitions/cli';
import type {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import type { BuiltInModelID } from '@industry/drool-sdk-ext/protocol/llm';

function getDisplayName(modelId: string): string {
  return getTuiModelConfig(modelId).shortDisplayName || modelId;
}

interface UpgradeResolutionResult {
  targetModelId?: BuiltInModelID;
  reason?: UpgradeFailureReason;
  /** Concrete model running this turn. */
  concreteModelId?: string;
  /** Raw configured session model. */
  sessionModelId: string;
}

async function resolveUpgradeTarget(
  sessionModelId: string
): Promise<UpgradeResolutionResult> {
  const effective = getSessionService().getEffectiveIndustryRouterModel();
  const concrete = resolveConcreteTurnModelId(sessionModelId, effective);

  if (concrete === undefined) {
    return { sessionModelId, reason: UpgradeFailureReason.NoEffectiveModel };
  }

  const configuredTarget = getSessionModelUpgradeTarget(concrete);
  if (!configuredTarget) {
    return {
      sessionModelId,
      concreteModelId: concrete,
      reason: UpgradeFailureReason.UpgradeNotDefined,
    };
  }

  const availableModels = await getAvailableModelsForResponse();
  const availableModelIds = new Set(availableModels.map((model) => model.id));
  if (!availableModelIds.has(configuredTarget)) {
    return {
      sessionModelId,
      concreteModelId: concrete,
      reason: UpgradeFailureReason.TargetNotAvailable,
      targetModelId: configuredTarget,
    };
  }

  const validation = getSettingsService().validateModelAccess(configuredTarget);
  if (!validation.allowed) {
    return {
      sessionModelId,
      concreteModelId: concrete,
      reason: UpgradeFailureReason.TargetNotAllowed,
      targetModelId: configuredTarget,
    };
  }

  return {
    sessionModelId,
    concreteModelId: concrete,
    targetModelId: configuredTarget,
  };
}

function resolveApiProviderForUpgrade(targetModelId: string): ApiProvider {
  try {
    const config = getModel(targetModelId);
    const first = config.apiProviders[0];
    if (first) return first;
  } catch {
    // Fall through to safe default below.
  }
  return ApiProvider.ANTHROPIC;
}

const UPGRADE_FAILED_USER_MESSAGE = 'Could not upgrade the session model';

function failedUpgradeResult(llmError: string): DraftToolFeedback<string> {
  return {
    type: DraftToolFeedbackType.Result,
    isError: true,
    errorType: ToolExecutionErrorType.EnvironmentStateError,
    llmError,
    userError: UPGRADE_FAILED_USER_MESSAGE,
  };
}

export class UpgradeSessionModelExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    _parameters: SessionModelUpgradeToolInput
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const sessionModelId = getSessionService().getDisplayModel();
    const resolution = await resolveUpgradeTarget(sessionModelId);

    if (resolution.reason === UpgradeFailureReason.NoEffectiveModel) {
      yield failedUpgradeResult(
        'Cannot upgrade an Auto Model session before the router has selected a concrete model.'
      );
      return;
    }

    const isIndustryRouterSession = sessionModelId === INDUSTRY_ROUTER_MODEL_ID;
    const concreteModelName = getDisplayName(
      resolution.concreteModelId ?? sessionModelId
    );
    const concreteLabel = isIndustryRouterSession
      ? 'the routed session model'
      : concreteModelName;

    if (resolution.reason === UpgradeFailureReason.UpgradeNotDefined) {
      yield failedUpgradeResult(
        `No upgrade path is defined for ${concreteLabel}.`
      );
      return;
    }

    if (resolution.reason === UpgradeFailureReason.TargetNotAvailable) {
      yield failedUpgradeResult(
        'The configured upgrade target model is not available for this session.'
      );
      return;
    }

    if (resolution.reason === UpgradeFailureReason.TargetNotAllowed) {
      yield failedUpgradeResult(
        'The configured upgrade target model is blocked by policy.'
      );
      return;
    }

    if (!resolution.targetModelId || !resolution.concreteModelId) {
      yield failedUpgradeResult(
        `No upgrade path is defined for ${concreteLabel}.`
      );
      return;
    }

    const targetModelName = getDisplayName(resolution.targetModelId);
    if (resolution.targetModelId === resolution.concreteModelId) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: isIndustryRouterSession
          ? 'Routed session model is already at the maximum tier. No upgrade needed.'
          : `Session model is already ${targetModelName}. No upgrade needed.`,
      };
      return;
    }

    // Router: overwrite the cached pick and leave the session
    // model as the router so the user's preference is preserved. Sticky
    // for the rest of the session (the routing layer never re-classifies
    // once effectiveIndustryRouterModel is populated). Success/error strings here
    // intentionally avoid the concrete model names -- exposing the
    // routed pick to the LLM (and via it the user) defeats the point
    // of presenting Router as an abstracted router.
    if (sessionModelId === INDUSTRY_ROUTER_MODEL_ID) {
      const reasoningEffort = getModelDefaultReasoningEffort(
        resolution.targetModelId
      );
      getSessionService().setEffectiveIndustryRouterModel({
        modelId: resolution.targetModelId,
        apiProvider: resolveApiProviderForUpgrade(resolution.targetModelId),
        reasoningEffort,
      });

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: 'Upgraded routed session model.',
      };
      return;
    }

    // Concrete session: swap via the controller so compaction,
    // provider locks, and UI state all follow.
    const defaultReasoningEffort = getModelDefaultReasoningEffort(
      resolution.targetModelId
    );
    const switchResult = await getSessionController().switchModel(
      resolution.targetModelId,
      defaultReasoningEffort
    );

    if (!switchResult.success) {
      yield failedUpgradeResult(
        switchResult.error || 'Failed to upgrade the session model'
      );
      return;
    }

    yield {
      type: DraftToolFeedbackType.Result,
      isError: false,
      value: `Upgraded session model from ${concreteModelName} to ${targetModelName}.`,
    };
  }
}
