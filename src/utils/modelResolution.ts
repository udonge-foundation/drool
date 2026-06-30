import {
  INDUSTRY_ROUTER_MODEL_ID,
  ModelID,
} from '@industry/drool-sdk-ext/protocol/llm';
import { resolveModelId as resolveModelAlias } from '@industry/utils/llm';
import { findCustomModel } from '@industry/utils/models';

import { getI18n } from '@/i18n';
import { getAvailableModelsForExec } from '@/models/availability';
import { isIndustryRouterSelectable } from '@/models/industryRouterAvailability';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import type { ResolveModelResult } from '@/utils/modelResolution/types';

/**
 * Resolves a model identifier to its canonical form.
 * Handles both built-in and custom models, normalizing the custom: prefix.
 *
 * @param input - Model identifier (may or may not have custom: prefix)
 * @returns Resolution result with canonical modelId
 */
export async function resolveModelId(
  input: string
): Promise<ResolveModelResult> {
  // Handle empty input
  if (!input || !input.trim()) {
    return { modelId: input, customModel: null, exists: false };
  }

  const trimmedInput = input.trim();

  // Pseudo-model gated on `isIndustryRouterSelectable`; without this gate a
  // user could backdoor routing via `--model auto`.
  if (trimmedInput === INDUSTRY_ROUTER_MODEL_ID) {
    return {
      modelId: INDUSTRY_ROUTER_MODEL_ID,
      customModel: null,
      exists: isIndustryRouterSelectable(),
    };
  }

  // 1. Check built-in models first (exact match)
  const builtInModels = await getAvailableModelsForExec();
  if (builtInModels.includes(trimmedInput as ModelID)) {
    return { modelId: trimmedInput, customModel: null, exists: true };
  }

  // 1b. Check model aliases (e.g. deprecated model IDs redirected to successors)
  const aliasResolved = resolveModelAlias(trimmedInput);
  if (aliasResolved && aliasResolved !== trimmedInput) {
    if (aliasResolved === INDUSTRY_ROUTER_MODEL_ID) {
      return {
        modelId: INDUSTRY_ROUTER_MODEL_ID,
        customModel: null,
        exists: isIndustryRouterSelectable(),
      };
    }

    if (builtInModels.includes(aliasResolved as ModelID)) {
      return {
        modelId: aliasResolved as string,
        customModel: null,
        exists: true,
      };
    }
  }

  // 2. Check custom models (index-based, id-based, and legacy model name matching)
  const models = getSettingsService().getCustomModels();
  const customModels = Array.isArray(models) ? models : [];

  const customMatch =
    findCustomModel(trimmedInput, customModels) ??
    (!trimmedInput.startsWith('custom:')
      ? findCustomModel(`custom:${trimmedInput}`, customModels)
      : null);
  if (customMatch) {
    return {
      modelId: customMatch.id,
      customModel: customMatch,
      exists: true,
    };
  }

  // 3. Model not found
  return {
    modelId: trimmedInput,
    customModel: null,
    exists: false,
  };
}

/**
 * Generate a consistent, helpful error message for invalid models.
 *
 * @param input - The invalid model identifier
 * @returns Formatted error message with available options
 */
export async function getInvalidModelErrorMessage(
  input: string
): Promise<string> {
  const builtInModels = await getAvailableModelsForExec();
  const models = getSettingsService().getCustomModels();
  const customModels = Array.isArray(models) ? models : [];

  const t = getI18n().t;
  const noneLabel = t('errors:agent.modelsNone');
  const availableBuiltIn =
    builtInModels.length > 0 ? builtInModels.join(', ') : noneLabel;
  const availableCustom =
    customModels.length > 0
      ? customModels
          .map((m) => `${m.id} (${m.displayName ?? m.model ?? '(custom)'})`)
          .join(', ')
      : noneLabel;

  if (customModels.length > 0) {
    return t('errors:agent.invalidModel', {
      input,
      builtIn: availableBuiltIn,
      custom: availableCustom,
    });
  }
  return t('errors:agent.invalidModelNoCustom', {
    input,
    builtIn: availableBuiltIn,
  });
}

/**
 * Single source of truth for "what model is the user actively using right now?"
 *
 * Honors spec mode: if the session is in spec mode AND a spec-mode model is
 * explicitly set, returns it; otherwise falls back to the regular session
 * model. This matches the resolution `useLLMStreaming` performs on every
 * render before initializing the SDK clients, and the same shape that the
 * compaction `Summarizer` and `SessionTitleGenerator` need to decide whether
 * to honor BYOK or fall back to a default model.
 *
 * Reads through {@link getSessionService}, which itself falls back to
 * {@link getSettingsService} when session settings haven't been populated
 * yet — so this works during session creation (title generation) and
 * mid-turn (compaction) alike.
 */
export function resolveActiveSessionModel(): ResolveModelResult {
  const session = getSessionService();
  const isSpecMode = session.isSpecMode();
  const regularModel = session.getModel();
  const specModel = session.hasSpecModeModel()
    ? session.getSpecModeModel()
    : regularModel;
  const modelId = isSpecMode ? specModel : regularModel;
  const customModels = getSettingsService().getCustomModels();
  const customModel = findCustomModel(modelId, customModels);
  return { modelId, customModel, exists: true };
}

/**
 * Resolve a model id with BYOK precedence and a caller-supplied fallback.
 *
 * If the active session model is a configured BYOK custom model, return
 * it as-is. Otherwise fall back to `fallback` — a static model id or a
 * callback that can read the (non-BYOK) active session resolution to
 * make a context-dependent choice (e.g. compaction following the current
 * session model).
 *
 * Returns the resolved model id along with the matched custom model so
 * callers can apply per-model caps (e.g. `customModel.maxOutputTokens`)
 * without repeating the lookup.
 */
export function resolveModelWithByokFallback(opts: {
  fallback: string | ((active: ResolveModelResult) => string);
}): ResolveModelResult {
  const active = resolveActiveSessionModel();
  if (active.customModel) {
    return active;
  }
  const fallbackId =
    typeof opts.fallback === 'string' ? opts.fallback : opts.fallback(active);
  // Re-run the custom-model lookup against the fallback id so a
  // user-configured `compactionModel === CURRENT_COMPACTION_MODEL` that happens to
  // resolve to a `custom:*` id still threads BYOK config through.
  const customModels = getSettingsService().getCustomModels();
  return {
    modelId: fallbackId,
    customModel: findCustomModel(fallbackId, customModels),
    exists: true,
  };
}
