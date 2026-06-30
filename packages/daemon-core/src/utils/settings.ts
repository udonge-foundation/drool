import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

import {
  type DaemonGetDefaultSettingsResult,
  type DaemonSessionDefaultsManagementMap,
  type DaemonUpdateSessionDefaultsRequestParams,
  type DaemonUpdateSessionDefaultsResult,
} from '@industry/common/daemon';
import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import {
  CURRENT_COMPACTION_MODEL,
  DEFAULT_GENERAL_SETTINGS,
  LEGACY_INDUSTRY_DEFAULT_COMPACTION_MODEL,
  type MissionModelSettings,
  type SessionDefaultSettings,
  type SettingsResolutionEvent,
  SubagentAutonomyLevel,
  type SubagentModelSettings,
} from '@industry/common/settings';
import { IndustryRegion } from '@industry/common/shared';
import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getAuthToken, getRegion } from '@industry/runtime/auth';
import {
  mergeHierarchyWithChain,
  SettingsManager,
  type SettingsHierarchyLevel,
} from '@industry/runtime/settings';
import {
  deriveAutonomyMode,
  resolveInteractionSettingsWithLegacyFallback,
  resolveLegacyCompatibleAutonomyMode,
} from '@industry/utils/autonomy';
import {
  CLI_MODELS,
  getModelConfig,
  MISSION_ORCHESTRATOR_MODEL,
  MISSION_VALIDATION_WORKER_MODEL,
} from '@industry/utils/llm';
import {
  applyModelPolicy,
  getAvailableModelsForResponse,
  resolveSelectableModel,
} from '@industry/utils/models';
import {
  createResolutionEvent,
  MISSION_SETTING_KEYS,
  MISSION_WORKER_ROLES,
  missionWorkerRoleModelKey,
  missionWorkerRoleReasoningKey,
  SUBAGENT_SETTING_KEYS,
  SUBAGENT_TIERS,
  subagentModelKey,
  subagentReasoningKey,
} from '@industry/utils/settings';
import {
  findProjectIndustryWithinGit,
  getUserIndustryDir,
  resolveSpecSaveDirectory,
} from '@industry/utils/specPaths';

import { getApiClient } from '../services/ApiClient';

interface FeatureFlagsApiResponse {
  flags?: Record<string, boolean>;
  configs?: Record<string, unknown>;
}

/**
 * Gets default feature flag values.
 */
function getDefaultFeatureFlagValues(): Record<string, boolean> {
  const defaultFlags: Record<string, boolean> = {};
  Object.entries(IndustryFeatureFlags).forEach(([_key, flag]) => {
    defaultFlags[flag.statsigName] = flag.defaultValue;
  });
  return defaultFlags;
}

/**
 * Creates a feature flag fetcher for the daemon.
 * Falls back to default values if user is not authenticated or API call fails.
 */
interface FetchedFlags {
  flags: Record<string, boolean>;
  source: 'remote' | 'defaults';
}

type AnnotatedAvailableModel = ReturnType<typeof applyModelPolicy>[number];

const SESSION_DEFAULT_FIELD_ENTRIES = [
  ['modelId', 'model'],
  ['reasoningEffort', 'reasoningEffort'],
  ['interactionMode', 'interactionMode'],
  ['autonomyLevel', 'autonomyLevel'],
  ['autonomyMode', 'autonomyMode'],
  ['specModeModelId', 'specModeModel'],
  ['specModeReasoningEffort', 'specModeReasoningEffort'],
  ['runInWorktree', 'runInWorktree'],
] as const satisfies readonly (readonly [
  keyof DaemonSessionDefaultsManagementMap,
  keyof SessionDefaultSettings,
])[];

const MANAGED_SETTINGS_LEVELS = new Set<SettingsLevel>([
  SettingsLevel.Runtime,
  SettingsLevel.Folder,
  SettingsLevel.Project,
]);

