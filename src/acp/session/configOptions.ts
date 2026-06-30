/**
 * Build ACP `configOptions` payloads for session lifecycle responses
 * (`session/new`, `session/load`, `session/resume`) and
 * `config_option_update` notifications.
 *
 * Per ACP spec (https://agentclientprotocol.com/protocol/session-config-options),
 * the payload is a `ConfigOption[]` (top-level array). Each option declares
 * `type: "select"`, a `category` (we use the spec's reserved
 * `"mode"` / `"model"` / `"thought_level"`), and an `options` list of
 * `{ value, name, description? }` entries.
 *
 * `reasoning_effort.options` is model-dependent: the active model decides
 * which efforts are advertised, so a `model` change is expected to fire a
 * subsequent `config_option_update` carrying the refreshed reasoning options.
 */
import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import { AutonomyMode } from '@industry/drool-sdk-ext/protocol/shared';
import { logWarn } from '@industry/logging';
import { getModelConfig, isAvailableInCLI } from '@industry/utils/llm';

import {
  AUTONOMY_LEVEL_LABELS,
  CONFIG_OPTION_AUTONOMY_LEVEL,
  CONFIG_OPTION_MODEL,
  CONFIG_OPTION_REASONING_EFFORT,
  DEFAULT_REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
} from '@/acp/session/constants';
import {
  getAllowedAcpAutonomyModes,
  resolveAllowedAcpAutonomyMode,
} from '@/acp/session/modes';
import type {
  ConfigOption,
  ConfigOptionsModelEntry,
  ConfigOptionsState,
} from '@/acp/session/types';

/**
 * Get the reasoning effort values advertised for the given model.
 *
 * Built-in models route through the shared `getModelConfig()` registry,
 * which is the same source `drool exec --help` prints. Custom/BYOK models
 * fall back to a sensible default set.
 */
export function getSupportedReasoningEfforts(
  modelId: string
): ReasoningEffort[] {
  if (!isAvailableInCLI(modelId)) {
    return DEFAULT_REASONING_EFFORTS;
  }
  try {
    return getModelConfig(modelId).supportedReasoningEfforts;
  } catch (error) {
    logWarn('[ACP] Failed to read supported reasoning efforts for model', {
      cause: error,
      modelId,
    });
    return DEFAULT_REASONING_EFFORTS;
  }
}

function buildReasoningEffortOption(
  modelId: string,
  currentValue: ReasoningEffort
): ConfigOption {
  const supported = getSupportedReasoningEfforts(modelId);
  const effortSet = supported.includes(currentValue)
    ? supported
    : [...supported, currentValue];

  return {
    id: CONFIG_OPTION_REASONING_EFFORT,
    name: 'Reasoning Effort',
    description:
      'Controls how much thinking the model performs before responding. The available options depend on the selected model.',
    category: 'thought_level',
    type: 'select',
    currentValue,
    options: effortSet.map((effort) => ({
      value: effort,
      name: REASONING_EFFORT_LABELS[effort] ?? effort,
    })),
  };
}

function buildAutonomyLevelOption(
  currentValue: AutonomyMode,
  availableModes: AutonomyMode[] = getAllowedAcpAutonomyModes()
): ConfigOption {
  const resolvedCurrentValue = availableModes.includes(currentValue)
    ? currentValue
    : (() => {
        const resolvedMode = resolveAllowedAcpAutonomyMode(currentValue);
        return availableModes.includes(resolvedMode)
          ? resolvedMode
          : (availableModes[availableModes.length - 1] ?? AutonomyMode.Normal);
      })();
  const ordered = availableModes.includes(resolvedCurrentValue)
    ? availableModes
    : [...availableModes, resolvedCurrentValue];

  return {
    id: CONFIG_OPTION_AUTONOMY_LEVEL,
    name: 'Autonomy Level',
    description: 'Which tool actions the agent may run without confirmation.',
    category: 'mode',
    type: 'select',
    currentValue: resolvedCurrentValue,
    options: ordered.map((mode) => ({
      value: mode,
      name: AUTONOMY_LEVEL_LABELS[mode] ?? mode,
    })),
  };
}

function buildModelOption(
  currentValue: string,
  availableModels: ConfigOptionsModelEntry[]
): ConfigOption {
  const options = availableModels.map((m) => ({
    value: m.modelId,
    name: m.name,
    ...(m.description ? { description: m.description } : {}),
  }));

  // Per spec the `currentValue` MUST appear in `options`. If the caller
  // couldn't load the canonical list (network failure, etc.), still expose
  // the current model so clients can render it.
  if (currentValue && !options.some((o) => o.value === currentValue)) {
    options.push({ value: currentValue, name: currentValue });
  }

  return {
    id: CONFIG_OPTION_MODEL,
    name: 'Model',
    description:
      'The model used for this session. Changing this may also change the available Reasoning Effort options.',
    category: 'model',
    type: 'select',
    currentValue,
    options,
  };
}

/**
 * Build the full configOptions payload for a session lifecycle response.
 *
 * Order matches the ACP spec example (mode → model → thought_level) and is
 * meaningful to clients; higher-priority/most-frequently-changed options
 * come first.
 */
export function buildConfigOptions(params: {
  modelId: string;
  reasoningEffort: ReasoningEffort;
  autonomyMode: AutonomyMode;
  availableModels: ConfigOptionsModelEntry[];
  availableAutonomyModes?: AutonomyMode[];
}): ConfigOptionsState {
  return [
    buildAutonomyLevelOption(
      params.autonomyMode,
      params.availableAutonomyModes
    ),
    buildModelOption(params.modelId, params.availableModels),
    buildReasoningEffortOption(params.modelId, params.reasoningEffort),
  ];
}

/**
 * Check whether a given value is a valid ReasoningEffort enum value.
 */
export function isValidReasoningEffort(
  value: string
): value is ReasoningEffort {
  return (Object.values(ReasoningEffort) as string[]).includes(value);
}

/**
 * Check whether a given value is a valid AutonomyMode enum value.
 */
export function isValidAutonomyMode(value: string): value is AutonomyMode {
  return (Object.values(AutonomyMode) as string[]).includes(value);
}
