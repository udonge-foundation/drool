import { spawn } from 'child_process';

import { Box, Text } from 'ink';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DiffMode,
  LogoAnimationMode,
  ToolResultDisplay,
} from '@industry/common/cli';
import { type UserModelSelection } from '@industry/common/llm';
import { convertLocallyPersistedMessageContentToDroolMessageContent } from '@industry/common/session';
import {
  CURRENT_COMPACTION_MODEL,
  type Settings,
} from '@industry/common/settings';
import {
  DiffMode as DiffModeEnum,
  SoundFocusMode,
  SubagentAutonomyLevel,
  SubagentSoundMode,
} from '@industry/common/settings/enums';
import { ComplexityTier } from '@industry/drool-core/tools/enums';
import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';
import {
  AutonomyLevel,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logException } from '@industry/logging';
import { getAllowedAutonomyLevels } from '@industry/utils';
import {
  isRouterModel,
  parseUserModelSelection,
  predictSelectionSwitchEffects,
} from '@industry/utils/llm';

import {
  ActiveOrganizationSelector,
  fetchActiveOrganizationOptions,
} from '@/components/ActiveOrganizationSelector';
import { AwaitingInputSoundSelector } from '@/components/AwaitingInputSoundSelector';
import { COLORS } from '@/components/chat/themedColors';
import { FilterableMenuContainer } from '@/components/common/FilterableMenuContainer';
import { getWindowedListSlice } from '@/components/common/getWindowedListSlice';
import { CompactionLimitSelector } from '@/components/CompactionLimitSelector';
import { GlobalSpecModeModelConfigurator } from '@/components/GlobalSpecModeModelConfigurator';
import { ModelSelector } from '@/components/ModelSelector';
import { ReasoningEffortSelector } from '@/components/ReasoningEffortSelector';
import { SoundFocusModeSelector } from '@/components/SoundFocusModeSelector';
import { SoundSelector } from '@/components/SoundSelector';
import { SpecSaveDirSelector } from '@/components/SpecSaveDirSelector';
import { SubagentSoundSelector } from '@/components/SubagentSoundSelector';
import { ThemeSelector } from '@/components/ThemeSelector';
import { KeypressLayer } from '@/contexts/enums';
import { serializeAndPersistForProviderSwitch } from '@/hooks/compaction/providerSwitchUtils';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import { getDefaultModelId } from '@/models/availability';
import {
  getModelDefaultReasoningEffort,
  getTuiModelConfig,
  getReasoningEffortDisplayName,
} from '@/models/config';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import type { SettingManagementInfo } from '@/services/types';
import { applyThemeSelection } from '@/theme/applyThemeChange';
import { getThemeEngine } from '@/theme/ThemeEngine';
import {
  displayWidth as getDisplayWidth,
  padEndByDisplayWidth,
} from '@/utils/displayWidth';
import { findProjectIndustryWithinGit } from '@/utils/industryPaths';
import { clampReasoningEffortForModel } from '@/utils/modelUtils';
import { cleanPastedText } from '@/utils/pasteHandler';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';
import {
  getSoundDisplayName,
  getSoundFocusModeDisplayName,
} from '@/utils/soundPlayer';
import type { SoundOption } from '@/utils/types';

interface SettingsListProps {
  settings: Settings;
  onClose: () => void;
  onThemeChanged?: () => void;
}

// path resolution moved to utils/industryPaths

function getSubagentSoundDisplayName(mode: SubagentSoundMode): string {
  switch (mode) {
    case SubagentSoundMode.Off:
      return 'Off';
    case SubagentSoundMode.Quiet:
      return 'Quiet (bell only)';
    case SubagentSoundMode.Inherit:
      return 'Inherit from parent';
    default:
      return 'Off';
  }
}

type SettingsTab =
  | 'session'
  | 'missions'
  | 'preferences'
  | 'sounds'
  | 'subagents';
type MissionDefaultsTarget = 'orchestrator' | 'worker' | 'validator';

const SUBAGENT_INHERIT_OPTION_ID = '__subagent_inherit__';