const SESSION_DEFAULT_PRECEDENCE: Record<SettingsLevel, number> = {
  [SettingsLevel.Runtime]: 0,
  [SettingsLevel.Folder]: 1,
  [SettingsLevel.Project]: 2,
  [SettingsLevel.User]: 3,
  [SettingsLevel.Org]: 4,
  [SettingsLevel.Dynamic]: 5,
  [SettingsLevel.BuiltIn]: 6,
};

function isManagedSource(level: SettingsLevel | null): boolean {
  return level !== null && MANAGED_SETTINGS_LEVELS.has(level);
}

function getSourceByPrecedence(
  hierarchy: SettingsHierarchyLevel[],
  hasValue: (entry: SettingsHierarchyLevel) => boolean
): SettingsHierarchyLevel | null {
  let winner: SettingsHierarchyLevel | null = null;
  let winnerPrecedence = Number.MAX_SAFE_INTEGER;
  for (const entry of hierarchy) {
    if (!hasValue(entry)) continue;
    const precedence =
      SESSION_DEFAULT_PRECEDENCE[entry.level] ?? Number.MAX_SAFE_INTEGER;
    if (precedence < winnerPrecedence) {
      winner = entry;
      winnerPrecedence = precedence;
    }
  }
  return winner;
}

function toManagementInfo(source: SettingsHierarchyLevel | null) {
  return {
    disabled: isManagedSource(source?.level ?? null),
    source: source?.level ?? null,
    folderPath: source?.folderPath,
  };
}

function buildManagementMap(
  hierarchy: SettingsHierarchyLevel[]
): DaemonSessionDefaultsManagementMap {
  const management: DaemonSessionDefaultsManagementMap = {};
  for (const [responseKey, settingsKey] of SESSION_DEFAULT_FIELD_ENTRIES) {
    const source = getSourceByPrecedence(
      hierarchy,
      (entry) =>
        entry.settings.general?.sessionDefaultSettings?.[settingsKey] !==
        undefined
    );
    management[responseKey] = toManagementInfo(source);
  }
  for (const responseKey of [
    'compactionTokenLimit',
    'compactionTokenLimitPerModel',
    'compactionModel',
    'specSaveDir',
    'worktreeDirectory',
    'subagentAutonomyLevel',
  ] as const) {
    const source =
      hierarchy.find(
        (entry) => entry.settings.general?.[responseKey] !== undefined
      ) ?? null;
    management[responseKey] = toManagementInfo(source);
  }
  // Expose canonical management ownership through the pre-existing wire field.
  management.compactionModelMode = management.compactionModel;
  const subagent: NonNullable<DaemonSessionDefaultsManagementMap['subagent']> =
    {};
  for (const key of SUBAGENT_SETTING_KEYS) {
    const source = getSourceByPrecedence(
      hierarchy,
      (entry) =>
        entry.settings.general?.subagentModelSettings?.[key] !== undefined
    );
    subagent[key] = toManagementInfo(source);
  }
  management.subagent = subagent;

  const mission: NonNullable<DaemonSessionDefaultsManagementMap['mission']> =
    {};
  mission.orchestratorModel = toManagementInfo(
    getSourceByPrecedence(
      hierarchy,
      (entry) => entry.settings.general?.missionOrchestratorModel !== undefined
    )
  );
  mission.orchestratorReasoningEffort = toManagementInfo(
    getSourceByPrecedence(
      hierarchy,
      (entry) =>
        entry.settings.general?.missionOrchestratorReasoningEffort !== undefined
    )
  );
  for (const key of MISSION_SETTING_KEYS) {
    const source = getSourceByPrecedence(
      hierarchy,
      (entry) =>
        entry.settings.general?.missionModelSettings?.[key] !== undefined
    );
    mission[key] = toManagementInfo(source);
  }
  management.mission = mission;
  return management;
}

