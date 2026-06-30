import * as path from 'path';

import {
  DiffMode,
  HookConfig,
  HooksSettings,
  LogoAnimationMode,
  TodoDisplayMode,
  ToolResultDisplay,
  type StatusLineConfig,
} from '@industry/common/cli';
import { IndustryTier } from '@industry/common/organization';
import {
  MODEL_POLICY_VIOLATION_ERROR,
  type ModelPolicy,
} from '@industry/common/policy';
import {
  CURRENT_COMPACTION_MODEL,
  BuiltInSound,
  DEFAULT_GENERAL_SETTINGS,
  type CustomModel,
  type DroolModel,
  type IndustryRouterRule,
  type ManagedSettings,
  type McpSettings,
  type MissionModelSettings,
  type SandboxSettings,
  type SessionDefaultSettings,
  type Settings,
  SettingsResolutionEvent,
  type SubagentModelSettings,
  type TrustedFolders,
} from '@industry/common/settings';
import {
  SoundFocusMode,
  SubagentAutonomyLevel,
  SubagentSoundMode,
} from '@industry/common/settings/enums';
import { ModelID, ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import {
  AutonomyLevel,
  AutonomyMode,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logException, logInfo, logWarn, logWarnOnce } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  SettingsManager,
  mergeHierarchyWithChain,
  type SettingsChangedEvent,
  type SettingsHierarchyLevel,
} from '@industry/runtime/settings';
import { deriveAutonomyMode, parseAutonomyMode } from '@industry/utils/autonomy';
import { getIndustryHome } from '@industry/utils/cli';
import {
  getIndustryDirName,
  getProcessEnvironment,
} from '@industry/utils/environment';
import {
  CLI_MODELS,
  getLLMModel,
  isAvailableInCLI,
  isRouterModel,
  MISSION_VALIDATION_WORKER_MODEL,
  resolveDefaultIndustryModel,
  resolveModelId,
} from '@industry/utils/llm';
import {
  findCustomModel,
  getCustomModelPolicyBaseUrl,
  isCustomModelBaseUrlAllowed,
  parseCustomModelId,
} from '@industry/utils/models';
import { isModelAllowedByPolicy } from '@industry/utils/models/policy';
import {
  domainMatchesPattern,
  mergeSandboxSettings,
  normalizeIndustryRouterRules,
  subagentModelKey,
  subagentReasoningKey,
  type SubagentSettingKey,
} from '@industry/utils/settings';
import {
  isPathUnderEntry,
  resolveSandboxPath,
} from '@industry/utils/settings/sandbox-paths';

import { getEnv, getRuntimeAuthConfig } from '@/environment';
import { getDefaultModelId } from '@/models/availability';
import {
  getModelDefaultReasoningEffort,
  getTuiModelConfig,
} from '@/models/config';
import { resolveIfIndustryRouterOrFallback } from '@/models/industryRouterAvailability';
import { SandboxDenyListKind } from '@/sandbox/enums';
import {
  DEFAULT_COMMAND_ALLOWLIST,
  DEFAULT_COMMAND_BLOCKLIST,
  DEFAULT_COMMAND_DENYLIST,
} from '@/services/constants';
import type { SettingManagementInfo } from '@/services/types';
import { CUSTOM_MODEL_BASE_URL_BLOCKED_MESSAGE } from '@/utils/constants';
import {
  calculateNextReasoningEffort,
  clampReasoningEffortForModel,
} from '@/utils/modelUtils';
import type { SoundOption } from '@/utils/types';

import type { SettingsLike } from '@industry/drool-core/llms/client/types';
import type { ComplexityTier } from '@industry/drool-core/tools/enums';

const getDefaultModelIdOrFallback = (): ModelID =>
  getDefaultModelId() ?? resolveDefaultIndustryModel(new Set(CLI_MODELS));

function getSettingsFilePath(): string {
  return path.join(getIndustryHome(), getIndustryDirName(), 'settings.json');
}

type ModelCycleCandidateSource = 'favorites' | 'all';

interface ModelCycleCandidates {
  modelIds: string[];
  source: ModelCycleCandidateSource;
}

function dedupeModelIds(modelIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const modelId of modelIds) {
    if (typeof modelId !== 'string' || modelId.length === 0) continue;
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    unique.push(modelId);
  }
  return unique;
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Get ModelPolicy from resolved settings.
 */
function getModelPolicyFromSettings(settings: Settings): ModelPolicy {
  return {
    allowedModelIds: settings.general?.modelPolicy?.allowedModelIds ?? [],
    blockedModelIds: settings.general?.modelPolicy?.blockedModelIds ?? [],
    allowCustomModels: settings.general?.modelPolicy?.allowCustomModels ?? true,
    allowedBaseUrls: settings.general?.modelPolicy?.allowedBaseUrls,
    allowAllIndustryModels:
      settings.general?.modelPolicy?.allowAllIndustryModels ?? true,
    requireExplicitOptInModelIds:
      settings.general?.modelPolicy?.requireExplicitOptInModelIds,
    allowIndustryRouterByok:
      settings.general?.modelPolicy?.allowIndustryRouterByok,
  };
}

class SettingsService implements SettingsLike {
  private settings: Settings = {
    general: { ...DEFAULT_GENERAL_SETTINGS },
  };

  private initialized = false;

  private reasoningEffortListeners: Set<(effort: ReasoningEffort) => void> =
    new Set();

  private specReasoningEffortListeners: Set<(effort: ReasoningEffort) => void> =
    new Set();

  private modelListeners: Set<(model: string) => void> = new Set();

  private specModeModelListeners: Set<(model: string | undefined) => void> =
    new Set();

  private missionModelListeners: Set<() => void> = new Set();

  // Cached model policy from settings
  private cachedModelPolicy: ModelPolicy = {
    allowedModelIds: [],
    blockedModelIds: [],
    allowCustomModels: true,
  };

  // Cached custom models from hierarchical settings
  private customModels: CustomModel[] = [];

  // Cached org-level settings for checking which settings are org-managed
  private orgSettings: Settings = {};

  // Cached hierarchy levels for per-setting source attribution
  private settingsHierarchy: SettingsHierarchyLevel[] = [];

  // Frozen resolution chain from initial settings load (used by /settings-debug)
  private debugResolutionChain: SettingsResolutionEvent[] = [];

  /**
   * Initialize settings from hierarchical settings resolver.
   * Resolves settings across org -> folder -> project -> user -> system defaults levels.
   * Must be called at app startup before any settings access.
   */
  public async initialize(): Promise<void> {
    if (this.initialized) return;

    const manager = SettingsManager.getInstance();
    manager.dynamicConfigDisabled = getEnv().extras.disableDynamicConfig;

    // Single call: load all hierarchy levels with attribution, then derive
    // merged settings, resolution chain, and org settings locally. This avoids
    // calling loadAllLevelsWithAttribution() twice.
    // Runtime settings overlays (--settings) are included in the hierarchy
    // automatically by SettingsManager.
    const hierarchy = await manager.getSettingsHierarchyWithAttribution();
    const { settings: resolved, resolutionChain } =
      mergeHierarchyWithChain(hierarchy);
    this.settings = resolved;

    // Store frozen resolution chain for debug access
    this.debugResolutionChain = resolutionChain;

    // Cache model policy from resolved settings
    this.cachedModelPolicy = getModelPolicyFromSettings(resolved);

    // Cache custom models from resolved settings
    this.customModels = resolved.general?.customModels ?? [];

    // Extract org settings from hierarchy (first Org entry is org managed
    // settings; the second Org entry is org plugin settings)
    this.orgSettings =
      hierarchy.find((l) => l.level === SettingsLevel.Org)?.settings ?? {};

    // Store full hierarchy for per-setting source attribution
    this.settingsHierarchy = hierarchy;

    // Subscribe to settings changes (e.g., file watching, plugin install/uninstall)
    // Reload hooks and custom models when caches are invalidated
    manager.on('settings-changed', (_event: SettingsChangedEvent) => {
      void this.refreshHooksAndModels();
    });

    // Enable file watching for config.json changes
    manager.enableWatching();

    logInfo('[SettingsService] Initialized with hierarchical settings');
    this.initialized = true;
  }

  /**
   * Get cached custom models loaded during initialization
   */
  public getCustomModels(): CustomModel[] {
    return this.customModels;
  }

  /**
   * Get the frozen settings resolution chain from initial load.
   * Used by /settings-debug to show how each setting was resolved.
   */
  public getDebugResolutionChain(): SettingsResolutionEvent[] {
    return this.debugResolutionChain;
  }

  /**
   * Refresh settings from SettingsManager.
   * Called when settings-changed event fires (e.g., file watching, plugin install/uninstall).
   * After plugin operations, caches are cleared so we need to reload.
   * Also refreshes model settings so that changes to custom models, mission
   * worker models, and subagent models are picked up without restarting.
   */
  private async refreshHooksAndModels(): Promise<void> {
    try {
      const manager = SettingsManager.getInstance();
      const hierarchy = await manager.getSettingsHierarchyWithAttribution();
      this.settingsHierarchy = hierarchy;
      const { settings: resolved, resolutionChain } =
        mergeHierarchyWithChain(hierarchy);
      this.debugResolutionChain = resolutionChain;

      this.settings = resolved;

      // Update custom models (important after config.json changes)
      this.customModels = resolved.general?.customModels ?? [];

      // Update model settings so stale custom model IDs are picked up
      // when the user edits settings.json during a running session.
      if (resolved.general) {
        if (resolved.general.missionModelSettings !== undefined) {
          this.settings.general = {
            ...this.settings.general,
            missionModelSettings: resolved.general.missionModelSettings,
          };
        }
        if (resolved.general.subagentModelSettings !== undefined) {
          this.settings.general = {
            ...this.settings.general,
            subagentModelSettings: resolved.general.subagentModelSettings,
          };
        }
        if (resolved.general.sessionDefaultSettings !== undefined) {
          this.settings.general = {
            ...this.settings.general,
            sessionDefaultSettings: resolved.general.sessionDefaultSettings,
          };
        }
        if (resolved.general.modelFavorites !== undefined) {
          this.settings.general = {
            ...this.settings.general,
            modelFavorites: resolved.general.modelFavorites,
          };
        }
      }

      // Update model policy (important when org settings change)
      this.cachedModelPolicy = getModelPolicyFromSettings(resolved);

      logInfo('[SettingsService] Hooks and custom models refreshed');
    } catch (error) {
      logException(error, 'Failed to refresh hooks and custom models');
    }
  }

  public async refreshFromSettingsManager(): Promise<void> {
    SettingsManager.getInstance().refresh();
    await this.refreshHooksAndModels();
    this.notifyModelListeners();
    this.notifyReasoningEffortListeners();
    this.notifySpecModeModelListeners();
    this.notifySpecReasoningEffortListeners();
    this.notifyMissionModelListeners();
  }

  /**
   * Re-fetch org-managed settings and re-resolve the full settings hierarchy.
   * Called after login/re-authentication to ensure org policies are applied,
   * preventing users from bypassing org-managed settings by starting the CLI
   * without credentials and then logging in.
   */
  public async reloadOrgSettings(): Promise<void> {
    const manager = SettingsManager.getInstance();
    manager.notifyAuthRefreshed();

    // Invalidate all caches (including org settings) so they are re-fetched
    manager.refresh();

    // Re-resolve the full hierarchy
    const hierarchy = await manager.getSettingsHierarchyWithAttribution();
    const { settings: resolved, resolutionChain } =
      mergeHierarchyWithChain(hierarchy);
    this.settings = resolved;

    // Update resolution chain
    this.debugResolutionChain = resolutionChain;

    // Re-cache model policy
    this.cachedModelPolicy = getModelPolicyFromSettings(resolved);

    // Re-cache custom models
    this.customModels = resolved.general?.customModels ?? [];

    // Re-extract org settings from hierarchy
    this.orgSettings =
      hierarchy.find((l) => l.level === SettingsLevel.Org)?.settings ?? {};

    // Update hierarchy for per-setting source attribution
    this.settingsHierarchy = hierarchy;

    // Notify subscribers so UI reflects the new org-managed values
    this.notifyModelListeners();
    this.notifyReasoningEffortListeners();
    this.notifyMissionModelListeners();

    // Reinitialize sandbox to apply new org sandbox policies
    try {
      const { getSandboxService } = await import('@/services/SandboxService');
      await getSandboxService().reinitialize(resolved.general?.sandbox);
    } catch (error) {
      logWarn(
        '[SettingsService] Failed to reinitialize sandbox after org reload',
        {
          cause: error instanceof Error ? error.message : String(error),
        }
      );
    }

    logInfo('[SettingsService] Org settings reloaded after authentication');
  }