export function SettingsList({
  settings,
  onClose,
  onThemeChanged,
}: SettingsListProps) {
  const { t } = useTranslation();
  const { width: terminalWidth } = useTerminalDimensions();
  const [selectedTab, setSelectedTab] = useState<SettingsTab>('session');
  const [searchQuery, setSearchQuery] = useState('');
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [showReasoningEffortSelector, setShowReasoningEffortSelector] =
    useState(false);
  const [pendingModelSelection, setPendingModelSelection] =
    useState<UserModelSelection | null>(null);
  const [showSpecModeConfigurator, setShowSpecModeConfigurator] =
    useState(false);
  const [showSpecDirSelector, setShowSpecDirSelector] = useState(false);
  const [showSoundSelector, setShowSoundSelector] = useState(false);
  const [showSoundFocusModeSelector, setShowSoundFocusModeSelector] =
    useState(false);
  const [showAwaitingInputSoundSelector, setShowAwaitingInputSoundSelector] =
    useState(false);
  const [showSubagentSoundSelector, setShowSubagentSoundSelector] =
    useState(false);
  const [showThemeSelector, setShowThemeSelector] = useState(false);
  const [showActiveOrganizationSelector, setShowActiveOrganizationSelector] =
    useState(false);
  const [activeOrganizationDisplay, setActiveOrganizationDisplay] = useState(
    () => t('common:settings.configure')
  );
  const [showActiveOrganizationSetting, setShowActiveOrganizationSetting] =
    useState(false);
  const [showCompactionLimitSelector, setShowCompactionLimitSelector] =
    useState(false);
  const [showCompactionModelSelector, setShowCompactionModelSelector] =
    useState(false);
  const [
    showCompactionPerModelModelSelector,
    setShowCompactionPerModelModelSelector,
  ] = useState(false);
  const [compactionPerModelTarget, setCompactionPerModelTarget] = useState<
    string | null
  >(null);
  const [subagentComplexityToConfigure, setSubagentComplexityToConfigure] =
    useState<ComplexityTier | null>(null);
  const [pendingSubagentModelSelection, setPendingSubagentModelSelection] =
    useState<{ complexity: ComplexityTier; model: string } | null>(null);
  const [
    missionDefaultsTargetToConfigure,
    setMissionDefaultsTargetToConfigure,
  ] = useState<MissionDefaultsTarget | null>(null);
  const [
    pendingMissionDefaultModelSelection,
    setPendingMissionDefaultModelSelection,
  ] = useState<{ target: MissionDefaultsTarget; model: string } | null>(null);

  const [currentSettings, setCurrentSettings] = useState(settings);

  const { industryDir: projectIndustryDir, gitRootDir } = useMemo(
    () => findProjectIndustryWithinGit(process.cwd()),
    []
  );
  const projectIndustryDetected = Boolean(projectIndustryDir);

  useMountEffect(() => {
    let cancelled = false;

    void fetchActiveOrganizationOptions()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setShowActiveOrganizationSetting(result.options.length > 1);
        setActiveOrganizationDisplay(
          result.activeOrganizationName
            ? sanitizeTerminalDisplayText(result.activeOrganizationName, {
                stripSgr: true,
              })
            : t('common:settings.configure')
        );
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setShowActiveOrganizationSetting(false);
        setActiveOrganizationDisplay(t('common:settings.unavailable'));
      });

    return () => {
      cancelled = true;
    };
  });

  type HeaderEntry = { type: 'header'; id: string; label: string };
  type ItemEntry = {
    type: 'item';
    id: string;
    label: string;
    value: string;
    action: () => void;
    disabled?: boolean;
    overrideInfo?: SettingManagementInfo;
    tab: SettingsTab;
  };
  type MenuEntry = HeaderEntry | ItemEntry;

  // Helper getters for accessing hierarchical settings
  const getSelectedModel = (): UserModelSelection =>
    parseUserModelSelection(
      currentSettings.general?.sessionDefaultSettings?.model
    ) ?? getDefaultModelId();
  const getReasoningEffort = () =>
    currentSettings.general?.sessionDefaultSettings?.reasoningEffort ??
    ReasoningEffort.High;
  const getDiffMode = () =>
    (currentSettings.general?.diffMode ?? 'github') as DiffMode;
  const getToolResultDisplay = () =>
    (currentSettings.general?.toolResultDisplay as ToolResultDisplay) ??
    ToolResultDisplay.Expanded;
  const getCloudSync = () => currentSettings.general?.cloudSessionSync ?? true;
  const getIdeAutoConnect = () =>
    currentSettings.general?.ideAutoConnect ?? false;
  const getCoAuthor = () =>
    currentSettings.general?.includeCoAuthoredByDrool ?? true;
  const getDroolShield = () =>
    currentSettings.general?.enableDroolShield ?? true;
  const getHooksDisabled = () => currentSettings.hooks?.hooksDisabled ?? false;
  const getShowHookOutput = () => currentSettings.hooks?.showHookOutput ?? true;
  const getShowThinking = () =>
    currentSettings.general?.showThinkingInMainView ?? false;
  const getTokenUsage = () =>
    currentSettings.general?.showTokenUsageIndicator ?? false;
  const getSpecEnabled = () => currentSettings.general?.specSaveEnabled ?? true;
  const getSpecDir = () => currentSettings.general?.specSaveDir;
  const getCompletionSound = () => currentSettings.general?.completionSound;
  const getAwaitingSound = () => currentSettings.general?.awaitingInputSound;
  const getSoundFocus = () => currentSettings.general?.soundFocusMode;
  const getLogoAnimation = () =>
    currentSettings.general?.logoAnimation ?? LogoAnimationMode.Always;
  const getTheme = () =>
    currentSettings.general?.theme ?? getThemeEngine().getActiveThemeName();
  const getInteractionMode = () =>
    currentSettings.general?.sessionDefaultSettings?.interactionMode ??
    DroolInteractionMode.Auto;
  const getAutonomyLevelSetting = () =>
    currentSettings.general?.sessionDefaultSettings?.autonomyLevel ??
    AutonomyLevel.Off;
  const getMaxAutonomyLevel = () =>
    currentSettings.general?.maxAutonomyLevel as AutonomyLevel | undefined;
  const getSpecModeModel = () =>
    currentSettings.general?.sessionDefaultSettings?.specModeModel;
  const getMissionOrchestratorModel = () =>
    currentSettings.general?.missionOrchestratorModel ??
    getSettingsService().getMissionOrchestratorModel();
  const getMissionOrchestratorReasoningEffort = () =>
    currentSettings.general?.missionOrchestratorReasoningEffort ??
    getSettingsService().getMissionOrchestratorReasoningEffort();
  const getMissionWorkerModel = () =>
    currentSettings.general?.missionModelSettings?.workerModel ??
    getSettingsService().getMissionWorkerModel();
  const getMissionWorkerReasoningEffort = () =>
    currentSettings.general?.missionModelSettings?.workerReasoningEffort ??
    getSettingsService().getMissionWorkerReasoningEffort();
  const getMissionValidationWorkerModel = () =>
    currentSettings.general?.missionModelSettings?.validationWorkerModel ??
    getSettingsService().getMissionValidationWorkerModel();
  const getMissionValidationWorkerReasoningEffort = () =>
    currentSettings.general?.missionModelSettings
      ?.validationWorkerReasoningEffort ??
    getSettingsService().getMissionValidationWorkerReasoningEffort();
  const getMissionSkipScrutiny = () =>
    currentSettings.general?.missionModelSettings?.skipScrutiny ??
    getSettingsService().getMissionSkipScrutiny();
  const getMissionSkipUserTesting = () =>
    currentSettings.general?.missionModelSettings?.skipUserTesting ??
    getSettingsService().getMissionSkipUserTesting();
  const getSubagentModel = (complexity: ComplexityTier) =>
    getSettingsService().getSubagentModelForComplexity(complexity);
  const getSubagentReasoningEffort = (complexity: ComplexityTier) =>
    getSettingsService().getSubagentReasoningEffortForComplexity(complexity);
  const getCompactionModel = () => getSettingsService().getCompactionModel();
  const getCompactionModelDisplayName = () => {
    const compactionModel = getCompactionModel();
    if (compactionModel === CURRENT_COMPACTION_MODEL) {
      return t('common:settings.compactionModelCurrent');
    }
    return getTuiModelConfig(compactionModel).displayName;
  };

  const getSubagentModelDisplayName = (complexity: ComplexityTier) => {
    const { displayName } = getTuiModelConfig(getSubagentModel(complexity));
    return displayName;
  };

  const getSubagentReasoningEffortDisplayName = (complexity: ComplexityTier) =>
    getReasoningEffortDisplayName(getSubagentReasoningEffort(complexity));

  const isSubagentModelInherited = (complexity: ComplexityTier) =>
    !getSettingsService().hasExplicitSubagentModelForComplexity(complexity);

  const getSubagentTaskValue = (complexity: ComplexityTier) =>
    isSubagentModelInherited(complexity)
      ? t('common:settings.subagentTaskInherit')
      : `${getSubagentModelDisplayName(complexity)} / ${getSubagentReasoningEffortDisplayName(complexity)}`;

  const getSubagentModelManagementInfo = (complexity: ComplexityTier) =>
    getSettingsService().getSubagentModelSettingManagementInfo(
      `${complexity}Model` as const
    );

  const getSubagentReasoningManagementInfo = (complexity: ComplexityTier) =>
    getSettingsService().getSubagentModelSettingManagementInfo(
      `${complexity}ReasoningEffort` as const
    );

  const getInitialSubagentReasoningEffort = (
    complexity: ComplexityTier,
    model: string
  ) => {
    if (
      getSettingsService().hasSubagentReasoningEffortOverrideForComplexity(
        complexity
      )
    ) {
      return clampReasoningEffortForModel(
        model,
        getSubagentReasoningEffort(complexity)
      );
    }

    return getModelDefaultReasoningEffort(model);
  };

  const applySubagentSettings = (
    complexity: ComplexityTier,
    model: string,
    effort?: ReasoningEffort
  ) => {
    const settingsService = getSettingsService();
    settingsService.setSubagentModelForComplexity(complexity, model);

    if (!getSubagentReasoningManagementInfo(complexity).disabled) {
      settingsService.setSubagentReasoningEffortForComplexity(
        complexity,
        effort ?? getInitialSubagentReasoningEffort(complexity, model)
      );
    }

    setCurrentSettings(settingsService.getSettings());
    setSubagentComplexityToConfigure(null);
    setPendingSubagentModelSelection(null);
  };

  const getMissionDefaultReasoningEffort = (
    target: MissionDefaultsTarget,
    model: string
  ) => {
    if (target === 'orchestrator') {
      return getModelDefaultReasoningEffort(model);
    }

    const currentEffort =
      target === 'worker'
        ? getMissionWorkerReasoningEffort()
        : getMissionValidationWorkerReasoningEffort();
    return clampReasoningEffortForModel(model, currentEffort);
  };

  const applyMissionDefaultSettings = (
    target: MissionDefaultsTarget,
    model: string,
    effort?: ReasoningEffort
  ) => {
    const settingsService = getSettingsService();

    if (target === 'orchestrator') {
      const resolvedEffort =
        effort ?? getMissionDefaultReasoningEffort(target, model);
      settingsService.setMissionOrchestratorModel(model);
      settingsService.setMissionOrchestratorReasoningEffort(resolvedEffort);
      setCurrentSettings(settingsService.getSettings());
      setMissionDefaultsTargetToConfigure(null);
      setPendingMissionDefaultModelSelection(null);
      return;
    }

    const resolvedEffort =
      effort ?? getMissionDefaultReasoningEffort(target, model);

    if (target === 'worker') {
      settingsService.setMissionWorkerModel(model);
      settingsService.setMissionWorkerReasoningEffort(resolvedEffort);
    } else {
      settingsService.setMissionValidationWorkerModel(model);
      settingsService.setMissionValidationWorkerReasoningEffort(resolvedEffort);
    }

    setCurrentSettings(settingsService.getSettings());
    setMissionDefaultsTargetToConfigure(null);
    setPendingMissionDefaultModelSelection(null);
  };

  // Helper to update nested general settings
  const updateGeneral = (
    updates: Partial<NonNullable<Settings['general']>>
  ) => {
    setCurrentSettings({
      ...currentSettings,
      general: { ...currentSettings.general, ...updates },
    });
  };

  // Helper to update nested session default settings
  const updateSession = (
    updates: Partial<
      NonNullable<NonNullable<Settings['general']>['sessionDefaultSettings']>
    >
  ) => {
    setCurrentSettings({
      ...currentSettings,
      general: {
        ...currentSettings.general,
        sessionDefaultSettings: {
          ...currentSettings.general?.sessionDefaultSettings,
          ...updates,
        },
      },
    });
  };

  const isSubagentsEnabled = getExecRuntimeConfig().isSubAgentsV2Enabled();

  const settingsTabs = useMemo(() => {
    const tabs: { id: SettingsTab; label: string }[] = [
      { id: 'session', label: t('common:settings.headerSessionDefaults') },
      { id: 'missions', label: t('common:settings.headerMissionDefaults') },
      { id: 'preferences', label: t('common:settings.headerPreferences') },
      { id: 'sounds', label: t('common:settings.headerSounds') },
    ];
    if (isSubagentsEnabled) {
      tabs.push({
        id: 'subagents',
        label: t('common:settings.tabSubagents'),
      });
    }
    return tabs;
  }, [t, isSubagentsEnabled]);

  const allMenuItems = useMemo<ItemEntry[]>(
    () => [
      // Session Defaults tab
      {
        id: 'model-setting',
        label: t('common:settings.defaultModel'),
        value: (() => {
          const { displayName: modelName } =
            getTuiModelConfig(getSelectedModel());
          return modelName;
        })(),
        action: () => setShowModelSelector(true),
        ...(() => {
          const info =
            getSettingsService().getSessionDefaultSettingManagementInfo(
              'model'
            );
          return { disabled: info.disabled, overrideInfo: info };
        })(),
        type: 'item',
        tab: 'session' as SettingsTab,
      },
      {
        id: 'reasoning-setting',
        label: t('common:settings.defaultReasoningLevel'),
        value: (() => {
          const effortDisplay =
            getReasoningEffortDisplayName(getReasoningEffort());
          return effortDisplay;
        })(),
        action: () => setShowReasoningEffortSelector(true),
        ...(() => {
          const info =
            getSettingsService().getSessionDefaultSettingManagementInfo(
              'reasoningEffort'
            );
          const onlyOneEffort =
            getTuiModelConfig(getSelectedModel()).supportedReasoningEfforts
              .length <= 1;
          return {
            disabled: info.disabled || onlyOneEffort,
            overrideInfo: info,
          };
        })(),
        type: 'item',
        tab: 'session' as SettingsTab,
      },
      {
        id: 'interaction-mode-setting',
        label: t('common:settings.defaultInteractionMode'),
        value:
          getInteractionMode() === DroolInteractionMode.Spec
            ? t('common:modes.spec')
            : t('common:modes.auto'),
        action: () => {
          const newMode =
            getInteractionMode() === DroolInteractionMode.Auto
              ? DroolInteractionMode.Spec
              : DroolInteractionMode.Auto;
          const autonomyLevel = getAutonomyLevelSetting();
          void getTuiDaemonAdapter()
            .updateDefaultSettings({
              interactionMode: newMode,
              autonomyLevel,
            })
            .then(() => {
              updateSession({ interactionMode: newMode, autonomyLevel });
            })
            .catch((error) => {
              logException(
                error,
                '[SettingsList] Failed to update default interaction mode'
              );
            });
        },
        ...(() => {
          const info =
            getSettingsService().getSessionDefaultSettingManagementInfo(
              'interactionMode'
            );
          return { disabled: info.disabled, overrideInfo: info };
        })(),
        type: 'item',
        tab: 'session' as SettingsTab,
      },
      {
        id: 'autonomy-level-setting',
        label: t('common:settings.defaultAutonomyLevel'),
        value: (() => {
          const level = getAutonomyLevelSetting();
          return level.charAt(0).toUpperCase() + level.slice(1);
        })(),
        action: () => {
          const currentLevel = getAutonomyLevelSetting();
          const allowedLevels = getAllowedAutonomyLevels(getMaxAutonomyLevel());
          const currentIndex = allowedLevels.indexOf(currentLevel);
          const nextLevel =
            currentIndex === -1 || allowedLevels.length === 0
              ? AutonomyLevel.Off
              : allowedLevels[(currentIndex + 1) % allowedLevels.length];
          const interactionMode = getInteractionMode();
          void getTuiDaemonAdapter()
            .updateDefaultSettings({
              interactionMode,
              autonomyLevel: nextLevel,
            })
            .then(() => {
              updateSession({ interactionMode, autonomyLevel: nextLevel });
            })
            .catch((error) => {
              logException(
                error,
                '[SettingsList] Failed to update default autonomy level'
              );
            });
        },
        ...(() => {
          const info =
            getSettingsService().getSessionDefaultSettingManagementInfo(
              'autonomyLevel'
            );
          return { disabled: info.disabled, overrideInfo: info };
        })(),
        type: 'item',
        tab: 'session' as SettingsTab,
      },
      {
        id: 'spec-mode-model-setting',
        label: t('common:settings.defaultSpecModeModel'),
        value: (() => {
          const specModel = getSpecModeModel();
          if (!specModel) return t('common:settings.sameAsMain');
          const { displayName } = getTuiModelConfig(specModel);
          return displayName;
        })(),
        action: () => setShowSpecModeConfigurator(true),
        ...(() => {
          const info =
            getSettingsService().getSessionDefaultSettingManagementInfo(
              'specModeModel'
            );
          return { disabled: info.disabled, overrideInfo: info };
        })(),
        type: 'item',
        tab: 'session' as SettingsTab,
      },
      {
        id: 'mission-orchestrator-model-setting',
        label: t('common:missionModelPicker.orchestratorModel'),
        value: (() => {
          const { displayName } = getTuiModelConfig(
            getMissionOrchestratorModel()
          );
          return `${displayName} / ${getReasoningEffortDisplayName(getMissionOrchestratorReasoningEffort())}`;
        })(),
        action: () => setMissionDefaultsTargetToConfigure('orchestrator'),
        type: 'item',
        tab: 'missions' as SettingsTab,
      },
      {
        id: 'mission-worker-model-setting',
        label: t('common:missionModels.workerModel'),
        value: (() => {
          const { displayName } = getTuiModelConfig(getMissionWorkerModel());
          return `${displayName} / ${getReasoningEffortDisplayName(getMissionWorkerReasoningEffort())}`;
        })(),
        action: () => setMissionDefaultsTargetToConfigure('worker'),
        type: 'item',
        tab: 'missions' as SettingsTab,
      },
      {
        id: 'mission-validator-model-setting',
        label: t('common:missionModels.validatorModel'),
        value: (() => {
          const { displayName } = getTuiModelConfig(
            getMissionValidationWorkerModel()
          );
          return `${displayName} / ${getReasoningEffortDisplayName(getMissionValidationWorkerReasoningEffort())}`;
        })(),
        action: () => setMissionDefaultsTargetToConfigure('validator'),
        type: 'item',
        tab: 'missions' as SettingsTab,
      },
      {
        id: 'mission-skip-scrutiny-setting',
        label: t('common:missionModels.skipScrutiny'),
        value: getMissionSkipScrutiny()
          ? t('common:settings.on')
          : t('common:settings.off'),
        action: () => {
          const nextValue = !getMissionSkipScrutiny();
          getSettingsService().setMissionSkipScrutiny(nextValue);
          setCurrentSettings(getSettingsService().getSettings());
        },
        type: 'item',
        tab: 'missions' as SettingsTab,
      },
      {
        id: 'mission-skip-user-testing-setting',
        label: t('common:missionModels.skipUserTesting'),
        value: getMissionSkipUserTesting()
          ? t('common:settings.on')
          : t('common:settings.off'),
        action: () => {
          const nextValue = !getMissionSkipUserTesting();
          getSettingsService().setMissionSkipUserTesting(nextValue);
          setCurrentSettings(getSettingsService().getSettings());
        },
        type: 'item',
        tab: 'missions' as SettingsTab,
      },
      {
        id: 'compaction-limit-setting',
        label: t('common:settings.compactionTokenLimit'),
        value: (() => {
          const limit = getSettingsService().getDefaultCompactionTokenLimit();
          if (limit >= 1_000_000) return `${limit / 1_000_000}M`;
          return `${limit / 1_000}K`;
        })(),
        action: () => setShowCompactionLimitSelector(true),
        type: 'item',
        tab: 'session' as SettingsTab,
      },
      {
        id: 'compaction-per-model-header',
        label: t('common:settings.compactionPerModelHeader'),
        value: '',
        action: () => {},
        disabled: true,
        type: 'item',
        tab: 'session' as SettingsTab,
      },
      ...(() => {
        const perModel =
          getSettingsService().getCompactionTokenLimitPerModel() ?? {};
        return Object.entries(perModel)
          .filter(([modelId]) => !isRouterModel(modelId))
          .map(([modelId, limit]) => {
            const { displayName } = getTuiModelConfig(modelId);
            const formatted =
              limit >= 1_000_000
                ? `${limit / 1_000_000}M`
                : `${limit / 1_000}K`;
            return {
              id: `compaction-per-model-${modelId}`,
              label: `  ${displayName}`,
              value: formatted,
              action: () => setCompactionPerModelTarget(modelId),
              type: 'item' as const,
              tab: 'session' as SettingsTab,
            };
          });
      })(),
      {
        id: 'compaction-per-model-add',
        label: t('common:settings.compactionPerModelAdd'),
        value: '+',
        action: () => setShowCompactionPerModelModelSelector(true),
        type: 'item',
        tab: 'session' as SettingsTab,
      },
      {
        id: 'compaction-model-setting',
        label: t('common:settings.compactionModel'),
        value: getCompactionModelDisplayName(),
        action: () => setShowCompactionModelSelector(true),
        type: 'item',
        tab: 'session' as SettingsTab,
      },

      // Preferences tab
      {
        id: 'diff-mode-setting',
        label: t('common:settings.diffDisplayMode'),
        value:
          getDiffMode() === DiffModeEnum.Github
            ? t('common:settings.diffGithub')
            : t('common:settings.diffUnified'),
        action: () => {
          const newMode: DiffMode =
            getDiffMode() === DiffModeEnum.Github
              ? DiffModeEnum.Unified
              : DiffModeEnum.Github;
          getSettingsService().setDiffMode(newMode);
          updateGeneral({ diffMode: newMode });
        },
        disabled: false,
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'theme-setting',
        label: t('common:settings.theme'),
        value: getTheme(),
        action: () => setShowThemeSelector(true),
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      ...(showActiveOrganizationSetting
        ? [
            {
              id: 'active-organization-setting',
              label: t('common:settings.activeOrganization'),
              value: activeOrganizationDisplay,
              action: () => setShowActiveOrganizationSelector(true),
              type: 'item' as const,
              tab: 'preferences' as SettingsTab,
            },
          ]
        : []),
      {
        id: 'tool-result-display-setting',
        label: t('common:settings.toolResultDisplay'),
        value:
          getToolResultDisplay() === ToolResultDisplay.Expanded
            ? t('common:settings.toolResultExpanded')
            : t('common:settings.toolResultCompact'),
        action: () => {
          const newMode =
            getToolResultDisplay() === ToolResultDisplay.Expanded
              ? ToolResultDisplay.Compact
              : ToolResultDisplay.Expanded;
          getSettingsService().setToolResultDisplay(newMode);
          updateGeneral({ toolResultDisplay: newMode });
        },
        disabled: false,
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'cloud-session-sync-setting',
        label: t('common:settings.cloudSessionSync'),
        value: getCloudSync()
          ? t('common:settings.on')
          : t('common:settings.off'),
        action: () => {
          const newValue = !getCloudSync();
          getSettingsService().setCloudSessionSync(newValue);
          updateGeneral({ cloudSessionSync: newValue });
        },
        ...(() => {
          const info =
            getSettingsService().getSettingManagementInfo('cloudSessionSync');
          return { disabled: info.disabled, overrideInfo: info };
        })(),
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'logo-animation-setting',
        label: t('common:settings.logoAnimation'),
        value: (() => {
          const mode = getLogoAnimation();
          if (mode === LogoAnimationMode.Once)
            return t('common:settings.logoOnce');
          if (mode === LogoAnimationMode.Always)
            return t('common:settings.logoAlways');
          return t('common:settings.off');
        })(),
        action: () => {
          const current = getLogoAnimation();
          let nextMode: LogoAnimationMode;
          if (current === LogoAnimationMode.Off) {
            nextMode = LogoAnimationMode.Once;
          } else if (current === LogoAnimationMode.Once) {
            nextMode = LogoAnimationMode.Always;
          } else {
            nextMode = LogoAnimationMode.Off;
          }
          getSettingsService().setLogoAnimation(nextMode);
          updateGeneral({ logoAnimation: nextMode });
        },
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'ide-auto-connect-setting',
        label: t('common:settings.ideAutoConnect'),
        value: getIdeAutoConnect()
          ? t('common:settings.on')
          : t('common:settings.off'),
        action: () => {
          const nextValue = !getIdeAutoConnect();
          getSettingsService().setIdeAutoConnect(nextValue);
          updateGeneral({ ideAutoConnect: nextValue });
        },
        ...(() => {
          const info =
            getSettingsService().getSettingManagementInfo('ideAutoConnect');
          return { disabled: info.disabled, overrideInfo: info };
        })(),
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'include-coauthored-by-drool-setting',
        label: t('common:settings.includeCoAuthor'),
        value: getCoAuthor()
          ? t('common:settings.on')
          : t('common:settings.off'),
        action: () => {
          const nextValue = !getCoAuthor();
          getSettingsService().setIncludeCoAuthoredByDrool(nextValue);
          updateGeneral({ includeCoAuthoredByDrool: nextValue });
        },
        ...(() => {
          const info = getSettingsService().getSettingManagementInfo(
            'includeCoAuthoredByDrool'
          );
          return { disabled: info.disabled, overrideInfo: info };
        })(),
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'enable-drool-shield-setting',
        label: t('common:settings.droolShield'),
        value: getDroolShield()
          ? t('common:settings.on')
          : t('common:settings.off'),
        action: () => {
          const nextValue = !getDroolShield();
          getSettingsService().setEnableDroolShield(nextValue);
          updateGeneral({ enableDroolShield: nextValue });
        },
        ...(() => {
          const info =
            getSettingsService().getSettingManagementInfo('enableDroolShield');
          return { disabled: info.disabled, overrideInfo: info };
        })(),
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'hooks-enabled-setting',
        label: t('common:settings.hooks'),
        value: getHooksDisabled()
          ? t('common:settings.hooksDisabled')
          : t('common:settings.hooksEnabled'),
        action: () => {
          const nextValue = !getHooksDisabled();
          getSettingsService().setHooksDisabled(nextValue);
          setCurrentSettings({
            ...currentSettings,
            hooks: { ...currentSettings.hooks, hooksDisabled: nextValue },
          });
        },
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'show-hook-output-setting',
        label: t('common:settings.showHookOutput'),
        value: getShowHookOutput()
          ? t('common:settings.on')
          : t('common:settings.off'),
        action: () => {
          const nextValue = !getShowHookOutput();
          getSettingsService().setShowHookOutput(nextValue);
          setCurrentSettings({
            ...currentSettings,
            hooks: { ...currentSettings.hooks, showHookOutput: nextValue },
          });
        },
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'show-thinking-setting',
        label: t('common:settings.showThinking'),
        value: getShowThinking()
          ? t('common:settings.on')
          : t('common:settings.off'),
        action: () => {
          const nextValue = !getShowThinking();
          getSettingsService().setShowThinkingInMainView(nextValue);
          updateGeneral({ showThinkingInMainView: nextValue });
        },
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'show-token-usage-indicator-setting',
        label: t('common:settings.showContextWindow'),
        value: getTokenUsage()
          ? t('common:settings.on')
          : t('common:settings.off'),
        action: () => {
          const nextValue = !getTokenUsage();
          getSettingsService().setShowTokenUsageIndicator(nextValue);
          updateGeneral({ showTokenUsageIndicator: nextValue });
        },
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'hide-changelog-setting',
        label: t('common:settings.hideChangelog'),
        value: getSettingsService().getHideChangelog()
          ? t('common:settings.on')
          : t('common:settings.off'),
        action: () => {
          const nextValue = !getSettingsService().getHideChangelog();
          getSettingsService().setHideChangelog(nextValue);
          updateGeneral({ hideChangelog: nextValue });
        },
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'nerd-font-setting',
        label: t('common:settings.nerdFont'),
        value: getSettingsService().getNerdFont()
          ? t('common:settings.on')
          : t('common:settings.off'),
        action: () => {
          const nextValue = !getSettingsService().getNerdFont();
          getSettingsService().setNerdFont(nextValue);
          updateGeneral({ nerdFont: nextValue });
        },
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'spec-save-enabled-setting',
        label: t('common:settings.saveSpecMarkdown'),
        value: getSpecEnabled()
          ? t('common:settings.on')
          : t('common:settings.off'),
        action: () => {
          const newValue = !getSpecEnabled();
          getSettingsService().setSpecSaveEnabled(newValue);
          updateGeneral({ specSaveEnabled: newValue });
        },
        disabled: false,
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      {
        id: 'open-settings-file',
        label: t('common:settings.editAllowDenyList'),
        value: t('common:settings.openInEditor'),
        action: () => {
          const settingsPath = getSettingsService().getSettingsFilePath();
          const platform = process.platform;
          let command: string;
          let args: string[];

          if (platform === 'darwin') {
            command = 'open';
            args = [settingsPath];
          } else if (platform === 'win32') {
            command = 'cmd';
            args = ['/c', 'start', '""', settingsPath];
          } else {
            command = 'xdg-open';
            args = [settingsPath];
          }

          try {
            spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
          } catch (error) {
            logException(error, 'Failed to open settings file');
          }
        },
        disabled: false,
        type: 'item',
        tab: 'preferences' as SettingsTab,
      },
      ...(getSpecEnabled()
        ? [
            {
              id: 'spec-save-dir-setting',
              label: t('common:settings.specSaveDirectory'),
              value: getSpecDir() || '.industry/docs',
              action: () => {
                setShowSpecDirSelector(true);
              },
              disabled: false,
              type: 'item' as const,
              tab: 'preferences' as SettingsTab,
            },
          ]
        : []),

      // Sounds tab
      {
        id: 'completion-sound-setting',
        label: t('common:settings.completionSound'),
        value: getSoundDisplayName(
          getCompletionSound() ?? getSettingsService().getCompletionSound()
        ),
        action: () => {
          setShowSoundSelector(true);
        },
        type: 'item',
        tab: 'sounds' as SettingsTab,
      },
      {
        id: 'awaiting-input-sound-setting',
        label: t('common:settings.awaitingInputSound'),
        value: getSoundDisplayName(
          getAwaitingSound() ?? getSettingsService().getAwaitingInputSound()
        ),
        action: () => {
          setShowAwaitingInputSoundSelector(true);
        },
        type: 'item',
        tab: 'sounds' as SettingsTab,
      },
      {
        id: 'sound-focus-mode-setting',
        label: t('common:settings.playSounds'),
        value: getSoundFocusModeDisplayName(
          (getSoundFocus() ??
            getSettingsService().getSoundFocusMode()) as SoundFocusMode
        ),
        action: () => {
          setShowSoundFocusModeSelector(true);
        },
        type: 'item',
        tab: 'sounds' as SettingsTab,
      },
      ...(isSubagentsEnabled
        ? [
            {
              id: 'subagent-sound-setting',
              label: 'Subagent sounds',
              value: getSubagentSoundDisplayName(
                getSettingsService().getSubagentSoundMode()
              ),
              action: () => {
                setShowSubagentSoundSelector(true);
              },
              type: 'item' as const,
              tab: 'sounds' as SettingsTab,
            },
          ]
        : []),

      // Subagents tab
      ...(isSubagentsEnabled
        ? [
            {
              id: 'subagent-autonomy-setting',
              label: t('common:settings.subagentAutonomyLevel'),
              value: (() => {
                const level = getSettingsService().getSubagentAutonomyLevel();
                return level.charAt(0).toUpperCase() + level.slice(1);
              })(),
              action: () => {
                const cycle: SubagentAutonomyLevel[] = [
                  SubagentAutonomyLevel.Inherit,
                  ...getAllowedAutonomyLevels(getMaxAutonomyLevel()).map(
                    (level) => level as unknown as SubagentAutonomyLevel
                  ),
                ];
                const current = getSettingsService().getSubagentAutonomyLevel();
                const currentIndex = cycle.indexOf(current);
                const nextLevel =
                  cycle[(currentIndex + 1) % cycle.length] ??
                  SubagentAutonomyLevel.Inherit;
                getSettingsService().setSubagentAutonomyLevel(nextLevel);
                setCurrentSettings(getSettingsService().getSettings());
              },
              ...(() => {
                const info =
                  getSettingsService().getSubagentAutonomyLevelManagementInfo();
                return { disabled: info.disabled, overrideInfo: info };
              })(),
              type: 'item' as const,
              tab: 'subagents' as SettingsTab,
            },
            {
              id: 'light-task-setting',
              label: t('common:settings.lightTaskModel'),
              value: getSubagentTaskValue(ComplexityTier.Light),
              action: () =>
                setSubagentComplexityToConfigure(ComplexityTier.Light),
              ...(() => {
                const info = getSubagentModelManagementInfo(
                  ComplexityTier.Light
                );
                return { disabled: info.disabled, overrideInfo: info };
              })(),
              type: 'item' as const,
              tab: 'subagents' as SettingsTab,
            },
            {
              id: 'medium-task-setting',
              label: t('common:settings.mediumTaskModel'),
              value: getSubagentTaskValue(ComplexityTier.Medium),
              action: () =>
                setSubagentComplexityToConfigure(ComplexityTier.Medium),
              ...(() => {
                const info = getSubagentModelManagementInfo(
                  ComplexityTier.Medium
                );
                return { disabled: info.disabled, overrideInfo: info };
              })(),
              type: 'item' as const,
              tab: 'subagents' as SettingsTab,
            },
            {
              id: 'heavy-task-setting',
              label: t('common:settings.heavyTaskModel'),
              value: getSubagentTaskValue(ComplexityTier.Heavy),
              action: () =>
                setSubagentComplexityToConfigure(ComplexityTier.Heavy),
              ...(() => {
                const info = getSubagentModelManagementInfo(
                  ComplexityTier.Heavy
                );
                return { disabled: info.disabled, overrideInfo: info };
              })(),
              type: 'item' as const,
              tab: 'subagents' as SettingsTab,
            },
          ]
        : []),
    ],
    [
      activeOrganizationDisplay,
      currentSettings,
      isSubagentsEnabled,
      showActiveOrganizationSetting,
      t,
    ]
  );

  const menuItems: MenuEntry[] = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      return allMenuItems.filter(
        (item) =>
          item.label.toLowerCase().includes(query) ||
          item.value.toLowerCase().includes(query)
      );
    }
    return allMenuItems.filter((item) => item.tab === selectedTab);
  }, [allMenuItems, selectedTab, searchQuery]);

  const isMainMenuActive =
    !showModelSelector &&
    !showReasoningEffortSelector &&
    !showSpecModeConfigurator &&
    !missionDefaultsTargetToConfigure &&
    !pendingMissionDefaultModelSelection &&
    !subagentComplexityToConfigure &&
    !pendingSubagentModelSelection &&
    !showSpecDirSelector &&
    !showSoundSelector &&
    !showSoundFocusModeSelector &&
    !showAwaitingInputSoundSelector &&
    !showSubagentSoundSelector &&
    !showThemeSelector &&
    !showActiveOrganizationSelector &&
    !showCompactionLimitSelector &&
    !showCompactionPerModelModelSelector &&
    !showCompactionModelSelector &&
    !compactionPerModelTarget;

  // Main menu navigation
  const { selectedIndex } = useMenuNavigation({
    items: menuItems,
    initialIndex: 0,
    isSelectable: (item) => item.type === 'item' && !item.disabled,
    onSelect: (item) => {
      if (item.type === 'item' && !item.disabled) {
        item.action();
      }
    },
    onCancel: onClose,
    isActive: isMainMenuActive,
    enableCharKeys: false,
  });

  useKeypressHandler(
    (_input, key) => {
      if (key.tab && !searchQuery.trim()) {
        const tabIds = settingsTabs.map((tab) => tab.id);
        const currentIndex = tabIds.indexOf(selectedTab);
        const nextIndex =
          currentIndex < tabIds.length - 1 ? currentIndex + 1 : 0;
        setSelectedTab(tabIds[nextIndex]);
        return true;
      }
      return false;
    },
    { isActive: isMainMenuActive, layer: KeypressLayer.Navigation }
  );

  const maxLabelWidth = useMemo(() => {
    let max = 0;
    for (const item of menuItems) {
      if (item.type === 'item' && getDisplayWidth(item.label) > max)
        max = getDisplayWidth(item.label);
    }
    return max;
  }, [menuItems]);

  const finalizeModelSwitch = async (
    model: UserModelSelection,
    effort?: ReasoningEffort
  ) => {
    const currentModel = getSelectedModel();
    const { requiresCompaction: needsProviderSwitch, losingImageSupport } =
      predictSelectionSwitchEffects(currentModel, model);

    const sessionService = getSessionService();
    const nextProvider = getTuiModelConfig(model).modelProvider;

    // If provider is changing or we are losing image support, serialize the conversation
    // so the new model has compatibility-safe context.
    if (needsProviderSwitch || losingImageSupport) {
      let sessionId = sessionService.getCurrentSessionId();
      if (!sessionId) {
        sessionId = await sessionService.createNewSession();
      }

      const events = await sessionService.getAllMessageEvents();

      // If there's conversation history, serialize it for the new provider
      if (events.length > 0) {
        const conversationHistory: IndustryDroolMessage[] = events.map(
          (messageEvent) => {
            const timestampAsNumber = new Date(
              messageEvent.timestamp
            ).getTime();
            return {
              id: messageEvent.id,
              parentId: messageEvent.parentId,
              createdAt: timestampAsNumber,
              updatedAt: timestampAsNumber,
              ...messageEvent.message,
              content:
                convertLocallyPersistedMessageContentToDroolMessageContent(
                  messageEvent.message.content
                ),
            };
          }
        );

        // Serialize conversation instantly (no LLM call needed)
        try {
          await serializeAndPersistForProviderSwitch(sessionService, {
            sessionId,
            messages: conversationHistory,
          });
        } catch (error) {
          logException(
            error,
            '[SettingsList] Failed to serialize conversation for provider switch'
          );
          // Continue with model switch -- prepareMessagesWithCaching will
          // filter incompatible thinking blocks as a safety net
        }
      }

      // Update provider lock only if provider is changing
      if (needsProviderSwitch) {
        sessionService.updateLockedModelProvider(nextProvider);
      }
    }

    await getTuiDaemonAdapter().updateDefaultSettings({
      modelId: model,
      reasoningEffort: effort,
    });
    updateSession({ model, reasoningEffort: effort });
    setPendingModelSelection(null);
    setShowModelSelector(false);
    setShowReasoningEffortSelector(false);
  };

  const handleModelSelect = async (model: UserModelSelection) => {
    const { supportedReasoningEfforts } = getTuiModelConfig(model);
    if (supportedReasoningEfforts.length > 1) {
      setPendingModelSelection(model);
      setShowModelSelector(false);
      setShowReasoningEffortSelector(true);
    } else {
      // Single or no reasoning effort — finalize immediately
      setShowModelSelector(false);
      await finalizeModelSwitch(model);
    }
  };

  const handleReasoningEffortSelect = async (effort: ReasoningEffort) => {
    if (pendingModelSelection) {
      await finalizeModelSwitch(pendingModelSelection, effort);
    } else {
      await getTuiDaemonAdapter().updateDefaultSettings({
        modelId: getSelectedModel(),
        reasoningEffort: effort,
      });
      updateSession({ reasoningEffort: effort });
      setShowReasoningEffortSelector(false);
    }
  };

  const handleReasoningEffortCancel = () => {
    // Close without changing settings
    setShowModelSelector(true);
    setPendingModelSelection(null);
    setShowReasoningEffortSelector(false);
  };

  if (missionDefaultsTargetToConfigure) {
    const currentMissionModel =
      missionDefaultsTargetToConfigure === 'orchestrator'
        ? getMissionOrchestratorModel()
        : missionDefaultsTargetToConfigure === 'worker'
          ? getMissionWorkerModel()
          : getMissionValidationWorkerModel();
    const currentMissionReasoningEffort =
      missionDefaultsTargetToConfigure === 'orchestrator'
        ? getMissionOrchestratorReasoningEffort()
        : missionDefaultsTargetToConfigure === 'worker'
          ? getMissionWorkerReasoningEffort()
          : getMissionValidationWorkerReasoningEffort();

    const missionDefaultsTitle =
      missionDefaultsTargetToConfigure === 'orchestrator'
        ? t('common:missionModelPicker.orchestratorModel')
        : missionDefaultsTargetToConfigure === 'worker'
          ? t('common:missionModels.workerModel')
          : t('common:missionModels.validatorModel');

    return (
      <ModelSelector
        currentModel={currentMissionModel}
        currentReasoningEffort={currentMissionReasoningEffort}
        title={missionDefaultsTitle}
        hideTabs
        onSelect={(model: string) => {
          const supportedEfforts =
            getTuiModelConfig(model).supportedReasoningEfforts;

          if (supportedEfforts.length > 1) {
            setPendingMissionDefaultModelSelection({
              target: missionDefaultsTargetToConfigure,
              model,
            });
            setMissionDefaultsTargetToConfigure(null);
            return;
          }

          applyMissionDefaultSettings(
            missionDefaultsTargetToConfigure,
            model,
            supportedEfforts[0] ?? ReasoningEffort.None
          );
        }}
        onCancel={() => setMissionDefaultsTargetToConfigure(null)}
      />
    );
  }

  if (pendingMissionDefaultModelSelection) {
    const pendingMissionDefaultsTitle =
      pendingMissionDefaultModelSelection.target === 'orchestrator'
        ? t('common:missionModelPicker.orchestratorModel')
        : pendingMissionDefaultModelSelection.target === 'worker'
          ? t('common:missionModels.workerModel')
          : t('common:missionModels.validatorModel');

    return (
      <ReasoningEffortSelector
        title={pendingMissionDefaultsTitle}
        currentEffort={getMissionDefaultReasoningEffort(
          pendingMissionDefaultModelSelection.target,
          pendingMissionDefaultModelSelection.model
        )}
        supportedEfforts={
          getTuiModelConfig(pendingMissionDefaultModelSelection.model)
            .supportedReasoningEfforts || []
        }
        onSelect={(effort: ReasoningEffort) => {
          applyMissionDefaultSettings(
            pendingMissionDefaultModelSelection.target,
            pendingMissionDefaultModelSelection.model,
            effort
          );
        }}
        onCancel={() => {
          setMissionDefaultsTargetToConfigure(
            pendingMissionDefaultModelSelection.target
          );
          setPendingMissionDefaultModelSelection(null);
        }}
      />
    );
  }

  if (showModelSelector) {
    return (
      <ModelSelector
        currentModel={getSelectedModel()}
        currentReasoningEffort={getReasoningEffort()}
        onSelect={handleModelSelect}
        onCancel={() => setShowModelSelector(false)}
      />
    );
  }
  if (showReasoningEffortSelector) {
    // Use the selected model's supported reasoning efforts when switching models
    const modelForEfforts = pendingModelSelection ?? getSelectedModel();
    const currentModelReasoningEfforts =
      getTuiModelConfig(modelForEfforts).supportedReasoningEfforts || [];

    return (
      <ReasoningEffortSelector
        currentEffort={getReasoningEffort()}
        supportedEfforts={currentModelReasoningEfforts}
        onSelect={handleReasoningEffortSelect}
        onCancel={handleReasoningEffortCancel}
      />
    );
  }

  if (showSpecModeConfigurator) {
    return (
      <GlobalSpecModeModelConfigurator
        onClose={() => setShowSpecModeConfigurator(false)}
        onSettingsChanged={setCurrentSettings}
      />
    );
  }

  if (subagentComplexityToConfigure) {
    const titleKey =
      subagentComplexityToConfigure === 'light'
        ? 'common:settings.lightTaskModel'
        : subagentComplexityToConfigure === 'medium'
          ? 'common:settings.mediumTaskModel'
          : 'common:settings.heavyTaskModel';

    return (
      <ModelSelector
        currentModel={
          isSubagentModelInherited(subagentComplexityToConfigure)
            ? SUBAGENT_INHERIT_OPTION_ID
            : getSubagentModel(subagentComplexityToConfigure)
        }
        currentReasoningEffort={getInitialSubagentReasoningEffort(
          subagentComplexityToConfigure,
          getSubagentModel(subagentComplexityToConfigure)
        )}
        title={t(titleKey)}
        additionalOptions={[
          {
            id: SUBAGENT_INHERIT_OPTION_ID,
            label: t('common:settings.subagentTaskInheritOption'),
          },
        ]}
        onOptionSelect={(optionId: string) => {
          if (optionId !== SUBAGENT_INHERIT_OPTION_ID) return;
          getSettingsService().clearSubagentModelForComplexity(
            subagentComplexityToConfigure
          );
          setCurrentSettings(getSettingsService().getSettings());
          setSubagentComplexityToConfigure(null);
        }}
        onSelect={(model: string) => {
          const reasoningInfo = getSubagentReasoningManagementInfo(
            subagentComplexityToConfigure
          );
          const supportedEfforts =
            getTuiModelConfig(model).supportedReasoningEfforts;

          if (supportedEfforts.length > 1 && !reasoningInfo.disabled) {
            setPendingSubagentModelSelection({
              complexity: subagentComplexityToConfigure,
              model,
            });
            setSubagentComplexityToConfigure(null);
            return;
          }

          applySubagentSettings(subagentComplexityToConfigure, model);
        }}
        onCancel={() => setSubagentComplexityToConfigure(null)}
      />
    );
  }

  if (pendingSubagentModelSelection) {
    const titleKey =
      pendingSubagentModelSelection.complexity === 'light'
        ? 'common:settings.lightTaskReasoningLevel'
        : pendingSubagentModelSelection.complexity === 'medium'
          ? 'common:settings.mediumTaskReasoningLevel'
          : 'common:settings.heavyTaskReasoningLevel';

    return (
      <ReasoningEffortSelector
        title={t(titleKey)}
        currentEffort={getInitialSubagentReasoningEffort(
          pendingSubagentModelSelection.complexity,
          pendingSubagentModelSelection.model
        )}
        supportedEfforts={
          getTuiModelConfig(pendingSubagentModelSelection.model)
            .supportedReasoningEfforts || []
        }
        onSelect={(effort: ReasoningEffort) => {
          applySubagentSettings(
            pendingSubagentModelSelection.complexity,
            pendingSubagentModelSelection.model,
            effort
          );
        }}
        onCancel={() => {
          setSubagentComplexityToConfigure(
            pendingSubagentModelSelection.complexity
          );
          setPendingSubagentModelSelection(null);
        }}
      />
    );
  }

  if (showSpecDirSelector) {
    return (
      <SpecSaveDirSelector
        projectIndustryDetected={projectIndustryDetected}
        gitRootDir={gitRootDir}
        initialValue={getSpecDir() || '.industry/docs'}
        onCancel={() => setShowSpecDirSelector(false)}
        onSave={(value) => {
          getSettingsService().setSpecSaveDir(value);
          updateGeneral({ specSaveDir: value });
          setShowSpecDirSelector(false);
        }}
      />
    );
  }

  if (showSoundSelector) {
    return (
      <SoundSelector
        currentSound={
          getCompletionSound() ?? getSettingsService().getCompletionSound()
        }
        onSelect={(sound: SoundOption) => {
          getSettingsService().setCompletionSound(sound);
          updateGeneral({ completionSound: sound });
          setShowSoundSelector(false);
        }}
        onCancel={() => setShowSoundSelector(false)}
      />
    );
  }

  if (showSoundFocusModeSelector) {
    return (
      <SoundFocusModeSelector
        currentMode={
          (getSoundFocus() ??
            getSettingsService().getSoundFocusMode()) as SoundFocusMode
        }
        onSelect={(mode: SoundFocusMode) => {
          getSettingsService().setSoundFocusMode(mode);
          updateGeneral({ soundFocusMode: mode });
          setShowSoundFocusModeSelector(false);
        }}
        onCancel={() => setShowSoundFocusModeSelector(false)}
      />
    );
  }

  if (showAwaitingInputSoundSelector) {
    return (
      <AwaitingInputSoundSelector
        currentSound={
          getAwaitingSound() ?? getSettingsService().getAwaitingInputSound()
        }
        onSelect={(sound: SoundOption) => {
          getSettingsService().setAwaitingInputSound(sound);
          updateGeneral({ awaitingInputSound: sound });
          setShowAwaitingInputSoundSelector(false);
        }}
        onCancel={() => setShowAwaitingInputSoundSelector(false)}
      />
    );
  }

  if (showCompactionLimitSelector) {
    return (
      <CompactionLimitSelector
        currentLimit={getSettingsService().getDefaultCompactionTokenLimit()}
        onSelect={(limit: number) => {
          getSettingsService().setDefaultCompactionTokenLimit(limit);
          updateGeneral({ compactionTokenLimit: limit });
          setShowCompactionLimitSelector(false);
        }}
        onCancel={() => setShowCompactionLimitSelector(false)}
      />
    );
  }

  if (showCompactionPerModelModelSelector) {
    return (
      <ModelSelector
        currentModel={getSelectedModel()}
        title={t('common:settings.compactionPerModelAdd')}
        onSelect={(model: string) => {
          if (isRouterModel(model)) {
            setShowCompactionPerModelModelSelector(false);
            return;
          }
          setCompactionPerModelTarget(model);
          setShowCompactionPerModelModelSelector(false);
        }}
        onCancel={() => setShowCompactionPerModelModelSelector(false)}
      />
    );
  }

  if (showCompactionModelSelector) {
    return (
      <ModelSelector
        currentModel={getCompactionModel()}
        title={t('common:settings.compactionModel')}
        additionalOptions={[
          {
            id: CURRENT_COMPACTION_MODEL,
            label: t('common:settings.compactionModelCurrent'),
          },
        ]}
        onOptionSelect={(model: string) => {
          getSettingsService().setCompactionModel(model);
          updateGeneral({ compactionModel: model });
          setShowCompactionModelSelector(false);
        }}
        onSelect={(model: string) => {
          getSettingsService().setCompactionModel(model);
          updateGeneral({ compactionModel: model });
          setShowCompactionModelSelector(false);
        }}
        onCancel={() => setShowCompactionModelSelector(false)}
      />
    );
  }

  if (compactionPerModelTarget) {
    const currentLimitForModel =
      getSettingsService().getCompactionTokenLimitForModel(
        compactionPerModelTarget
      );
    const { displayName } = getTuiModelConfig(compactionPerModelTarget);
    const isEditingExisting =
      getSettingsService().getCompactionTokenLimitPerModel()?.[
        compactionPerModelTarget
      ] !== undefined;

    return (
      <CompactionLimitSelector
        currentLimit={currentLimitForModel}
        title={t('common:compactionLimitSelector.perModelTitle', {
          model: displayName,
        })}
        onSelect={(limit: number) => {
          getSettingsService().setCompactionTokenLimitForModel(
            compactionPerModelTarget,
            limit
          );
          updateGeneral({
            compactionTokenLimitPerModel:
              getSettingsService().getCompactionTokenLimitPerModel(),
          });
          setCompactionPerModelTarget(null);
        }}
        onCancel={() => {
          setCompactionPerModelTarget(null);
          if (!isEditingExisting) {
            setShowCompactionPerModelModelSelector(true);
          }
        }}
      />
    );
  }

  if (showSubagentSoundSelector) {
    return (
      <SubagentSoundSelector
        currentMode={getSettingsService().getSubagentSoundMode()}
        onSelect={(mode: SubagentSoundMode) => {
          getSettingsService().setSubagentSoundMode(mode);
          updateGeneral({ subagentSounds: mode });
          setShowSubagentSoundSelector(false);
        }}
        onCancel={() => setShowSubagentSoundSelector(false)}
      />
    );
  }

  if (showThemeSelector) {
    return (
      <ThemeSelector
        onThemeSelect={(themeName) => {
          if (!applyThemeSelection(themeName)) return false;
          setCurrentSettings(getSettingsService().getSettings());
          setShowThemeSelector(false);
          return true;
        }}
        onThemeChanged={onThemeChanged}
        onCancel={() => {
          setCurrentSettings(getSettingsService().getSettings());
          setShowThemeSelector(false);
        }}
      />
    );
  }

  if (showActiveOrganizationSelector) {
    return (
      <ActiveOrganizationSelector
        onCancel={() => setShowActiveOrganizationSelector(false)}
        onSelectComplete={(option) => {
          setActiveOrganizationDisplay(
            sanitizeTerminalDisplayText(option.name, { stripSgr: true })
          );
          setShowActiveOrganizationSelector(false);
        }}
      />
    );
  }

  // Tabbed interface, model-selector style
  const VISIBLE_ROWS = 10;

  const selectableItems = menuItems.filter((item) => item.type === 'item');
  const selectableSelectedIdx = selectableItems.findIndex(
    (_, i) => menuItems.indexOf(selectableItems[i]) === selectedIndex
  );

  const { visibleItems: visibleSlice, padCount: padRows } =
    getWindowedListSlice({
      items: selectableItems,
      selectedIndex: selectableSelectedIdx < 0 ? 0 : selectableSelectedIdx,
      visibleCount: VISIBLE_ROWS,
      anchorRow: 3,
    });

  return (
    <FilterableMenuContainer
      title={t('common:settings.title')}
      width={terminalWidth}
      tabs={settingsTabs}
      activeTab={selectedTab}
      hideHeaderWhenSearching
      searchValue={searchQuery}
      onSearchChange={(value) => setSearchQuery(cleanPastedText(value))}
      searchPlaceholder="Filter settings..."
      helpText="↑↓ navigate · Enter select · Tab switch tab · Esc cancel"
    >
      {visibleSlice.map((item) => {
        const globalIndex = menuItems.indexOf(item);
        const isSelected = globalIndex === selectedIndex;
        const isDisabled = item.disabled;
        const isManagedByOrg = item.overrideInfo?.disabled ?? false;
        const overrideReason = item.overrideInfo?.reason;
        const showOrgBadge = overrideReason === 'org';
        const labelColor: string | undefined = isSelected
          ? COLORS.text.primary
          : COLORS.text.muted;
        const valueColor: string | undefined = isSelected
          ? COLORS.text.primary
          : isDisabled
            ? COLORS.text.muted
            : COLORS.text.secondary;

        const isCompactionHeader = item.id === 'compaction-per-model-header';
        return (
          <Box key={item.id} marginTop={isCompactionHeader ? 1 : 0}>
            <Box width={2}>
              <Text> </Text>
            </Box>
            <Text bold={isSelected} color={labelColor}>
              {padEndByDisplayWidth(item.label, maxLabelWidth)}
            </Text>
            <Text bold={isSelected} color={valueColor}>
              {'      '}
              {item.value}
            </Text>
            {showOrgBadge && (
              <Text color={COLORS.text.muted}>
                {' '}
                {t(
                  isManagedByOrg
                    ? 'common:settings.managedByOrg'
                    : 'common:settings.defaultFromOrg'
                )}
              </Text>
            )}
            {isDisabled && overrideReason === 'runtime' && (
              <Text color={COLORS.text.muted}>
                {' '}
                {t('common:settings.overriddenByRuntime')}
              </Text>
            )}
            {isDisabled && overrideReason === 'folder' && (
              <Text color={COLORS.text.muted}>
                {' '}
                {t('common:settings.overriddenByFolder')}
              </Text>
            )}
            {isDisabled && overrideReason === 'project' && (
              <Text color={COLORS.text.muted}>
                {' '}
                {t('common:settings.overriddenByProject')}
              </Text>
            )}
          </Box>
        );
      })}
      {padRows > 0 &&
        Array.from({ length: padRows }, (_, i) => (
          <Text key={`pad-${i}`}> </Text>
        ))}
    </FilterableMenuContainer>
  );
}

// end