function clampReasoningForModel(
  availableModels: NonNullable<
    DaemonGetDefaultSettingsResult['availableModels']
  >,
  modelId: string | undefined,
  effort: ReasoningEffort | undefined
): ReasoningEffort | undefined {
  if (!modelId || !effort) return effort;
  const model = availableModels.find((candidate) => candidate.id === modelId);
  if (!model) return effort;
  return model.supportedReasoningEfforts.includes(effort)
    ? effort
    : model.defaultReasoningEffort;
}

function resolveSelectableModelId(
  modelId: string | undefined,
  availableModels: readonly AnnotatedAvailableModel[]
): string | undefined {
  if (modelId === undefined) return undefined;
  if (availableModels.length === 0) return modelId;
  return resolveSelectableModel(modelId, availableModels)?.id;
}

function assertSelectableDefaultModel(
  modelId: string,
  availableModels: readonly AnnotatedAvailableModel[]
): void {
  if (availableModels.length === 0) return;
  const model = availableModels.find((candidate) => candidate.id === modelId);
  if (model && !model.disabled) return;
  throw new MetaError('Model is not available', { modelId });
}

function resolveMissionModelSettings(
  configuredSettings: MissionModelSettings | undefined
): Required<MissionModelSettings> {
  const defaults = DEFAULT_GENERAL_SETTINGS.missionModelSettings;
  return {
    workerModel:
      configuredSettings?.workerModel ??
      defaults?.workerModel ??
      MISSION_ORCHESTRATOR_MODEL,
    workerReasoningEffort:
      configuredSettings?.workerReasoningEffort ??
      defaults?.workerReasoningEffort ??
      ReasoningEffort.High,
    validationWorkerModel:
      configuredSettings?.validationWorkerModel ??
      defaults?.validationWorkerModel ??
      MISSION_VALIDATION_WORKER_MODEL,
    validationWorkerReasoningEffort:
      configuredSettings?.validationWorkerReasoningEffort ??
      defaults?.validationWorkerReasoningEffort ??
      ReasoningEffort.High,
    skipScrutiny: configuredSettings?.skipScrutiny ?? false,
    skipUserTesting: configuredSettings?.skipUserTesting ?? false,
  };
}