  /**
   * Persist settings updates to the user settings file (~/.industry/settings.json).
   * Only writes the specified properties, preserving existing user settings.
   */
  private async persistSettings(updates: Partial<Settings>): Promise<void> {
    const isTestEnv =
      process.env.NODE_ENV === 'test' ||
      // Vitest sets this, but some runners may not set NODE_ENV consistently.
      process.env.VITEST_WORKER_ID !== undefined;
    const persistenceDisabled =
      process.env.INDUSTRY_DISABLE_SETTINGS_PERSISTENCE === 'true' && !isTestEnv;
    if (persistenceDisabled) {
      logInfo('[SettingsService] Persistence disabled. Not saving settings');
      return;
    }
    try {
      await SettingsManager.getInstance().updateLevelSettings(
        SettingsLevel.User,
        updates
      );
    } catch (error) {
      logException(error, 'Failed to persist settings');
    }
  }

  public getSettings(): Settings {
    return { ...this.settings };
  }

  // ---------------------------------------------------------------------------
  // Model Policy Management
  // ---------------------------------------------------------------------------

  /**
   * Get effective model policy from cached settings.
   */
  public getModelPolicy(): ModelPolicy {
    return this.cachedModelPolicy;
  }

  private resolveCanonicalCustomModelId(modelId: string): string {
    if (!modelId.startsWith('custom:')) return modelId;
    return findCustomModel(modelId, this.customModels)?.id ?? modelId;
  }

  /**
   * Check if a model is allowed by organization model policy.
   */
  public validateModelAccess(modelId: string): {
    allowed: boolean;
    reason?: string;
    isCustomModel: boolean;
  } {
    const modelPolicy = this.getModelPolicy();
    const isCustomModel = modelId.startsWith('custom:');

    // Check custom models
    if (isCustomModel) {
      const customAllowed = modelPolicy.allowCustomModels ?? true;
      if (!customAllowed) {
        return {
          allowed: false,
          reason: 'Custom models are not allowed by your organization policy',
          isCustomModel: true,
        };
      }

      const allowedBaseUrls = modelPolicy.allowedBaseUrls;
      if (allowedBaseUrls && allowedBaseUrls.length > 0) {
        const customModel = findCustomModel(modelId, this.customModels);
        const customBaseUrl = getCustomModelPolicyBaseUrl(
          customModel,
          getProcessEnvironment()
        );
        const isAllowed =
          typeof customBaseUrl === 'string' &&
          isCustomModelBaseUrlAllowed(customBaseUrl, allowedBaseUrls);

        if (!isAllowed) {
          return {
            allowed: false,
            reason: CUSTOM_MODEL_BASE_URL_BLOCKED_MESSAGE,
            isCustomModel: true,
          };
        }
      }

      return { allowed: true, isCustomModel: true };
    }

    // Check built-in models
    const allowed = isModelAllowedByPolicy(
      modelId as unknown as ModelID,
      modelPolicy
    );
    if (!allowed) {
      return {
        allowed: false,
        reason: MODEL_POLICY_VIOLATION_ERROR,
        isCustomModel: false,
      };
    }

    return { allowed: true, isCustomModel: false };
  }

  /**
   * Return the first model that is allowed by the current org model policy,
   * intended as a replacement when a persisted model has been blocked by the
   * policy.
   *
   * Fallback order is designed so that when an org admin blocks a model, the
   * user ends up on the admin's intended replacement rather than a personal
   * BYOK custom model they happened to register:
   *   1. The org-managed default model (if any), if allowed.
   *   2. The built-in default model, if allowed.
   *   3. The first allowed built-in CLI model.
   *   4. The first allowed custom model.
   *   5. null if every candidate is blocked.
   *
   * An optional `filter` predicate is applied on top of policy validation.
   * Callers can use this to constrain the search to a subset of models
   * (e.g. models belonging to a specific provider) without SettingsService
   * needing to know about provider semantics.
   */
  public getFirstAllowedModel(
    filter?: (modelId: string) => boolean
  ): string | null {
    // Run the (typically cheap) caller-supplied filter first so we
    // short-circuit before invoking the heavier policy check.
    const pass = (modelId: string): boolean =>
      (!filter || filter(modelId)) && this.validateModelAccess(modelId).allowed;

    const orgDefault = this.orgSettings.general?.sessionDefaultSettings?.model;
    if (orgDefault && pass(orgDefault)) return orgDefault;

    const builtInDefault = getDefaultModelIdOrFallback();
    if (builtInDefault && pass(builtInDefault)) return builtInDefault;

    const builtInFallback = CLI_MODELS.find(pass);
    if (builtInFallback) return builtInFallback;

    const customFallback = this.customModels.find((m) => pass(m.id));
    if (customFallback) return customFallback.id;

    return null;
  }

  /**
   * Check if at least one model is available for use (not blocked by policy).
   * Takes the feature-flag-filtered built-in model list and checks policy on each.
   * Also considers custom models if allowed and configured.
   */
  public hasAnyAvailableModel(availableBuiltInModels: string[]): boolean {
    const policy = this.getModelPolicy();
    const hasBuiltIn = availableBuiltInModels.some(
      (id) => this.validateModelAccess(id).allowed
    );
    if (hasBuiltIn) return true;
    if (
      policy.allowCustomModels &&
      this.customModels.some(
        (model) => this.validateModelAccess(model.id).allowed
      )
    ) {
      return true;
    }
    return false;
  }

  public getModelFavorites(): string[] {
    const storedFavorites = dedupeModelIds(
      this.settings.general?.modelFavorites ?? []
    );
    const canonicalFavorites = dedupeModelIds(
      storedFavorites.map((id) => this.resolveCanonicalCustomModelId(id))
    );

    if (!arraysEqual(storedFavorites, canonicalFavorites)) {
      this.updateSettings({ general: { modelFavorites: canonicalFavorites } });
    }

    return canonicalFavorites;
  }

  public setModelFavorites(modelIds: readonly string[]): string[] {
    const modelFavorites = dedupeModelIds(modelIds);
    this.updateSettings({ general: { modelFavorites } });
    return modelFavorites;
  }

  public toggleModelFavorite(modelId: string): string[] {
    const favorites = this.getModelFavorites();
    const next = favorites.includes(modelId)
      ? favorites.filter((id) => id !== modelId)
      : [...favorites, modelId];
    return this.setModelFavorites(next);
  }

  public getDismissedNewModels(): string[] {
    return dedupeModelIds(this.settings.general?.dismissedNewModels ?? []);
  }

  public dismissNewModel(modelId: string): string[] {
    const current = this.getDismissedNewModels();
    if (current.includes(modelId)) return current;
    const next = [...current, modelId];
    this.updateSettings({ general: { dismissedNewModels: next } });
    return next;
  }

  private getAllowedCycleModelIds(modelIds: readonly string[]): string[] {
    return dedupeModelIds(modelIds).filter((modelId) => {
      if (!this.validateModelAccess(modelId).allowed) {
        return false;
      }
      return true;
    });
  }

  public getModelCycleCandidates(
    availableBuiltInModels: string[]
  ): ModelCycleCandidates {
    const availableModelIds = new Set([
      ...availableBuiltInModels,
      ...this.customModels.map((model) => model.id),
    ]);
    const allowedFavorites = this.getAllowedCycleModelIds(
      this.getModelFavorites().filter((modelId) =>
        availableModelIds.has(modelId)
      )
    );

    if (allowedFavorites.length > 0) {
      return { modelIds: allowedFavorites, source: 'favorites' };
    }

    const cycleModelIds = [
      ...availableBuiltInModels,
      ...this.customModels.map((model) => model.id),
    ];

    return {
      modelIds: this.getAllowedCycleModelIds(cycleModelIds),
      source: 'all',
    };
  }

  public updateSettings(updates: Partial<Settings>): void {
    // Deep merge for nested structures
    this.settings = {
      ...this.settings,
      general: {
        ...this.settings.general,
        ...updates.general,
        sessionDefaultSettings: {
          ...this.settings.general?.sessionDefaultSettings,
          ...updates.general?.sessionDefaultSettings,
        },
        missionModelSettings: {
          ...this.settings.general?.missionModelSettings,
          ...updates.general?.missionModelSettings,
        },
        subagentModelSettings: {
          ...this.settings.general?.subagentModelSettings,
          ...updates.general?.subagentModelSettings,
        },
      },
      hooks: {
        ...this.settings.hooks,
        ...updates.hooks,
      },
    };
    void this.persistSettings(updates);
  }

  public async persistSessionDefaultSettings(): Promise<void> {
    await this.persistSettings({
      general: {
        sessionDefaultSettings:
          this.settings.general?.sessionDefaultSettings ?? {},
      },
    });
  }

  private writeSubagentSetting<K extends SubagentSettingKey>(
    key: K,
    value: SubagentModelSettings[K]
  ): void {
    this.updateSettings({
      general: {
        subagentModelSettings: { [key]: value },
      },
    });
  }

  private resolveSubagentModel(
    complexity: ComplexityTier,
    storedModel: string
  ): string {
    const settingKey = subagentModelKey(complexity);
    let resolvedModel = storedModel;

    if (resolvedModel.startsWith('custom:')) {
      const parsed = parseCustomModelId(resolvedModel, this.customModels);
      if (parsed && !parsed.isNewFormat) {
        const foundModel = this.customModels.find(
          (model) => model.model === parsed.displayName
        );

        if (foundModel && foundModel.id !== resolvedModel) {
          logInfo(
            '[Settings] Migrating subagent custom model ID to new format',
            {
              complexity,
              oldId: resolvedModel,
              newId: foundModel.id,
            }
          );

          resolvedModel = foundModel.id;
          this.writeSubagentSetting(settingKey, resolvedModel);
        }
      }
    }

    const isBuiltIn = isAvailableInCLI(resolvedModel);
    const customModel = findCustomModel(resolvedModel, this.customModels);
    const modelExists = isBuiltIn || customModel !== null;

    if (!modelExists) {
      const fallbackModel = this.getModel();

      logException(
        new Error('Model not found'),
        '[Settings] Subagent model not found, falling back to current model',
        {
          complexity,
          selectedModel: resolvedModel,
          fallbackModelId: fallbackModel,
        }
      );

      this.writeSubagentSetting(settingKey, fallbackModel);

      return fallbackModel;
    }

    const validation = this.validateModelAccess(resolvedModel);
    if (!validation.allowed) {
      const fallbackModel = this.getModel();

      logWarn('[Settings] Subagent model blocked by org policy', {
        complexity,
        selectedModel: resolvedModel,
        fallbackModelId: fallbackModel,
      });

      this.writeSubagentSetting(settingKey, fallbackModel);

      return fallbackModel;
    }

    return resolvedModel;
  }

  // ---------------------------------------------------------------------------
  // Subagent complexity model settings
  // ---------------------------------------------------------------------------

  public getSubagentModelForComplexity(complexity: ComplexityTier): string {
    const settingKey = subagentModelKey(complexity);
    const storedModel =
      this.settings.general?.subagentModelSettings?.[settingKey] ??
      this.getModel();

    return this.resolveSubagentModel(complexity, storedModel);
  }

  public setSubagentModelForComplexity(
    complexity: ComplexityTier,
    model: string
  ): void {
    const validation = this.validateModelAccess(model);
    if (!validation.allowed) {
      logWarn('[Settings] Cannot set subagent model - blocked by org policy', {
        complexity,
        modelId: model,
      });
      throw new MetaError('Model not allowed by organization policy', {
        modelId: model,
      });
    }

    this.writeSubagentSetting(subagentModelKey(complexity), model);
  }

  public getSubagentReasoningEffortForComplexity(
    complexity: ComplexityTier
  ): ReasoningEffort {
    const model = this.getSubagentModelForComplexity(complexity);
    const settingKey = subagentReasoningKey(complexity);
    const storedEffort =
      this.settings.general?.subagentModelSettings?.[settingKey];

    if (storedEffort !== undefined) {
      return clampReasoningEffortForModel(model, storedEffort);
    }

    return getModelDefaultReasoningEffort(model);
  }

  public hasExplicitSubagentModelForComplexity(
    complexity: ComplexityTier
  ): boolean {
    const settingKey = subagentModelKey(complexity);
    return (
      this.settings.general?.subagentModelSettings?.[settingKey] !== undefined
    );
  }

  public hasSubagentReasoningEffortOverrideForComplexity(
    complexity: ComplexityTier
  ): boolean {
    const settingKey = subagentReasoningKey(complexity);
    return (
      this.settings.general?.subagentModelSettings?.[settingKey] !== undefined
    );
  }

