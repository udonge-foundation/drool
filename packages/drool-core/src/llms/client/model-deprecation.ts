import { logWarn } from '@industry/logging';
import { getFlag, getFlagValues } from '@industry/runtime/feature-flags';
import { getModel, getModelFeatureFlags } from '@industry/utils/llm';
import {
  filterModelsByFlags,
  resolveHardDeprecatedModelFallbackCore,
} from '@industry/utils/models';

import type {
  AppliedDeprecatedModelFallback,
  ApplyDeprecatedModelFallbackOptions,
  DeprecatedModelFallback,
  SessionLike,
} from './types';

type Translate = (key: string, options?: Record<string, string>) => string;

function getDefaultCandidateModelIds(): readonly string[] {
  return filterModelsByFlags(getFlagValues(getModelFeatureFlags()));
}

export function resolveHardDeprecatedModelFallback(
  modelId: string,
  options: {
    translate: Translate;
    candidateModelIds?: readonly string[] | ReadonlySet<string>;
    getCandidateModelIds?: () => readonly string[] | ReadonlySet<string>;
    isCandidateAllowed?: (candidateModelId: string) => boolean;
  }
): DeprecatedModelFallback | null {
  let candidateModelIds: ReadonlySet<string> | undefined;
  const getCandidateModelIds = () => {
    if (!candidateModelIds) {
      const modelIds =
        options.candidateModelIds ??
        options.getCandidateModelIds?.() ??
        getDefaultCandidateModelIds();
      candidateModelIds =
        modelIds instanceof Set ? modelIds : new Set(modelIds);
    }
    return candidateModelIds;
  };

  const resolution = resolveHardDeprecatedModelFallbackCore(modelId, {
    getFlag,
    isCandidateAvailable: (candidateModelId) =>
      getCandidateModelIds().has(candidateModelId),
    ...(options.isCandidateAllowed
      ? { isCandidateAllowed: options.isCandidateAllowed }
      : {}),
  });
  if (!resolution) {
    return null;
  }

  const { deprecatedModelId, fallbackModelId } = resolution;
  const model = getModel(deprecatedModelId).name;
  if (!fallbackModelId) {
    return {
      deprecatedModelId,
      message: options.translate(
        'common:appMessages.modelHardDeprecatedNoFallback',
        { model }
      ),
    };
  }

  const fallbackModel = getModel(fallbackModelId).name;
  return {
    deprecatedModelId,
    fallbackModelId,
    message: options.translate(
      'common:appMessages.modelHardDeprecatedFallback',
      { model, fallbackModel }
    ),
  };
}

export function applyDeprecatedModelFallback(
  session: SessionLike,
  fallback: AppliedDeprecatedModelFallback,
  options: ApplyDeprecatedModelFallbackOptions
): boolean {
  const useSpecModeSlot = options.isSpecMode && session.hasSpecModeModel();
  if (useSpecModeSlot) {
    if (session.getSpecModeModel() !== fallback.deprecatedModelId) {
      return false;
    }
    session.setSpecModeModel(fallback.fallbackModelId);
  } else {
    if (session.getModel() !== fallback.deprecatedModelId) {
      return false;
    }
    session.setModel(fallback.fallbackModelId);
  }

  if (options.persistNotice && session.appendUserOnlySystemMessage) {
    void Promise.resolve(
      session.appendUserOnlySystemMessage(fallback.message)
    ).catch((error) => {
      logWarn('[model-deprecation] Failed to append fallback notice', {
        error,
      });
    });
  }

  return true;
}