async function fetchFeatureFlags(): Promise<FetchedFlags> {
  const apiClient = getApiClient();
  const runtimeAuthConfig = apiClient?.getRuntimeAuthConfig?.();
  if (!apiClient || !runtimeAuthConfig) {
    return { flags: getDefaultFeatureFlagValues(), source: 'defaults' };
  }
  const token = await getAuthToken(runtimeAuthConfig);
  if (!token) {
    return { flags: getDefaultFeatureFlagValues(), source: 'defaults' };
  }

  try {
    const response =
      await apiClient.get<FeatureFlagsApiResponse>('/api/feature-flags');
    const remoteFlags = response.data.flags ?? {};

    // Merge with default values for any missing flags
    const mergedFlags: Record<string, boolean> = {};
    Object.entries(IndustryFeatureFlags).forEach(([_key, flag]) => {
      const { statsigName, defaultValue } = flag;
      mergedFlags[statsigName] =
        remoteFlags[statsigName] !== undefined
          ? remoteFlags[statsigName]
          : defaultValue;
    });

    return { flags: mergedFlags, source: 'remote' };
  } catch (error) {
    logWarn('Failed to fetch feature flags, using defaults', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { flags: getDefaultFeatureFlagValues(), source: 'defaults' };
  }
}

/**
 * Build per-model resolution events showing which feature flag enabled/disabled each model.
 */
function buildModelResolutionEvents(
  flags: Record<string, boolean>,
  flagSource: 'remote' | 'defaults',
  customModels: { id: string }[],
  modelPolicy?: {
    allowedModelIds?: string[];
    blockedModelIds?: string[];
    allowCustomModels?: boolean;
    allowAllIndustryModels?: boolean;
  }
): SettingsResolutionEvent[] {
  const events: SettingsResolutionEvent[] = [];
  const allowedIds = modelPolicy?.allowedModelIds ?? [];
  const blockedIds = modelPolicy?.blockedModelIds ?? [];
  const allowAllIndustry = modelPolicy?.allowAllIndustryModels ?? true;
  const hasPolicyRestrictions =
    blockedIds.length > 0 || (allowedIds.length > 0 && !allowAllIndustry);
  const usingDefaults = flagSource === 'defaults';

  for (const modelId of CLI_MODELS) {
    const config = getModelConfig(modelId);
    const flag = config.featureFlag;

    // Check feature flag first
    let enabledByFlag = true;
    if (flag) {
      enabledByFlag = flags[flag.statsigName] ?? flag.defaultValue;
    }

    // Check org model policy
    let blockedByPolicy = false;
    let policyReason: string | undefined;
    if (enabledByFlag && hasPolicyRestrictions) {
      if (blockedIds.includes(modelId)) {
        blockedByPolicy = true;
        policyReason = 'Blocked by org model policy (blocklist)';
      } else if (
        !allowAllIndustry &&
        allowedIds.length > 0 &&
        !allowedIds.includes(modelId)
      ) {
        blockedByPolicy = true;
        policyReason = 'Not in org model policy allowlist';
      }
    }

    const defaultsSuffix = usingDefaults
      ? ' (using hardcoded defaults — daemon not authenticated)'
      : '';

    events.push(
      createResolutionEvent('daemon-model-flag-check', {
        keys: [`availableModels.${modelId}`],
        action: enabledByFlag && !blockedByPolicy ? 'set' : 'skip',
        source: { type: 'feature-flag', flagName: flag?.statsigName },
        reason: !enabledByFlag
          ? `Model disabled by feature flag${defaultsSuffix}`
          : blockedByPolicy
            ? policyReason!
            : flag
              ? `Model enabled by feature flag${defaultsSuffix}`
              : 'No feature flag gate (always available)',
      })
    );
  }

  const allowCustom = modelPolicy?.allowCustomModels ?? true;
  for (const model of customModels) {
    events.push(
      createResolutionEvent('daemon-custom-model-check', {
        keys: [`availableModels.${model.id}`],
        action: allowCustom ? 'set' : 'skip',
        source: { type: 'user', filePath: '~/.industry/settings.json' },
        reason: allowCustom
          ? 'Custom BYOK model'
          : 'Custom BYOK model blocked by org policy (allowCustomModels: false)',
      })
    );
  }

  return events;
}

/**
 * Gets the default settings for new sessions.
 * Uses SettingsManager for properly resolved and typed settings.
 * Includes a resolution chain tracking how each setting was resolved.
 */
export async function getDefaultSettings(): Promise<DaemonGetDefaultSettingsResult> {
  try {
    // Refresh to ensure we read the latest settings from disk.
    // The CLI (separate process) may have updated settings.json since daemon started.
    const settingsManager = SettingsManager.getInstance();
    settingsManager.refresh();
    const hierarchy =
      await settingsManager.getSettingsHierarchyWithAttribution();
    const { settings, resolutionChain } = mergeHierarchyWithChain(hierarchy);
    const sessionDefaults = settings.general?.sessionDefaultSettings;
    const { interactionMode, autonomyLevel } =
      resolveInteractionSettingsWithLegacyFallback({
        interactionMode: sessionDefaults?.interactionMode,
        autonomyLevel: sessionDefaults?.autonomyLevel,
        autonomyMode: sessionDefaults?.autonomyMode,
      });
    const autonomyMode = resolveLegacyCompatibleAutonomyMode({
      interactionMode,
      autonomyLevel,
      autonomyMode: sessionDefaults?.autonomyMode,
    });
    const customModels = settings.general?.customModels ?? [];

    // Fetch feature flags and build per-model events (including org model policy)
    const { flags, source: flagSource } = await fetchFeatureFlags();
    const modelPolicy = settings.general?.modelPolicy;
    const modelEvents = buildModelResolutionEvents(
      flags,
      flagSource,
      customModels,
      modelPolicy
    );

    const runtimeAuthConfig = getApiClient()?.getRuntimeAuthConfig?.();
    const region = runtimeAuthConfig
      ? await getRegion(runtimeAuthConfig)
      : IndustryRegion.Global;

    const { industryDir: projectIndustryDir } = findProjectIndustryWithinGit();

    const compactionModel =
      settings.general?.compactionModel ?? CURRENT_COMPACTION_MODEL;

    const availableModels = applyModelPolicy(
      await getAvailableModelsForResponse(
        () => Promise.resolve(flags),
        customModels,
        region
      ),
      modelPolicy
    );
    const modelId = resolveSelectableModelId(
      sessionDefaults?.model,
      availableModels
    );
    const specModeModelId = resolveSelectableModelId(
      sessionDefaults?.specModeModel,
      availableModels
    );

    return {
      autonomyMode,
      interactionMode,
      autonomyLevel,
      maxAutonomyLevel: settings.general?.maxAutonomyLevel,
      modelId,
      reasoningEffort: clampReasoningForModel(
        availableModels,
        modelId,
        sessionDefaults?.reasoningEffort
      ),
      specSaveDir: settings.general?.specSaveDir,
      specModeModelId,
      specModeReasoningEffort: clampReasoningForModel(
        availableModels,
        specModeModelId,
        sessionDefaults?.specModeReasoningEffort
      ),
      compactionTokenLimit: settings.general?.compactionTokenLimit,
      compactionTokenLimitPerModel:
        settings.general?.compactionTokenLimitPerModel,
      compactionModel,
      // Older clients can only render the former two-state model choice.
      compactionModelMode:
        compactionModel === CURRENT_COMPACTION_MODEL
          ? CURRENT_COMPACTION_MODEL
          : 'industry-default',
      runInWorktree: sessionDefaults?.runInWorktree,
      worktreeDirectory: settings.general?.worktreeDirectory,
      subagentAutonomyLevel: settings.general?.subagentAutonomyLevel,
      management: buildManagementMap(hierarchy),
      missionOrchestratorModel: settings.general?.missionOrchestratorModel,
      missionOrchestratorReasoningEffort:
        settings.general?.missionOrchestratorReasoningEffort,
      missionSettings: resolveMissionModelSettings(
        settings.general?.missionModelSettings
      ),
      subagentModelSettings: settings.general?.subagentModelSettings,
      availableModels,
      specSavePresets: {
        userIndustryDir: getUserIndustryDir(),
        ...(projectIndustryDir ? { projectIndustryDir } : {}),
      },
      resolutionChain: [...resolutionChain, ...modelEvents],
    };
  } catch (error) {
    logWarn('Failed to get default settings', { cause: error });
    return {};
  }
}

/**
 * Lightweight read of just the worktree-related session defaults from disk.
 * Used by the initialize-session daemon handler to fall back when the
 * frontend submits before its async settings query has resolved.
 */
export async function getWorktreeDefaults(): Promise<{
  runInWorktree: boolean | undefined;
  worktreeDirectory: string | undefined;
}> {
  try {
    const settingsManager = SettingsManager.getInstance();
    settingsManager.refresh();
    const hierarchy =
      await settingsManager.getSettingsHierarchyWithAttribution();
    const { settings } = mergeHierarchyWithChain(hierarchy);
    return {
      runInWorktree: settings.general?.sessionDefaultSettings?.runInWorktree,
      worktreeDirectory: settings.general?.worktreeDirectory,
    };
  } catch (error) {
    logWarn('Failed to read worktree defaults', { cause: error });
    return { runInWorktree: undefined, worktreeDirectory: undefined };
  }
}

type MissionGeneralPatch = Partial<{
  missionOrchestratorModel: string | undefined;
  missionOrchestratorReasoningEffort: ReasoningEffort | undefined;
  missionModelSettings: MissionModelSettings;
}>;

function buildMissionSettingsPatch(
  params: DaemonUpdateSessionDefaultsRequestParams,
  currentDefaults: DaemonGetDefaultSettingsResult
): MissionGeneralPatch {
  const availableModels = currentDefaults.availableModels ?? [];
  const stored = currentDefaults.missionSettings;
  const fallbackModel = currentDefaults.modelId;
  const general: MissionGeneralPatch = {};

  if (params.missionOrchestratorModel === null) {
    general.missionOrchestratorModel = undefined;
    general.missionOrchestratorReasoningEffort = undefined;
  } else if (params.missionOrchestratorModel !== undefined) {
    general.missionOrchestratorModel = params.missionOrchestratorModel;
    const nextEffort =
      params.missionOrchestratorReasoningEffort === null
        ? undefined
        : (params.missionOrchestratorReasoningEffort ??
          currentDefaults.missionOrchestratorReasoningEffort);
    general.missionOrchestratorReasoningEffort = clampReasoningForModel(
      availableModels,
      params.missionOrchestratorModel,
      nextEffort
    );
  } else if (params.missionOrchestratorReasoningEffort === null) {
    general.missionOrchestratorReasoningEffort = undefined;
  } else if (params.missionOrchestratorReasoningEffort !== undefined) {
    const orchestratorModel =
      currentDefaults.missionOrchestratorModel ?? fallbackModel;
    general.missionOrchestratorReasoningEffort = clampReasoningForModel(
      availableModels,
      orchestratorModel,
      params.missionOrchestratorReasoningEffort
    );
  }

  const missionPatch = params.missionModelSettings;
  if (!missionPatch) {
    return general;
  }

  const next: MissionModelSettings = {};

  for (const role of MISSION_WORKER_ROLES) {
    const modelKey = missionWorkerRoleModelKey(role);
    const reasoningKey = missionWorkerRoleReasoningKey(role);
    const nextModel = missionPatch[modelKey];
    const nextReasoning = missionPatch[reasoningKey];

    if (nextModel !== undefined) {
      next[modelKey] = nextModel;
    }

    if (nextReasoning !== undefined || nextModel !== undefined) {
      const roleModel = nextModel ?? stored?.[modelKey] ?? fallbackModel;
      const roleEffort = nextReasoning ?? stored?.[reasoningKey];
      const clamped = clampReasoningForModel(
        availableModels,
        roleModel,
        roleEffort
      );
      if (clamped !== undefined) {
        next[reasoningKey] = clamped;
      }
    }
  }

  if (missionPatch.skipScrutiny !== undefined) {
    next.skipScrutiny = missionPatch.skipScrutiny;
  }
  if (missionPatch.skipUserTesting !== undefined) {
    next.skipUserTesting = missionPatch.skipUserTesting;
  }

  if (Object.keys(next).length > 0) {
    general.missionModelSettings = next;
  }
  return general;
}

function buildSubagentSettingsPatch(
  patch: DaemonUpdateSessionDefaultsRequestParams['subagentModelSettings'],
  inheritTiers: DaemonUpdateSessionDefaultsRequestParams['subagentInheritTiers'],
  currentDefaults: DaemonGetDefaultSettingsResult
): SubagentModelSettings | undefined {
  const tiersToInherit = new Set(inheritTiers ?? []);
  if (!patch && tiersToInherit.size === 0) return undefined;
  const result: SubagentModelSettings = {};
  const stored = currentDefaults.subagentModelSettings;
  const fallbackModel = currentDefaults.modelId;
  const availableModels = currentDefaults.availableModels ?? [];

  for (const tier of SUBAGENT_TIERS) {
    const modelKey = subagentModelKey(tier);
    const reasoningKey = subagentReasoningKey(tier);

    // Resetting a tier clears any pinned model/reasoning so it inherits the
    // spawning session's model.
    if (tiersToInherit.has(tier)) {
      result[modelKey] = undefined;
      result[reasoningKey] = undefined;
      continue;
    }

    const nextModel = patch?.[modelKey];
    const nextReasoning = patch?.[reasoningKey];

    if (nextModel !== undefined) {
      result[modelKey] = nextModel;
    }

    if (nextReasoning !== undefined || nextModel !== undefined) {
      const tierModel = nextModel ?? stored?.[modelKey] ?? fallbackModel;
      const tierEffort = nextReasoning ?? stored?.[reasoningKey];
      const clamped = clampReasoningForModel(
        availableModels,
        tierModel,
        tierEffort
      );
      if (clamped !== undefined) {
        result[reasoningKey] = clamped;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Validate a `specSaveDir` setting value and return the patch to apply to
 * general settings.
 *
 * For absolute paths and `~`-prefixed paths, the directory is created (if
 * missing) and probed for writability so we can fail fast with inline UI
 * feedback. For project-relative shorthands like `.industry/docs` we skip the
 * disk probe: the daemon's CWD typically isn't the workspace where future
 * sessions will run, so probing here would create directories in unrelated
 * places and produce misleading pass/fail results. Resolution and writability
 * for those values are deferred to session start.
 *
 * Pass `null` to clear the override.
 *
 * Throws `MetaError` with a user-facing message when the directory cannot
 * be created or written to.
 */
async function resolveAndValidateSpecSaveDir(
  value: string | null
): Promise<{ specSaveDir?: string }> {
  if (value === null) {
    return { specSaveDir: undefined };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new MetaError('Spec save directory cannot be empty', {});
  }

  const shouldProbeDisk =
    path.isAbsolute(trimmed) || trimmed === '~' || trimmed.startsWith('~/');
  if (!shouldProbeDisk) {
    return { specSaveDir: trimmed };
  }

  let resolved: string;
  try {
    resolved = resolveSpecSaveDirectory(trimmed);
  } catch (err) {
    throw new MetaError('Failed to resolve spec save directory', {
      cause: err,
    });
  }

  try {
    await fsPromises.mkdir(resolved, { recursive: true });
    await fsPromises.access(resolved, fs.constants.W_OK);
  } catch (err) {
    throw new MetaError(`Spec save directory is not writable: ${resolved}`, {
      cause: err,
    });
  }

  return { specSaveDir: trimmed };
}

export async function updateSessionDefaults(
  params: DaemonUpdateSessionDefaultsRequestParams
): Promise<DaemonUpdateSessionDefaultsResult> {
  const settingsManager = SettingsManager.getInstance();
  const currentDefaults = await getDefaultSettings();
  const currentModel = params.modelId ?? currentDefaults.modelId;
  const availableModels = currentDefaults.availableModels ?? [];
  const sessionDefaultSettings: Partial<SessionDefaultSettings> = {};

  if (params.modelId !== undefined) {
    assertSelectableDefaultModel(params.modelId, availableModels);
    sessionDefaultSettings.model = params.modelId;
    sessionDefaultSettings.reasoningEffort = clampReasoningForModel(
      availableModels,
      params.modelId,
      params.reasoningEffort ?? currentDefaults.reasoningEffort
    );
  } else if (params.reasoningEffort !== undefined) {
    sessionDefaultSettings.reasoningEffort = clampReasoningForModel(
      availableModels,
      currentModel,
      params.reasoningEffort
    );
  }

  const nextInteractionMode =
    params.interactionMode ?? currentDefaults.interactionMode;
  const nextAutonomyLevel =
    params.autonomyLevel ?? currentDefaults.autonomyLevel;
  if (params.interactionMode !== undefined) {
    sessionDefaultSettings.interactionMode = params.interactionMode;
  }
  if (params.autonomyLevel !== undefined) {
    sessionDefaultSettings.autonomyLevel = params.autonomyLevel;
  }
  if (
    (params.interactionMode !== undefined ||
      params.autonomyLevel !== undefined) &&
    nextInteractionMode !== undefined &&
    nextAutonomyLevel !== undefined
  ) {
    sessionDefaultSettings.autonomyMode = deriveAutonomyMode(
      nextInteractionMode,
      nextAutonomyLevel
    );
  }

  if (params.specModeModelId === null) {
    sessionDefaultSettings.specModeModel = undefined;
    sessionDefaultSettings.specModeReasoningEffort = undefined;
  } else if (params.specModeModelId !== undefined) {
    assertSelectableDefaultModel(params.specModeModelId, availableModels);
    sessionDefaultSettings.specModeModel = params.specModeModelId;
    sessionDefaultSettings.specModeReasoningEffort = clampReasoningForModel(
      availableModels,
      params.specModeModelId,
      params.specModeReasoningEffort ?? currentDefaults.specModeReasoningEffort
    );
  } else if (params.specModeReasoningEffort !== undefined) {
    const specModel = currentDefaults.specModeModelId ?? currentModel;
    sessionDefaultSettings.specModeReasoningEffort =
      params.specModeReasoningEffort === null
        ? undefined
        : clampReasoningForModel(
            availableModels,
            specModel,
            params.specModeReasoningEffort
          );
  }

  if (params.runInWorktree === null) {
    sessionDefaultSettings.runInWorktree = undefined;
  } else if (params.runInWorktree !== undefined) {
    sessionDefaultSettings.runInWorktree = params.runInWorktree;
  }

  const subagentPatch = buildSubagentSettingsPatch(
    params.subagentModelSettings,
    params.subagentInheritTiers,
    currentDefaults
  );

  let specSaveDirPatch: { specSaveDir?: string } | undefined;
  if (params.specSaveDir !== undefined) {
    specSaveDirPatch = await resolveAndValidateSpecSaveDir(params.specSaveDir);
  }

  let worktreeDirectoryPatch: { worktreeDirectory?: string } | undefined;
  if (params.worktreeDirectory === null) {
    worktreeDirectoryPatch = { worktreeDirectory: undefined };
  } else if (params.worktreeDirectory !== undefined) {
    const trimmed = params.worktreeDirectory.trim();
    worktreeDirectoryPatch = trimmed
      ? { worktreeDirectory: trimmed }
      : { worktreeDirectory: undefined };
  }

  let subagentAutonomyLevelPatch:
    | { subagentAutonomyLevel?: SubagentAutonomyLevel }
    | undefined;
  if (params.subagentAutonomyLevel === null) {
    subagentAutonomyLevelPatch = { subagentAutonomyLevel: undefined };
  } else if (params.subagentAutonomyLevel !== undefined) {
    subagentAutonomyLevelPatch = {
      subagentAutonomyLevel: params.subagentAutonomyLevel,
    };
  }

  const missionPatch = buildMissionSettingsPatch(params, currentDefaults);
  // `compactionModelMode` is retained only as an existing daemon request input.
  const compactionModel =
    params.compactionModel ??
    (params.compactionModelMode === CURRENT_COMPACTION_MODEL
      ? CURRENT_COMPACTION_MODEL
      : params.compactionModelMode === 'industry-default'
        ? LEGACY_INDUSTRY_DEFAULT_COMPACTION_MODEL
        : undefined);

  await settingsManager.updateLevelSettings(SettingsLevel.User, {
    general: {
      ...(Object.keys(sessionDefaultSettings).length > 0
        ? { sessionDefaultSettings }
        : {}),
      ...(params.compactionTokenLimit !== undefined
        ? { compactionTokenLimit: params.compactionTokenLimit }
        : {}),
      ...(params.compactionTokenLimitPerModel !== undefined
        ? { compactionTokenLimitPerModel: params.compactionTokenLimitPerModel }
        : {}),
      ...(compactionModel !== undefined ? { compactionModel } : {}),
      ...(subagentPatch ? { subagentModelSettings: subagentPatch } : {}),
      ...(specSaveDirPatch ?? {}),
      ...(worktreeDirectoryPatch ?? {}),
      ...(subagentAutonomyLevelPatch ?? {}),
      ...missionPatch,
    },
  });

  return { success: true, defaults: await getDefaultSettings() };
}