  public setSubagentReasoningEffortForComplexity(
    complexity: ComplexityTier,
    effort: ReasoningEffort
  ): void {
    const model = this.getSubagentModelForComplexity(complexity);
    const clamped = clampReasoningEffortForModel(model, effort);

    this.writeSubagentSetting(subagentReasoningKey(complexity), clamped);
  }

  /**
   * Clear any pinned model/reasoning override for a complexity tier so the tier
   * inherits the spawning session's model (the default "Inherit" state).
   */
  public clearSubagentModelForComplexity(complexity: ComplexityTier): void {
    this.updateSettings({
      general: {
        subagentModelSettings: {
          [subagentModelKey(complexity)]: undefined,
          [subagentReasoningKey(complexity)]: undefined,
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Mission orchestrator model setting
  // ---------------------------------------------------------------------------

  public getMissionOrchestratorModel(): string {
    const storedModel =
      this.settings.general?.missionOrchestratorModel ??
      getDefaultModelIdOrFallback();

    let orchestratorModel = storedModel;

    if (orchestratorModel.startsWith('custom:')) {
      const models = this.customModels;
      const parsed = parseCustomModelId(orchestratorModel, models);
      if (parsed && !parsed.isNewFormat) {
        const foundModel = models.find((m) => m.model === parsed.displayName);
        if (foundModel && foundModel.id !== orchestratorModel) {
          logInfo(
            '[Settings] Migrating mission orchestrator custom model ID to new format',
            {
              oldId: orchestratorModel,
              newId: foundModel.id,
            }
          );

          orchestratorModel = foundModel.id;
          this.updateSettings({
            general: {
              missionOrchestratorModel: orchestratorModel,
            },
          });
        }
      }
    }

    const isBuiltIn = isAvailableInCLI(orchestratorModel);
    const customModel = orchestratorModel.startsWith('custom:')
      ? findCustomModel(orchestratorModel, this.customModels)
      : null;
    const modelExists = isBuiltIn || customModel !== null;

    if (!modelExists) {
      const fallbackModel = getDefaultModelIdOrFallback();

      logException(
        new Error('Model not found'),
        'Mission orchestrator model not found, falling back to default',
        {
          selectedModel: orchestratorModel,
          fallbackModelId: fallbackModel,
        }
      );

      this.updateSettings({
        general: {
          missionOrchestratorModel: fallbackModel,
        },
      });

      return fallbackModel;
    }

    return orchestratorModel;
  }

  public setMissionOrchestratorModel(model: string): void {
    const validation = this.validateModelAccess(model);
    if (!validation.allowed) {
      logWarn(
        '[Settings] Cannot set mission orchestrator model - blocked by org'
      );
      throw new MetaError('Model not allowed by organization policy', {
        modelId: model,
      });
    }

    const currentEffort = this.getMissionOrchestratorReasoningEffort();
    const clampedEffort = clampReasoningEffortForModel(model, currentEffort);

    this.updateSettings({
      general: {
        missionOrchestratorModel: model,
        missionOrchestratorReasoningEffort: clampedEffort,
      },
    });
    this.notifyMissionModelListeners();
  }

  public getMissionOrchestratorReasoningEffort(): ReasoningEffort {
    const storedEffort =
      this.settings.general?.missionOrchestratorReasoningEffort;

    if (storedEffort !== undefined) {
      return storedEffort;
    }

    const orchestratorModel = this.getMissionOrchestratorModel();
    return getModelDefaultReasoningEffort(orchestratorModel);
  }

  public setMissionOrchestratorReasoningEffort(effort: ReasoningEffort): void {
    const orchestratorModel = this.getMissionOrchestratorModel();
    const clamped = clampReasoningEffortForModel(orchestratorModel, effort);
    this.updateSettings({
      general: {
        missionOrchestratorReasoningEffort: clamped,
      },
    });
    this.notifyMissionModelListeners();
  }

  // ---------------------------------------------------------------------------
  // Mission worker model settings
  // ---------------------------------------------------------------------------

  public getMissionModelSettings(): Required<MissionModelSettings> {
    return {
      workerModel: this.getMissionWorkerModel(),
      workerReasoningEffort: this.getMissionWorkerReasoningEffort(),
      validationWorkerModel: this.getMissionValidationWorkerModel(),
      validationWorkerReasoningEffort:
        this.getMissionValidationWorkerReasoningEffort(),
      skipScrutiny: this.getMissionSkipScrutiny(),
      skipUserTesting: this.getMissionSkipUserTesting(),
    };
  }

  public getMissionWorkerModel(): string {
    const storedModel =
      this.settings.general?.missionModelSettings?.workerModel ??
      getDefaultModelIdOrFallback();

    let workerModel = storedModel;

    // Migration: Convert old format custom model IDs to new format
    if (workerModel.startsWith('custom:')) {
      const models = this.customModels;
      const parsed = parseCustomModelId(workerModel, models);
      if (parsed && !parsed.isNewFormat) {
        const foundModel = models.find((m) => m.model === parsed.displayName);
        if (foundModel && foundModel.id !== workerModel) {
          logInfo(
            '[Settings] Migrating mission worker custom model ID to new format',
            {
              oldId: workerModel,
              newId: foundModel.id,
            }
          );

          workerModel = foundModel.id;
          this.updateSettings({
            general: {
              missionModelSettings: {
                ...this.settings.general?.missionModelSettings,
                workerModel,
              },
            },
          });
        }
      }
    }

    // Validate that the model actually exists (built-in or in custom models list)
    const isBuiltIn = isAvailableInCLI(workerModel);
    const customModel = workerModel.startsWith('custom:')
      ? findCustomModel(workerModel, this.customModels)
      : null;
    const modelExists = isBuiltIn || customModel !== null;

    if (!modelExists) {
      const fallbackModel = getDefaultModelIdOrFallback();

      logException(
        new Error('Model not found'),
        'Mission worker model not found, falling back to default',
        {
          selectedModel: workerModel,
          fallbackModelId: fallbackModel,
        }
      );

      this.updateSettings({
        general: {
          missionModelSettings: {
            ...this.settings.general?.missionModelSettings,
            workerModel: fallbackModel,
          },
        },
      });

      return fallbackModel;
    }

    return workerModel;
  }

  public setMissionWorkerModel(model: string): void {
    const effectiveModel = resolveIfIndustryRouterOrFallback(model, {
      slotLabel: 'missionWorkerModel',
    });
    const validation = this.validateModelAccess(effectiveModel);
    if (!validation.allowed) {
      logWarn('[Settings] Cannot set mission worker model - blocked by org');
      throw new MetaError('Model not allowed by organization policy', {
        modelId: effectiveModel,
      });
    }

    this.updateSettings({
      general: {
        missionModelSettings: {
          ...this.settings.general?.missionModelSettings,
          workerModel: effectiveModel,
        },
      },
    });
    this.notifyMissionModelListeners();
  }

  public getMissionValidationWorkerModel(): string {
    const storedModel =
      this.settings.general?.missionModelSettings?.validationWorkerModel ??
      MISSION_VALIDATION_WORKER_MODEL ??
      getDefaultModelIdOrFallback();

    let validationWorkerModel = storedModel;

    // Migration: Convert old format custom model IDs to new format
    if (validationWorkerModel.startsWith('custom:')) {
      const models = this.customModels;
      const parsed = parseCustomModelId(validationWorkerModel, models);
      if (parsed && !parsed.isNewFormat) {
        const foundModel = models.find((m) => m.model === parsed.displayName);
        if (foundModel && foundModel.id !== validationWorkerModel) {
          logInfo(
            '[Settings] Migrating mission validation worker custom model ID to new format',
            {
              oldId: validationWorkerModel,
              newId: foundModel.id,
            }
          );

          validationWorkerModel = foundModel.id;
          this.updateSettings({
            general: {
              missionModelSettings: {
                ...this.settings.general?.missionModelSettings,
                validationWorkerModel,
              },
            },
          });
        }
      }
    }

    // Validate that the model actually exists (built-in or in custom models list)
    const isBuiltIn = isAvailableInCLI(validationWorkerModel);
    const customModel = validationWorkerModel.startsWith('custom:')
      ? findCustomModel(validationWorkerModel, this.customModels)
      : null;
    const modelExists = isBuiltIn || customModel !== null;

    if (!modelExists) {
      const fallbackModel =
        MISSION_VALIDATION_WORKER_MODEL ?? getDefaultModelIdOrFallback();

      logException(
        new Error('Model not found'),
        'Mission validation worker model not found, falling back to default',
        {
          selectedModel: validationWorkerModel,
          fallbackModelId: fallbackModel,
        }
      );

      this.updateSettings({
        general: {
          missionModelSettings: {
            ...this.settings.general?.missionModelSettings,
            validationWorkerModel: fallbackModel,
          },
        },
      });

      return fallbackModel;
    }

    return validationWorkerModel;
  }

  public setMissionValidationWorkerModel(model: string): void {
    const effectiveModel = resolveIfIndustryRouterOrFallback(model, {
      slotLabel: 'missionValidationWorkerModel',
    });
    const validation = this.validateModelAccess(effectiveModel);
    if (!validation.allowed) {
      logWarn(
        '[Settings] Cannot set mission validation worker model - blocked by org'
      );
      throw new MetaError('Model not allowed by organization policy', {
        modelId: effectiveModel,
      });
    }

    this.updateSettings({
      general: {
        missionModelSettings: {
          ...this.settings.general?.missionModelSettings,
          validationWorkerModel: effectiveModel,
        },
      },
    });
    this.notifyMissionModelListeners();
  }

  public getMissionWorkerReasoningEffort(): ReasoningEffort {
    const storedEffort =
      this.settings.general?.missionModelSettings?.workerReasoningEffort;

    if (storedEffort !== undefined) {
      return storedEffort;
    }

    // Fall back to model's default reasoning effort
    const workerModel = this.getMissionWorkerModel();
    return getModelDefaultReasoningEffort(workerModel);
  }

  public setMissionWorkerReasoningEffort(effort: ReasoningEffort): void {
    const workerModel = this.getMissionWorkerModel();
    const clamped = clampReasoningEffortForModel(workerModel, effort);
    this.updateSettings({
      general: {
        missionModelSettings: {
          ...this.settings.general?.missionModelSettings,
          workerReasoningEffort: clamped,
        },
      },
    });
    this.notifyMissionModelListeners();
  }

  public getMissionValidationWorkerReasoningEffort(): ReasoningEffort {
    const storedEffort =
      this.settings.general?.missionModelSettings
        ?.validationWorkerReasoningEffort;

    if (storedEffort !== undefined) {
      return storedEffort;
    }

    // Fall back to model's default reasoning effort
    const validationModel = this.getMissionValidationWorkerModel();
    return getModelDefaultReasoningEffort(validationModel);
  }

  public setMissionValidationWorkerReasoningEffort(
    effort: ReasoningEffort
  ): void {
    const validationModel = this.getMissionValidationWorkerModel();
    const clamped = clampReasoningEffortForModel(validationModel, effort);
    this.updateSettings({
      general: {
        missionModelSettings: {
          ...this.settings.general?.missionModelSettings,
          validationWorkerReasoningEffort: clamped,
        },
      },
    });
    this.notifyMissionModelListeners();
  }

  // ---------------------------------------------------------------------------
  // Mission validation skip toggles (experimental)
  // ---------------------------------------------------------------------------
  public getMissionSkipScrutiny(): boolean {
    return this.settings.general?.missionModelSettings?.skipScrutiny ?? false;
  }

  public setMissionSkipScrutiny(skip: boolean): void {
    this.updateSettings({
      general: {
        missionModelSettings: {
          ...this.settings.general?.missionModelSettings,
          skipScrutiny: skip,
        },
      },
    });
    this.notifyMissionModelListeners();
  }

  public getMissionSkipUserTesting(): boolean {
    return (
      this.settings.general?.missionModelSettings?.skipUserTesting ?? false
    );
  }

  public setMissionSkipUserTesting(skip: boolean): void {
    this.updateSettings({
      general: {
        missionModelSettings: {
          ...this.settings.general?.missionModelSettings,
          skipUserTesting: skip,
        },
      },
    });
    this.notifyMissionModelListeners();
  }

  public getModel(): string {
    // Airgap sessions can only run BYOK models. A built-in settings default
    // (common when the same settings.json is shared with non-airgap
    // environments) would land the session on a refused model, so pick the
    // first allowed custom model instead. A custom:* default is kept; with
    // no custom models configured we fall through to the regular resolution
    // and the allModelsBlockedAirgap hint.
    if (getRuntimeAuthConfig().airgapEnabled) {
      const configured = this.settings.general?.sessionDefaultSettings?.model;
      if (!configured?.startsWith('custom:')) {
        const customDefault = this.customModels.find(
          (m) => this.validateModelAccess(m.id).allowed
        );
        if (customDefault) return customDefault.id;
      }
    }

    const defaultModelId = getDefaultModelIdOrFallback();

    // Explicitly type as string to accommodate custom model IDs (which are strings)
    let currentModel: string =
      this.settings.general?.sessionDefaultSettings?.model ?? defaultModelId;

    // Migration: Convert old format custom model IDs to new format
    if (currentModel.startsWith('custom:')) {
      const canonicalModel = this.resolveCanonicalCustomModelId(currentModel);
      if (canonicalModel !== currentModel) {
        logInfo('[Settings] Migrating custom model ID to canonical format', {
          oldId: currentModel,
          newId: canonicalModel,
        });

        currentModel = canonicalModel;
        this.updateSettings({
          general: { sessionDefaultSettings: { model: currentModel } },
        });
      }
    }

    const canonicalModelId = resolveModelId(currentModel);
    if (
      canonicalModelId &&
      canonicalModelId !== currentModel &&
      isAvailableInCLI(canonicalModelId)
    ) {
      logWarn('[Settings] Migrating default model alias to canonical ModelID', {
        previousModelId: currentModel,
        modelId: canonicalModelId,
      });
      currentModel = canonicalModelId;
      this.updateSettings({
        general: { sessionDefaultSettings: { model: currentModel } },
      });
    }

    // Validate that the model exists
    const modelConfig = getTuiModelConfig(currentModel);

    // Check if we fell back to the default model (getTuiModelConfig now returns default instead of throwing)
    // If the current model is not a built-in model and not a custom model, we've fallen back
    const isBuiltIn = isAvailableInCLI(currentModel);
    const isCustom = currentModel.startsWith('custom:');
    const fellBackToDefault =
      !isBuiltIn && !isCustom && modelConfig.id === defaultModelId;

    if (fellBackToDefault) {
      // Model is not recognized by this CLI's registry. Try to canonicalize
      // it via resolveModelId, which resolves MODEL_ALIASES entries and
      // ModelID enum key/value lookups (e.g.
      // `claude-opus-4-20250514` → `ModelID.CLAUDE_OPUS_4` =
      // `claude-opus-4-1-20250805`). We deliberately do NOT use the
      // broader `findClosestModelId` here — its substring / matchPatterns
      // fuzzy paths are aggressive enough to migrate users to the wrong
      // model (e.g. `sonnet-4-6` pattern-matches the longest `Sonnet 4`
      // ModelID first, silently downgrading the user). Alias-only migration
      // is deterministic: if resolveModelId returns a different string, it
      // is the same logical model spelled canonically. Truly ambiguous or
      // unknown strings fall through to the preserve branch below.
      const canonical = resolveModelId(currentModel);
      if (canonical && canonical !== currentModel) {
        // Log at warn level so successful in-field migrations show up in
        // Axiom and we can confirm the fix is working per-org / per-version.
        logWarn(
          '[Settings] Migrating persisted model id to canonical ModelID',
          { previousModelId: currentModel, modelId: canonical }
        );
        this.updateSettings({
          general: { sessionDefaultSettings: { model: canonical } },
        });
        // If the canonical id is in CLI_MODEL_ORDER, use it for this call.
        // Otherwise (deprecated / hidden model) fall back to the dynamic
        // default for the session; the on-disk value has still been
        // corrected so future CLI versions that re-enable the model will
        // pick it up transparently.
        return isAvailableInCLI(canonical) ? canonical : defaultModelId;
      }

      // Truly unknown string (no alias, no enum value match) OR a
      // canonical ModelID that's already in its canonical form but not
      // currently in CLI_MODEL_ORDER. Either way: preserve disk (FAC-19043)
      // and return the default for this call. Log at most once per unique
      // id per process to avoid Axiom log-spam on repeated getModel() calls.
      logWarnOnce(
        `unknown-persisted-model:${currentModel}`,
        '[Settings] Persisted model not recognized by local registry, returning default for this call',
        { selectedModel: currentModel, fallbackModelId: defaultModelId }
      );

      return defaultModelId;
    }

    // Check if the resolved model is allowed by org policy. If not, return
    // an allowed model for THIS call (so new sessions land on the admin's
    // intended replacement rather than hitting a 403) but do NOT rewrite
    // the user's persisted sessionDefaultSettings.model. Org policies
    // change at runtime and can be refreshed mid-session via
    // reloadOrgSettings; silently overwriting the user's saved default
    // means they permanently lose their choice if the policy cache is
    // briefly out of sync (e.g. right after login, before Statsig /
    // managed-settings finish fetching). Session-scoped enforcement still
    // happens in SessionService.enforceOrgModelPolicyOnLoad.
    const access = this.validateModelAccess(currentModel);
    if (!access.allowed) {
      const fallback = this.getFirstAllowedModel();
      if (fallback) {
        return fallback;
      }
    }

    return currentModel;
  }

  public setModel(model: string, reasoningEffort?: ReasoningEffort): void {
    // Validate against org policy
    const validation = this.validateModelAccess(model);

    if (!validation.allowed) {
      logWarn('[Settings] Cannot set model - blocked by org policy');

      // Throw error to prevent setting blocked model
      throw new MetaError('Model not allowed by organization policy', {
        modelId: model,
      });
    }

    // Build session default settings updates
    const sessionUpdates: { model: string; reasoningEffort?: ReasoningEffort } =
      { model };

    if (reasoningEffort !== undefined) {
      // Clamp to supported efforts for the new model
      sessionUpdates.reasoningEffort = clampReasoningEffortForModel(
        model,
        reasoningEffort
      );
    } else {
      // When switching models without specifying reasoning effort,
      // reset to the new model's default if current effort is not supported
      const newModelConfig = getTuiModelConfig(model);
      const supportedEfforts = newModelConfig.supportedReasoningEfforts || [];
      const currentEffort =
        this.settings.general?.sessionDefaultSettings?.reasoningEffort;

      if (!currentEffort || !supportedEfforts.includes(currentEffort)) {
        sessionUpdates.reasoningEffort = getModelDefaultReasoningEffort(model);
      }
    }

    this.updateSettings({
      general: { sessionDefaultSettings: sessionUpdates },
    });
    this.notifyModelListeners();

    // If reasoning effort was updated, notify reasoning effort listeners too
    if (sessionUpdates.reasoningEffort !== undefined) {
      this.notifyReasoningEffortListeners();
    }
  }

  public getReasoningEffort(): ReasoningEffort {
    return (
      this.settings.general?.sessionDefaultSettings?.reasoningEffort ??
      ReasoningEffort.High
    );
  }

  public setReasoningEffort(reasoningEffort: ReasoningEffort): void {
    const currentModel = this.getModel();
    const clamped = clampReasoningEffortForModel(currentModel, reasoningEffort);
    this.updateSettings({
      general: { sessionDefaultSettings: { reasoningEffort: clamped } },
    });
    this.notifyReasoningEffortListeners();
  }

  public cycleReasoningEffort(): ReasoningEffort {
    const currentModel = this.getModel();
    const currentEffort = this.getReasoningEffort();
    const nextEffort = calculateNextReasoningEffort(
      currentModel,
      currentEffort
    );

    this.setReasoningEffort(nextEffort);
    return nextEffort;
  }

  /**
   * Determine the next model in the cycle without applying it.
   * Used by Ctrl+N to compute the target before triggering compaction.
   * Skips models that are disabled by admin policy.
   * @param availableModels - List of available model IDs to cycle through
   * @returns The next model ID and its default reasoning effort, or null if no change
   */
  public peekNextCycleModel(
    availableModels: string[],
    currentModel?: string
  ): { modelId: string; effort: ReasoningEffort } | null {
    if (availableModels.length === 0) {
      return null;
    }

    const model = currentModel ?? this.getModel();
    const currentIndex = availableModels.indexOf(model);
    const startIndex = currentIndex === -1 ? 0 : currentIndex;

    for (let i = 1; i <= availableModels.length; i++) {
      const nextIndex = (startIndex + i) % availableModels.length;
      const nextModel = availableModels[nextIndex];

      const validation = this.validateModelAccess(nextModel);
      if (!validation.allowed) {
        continue;
      }

      try {
        const defaultEffort = getModelDefaultReasoningEffort(nextModel);
        return { modelId: nextModel, effort: defaultEffort };
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * Cycle through available models (for Ctrl+N shortcut).
   * Returns the new model ID.
   * Resets reasoning effort to the model's default (first supported option).
   * Skips models that are disabled by admin policy.
   * @param availableModels - List of available model IDs to cycle through
   */
  public cycleModel(availableModels: string[], currentModel?: string): string {
    const next = this.peekNextCycleModel(availableModels, currentModel);
    if (!next) {
      return currentModel ?? this.getModel();
    }
    this.setModel(next.modelId, next.effort);
    return next.modelId;
  }

  /**
   * Determine the next spec mode model in the cycle without applying it.
   * Used by Ctrl+N to compute the target before triggering compaction.
   * Skips models that are disabled by admin policy.
   */
  public peekNextCycleSpecModeModel(
    availableModels: string[],
    currentSpecModel?: string
  ): { modelId: string; effort: ReasoningEffort } | null {
    if (availableModels.length === 0) {
      return null;
    }

    const specModel = currentSpecModel ?? this.getSpecModeModel();
    const currentIndex = availableModels.indexOf(specModel);
    const startIndex = currentIndex === -1 ? 0 : currentIndex;

    for (let i = 1; i <= availableModels.length; i++) {
      const nextIndex = (startIndex + i) % availableModels.length;
      const nextModel = availableModels[nextIndex];

      const validation = this.validateModelAccess(nextModel);
      if (!validation.allowed) {
        continue;
      }

      try {
        const defaultEffort = getModelDefaultReasoningEffort(nextModel);
        return { modelId: nextModel, effort: defaultEffort };
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * Cycle through available models for Spec Mode (for Ctrl+N shortcut while in Spec mode).
   * Returns the new spec mode model ID.
   * Resets spec reasoning effort to the model's default (first supported option).
   * Skips models that are disabled by admin policy.
   * @param availableModels - List of available model IDs to cycle through
   */
  public cycleSpecModeModel(availableModels: string[]): string {
    if (availableModels.length === 0) {
      return this.getSpecModeModel();
    }

    const currentSpecModel = this.getSpecModeModel();
    const currentIndex = availableModels.indexOf(currentSpecModel);
    const startIndex = currentIndex === -1 ? 0 : currentIndex;

    for (let i = 1; i <= availableModels.length; i++) {
      const nextIndex = (startIndex + i) % availableModels.length;
      const nextModel = availableModels[nextIndex];

      const validation = this.validateModelAccess(nextModel);
      if (!validation.allowed) {
        continue;
      }

      try {
        const defaultEffort = getModelDefaultReasoningEffort(nextModel);
        this.setSpecModeModel(nextModel, defaultEffort);
        return nextModel;
      } catch {
        continue;
      }
    }

    return currentSpecModel;
  }

  /**
   * Subscribe to reasoning effort changes
   */
  public subscribeToReasoningEffort(
    listener: (effort: ReasoningEffort) => void
  ): () => void {
    this.reasoningEffortListeners.add(listener);
    return () => {
      this.reasoningEffortListeners.delete(listener);
    };
  }

  /**
   * Notify all listeners of reasoning effort change
   */
  private notifyReasoningEffortListeners(): void {
    const currentEffort = this.getReasoningEffort();
    this.reasoningEffortListeners.forEach((listener) =>
      listener(currentEffort)
    );
  }

  /**
   * Subscribe to spec mode reasoning effort changes
   */
  public subscribeToSpecModeReasoningEffort(
    listener: (effort: ReasoningEffort) => void
  ): () => void {
    this.specReasoningEffortListeners.add(listener);
    return () => {
      this.specReasoningEffortListeners.delete(listener);
    };
  }

  /**
   * Notify all listeners of spec mode reasoning effort change
   */
  private notifySpecReasoningEffortListeners(): void {
    const currentEffort = this.getSpecModeReasoningEffort();
    this.specReasoningEffortListeners.forEach((listener) =>
      listener(currentEffort)
    );
  }

  /**
   * Subscribe to model changes
   */
  public subscribeToModel(listener: (model: string) => void): () => void {
    this.modelListeners.add(listener);
    return () => {
      this.modelListeners.delete(listener);
    };
  }

  /**
   * Notify all listeners of model change
   */
  private notifyModelListeners(): void {
    const currentModel = this.getModel();
    this.modelListeners.forEach((listener) => listener(currentModel));
  }

  /**
   * Subscribe to spec mode model changes
   */
  public subscribeToSpecModeModel(
    listener: (model: string | undefined) => void
  ): () => void {
    this.specModeModelListeners.add(listener);
    return () => {
      this.specModeModelListeners.delete(listener);
    };
  }

  /**
   * Notify all listeners of spec mode model change
   */
  private notifySpecModeModelListeners(): void {
    const currentModel =
      this.settings.general?.sessionDefaultSettings?.specModeModel;
    this.specModeModelListeners.forEach((listener) => listener(currentModel));
  }

  /**
   * Subscribe to mission model/effort default changes (orchestrator,
   * worker, validator). Fires whenever any mission default model or its
   * reasoning effort is updated so cross-view consumers (e.g. /model and
   * Mission Control) stay in sync.
   */
  public subscribeToMissionModels(listener: () => void): () => void {
    this.missionModelListeners.add(listener);
    return () => {
      this.missionModelListeners.delete(listener);
    };
  }

  private notifyMissionModelListeners(): void {
    this.missionModelListeners.forEach((listener) => listener());
  }

  public setCloudSessionSync(cloudSessionSync: boolean): void {
    this.updateSettings({ general: { cloudSessionSync } });
  }

  // ---------------------------------------------------------------------------
  // Diff mode
  // ---------------------------------------------------------------------------
  public getDiffMode(): DiffMode {
    return (this.settings.general?.diffMode ?? 'github') as DiffMode;
  }

  public setDiffMode(diffMode: DiffMode): void {
    this.updateSettings({ general: { diffMode } });
  }

  // ---------------------------------------------------------------------------
  // IDE extension
  // ---------------------------------------------------------------------------
  public getIdeExtensionPromptedAt(ideType: string): number | null {
    const promptedAt = this.settings.general?.ideExtensionPromptedAt?.[ideType];
    return promptedAt ?? null;
  }

  public setIdeExtensionPromptedAt(ideType: string, timestamp?: number): void {
    const ideExtensionPromptedAt =
      this.settings.general?.ideExtensionPromptedAt || {};
    ideExtensionPromptedAt[ideType] = timestamp ?? Date.now();

    this.updateSettings({
      general: { ideExtensionPromptedAt },
    });
  }

  public clearIdeExtensionPrompted(ideType: string): void {
    if (this.settings.general?.ideExtensionPromptedAt) {
      const ideExtensionPromptedAt = {
        ...this.settings.general.ideExtensionPromptedAt,
      };
      delete ideExtensionPromptedAt[ideType];

      this.updateSettings({
        general: { ideExtensionPromptedAt },
      });
    }
  }

  public hasBeenPromptedForIdeExtension(ideType: string): boolean {
    return !!this.settings.general?.ideExtensionPromptedAt?.[ideType];
  }

  // ---------------------------------------------------------------------------
  // Autonomy / Interaction Settings
  // ---------------------------------------------------------------------------

  /**
   * Get the stored interaction mode (decoupled field).
   * Returns undefined if not set (caller should fall back to legacy).
   */
  public getInteractionMode(): DroolInteractionMode | undefined {
    return this.settings.general?.sessionDefaultSettings?.interactionMode as
      | DroolInteractionMode
      | undefined;
  }

  /**
   * Get the stored autonomy level (decoupled field).
   * Returns undefined if not set (caller should fall back to legacy).
   */
  public getAutonomyLevel(): AutonomyLevel | undefined {
    return this.settings.general?.sessionDefaultSettings?.autonomyLevel as
      | AutonomyLevel
      | undefined;
  }

  /**
   * @deprecated Use getInteractionMode() and getAutonomyLevel() instead.
   * Returns the legacy combined autonomyMode field.
   */
  public getAutonomyMode(): AutonomyMode {
    return (
      (this.settings.general?.sessionDefaultSettings
        ?.autonomyMode as AutonomyMode) ?? AutonomyMode.Normal
    );
  }

  public getMaxAutonomyLevel(): AutonomyLevel | undefined {
    return this.settings.general?.maxAutonomyLevel as AutonomyLevel | undefined;
  }

  /**
   * Get the autonomy level applied to subagents spawned by the Task tool
   * (Subagents V2). Returns the configured value or `Inherit` when unset.
   * Mission workers do not use this setting.
   */
  public getSubagentAutonomyLevel(): SubagentAutonomyLevel {
    return (
      (this.settings.general?.subagentAutonomyLevel as
        | SubagentAutonomyLevel
        | undefined) ?? SubagentAutonomyLevel.Inherit
    );
  }

  public setSubagentAutonomyLevel(level: SubagentAutonomyLevel): void {
    this.updateSettings({
      general: { subagentAutonomyLevel: level },
    });
  }

  public getSubagentAutonomyLevelManagementInfo(): SettingManagementInfo {
    return this.getSettingManagementInfo('subagentAutonomyLevel');
  }

  public getMcpAutonomyOverrides(): ManagedSettings['mcpAutonomyOverrides'] {
    return this.settings.general?.mcpAutonomyOverrides;
  }

  public setMcpAutonomyOverrides(
    overrides: ManagedSettings['mcpAutonomyOverrides']
  ): void {
    this.updateSettings({ general: { mcpAutonomyOverrides: overrides } });
  }

  public getMcpAutonomyUrlOverrides(): ManagedSettings['mcpAutonomyUrlOverrides'] {
    return this.settings.general?.mcpAutonomyUrlOverrides;
  }

  /**
   * Persist decoupled interaction settings (canonical storage format).
   * Also derives and stores legacy autonomyMode for backward compatibility.
   */
  public setInteractionSettings(
    interactionMode: DroolInteractionMode,
    autonomyLevel: AutonomyLevel
  ): void {
    const autonomyMode = deriveAutonomyMode(interactionMode, autonomyLevel);
    this.updateSettings({
      general: {
        sessionDefaultSettings: {
          interactionMode,
          autonomyLevel,
          autonomyMode,
        },
      },
    });
  }

  /**
   * @deprecated Use setInteractionSettings() instead.
   * This derives decoupled values from legacy mode which loses information.
   */
  public setAutonomyMode(autonomyMode: AutonomyMode): void {
    const { mode, level } = parseAutonomyMode(autonomyMode);
    this.setInteractionSettings(mode, level);
  }

  public reset(): void {
    const defaults: Settings = { general: { ...DEFAULT_GENERAL_SETTINGS } };
    this.settings = defaults;
    void this.persistSettings(defaults);
  }

  // Test helper - only exposed for testing
  public resetForTesting(): void {
    this.settings = { general: { ...DEFAULT_GENERAL_SETTINGS } };
    this.initialized = false;
    this.cachedModelPolicy = {
      allowedModelIds: [],
      blockedModelIds: [],
      allowCustomModels: true,
    };
    this.customModels = [];
    this.orgSettings = {};
    this.settingsHierarchy = [];
    SettingsManager.getInstance().disableWatching();
    SettingsManager.resetInstance();
  }

  /**
   * @deprecated Use getCompletionSound() instead
   */
  public getEnableCompletionBell(): boolean {
    return this.settings.general?.enableCompletionBell ?? false;
  }

  /**
   * @deprecated Use setCompletionSound() instead
   */
  public setEnableCompletionBell(enableCompletionBell: boolean): void {
    this.updateSettings({ general: { enableCompletionBell } });
  }

  /**
   * Gets the completion sound setting with backward compatibility
   * If the new completionSound setting is not set, migrates from enableCompletionBell
   */
  public getCompletionSound(): SoundOption {
    // If new setting exists, use it
    if (this.settings.general?.completionSound !== undefined) {
      return this.settings.general.completionSound;
    }

    // Migrate from old setting
    if (this.settings.general?.enableCompletionBell) {
      return 'bell';
    }

    return 'off';
  }

  /**
   * Sets the completion sound option
   */
  public setCompletionSound(completionSound: SoundOption): void {
    this.updateSettings({ general: { completionSound } });
  }

  public getSoundFocusMode(): SoundFocusMode {
    // Prefer the unified setting
    if (this.settings.general?.soundFocusMode !== undefined) {
      return this.settings.general.soundFocusMode as SoundFocusMode;
    }

    if (this.settings.general?.completionSoundFocusMode !== undefined) {
      return this.settings.general.completionSoundFocusMode as SoundFocusMode;
    }

    return SoundFocusMode.Always;
  }

  public setSoundFocusMode(soundFocusMode: SoundFocusMode): void {
    this.updateSettings({ general: { soundFocusMode } });
  }

  public getAwaitingInputSound(): SoundOption {
    return this.settings.general?.awaitingInputSound ?? BuiltInSound.FX_ACK01;
  }

  public setAwaitingInputSound(awaitingInputSound: SoundOption): void {
    this.updateSettings({ general: { awaitingInputSound } });
  }

  public getSubagentSoundMode(): SubagentSoundMode {
    return this.settings.general?.subagentSounds ?? SubagentSoundMode.Off;
  }

  public setSubagentSoundMode(subagentSounds: SubagentSoundMode): void {
    this.updateSettings({ general: { subagentSounds } });
  }

  public getIncludeCoAuthoredByDrool(): boolean {
    return this.settings.general?.includeCoAuthoredByDrool ?? true;
  }

  public setIncludeCoAuthoredByDrool(includeCoAuthoredByDrool: boolean): void {
    this.updateSettings({ general: { includeCoAuthoredByDrool } });
  }

  public getKeepSystemAwakeDuringMissions(): boolean {
    return this.settings.general?.keepSystemAwakeDuringMissions ?? true;
  }

  // ---------------------------------------------------------------------------
  // Spec Save Settings
  // ---------------------------------------------------------------------------
  public getSpecSaveEnabled(): boolean {
    // Always return true - spec saving is now mandatory
    return true;
  }

  public setSpecSaveEnabled(_specSaveEnabled: boolean): void {
    // Deprecated - spec saving is always enabled
    // Keep for backward compatibility but don't actually change the setting
    logWarn(
      '[Settings] specSaveEnabled is deprecated - spec saving is now always enabled'
    );
  }

  public getSpecSaveDir(): string {
    return (
      this.settings.general?.specSaveDir ??
      `${getIndustryHome()}/${getIndustryDirName()}/specs`
    );
  }

  public setSpecSaveDir(specSaveDir: string): void {
    this.updateSettings({ general: { specSaveDir } });
  }

  public getWorktreeDirectory(): string | undefined {
    return this.settings.general?.worktreeDirectory;
  }

  // ---------------------------------------------------------------------------
  // Spec Mode Model Settings
  // ---------------------------------------------------------------------------
  public getSpecModeModel(): string {
    // If no spec mode model is configured, fall back to the main model
    const specModeModel =
      this.settings.general?.sessionDefaultSettings?.specModeModel;
    if (!specModeModel) {
      return this.getModel();
    }

    let specModel = specModeModel;

    // Migration: Convert old format custom model IDs to new format
    if (specModel.startsWith('custom:')) {
      const canonicalModel = this.resolveCanonicalCustomModelId(specModel);
      if (canonicalModel !== specModel) {
        logInfo(
          '[Settings] Migrating spec mode custom model ID to canonical format',
          {
            oldId: specModel,
            newId: canonicalModel,
          }
        );

        specModel = canonicalModel;
        this.updateSettings({
          general: { sessionDefaultSettings: { specModeModel: specModel } },
        });
      }
    }

    const access = this.validateModelAccess(specModel);
    if (!access.allowed) {
      const fallback = this.getFirstAllowedModel();
      if (fallback) {
        return fallback;
      }
    }

    return specModel;
  }

  public setSpecModeModel(
    model: string,
    reasoningEffort?: ReasoningEffort
  ): void {
    const validation = this.validateModelAccess(model);
    if (!validation.allowed) {
      throw new MetaError('Model not allowed by organization policy', {
        modelId: model,
      });
    }

    const sessionUpdates: {
      specModeModel: string;
      specModeReasoningEffort?: ReasoningEffort;
    } = { specModeModel: model };

    if (reasoningEffort !== undefined) {
      sessionUpdates.specModeReasoningEffort = clampReasoningEffortForModel(
        model,
        reasoningEffort
      );
    } else {
      // When setting spec mode model without specifying reasoning effort,
      // reset to the new model's default if current effort is not supported
      const newModelConfig = getTuiModelConfig(model);
      const supportedEfforts = newModelConfig.supportedReasoningEfforts || [];
      const currentEffort =
        this.settings.general?.sessionDefaultSettings?.specModeReasoningEffort;

      if (!currentEffort || !supportedEfforts.includes(currentEffort)) {
        sessionUpdates.specModeReasoningEffort =
          getModelDefaultReasoningEffort(model);
      }
    }

    this.updateSettings({
      general: { sessionDefaultSettings: sessionUpdates },
    });
    this.notifySpecModeModelListeners();

    // If spec mode reasoning effort was updated, notify spec reasoning effort listeners too
    if (sessionUpdates.specModeReasoningEffort !== undefined) {
      this.notifySpecReasoningEffortListeners();
    }
  }

  public getSpecModeReasoningEffort(): ReasoningEffort {
    // If no spec mode reasoning effort is configured:
    // - If there's an explicit spec model, use that model's default reasoning effort
    // - If there's no explicit spec model (using main model), use main model's reasoning effort
    const specModeReasoningEffort =
      this.settings.general?.sessionDefaultSettings?.specModeReasoningEffort;
    if (!specModeReasoningEffort) {
      if (this.hasSpecModeModel()) {
        // Explicit spec model configured - use its default reasoning effort
        const specModel = this.getSpecModeModel();
        return getModelDefaultReasoningEffort(specModel);
      }
      // No explicit spec model - use main model's reasoning effort
      return this.getReasoningEffort();
    }
    return specModeReasoningEffort;
  }

  public setSpecModeReasoningEffort(effort: ReasoningEffort): void {
    const specModel = this.getSpecModeModel();
    const clamped = clampReasoningEffortForModel(specModel, effort);
    this.updateSettings({
      general: {
        sessionDefaultSettings: { specModeReasoningEffort: clamped },
      },
    });
    this.notifySpecReasoningEffortListeners();
  }

  public clearSpecModeModel(): void {
    this.updateSettings({
      general: {
        sessionDefaultSettings: {
          specModeModel: undefined,
          specModeReasoningEffort: undefined,
        },
      },
    });
    this.notifySpecModeModelListeners();
  }

  public hasSpecModeModel(): boolean {
    return (
      this.settings.general?.sessionDefaultSettings?.specModeModel !== undefined
    );
  }

  public cycleSpecModeReasoningEffort(): ReasoningEffort {
    const specModel = this.getSpecModeModel();
    const currentEffort = this.getSpecModeReasoningEffort();
    const nextEffort = calculateNextReasoningEffort(specModel, currentEffort);

    this.updateSettings({
      general: {
        sessionDefaultSettings: { specModeReasoningEffort: nextEffort },
      },
    });
    this.notifySpecReasoningEffortListeners();
    return nextEffort;
  }

  // ---------------------------------------------------------------------------
  // Command Allowlist/Denylist
  // ---------------------------------------------------------------------------
  public getCommandAllowlist(): string[] {
    return this.settings.general?.commandAllowlist || DEFAULT_COMMAND_ALLOWLIST;
  }

  public getCommandDenylist(): string[] {
    return this.settings.general?.commandDenylist || DEFAULT_COMMAND_DENYLIST;
  }

  /**
   * Blocked commands can never run and can never be approved (a hard denylist),
   * unlike denylisted commands which can still be approved manually.
   */
  public getCommandBlocklist(): string[] {
    return this.settings.general?.commandBlocklist || DEFAULT_COMMAND_BLOCKLIST;
  }

  public setCommandAllowlist(allowlist: string[]): void {
    this.updateSettings({ general: { commandAllowlist: allowlist } });
  }

  public setCommandDenylist(denylist: string[]): void {
    this.updateSettings({ general: { commandDenylist: denylist } });
  }

  /** Persist the hard-denylist of commands that can never run or be approved. */
  public setCommandBlocklist(blocklist: string[]): void {
    this.updateSettings({ general: { commandBlocklist: blocklist } });
  }

  // Get the path to the settings file for external opening
  public getSettingsFilePath(): string {
    return path.normalize(getSettingsFilePath());
  }

  // ---------------------------------------------------------------------------
  // Drool Shield
  // ---------------------------------------------------------------------------
  public getEnableDroolShield(): boolean {
    return this.settings.general?.enableDroolShield ?? true;
  }

  public setEnableDroolShield(enableDroolShield: boolean): void {
    this.updateSettings({ general: { enableDroolShield } });
  }

  // ---------------------------------------------------------------------------
  // Auto Model guidance (org-only managed setting)
  // ---------------------------------------------------------------------------
  // Sourced from this.orgSettings, not the merged this.settings, so
  // user/project/folder configs can't silently shadow what the admin set in
  // Enterprise Controls.
  public getIndustryRouterGuidance(): string | undefined {
    const orgValue = this.orgSettings.general?.industryRouterGuidance;
    const mergedValue = this.settings.general?.industryRouterGuidance;
    if (
      typeof mergedValue === 'string' &&
      mergedValue.trim().length > 0 &&
      mergedValue !== orgValue
    ) {
      logWarnOnce(
        'industry-router-guidance-non-org',
        '[SettingsService] industryRouterGuidance set at a non-org settings level is ignored; only org-managed values flow into Auto Model decisions.'
      );
    }
    if (typeof orgValue !== 'string') return undefined;
    const trimmed = orgValue.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  public getIndustryRouterRules(): IndustryRouterRule[] | undefined {
    const orgValue = this.orgSettings.general?.industryRouterRules;
    const mergedValue = this.settings.general?.industryRouterRules;
    const mergedRules = Array.isArray(mergedValue)
      ? normalizeIndustryRouterRules(mergedValue)
      : undefined;
    if (
      mergedRules &&
      JSON.stringify(mergedValue) !== JSON.stringify(orgValue)
    ) {
      logWarnOnce(
        'industry-router-rules-non-org',
        '[SettingsService] industryRouterRules set at a non-org settings level is ignored; only org-managed values flow into Auto Model decisions.'
      );
    }
    if (!Array.isArray(orgValue)) return undefined;
    return normalizeIndustryRouterRules(orgValue);
  }

  // ---------------------------------------------------------------------------
  // Hooks Management
  // ---------------------------------------------------------------------------
  public getHooksDisabled(): boolean {
    return this.settings.hooks?.hooksDisabled ?? false;
  }

  public setHooksDisabled(hooksDisabled: boolean): void {
    this.updateSettings({ hooks: { hooksDisabled } });
  }

  public addHook(
    hookType: keyof HooksSettings,
    matcher: string,
    command: string,
    timeout?: number,
    commandRegex?: string,
    replaceWhere?: (existingCommand: string) => boolean
  ): void {
    const currentHooks = this.settings.hooks ?? {};
    const hookConfigs = [...(currentHooks[hookType] || [])];
    const newHook = {
      type: 'command' as const,
      command,
      ...(timeout && { timeout }),
    };

    // Find existing config with this matcher AND commandRegex
    // Both matcher and commandRegex must match to be considered the same config
    const existingConfigIndex = hookConfigs.findIndex(
      (config: HookConfig) =>
        config.matcher === matcher && config.commandRegex === commandRegex
    );

    if (existingConfigIndex >= 0) {
      const existingHooks = hookConfigs[existingConfigIndex].hooks;
      const filteredHooks = replaceWhere
        ? existingHooks.filter((h) => !replaceWhere(h.command))
        : existingHooks;
      hookConfigs[existingConfigIndex] = {
        ...hookConfigs[existingConfigIndex],
        hooks: [...filteredHooks, newHook],
      };
    } else {
      hookConfigs.push({
        matcher,
        ...(commandRegex && { commandRegex }),
        hooks: [newHook],
      });
    }

    this.updateSettings({ hooks: { [hookType]: hookConfigs } });
  }

  public removeHook(
    hookType: keyof HooksSettings,
    matcher: string,
    commandIndex: number
  ): void {
    const currentHooks = this.settings.hooks ?? {};
    const hookConfigs = [...(currentHooks[hookType] || [])];

    const configIndex = hookConfigs.findIndex(
      (config: HookConfig) => config.matcher === matcher
    );

    if (configIndex >= 0) {
      const updatedHooks = [...hookConfigs[configIndex].hooks];
      updatedHooks.splice(commandIndex, 1);

      // Remove the config if no hooks left
      if (updatedHooks.length === 0) {
        hookConfigs.splice(configIndex, 1);
      } else {
        hookConfigs[configIndex] = {
          ...hookConfigs[configIndex],
          hooks: updatedHooks,
        };
      }

      this.updateSettings({ hooks: { [hookType]: hookConfigs } });
    }
  }

  // Removes any hook commands in `hookType` whose `command` matches the
  // predicate, across every matcher bucket. Empty buckets are dropped.
  // Used by Git AI auto-setup so a single canonical entry survives even
  // when older or imported configs registered the same command under a
  // different matcher (e.g. legacy Claude `*`).
  public removeHookCommandsMatching(
    hookType: keyof HooksSettings,
    predicate: (command: string) => boolean
  ): void {
    const currentHooks = this.settings.hooks ?? {};
    const hookConfigs = currentHooks[hookType];
    if (!Array.isArray(hookConfigs) || hookConfigs.length === 0) {
      return;
    }

    let mutated = false;
    const updated: HookConfig[] = [];
    for (const config of hookConfigs) {
      if (!config || !Array.isArray(config.hooks)) {
        updated.push(config);
        continue;
      }
      const filteredHooks = config.hooks.filter((h) => !predicate(h.command));
      if (filteredHooks.length === config.hooks.length) {
        updated.push(config);
        continue;
      }
      mutated = true;
      if (filteredHooks.length > 0) {
        updated.push({ ...config, hooks: filteredHooks });
      }
    }

    if (!mutated) return;

    this.updateSettings({ hooks: { [hookType]: updated } });
  }

  public getHooksForType(hookType: keyof HooksSettings): HookConfig[] {
    return (this.settings.hooks?.[hookType] as HookConfig[] | undefined) || [];
  }

  // ---------------------------------------------------------------------------
  // Show Hook Output
  // ---------------------------------------------------------------------------
  public getShowHookOutput(): boolean {
    return this.settings.hooks?.showHookOutput ?? true;
  }

  public setShowHookOutput(showHookOutput: boolean): void {
    this.updateSettings({ hooks: { showHookOutput } });
  }

  // ---------------------------------------------------------------------------
  // Todo Display Mode
  // ---------------------------------------------------------------------------
  public getTodoDisplayMode(): TodoDisplayMode {
    return TodoDisplayMode.Pinned;
  }

  public setTodoDisplayMode(_todoDisplayMode: TodoDisplayMode): void {}

  // ---------------------------------------------------------------------------
  // Tool Result Display
  // ---------------------------------------------------------------------------
  public getToolResultDisplay(): ToolResultDisplay {
    return (
      (this.settings.general?.toolResultDisplay as ToolResultDisplay) ??
      ToolResultDisplay.Expanded
    );
  }

  public setToolResultDisplay(toolResultDisplay: ToolResultDisplay): void {
    this.updateSettings({ general: { toolResultDisplay } });
  }

  // ---------------------------------------------------------------------------
  // Logo Animation Settings
  // ---------------------------------------------------------------------------
  public getLogoAnimation(): LogoAnimationMode {
    return this.settings.general?.logoAnimation ?? LogoAnimationMode.Always;
  }

  public setLogoAnimation(mode: LogoAnimationMode): void {
    this.updateSettings({ general: { logoAnimation: mode } });
  }

  public shouldShowLogoAnimation(): boolean {
    const mode = this.getLogoAnimation();
    return mode === LogoAnimationMode.Once || mode === LogoAnimationMode.Always;
  }

  public markLogoAnimationShown(): void {
    const mode = this.getLogoAnimation();
    // Auto-toggle from ONCE to OFF after animation is shown
    if (mode === LogoAnimationMode.Once) {
      this.setLogoAnimation(LogoAnimationMode.Off);
    }
  }

  // ---------------------------------------------------------------------------
  // Hide Changelog
  // ---------------------------------------------------------------------------
  public getHideChangelog(): boolean {
    return this.settings.general?.hideChangelog ?? true;
  }

  public setHideChangelog(hideChangelog: boolean): void {
    this.updateSettings({ general: { hideChangelog } });
  }

  // ---------------------------------------------------------------------------
  // Nerd Font
  // ---------------------------------------------------------------------------
  public getNerdFont(): boolean {
    return this.settings.general?.nerdFont ?? false;
  }

  public setNerdFont(nerdFont: boolean): void {
    this.updateSettings({ general: { nerdFont } });
  }

  // ---------------------------------------------------------------------------
  // Show Thinking in Main View
  // ---------------------------------------------------------------------------
  public getShowThinkingInMainView(): boolean {
    return this.settings.general?.showThinkingInMainView ?? false;
  }

  public setShowThinkingInMainView(showThinking: boolean): void {
    this.updateSettings({ general: { showThinkingInMainView: showThinking } });
  }

  // ---------------------------------------------------------------------------
  // IDE Auto-Connect
  // ---------------------------------------------------------------------------
  public getIdeAutoConnect(): boolean {
    return this.settings.general?.ideAutoConnect ?? false;
  }

  public setIdeAutoConnect(ideAutoConnect: boolean): void {
    this.updateSettings({ general: { ideAutoConnect } });
  }

  // ---------------------------------------------------------------------------
  // Token Usage Indicator
  // ---------------------------------------------------------------------------
  public getShowTokenUsageIndicator(): boolean {
    return this.settings.general?.showTokenUsageIndicator ?? false;
  }

  public setShowTokenUsageIndicator(showTokenUsageIndicator: boolean): void {
    this.updateSettings({ general: { showTokenUsageIndicator } });
  }

  // ---------------------------------------------------------------------------
  // Status Line
  // ---------------------------------------------------------------------------
  public getStatusLine(): StatusLineConfig | undefined {
    return this.settings.general?.statusLine;
  }

  public setStatusLine(statusLine: StatusLineConfig | undefined): void {
    this.updateSettings({ general: { statusLine } });
  }

  // ---------------------------------------------------------------------------
  // Override Terminal Colors
  // ---------------------------------------------------------------------------
  public getOverrideTerminalColors(): boolean {
    return this.settings.general?.overrideTerminalColors ?? false;
  }

  public setOverrideTerminalColors(overrideTerminalColors: boolean): void {
    this.updateSettings({ general: { overrideTerminalColors } });
  }

  // ---------------------------------------------------------------------------
  // Org Managed Settings
  // ---------------------------------------------------------------------------

  /**
   * Get the cached org-level settings.
   * Used to check org-level deny lists and other org-managed values.
   */
  public getOrgSettings(): Settings {
    return this.orgSettings;
  }

  /**
   * Get the organization's Industry tier (e.g., 'team', 'enterprise').
   * Returns null if org settings haven't been loaded yet or tier is unknown.
   */
  public getOrgTier(): IndustryTier | null {
    return SettingsManager.getInstance().getOrgTier();
  }

  /**
   * Get sandbox settings from levels above user (org, runtime, folder, project).
   * Returns the union-merged sandbox settings from all higher-priority levels.
   */
  private getHigherLevelSandboxSettings(): SandboxSettings | undefined {
    let merged: SandboxSettings | undefined;
    for (const entry of this.settingsHierarchy) {
      if (
        entry.level === SettingsLevel.User ||
        entry.level === SettingsLevel.Dynamic ||
        entry.level === SettingsLevel.BuiltIn
      ) {
        continue;
      }
      const levelSandbox = entry.settings.general?.sandbox;
      if (levelSandbox) {
        merged = merged
          ? mergeSandboxSettings(merged, levelSandbox)
          : levelSandbox;
      }
    }
    return merged;
  }

  /**
   * Get sandbox settings from user level only.
   * Used by persistAllowAlways to avoid copying higher-level entries.
   */
  public getUserSandboxSettings(): SandboxSettings | undefined {
    const userEntry = this.settingsHierarchy.find(
      (l) => l.level === SettingsLevel.User
    );
    return userEntry?.settings.general?.sandbox;
  }

  /**
   * Update user-level sandbox settings and refresh the resolved hierarchy.
   * Uses SettingsManager's serialized write path so concurrent calls are safe.
   */
  public async updateUserSandboxSettings(
    patch: SandboxSettings
  ): Promise<void> {
    const manager = SettingsManager.getInstance();
    await manager.updateLevelSettings(SettingsLevel.User, {
      general: { sandbox: patch },
    });
    // Re-read the hierarchy so subsequent calls see the persisted state
    this.settingsHierarchy =
      await manager.getSettingsHierarchyWithAttribution();
  }

  /**
   * Check if a specific deny path is owned at the user level (can be removed).
   */
  public hasUserLevelMatchingDeny(
    filePath: string,
    kind: SandboxDenyListKind
  ): boolean {
    const userSandbox = this.getUserSandboxSettings();
    const entries = userSandbox?.filesystem?.[kind] ?? [];
    const resolvedFilePath = resolveSandboxPath({ rawPath: filePath });
    return entries.some((entry) =>
      isPathUnderEntry(resolvedFilePath, resolveSandboxPath({ rawPath: entry }))
    );
  }

  // ===========================================================================
  // MCP Settings (User Level)
  // ===========================================================================

  /**
   * Get MCP settings from user level only.
   * Used by McpPermissionService to manage persistent permissions.
   */
  public getUserMcpSettings(): McpSettings | undefined {
    const userEntry = this.settingsHierarchy.find(
      (l) => l.level === SettingsLevel.User
    );
    return userEntry?.settings.mcp;
  }

  /**
   * Update user-level MCP settings and refresh the resolved hierarchy.
   * Uses SettingsManager's serialized write path so concurrent calls are safe.
   *
   * @param patch - Partial MCP settings to merge with existing settings
   */
  public async updateUserMcpSettings(
    patch: Partial<McpSettings>
  ): Promise<void> {
    const manager = SettingsManager.getInstance();
    await manager.updateLevelSettings(SettingsLevel.User, {
      mcp: patch,
    });
    // Re-read the hierarchy so subsequent calls see the persisted state
    this.settingsHierarchy =
      await manager.getSettingsHierarchyWithAttribution();
  }

  // ===========================================================================
  // Folder Trust (User Level)
  // ===========================================================================

  /**
   * Get the trusted-folders map from user level only.
   *
   * SECURITY: intentionally NOT read from resolved settings. Project-level
   * settings.json is attacker-controlled for the folder-trust threat model,
   * and the hierarchy merge would let a repository inject its own path into
   * the resolved `general.trustedFolders`.
   */
  public getUserTrustedFolders(): TrustedFolders | undefined {
    const userEntry = this.settingsHierarchy.find(
      (l) => l.level === SettingsLevel.User
    );
    return userEntry?.settings.general?.trustedFolders;
  }

  /**
   * Persist the full trusted-folders map at user level and refresh the
   * hierarchy. Callers pass the complete map (read-modify-write), matching
   * the ideExtensionPromptedAt pattern.
   */
  public async updateUserTrustedFolders(
    trustedFolders: TrustedFolders
  ): Promise<void> {
    const manager = SettingsManager.getInstance();
    await manager.updateLevelSettings(SettingsLevel.User, {
      general: { trustedFolders },
    });
    // Re-read the hierarchy so subsequent calls see the persisted state
    this.settingsHierarchy =
      await manager.getSettingsHierarchyWithAttribution();
  }

  /**
   * Return the merged higher-level sandbox settings only if the higher level
   * participates in policy (enabled: true). Returns undefined otherwise.
   */
  private getParticipatingHigherSandbox(): SandboxSettings | undefined {
    const higher = this.getHigherLevelSandboxSettings();
    if (!higher || higher.enabled !== true) return undefined;
    return higher;
  }

  /**
   * Check if a participating higher level imposes a capability ceiling that
   * excludes the given filesystem write path.
   *
   * A participating level that omits `allowWrite` has an implicit empty ceiling.
   */
  public isWriteBlockedByHigherCeiling(targetPath: string): boolean {
    const higher = this.getParticipatingHigherSandbox();
    if (!higher) return false;
    const ceiling = higher.filesystem?.allowWrite;
    if (ceiling === undefined) return true;
    const resolvedTargetPath = resolveSandboxPath({ rawPath: targetPath });
    return !ceiling.some((entry) =>
      isPathUnderEntry(
        resolvedTargetPath,
        resolveSandboxPath({ rawPath: entry })
      )
    );
  }

  /**
   * Check if a participating higher level imposes a capability ceiling that
   * excludes the given network domain.
   *
   * A participating level that omits `allowedDomains` has an implicit empty ceiling.
   */
  public isDomainBlockedByHigherCeiling(domain: string): boolean {
    const higher = this.getParticipatingHigherSandbox();
    if (!higher) return false;
    const ceiling = higher.network?.allowedDomains;
    if (ceiling === undefined) return true;
    return !ceiling.some((pattern) => domainMatchesPattern(domain, pattern));
  }

  /**
   * Check if a participating higher level imposes a capability ceiling that
   * excludes the given read path from its allowRead carve-outs.
   *
   * Returns true when the higher level participates, has a denyRead covering
   * the path, and its allowRead ceiling does not include the target path.
   * This means user-level "Allow always" would be ineffective.
   */
  public isReadBlockedByHigherCeiling(targetPath: string): boolean {
    const higher = this.getParticipatingHigherSandbox();
    if (!higher) return false;
    const resolvedTargetPath = resolveSandboxPath({ rawPath: targetPath });

    // Only relevant if the higher level actually denies this path
    const denyEntries = higher.filesystem?.denyRead ?? [];
    const isDenied = denyEntries.some((entry) =>
      isPathUnderEntry(
        resolvedTargetPath,
        resolveSandboxPath({ rawPath: entry })
      )
    );
    if (!isDenied) return false;

    // Check if the higher level's allowRead ceiling includes this path
    const ceiling = higher.filesystem?.allowRead;
    if (ceiling === undefined) return true; // omitted = empty ceiling
    return !ceiling.some((entry) =>
      isPathUnderEntry(
        resolvedTargetPath,
        resolveSandboxPath({ rawPath: entry })
      )
    );
  }

  /**
   * Check if a deny entry for the given path originates from a participating
   * higher level. Non-participating levels' deny entries do not count as
   * higher-level policy under Section 9.4.
   */
  public isDenyFromParticipatingHigherLevel(
    filePath: string,
    kind: SandboxDenyListKind
  ): boolean {
    const higher = this.getParticipatingHigherSandbox();
    if (!higher) return false;
    const entries = higher.filesystem?.[kind] ?? [];
    const resolvedFilePath = resolveSandboxPath({ rawPath: filePath });
    return entries.some((entry) =>
      isPathUnderEntry(resolvedFilePath, resolveSandboxPath({ rawPath: entry }))
    );
  }

  /**
   * Check if a general setting is managed by the organization.
   * When a setting is org-managed, it should be displayed as disabled in the UI.
   *
   * @param settingKey - The key of the setting in general settings (e.g., 'cloudSessionSync')
   * @returns true if the setting is set at the org level
   */
  public isSettingOrgManaged(settingKey: string): boolean {
    const orgGeneral = this.orgSettings.general;
    if (!orgGeneral) return false;
    return (orgGeneral as Record<string, unknown>)[settingKey] !== undefined;
  }

  /**
   * Get all org-managed setting keys.
   * @returns Array of setting keys that are managed by the organization
   */
  public getOrgManagedSettingKeys(): string[] {
    const orgGeneral = this.orgSettings.general;
    if (!orgGeneral) return [];
    return Object.keys(orgGeneral);
  }

  /**
   * Determine which hierarchy level provides the effective value for a general setting key.
   * Walks the cached hierarchy in precedence order; the first level that defines the key wins.
   * If the winning level is org/folder/project (above user), the setting is disabled in the UI.
   */
  public getSettingManagementInfo(settingKey: string): SettingManagementInfo {
    for (const entry of this.settingsHierarchy) {
      if (
        entry.level === SettingsLevel.Dynamic ||
        entry.level === SettingsLevel.BuiltIn
      ) {
        continue;
      }

      const general = entry.settings.general;
      if (!general) continue;
      const value = (general as Record<string, unknown>)[settingKey];
      if (value === undefined) continue;

      switch (entry.level) {
        case SettingsLevel.Org:
          return { disabled: true, reason: 'org' };
        case SettingsLevel.Runtime:
          return { disabled: true, reason: 'runtime' };
        case SettingsLevel.Folder:
          return {
            disabled: true,
            reason: 'folder',
            folderPath: entry.folderPath,
          };
        case SettingsLevel.Project:
          return { disabled: true, reason: 'project' };
        default:
          return { disabled: false, reason: null };
      }
    }
    return { disabled: false, reason: null };
  }

  private getSessionDefaultSettingWinningEntry(
    settingKey: keyof SessionDefaultSettings
  ): SettingsHierarchyLevel | null {
    const getPrecedence = (level: SettingsLevel): number => {
      switch (level) {
        case SettingsLevel.Runtime:
          return 0;
        case SettingsLevel.Folder:
          return 1;
        case SettingsLevel.Project:
          return 2;
        case SettingsLevel.User:
          return 3;
        case SettingsLevel.Org:
          return 4;
        case SettingsLevel.Dynamic:
          return 5;
        case SettingsLevel.BuiltIn:
          return 6;
        default:
          return Number.MAX_SAFE_INTEGER;
      }
    };

    let winningEntry: SettingsHierarchyLevel | null = null;
    let winningPrecedence = Number.MAX_SAFE_INTEGER;

    for (const entry of this.settingsHierarchy) {
      const sessionDefaults = entry.settings.general?.sessionDefaultSettings;
      if (!sessionDefaults) continue;

      const value = (sessionDefaults as Record<string, unknown>)[settingKey];
      if (value === undefined) continue;

      const precedence = getPrecedence(entry.level);
      if (precedence < winningPrecedence) {
        winningEntry = entry;
        winningPrecedence = precedence;
      }
    }

    return winningEntry;
  }

  /**
   * Determine which hierarchy level provides the effective value for a session default setting key.
   * Similar to getSettingManagementInfo but looks inside general.sessionDefaultSettings.
   */
  public getSessionDefaultSettingManagementInfo(
    settingKey: keyof SessionDefaultSettings
  ): SettingManagementInfo {
    const winningEntry = this.getSessionDefaultSettingWinningEntry(settingKey);
    if (!winningEntry) {
      return { disabled: false, reason: null };
    }

    switch (winningEntry.level) {
      case SettingsLevel.Org:
        return { disabled: false, reason: 'org' };
      case SettingsLevel.Runtime:
        return { disabled: true, reason: 'runtime' };
      case SettingsLevel.Folder:
        return {
          disabled: true,
          reason: 'folder',
          folderPath: winningEntry.folderPath,
        };
      case SettingsLevel.Project:
        return { disabled: true, reason: 'project' };
      default:
        return { disabled: false, reason: null };
    }
  }

  /**
   * Determine which hierarchy level provides the effective value for a subagent Task setting key.
   * Similar to getSessionDefaultSettingManagementInfo but looks inside general.subagentModelSettings.
   */
  public getSubagentModelSettingManagementInfo(
    settingKey: SubagentSettingKey
  ): SettingManagementInfo {
    for (const entry of this.settingsHierarchy) {
      if (
        entry.level === SettingsLevel.Dynamic ||
        entry.level === SettingsLevel.BuiltIn
      ) {
        continue;
      }

      const subagentModelSettings =
        entry.settings.general?.subagentModelSettings;
      if (!subagentModelSettings) continue;
      const value = (subagentModelSettings as Record<string, unknown>)[
        settingKey
      ];
      if (value === undefined) continue;

      switch (entry.level) {
        case SettingsLevel.Org:
          return { disabled: true, reason: 'org' };
        case SettingsLevel.Runtime:
          return { disabled: true, reason: 'runtime' };
        case SettingsLevel.Folder:
          return {
            disabled: true,
            reason: 'folder',
            folderPath: entry.folderPath,
          };
        case SettingsLevel.Project:
          return { disabled: true, reason: 'project' };
        default:
          return { disabled: false, reason: null };
      }
    }

    return { disabled: false, reason: null };
  }

  // ---------------------------------------------------------------------------
  // Mission Onboarding
  // ---------------------------------------------------------------------------
  public getHasSeenMissionOnboarding(): boolean {
    return this.settings.general?.hasSeenMissionOnboarding ?? false;
  }

  public setHasSeenMissionOnboarding(seen: boolean): void {
    this.updateSettings({ general: { hasSeenMissionOnboarding: seen } });
  }

  public getReauthBannerShownTui(): boolean {
    return this.settings.general?.reauthBannerShownTui ?? false;
  }

  public setReauthBannerShownTui(shown: boolean): void {
    this.updateSettings({ general: { reauthBannerShownTui: shown } });
  }

  // ---------------------------------------------------------------------------
  // Compaction Token Limit
  // ---------------------------------------------------------------------------
  public getDefaultCompactionTokenLimit(): number {
    return this.settings.general?.compactionTokenLimit ?? 250_000;
  }

  public setDefaultCompactionTokenLimit(limit: number): void {
    this.updateSettings({ general: { compactionTokenLimit: limit } });
  }

  public getCompactionTokenLimitForModel(modelId: string): number {
    const resolved = resolveModelId(modelId);
    let modelMax = Infinity;
    let modelDefault: number | undefined;

    // Routers fall through to the global default; pass session.getModel() for the routed concrete.
    if (resolved && !isRouterModel(resolved)) {
      try {
        const effort = this.getReasoningEffort() ?? ReasoningEffort.Off;
        const model = getLLMModel({
          modelId: resolved,
          reasoningEffort: effort,
        });
        modelMax = model.maxInputTokens;
        modelDefault = model.defaultCompactionLimit;
      } catch {
        // Unknown model, fall through to global default
      }
    }

    // Per-model override wins over everything (capped at the provider's
    // absolute max input tokens). Match the stored key robustly:
    //   1. direct match against the requested modelId
    //   2. direct match against the resolved canonical ModelID
    //   3. scan all stored keys and match any whose resolved ModelID equals ours
    // Step (3) handles cases where the override was written under a model
    // alias (e.g. "gemini-3-pro-preview" ↔ "gemini-3.1-pro-preview") or where
    // the caller passes a non-canonical id.
    const perModel = this.settings.general?.compactionTokenLimitPerModel;
    let perModelOverride: number | undefined;
    if (perModel) {
      if (perModel[modelId] !== undefined) {
        perModelOverride = perModel[modelId];
      } else if (resolved !== undefined && perModel[resolved] !== undefined) {
        perModelOverride = perModel[resolved];
      } else if (resolved !== undefined) {
        for (const [key, value] of Object.entries(perModel)) {
          if (resolveModelId(key) === resolved) {
            perModelOverride = value;
            break;
          }
        }
      }
    }
    if (perModelOverride !== undefined) {
      return Math.min(perModelOverride, modelMax);
    }

    // User's explicit global default takes precedence over the model's
    // baked-in defaultCompactionLimit. Only fall back to the model default
    // (or the hardcoded fallback) when the user hasn't configured one.
    const userExplicit = this.settings.general?.compactionTokenLimit;
    const effectiveDefault = userExplicit ?? modelDefault ?? 250_000;
    return Math.min(effectiveDefault, modelMax);
  }

  public getCompactionTokenLimitPerModel(): Record<string, number> | undefined {
    return this.settings.general?.compactionTokenLimitPerModel;
  }

  public setCompactionTokenLimitForModel(modelId: string, limit: number): void {
    // Normalize the key to the canonical ModelID so reads via aliases find
    // the override. If the caller passed an id we can't resolve (e.g. a
    // custom model id) just store it verbatim.
    const key = resolveModelId(modelId) ?? modelId;
    const existing = this.getCompactionTokenLimitPerModel() ?? {};

    // If an entry already exists under a non-canonical alias for the same
    // model, drop it so we don't end up with duplicates.
    const cleaned: Record<string, number> = {};
    for (const [k, v] of Object.entries(existing)) {
      if (resolveModelId(k) === key && k !== key) continue;
      cleaned[k] = v;
    }

    this.updateSettings({
      general: {
        compactionTokenLimitPerModel: { ...cleaned, [key]: limit },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Compaction Model
  // ---------------------------------------------------------------------------
  public resolveCompactionModelForUse(model: string): {
    model: string;
    valid: boolean;
    reason?: string;
  } {
    if (model === CURRENT_COMPACTION_MODEL) {
      return { model, valid: true };
    }

    const resolvedModel = this.resolveCanonicalCustomModelId(model);

    if (isRouterModel(resolvedModel)) {
      return {
        model: CURRENT_COMPACTION_MODEL,
        valid: false,
        reason: 'Auto Model must be selected via current-model',
      };
    }

    if (resolvedModel.startsWith('custom:')) {
      const customModel = findCustomModel(resolvedModel, this.customModels);
      if (!customModel) {
        return {
          model: CURRENT_COMPACTION_MODEL,
          valid: false,
          reason: 'Custom compaction model is not configured',
        };
      }
    } else if (getTuiModelConfig(resolvedModel).isUnknownFallback) {
      return {
        model: CURRENT_COMPACTION_MODEL,
        valid: false,
        reason: 'Compaction model is not in the model registry',
      };
    }

    const validation = this.validateModelAccess(resolvedModel);
    if (!validation.allowed) {
      return {
        model: CURRENT_COMPACTION_MODEL,
        valid: false,
        reason: validation.reason ?? 'Model not allowed by organization policy',
      };
    }

    return { model: resolvedModel, valid: true };
  }

  public getCompactionModel(): string {
    const storedModel =
      this.settings.general?.compactionModel ?? CURRENT_COMPACTION_MODEL;
    const resolved = this.resolveCompactionModelForUse(storedModel);
    if (resolved.valid) {
      if (resolved.model !== storedModel) {
        this.updateSettings({ general: { compactionModel: resolved.model } });
      }
      return resolved.model;
    }

    logWarn(
      '[Settings] Invalid compaction model, falling back to current-model',
      {
        previousModelId: storedModel,
        modelId: CURRENT_COMPACTION_MODEL,
        reason: resolved.reason,
      }
    );
    this.updateSettings({
      general: { compactionModel: CURRENT_COMPACTION_MODEL },
    });
    return CURRENT_COMPACTION_MODEL;
  }

  public setCompactionModel(model: string): void {
    const resolved = this.resolveCompactionModelForUse(model);
    if (!resolved.valid) {
      throw new MetaError(
        resolved.reason ?? 'Model not allowed by organization policy',
        {
          modelId: model,
        }
      );
    }

    this.updateSettings({ general: { compactionModel: resolved.model } });
  }

  // ---------------------------------------------------------------------------
  // Model Fallbacks
  // ---------------------------------------------------------------------------

  /**
   * Map of a drool's configured model ID to the fallback model ID. Used when
   * an org blocks (or serves via a different ID) the model a drool is tied to.
   */
  public getModelFallbacks(): Record<string, string> {
    return this.settings.general?.modelFallbacks ?? {};
  }

  /**
   * Resolve the effective model for a drool. A configured fallback is returned
   * when `model` is not currently allowed (e.g. blocked by org policy or
   * otherwise unavailable); an allowed model — and `inherit`/undefined — is
   * returned unchanged. When no fallback is configured the original model is
   * returned so the caller can decide how to handle it.
   * `isAllowed` is injected so this stays decoupled from the model-availability
   * layer (which itself reads settings).
   */
  public resolveModelWithFallback(
    model: DroolModel | undefined,
    isAllowed: (modelId: DroolModel) => boolean
  ): DroolModel | undefined {
    if (!model || model === 'inherit') return model;
    if (isAllowed(model)) return model;
    const fallback = this.getModelFallbacks()[model] as DroolModel | undefined;
    return fallback ?? model;
  }

  /**
   * Persist a fallback model for invalid models (ex unknown or blocked by org settings)
   */
  public async setModelFallback(
    fromModelId: string,
    toModelId: string,
    scope: SettingsLevel = SettingsLevel.User
  ): Promise<void> {
    const manager = SettingsManager.getInstance();
    const levelSettings = await manager.getLevelSettings(scope);
    const existing = levelSettings.general?.modelFallbacks ?? {};
    const next = { ...existing, [fromModelId]: toModelId };
    await manager.updateLevelSettings(scope, {
      general: { modelFallbacks: next },
    });
    // Reflect the new entry in the in-memory merged view so immediate
    // reads via getModelFallbacks() / resolveModelWithFallback() are consistent.
    if (this.settings.general) {
      this.settings.general = {
        ...this.settings.general,
        modelFallbacks: {
          ...this.settings.general.modelFallbacks,
          [fromModelId]: toModelId,
        },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Language Preference (i18n)
  // ---------------------------------------------------------------------------

  /**
   * Get the persisted language preference.
   * Returns undefined if no preference has been set (use env var detection).
   */
  public getLlmRequestTimeout(): number {
    return this.settings.general?.llmRequestTimeout ?? 10 * 60 * 1000;
  }

  public getSubagentInactivityTimeout(): number {
    return this.settings.general?.subagentInactivityTimeout ?? 15 * 60 * 1000;
  }

  public getLanguagePreference(): string | undefined {
    return (this.settings.general as Record<string, unknown> | undefined)
      ?.locale as string | undefined;
  }

  /**
   * Set the language preference. Persisted to settings so it survives restarts.
   * Pass undefined to clear the preference and revert to env var detection.
   */
  public setLanguagePreference(locale: string | undefined): void {
    this.updateSettings({
      general: { locale } as Record<string, unknown>,
    } as Partial<Settings>);
  }
}

export const settingsService = new SettingsService();

export function getSettingsService(): SettingsService {
  return settingsService;
}
