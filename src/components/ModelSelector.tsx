import { Fzf } from 'fzf';
import { Box, Text } from 'ink';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import {
  INDUSTRY_ROUTER_MODEL_ID,
  ModelProvider,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';
import { getProcessEnvironment } from '@industry/utils/environment';
import {
  getPromoLabel,
  getTokenMultiplier,
  MISSION_ORCHESTRATOR_MODEL_WARNING,
  MISSION_ORCHESTRATOR_RECOMMENDED_MODELS,
  parseUserModelSelection,
} from '@industry/utils/llm';

import { COLORS } from '@/components/chat/themedColors';
import { FilterableMenuContainer } from '@/components/common/FilterableMenuContainer';
import { getWindowedListSlice } from '@/components/common/getWindowedListSlice';
import { getMultiplierDisplay } from '@/components/getMultiplierDisplay';
import { KeypressLayer } from '@/contexts/enums';
import { useFeatureFlagValue } from '@/feature-flags/hooks';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import { matchKeyboardChord } from '@/keyboard/keyboardChords';
import { useAvailableModels } from '@/models/availability';
import {
  getTuiModelConfig,
  getReasoningEffortDisplayName,
} from '@/models/config';
import { hasAnyAllowedIndustryRouterCandidate } from '@/models/industryRouterAvailability';
import {
  CODING_SUBSCRIPTION_PROVIDER_LABELS,
  parseCodingSubscriptionApiKey,
} from '@/services/coding-subs/modelInstall';
import { getSettingsService } from '@/services/SettingsService';
import { padEndByDisplayWidth } from '@/utils/displayWidth';
import { validateModelAccess } from '@/utils/modelValidation';
import { cleanPastedText } from '@/utils/pasteHandler';

import type { UserModelSelection } from '@industry/common/llm';

const VISIBLE_ROW_COUNT = 15;
const PROVIDER_COLLAPSED_MODEL_COUNT = 4;

type ModelTab = 'main' | 'spec' | 'orchestrator' | 'worker' | 'validator';
type ModelProviderGroup =
  | 'router'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'industry'
  | 'xai'
  | 'codex-subscription'
  | 'claude-subscription'
  | 'antigravity-subscription'
  | 'kimi-subscription'
  | 'xai-subscription'
  | 'custom'
  | 'other';

function dedupeCustomModelsById<T extends { id: string }>(
  models: readonly T[]
): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    unique.push(model);
  }

  return unique;
}

const MODEL_PROVIDER_GROUP_ORDER: ModelProviderGroup[] = [
  'router',
  'anthropic',
  'openai',
  'industry',
  'google',
  'xai',
  'codex-subscription',
  'claude-subscription',
  'antigravity-subscription',
  'kimi-subscription',
  'xai-subscription',
  'custom',
  'other',
];

const MODEL_PROVIDER_GROUP_LABELS: Record<ModelProviderGroup, string> = {
  router: 'Optimized Routing',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  industry: 'Drool Core',
  xai: 'xAI',
  'codex-subscription': CODING_SUBSCRIPTION_PROVIDER_LABELS.codex,
  'claude-subscription': CODING_SUBSCRIPTION_PROVIDER_LABELS.claude,
  'antigravity-subscription': CODING_SUBSCRIPTION_PROVIDER_LABELS.antigravity,
  'kimi-subscription': CODING_SUBSCRIPTION_PROVIDER_LABELS.kimi,
  'xai-subscription': CODING_SUBSCRIPTION_PROVIDER_LABELS.xai,
  custom: 'Custom Models',
  other: 'Other',
};

function getModelProviderGroup(modelId: string): ModelProviderGroup {
  if (modelId === INDUSTRY_ROUTER_MODEL_ID) return 'router';
  const config = getTuiModelConfig(modelId);
  if (config.isCustom) {
    const customModel = getSettingsService()
      .getCustomModels()
      .find((model) => model.id === modelId);
    const subscriptionProvider = parseCodingSubscriptionApiKey(
      customModel?.apiKey
    );
    if (subscriptionProvider === 'codex') return 'codex-subscription';
    if (subscriptionProvider === 'claude') return 'claude-subscription';
    if (subscriptionProvider === 'antigravity') {
      return 'antigravity-subscription';
    }
    if (subscriptionProvider === 'kimi') return 'kimi-subscription';
    if (subscriptionProvider === 'xai') return 'xai-subscription';
    return 'custom';
  }

  switch (config.modelProvider) {
    case ModelProvider.ANTHROPIC:
      return 'anthropic';
    case ModelProvider.OPENAI:
      return 'openai';
    case ModelProvider.GOOGLE:
      return 'google';
    case ModelProvider.INDUSTRY:
      return 'industry';
    case ModelProvider.XAI:
      return 'xai';
    case ModelProvider.GENERIC_CHAT_COMPLETION_API:
      return 'custom';
    default:
      return 'other';
  }
}

interface ModelSelectorProps {
  currentModel: string;
  currentReasoningEffort?: ReasoningEffort;
  mainReasoningEffort?: ReasoningEffort | null;
  specModeModel?: string | null;
  specModeReasoningEffort?: ReasoningEffort | null;
  onSelect: (model: UserModelSelection) => void;
  onCancel: () => void;
  onOptionSelect?: (optionId: string) => void;
  onSpecModeConfig?: () => void;
  onSpecSelect?: (model: UserModelSelection) => void;
  onClearSpecModel?: () => void;
  hasSpecModel?: boolean;
  compatibleModelsOnly?: string[];
  isOrchestratorModelSelector?: boolean;
  initialTab?: ModelTab;
  title?: string;
  onSetAsDefault?: (modelId: string) => void | Promise<void>;
  onSetSpecAsDefault?: (modelId: string) => void | Promise<void>;
  defaultModelId?: string | null;
  defaultSpecModeModelId?: string | null;
  defaultDescription?: string;
  // Mission mode props
  missionMode?: boolean;
  missionWorkerModel?: string;
  missionWorkerReasoningEffort?: ReasoningEffort;
  missionValidatorModel?: string;
  missionValidatorReasoningEffort?: ReasoningEffort;
  defaultMissionOrchestratorModelId?: string | null;
  defaultMissionWorkerModelId?: string | null;
  defaultMissionValidatorModelId?: string | null;
  onMissionSelect?: (
    target: 'orchestrator' | 'worker' | 'validator',
    model: string
  ) => void;
  onSetMissionDefault?: (
    target: 'orchestrator' | 'worker' | 'validator',
    modelId: string
  ) => void | Promise<void>;
  /** Hide the Main/Spec tab toggle (e.g. when selecting a single mission role model) */
  hideTabs?: boolean;
  additionalOptions?: Array<{ id: string; label: string }>;
}

// ---------------------------------------------------------------------------
// REMOVED: Legacy ModelSelector — was gated behind cli_reskin_v1=false
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ModelSelector — tabs, search, custom keypress handling
// ---------------------------------------------------------------------------
function ModelSelectorContent({
  currentModel,
  currentReasoningEffort,
  mainReasoningEffort,
  specModeModel,
  specModeReasoningEffort,
  onSelect,
  onCancel,
  onOptionSelect,
  onSpecModeConfig,
  onSpecSelect,
  onClearSpecModel,
  hasSpecModel = false,
  compatibleModelsOnly,
  isOrchestratorModelSelector = false,
  initialTab,
  title,
  onSetAsDefault,
  onSetSpecAsDefault,
  defaultModelId,
  defaultSpecModeModelId,
  defaultDescription: _defaultDescription,
  missionMode = false,
  missionWorkerModel,
  missionWorkerReasoningEffort,
  missionValidatorModel,
  missionValidatorReasoningEffort,
  defaultMissionOrchestratorModelId,
  defaultMissionWorkerModelId,
  defaultMissionValidatorModelId,
  onMissionSelect,
  onSetMissionDefault,
  hideTabs = false,
  additionalOptions = [],
}: ModelSelectorProps) {
  const { t } = useTranslation();
  const { width: terminalWidth } = useTerminalDimensions();
  const isAutoFlagEnabled = useFeatureFlagValue(
    IndustryFeatureFlags.IndustryRouter
  );
  const hideOrgDisabledModels = useFeatureFlagValue(
    IndustryFeatureFlags.HideOrgDisabledModels
  );
  const [selectedTab, setSelectedTab] = useState<ModelTab>(
    initialTab ?? (missionMode ? 'orchestrator' : 'main')
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [focusedRegion, setFocusedRegion] = useState<'search' | 'list'>(
    'search'
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedProviderGroups, setExpandedProviderGroups] = useState<
    Set<ModelProviderGroup>
  >(() => new Set());
  const hasInitializedSelection = useRef(false);
  type PendingFavoriteFocus =
    | { type: 'model'; modelId: string }
    | { type: 'first-selectable' };
  const pendingFavoriteFocus = useRef<PendingFavoriteFocus | null>(null);
  const pendingProviderToggleFocusGroup = useRef<ModelProviderGroup | null>(
    null
  );

  const modelPolicy = getSettingsService().getModelPolicy();
  const allBuiltInModels = useAvailableModels();
  const settingsService = getSettingsService();
  const processEnvironment = getProcessEnvironment();
  const resolvedFavoriteModelIds = useMemo(
    () => settingsService.getModelFavorites(),
    [settingsService]
  );
  const dismissedNewModelIds = useMemo(
    () => new Set(settingsService.getDismissedNewModels()),
    [settingsService]
  );

  const builtinModels = compatibleModelsOnly
    ? allBuiltInModels.filter((m) => compatibleModelsOnly.includes(m))
    : allBuiltInModels;

  const allCustomModels = useMemo(() => {
    const models = settingsService.getCustomModels();
    return Array.isArray(models) ? dedupeCustomModelsById(models) : [];
  }, [settingsService]);

  const customModels = compatibleModelsOnly
    ? allCustomModels.filter((m) => compatibleModelsOnly.includes(m.id))
    : allCustomModels;

  const isMissionOrchestratorTab =
    missionMode && selectedTab === 'orchestrator';
  // Auto Model is allowed on the mission worker tab (varied feature-impl
  // tasks are exactly the routing target). Excluded from orchestrator
  // (top-level reasoning needs flagship) and validator (verification
  // determinism > routing variance) until we have more confidence.
  const isIndustryRouterExcludedMissionTab =
    missionMode &&
    (selectedTab === 'orchestrator' || selectedTab === 'validator');

  const orderedBuiltInModels = useMemo(() => {
    const availableBuiltIns = new Set<string>(builtinModels);
    if (isMissionOrchestratorTab) {
      const recommended = MISSION_ORCHESTRATOR_RECOMMENDED_MODELS.filter((id) =>
        availableBuiltIns.has(id)
      );
      const recommendedSet = new Set<string>(recommended);
      return [
        ...recommended,
        ...builtinModels.filter((id) => !recommendedSet.has(id)),
      ];
    }
    return builtinModels;
  }, [builtinModels, isMissionOrchestratorTab]);

  const availableFavoriteModelIds = useMemo(() => {
    const availableModelIds = new Set<string>([
      ...builtinModels,
      ...customModels.map((model) => model.id),
    ]);
    if (isIndustryRouterExcludedMissionTab) {
      availableModelIds.delete(INDUSTRY_ROUTER_MODEL_ID);
    }
    return resolvedFavoriteModelIds.filter((id) => availableModelIds.has(id));
  }, [
    builtinModels,
    customModels,
    resolvedFavoriteModelIds,
    isIndustryRouterExcludedMissionTab,
  ]);

  const visibleFavoriteModelIds = useMemo(() => {
    const availableFavorites = new Set(availableFavoriteModelIds);
    const favoritesByGroup = new Map<ModelProviderGroup, string[]>();
    const providerOrderedModelIds = [
      ...orderedBuiltInModels,
      ...customModels.map((model) => model.id),
    ];

    for (const modelId of providerOrderedModelIds) {
      if (!availableFavorites.has(modelId)) continue;
      const group = getModelProviderGroup(modelId);
      const rowsForGroup = favoritesByGroup.get(group) ?? [];
      rowsForGroup.push(modelId);
      favoritesByGroup.set(group, rowsForGroup);
    }

    return MODEL_PROVIDER_GROUP_ORDER.flatMap(
      (group) => favoritesByGroup.get(group) ?? []
    );
  }, [availableFavoriteModelIds, customModels, orderedBuiltInModels]);

  const favoriteModelIdSet = useMemo(
    () => new Set(visibleFavoriteModelIds),
    [visibleFavoriteModelIds]
  );

  const newModelIds = useMemo(() => {
    const availableModelIds = new Set<string>([
      ...builtinModels,
      ...customModels.map((model) => model.id),
    ]);
    if (isIndustryRouterExcludedMissionTab) {
      availableModelIds.delete(INDUSTRY_ROUTER_MODEL_ID);
    }
    return orderedBuiltInModels.filter((id) => {
      if (!availableModelIds.has(id)) return false;
      if (dismissedNewModelIds.has(id)) return false;
      if (favoriteModelIdSet.has(id)) return false;
      return getTuiModelConfig(id).isNew === true;
    });
  }, [
    builtinModels,
    customModels,
    dismissedNewModelIds,
    favoriteModelIdSet,
    isIndustryRouterExcludedMissionTab,
    orderedBuiltInModels,
  ]);

  const newModelIdSet = useMemo(() => new Set(newModelIds), [newModelIds]);

  const currentModelForTab = useMemo(() => {
    if (selectedTab === 'spec') {
      return hasSpecModel && specModeModel ? specModeModel : currentModel;
    }
    if (selectedTab === 'worker' && missionWorkerModel) {
      return missionWorkerModel;
    }
    if (selectedTab === 'validator' && missionValidatorModel) {
      return missionValidatorModel;
    }
    return currentModel;
  }, [
    selectedTab,
    hasSpecModel,
    specModeModel,
    currentModel,
    missionWorkerModel,
    missionValidatorModel,
  ]);

  type ModelRow = {
    type: 'model';
    id: string;
    disabled: boolean;
    section: 'new' | 'favorites' | 'provider';
  };

  type Row =
    | ModelRow
    | { type: 'option'; id: string; label: string }
    | { type: 'sep' }
    | { type: 'clear-spec-model' }
    | {
        type: 'provider-toggle';
        group: ModelProviderGroup;
        hiddenCount: number;
        expanded: boolean;
      }
    | { type: 'header'; label: string };
  type ModelSearchRow = Extract<Row, { type: 'model' | 'option' }>;

  const createModelRow = useCallback(
    (id: string, section: ModelRow['section']): ModelRow | null => {
      if (id === INDUSTRY_ROUTER_MODEL_ID) {
        if (!isAutoFlagEnabled || isIndustryRouterExcludedMissionTab) {
          return null;
        }
        const validation = validateModelAccess(
          id,
          modelPolicy,
          undefined,
          processEnvironment
        );
        return {
          type: 'model' as const,
          id,
          disabled:
            !validation.allowed || !hasAnyAllowedIndustryRouterCandidate(),
          section,
        };
      }
      const customModel = customModels.find((model) => model.id === id);
      const validation = validateModelAccess(
        id,
        modelPolicy,
        customModel,
        processEnvironment
      );
      return {
        type: 'model' as const,
        id,
        disabled: !validation.allowed,
        section,
      };
    },
    [
      isAutoFlagEnabled,
      isIndustryRouterExcludedMissionTab,
      customModels,
      modelPolicy,
      processEnvironment,
    ]
  );

  const shouldHideDisabledModelRow = useCallback(
    (row: ModelRow): boolean => hideOrgDisabledModels && row.disabled,
    [hideOrgDisabledModels]
  );

  const allRows: Row[] = useMemo(() => {
    const items: Row[] = [];
    const shouldShowClearSpecModel =
      selectedTab === 'spec' && hasSpecModel && onClearSpecModel;
    let clearSpecModelInserted = false;

    const pushClearSpecModel = (): void => {
      if (!shouldShowClearSpecModel || clearSpecModelInserted) return;
      items.push({ type: 'clear-spec-model' as const });
      clearSpecModelInserted = true;
    };

    items.push(
      ...additionalOptions.map((option) => ({
        ...option,
        type: 'option' as const,
      }))
    );
    if (additionalOptions.length > 0) {
      items.push({ type: 'sep' as const });
    }

    const pushModelRows = (modelRows: readonly (ModelRow | null)[]): void => {
      for (const row of modelRows) {
        if (!row) continue;
        if (shouldHideDisabledModelRow(row)) {
          continue;
        }
        if (row.id === currentModelForTab) {
          pushClearSpecModel();
        }
        items.push(row);
      }
    };

    const getVisibleProviderRows = (
      group: ModelProviderGroup,
      rowsForGroup: readonly ModelRow[]
    ): {
      rows: readonly ModelRow[];
      hiddenCount: number;
      expanded: boolean;
    } => {
      const expanded = expandedProviderGroups.has(group);
      if (expanded || rowsForGroup.length <= PROVIDER_COLLAPSED_MODEL_COUNT) {
        return { rows: rowsForGroup, hiddenCount: 0, expanded };
      }

      const visibleRows = rowsForGroup.slice(0, PROVIDER_COLLAPSED_MODEL_COUNT);
      const currentRowIndex = rowsForGroup.findIndex(
        (row) => row.id === currentModelForTab
      );

      if (currentRowIndex >= PROVIDER_COLLAPSED_MODEL_COUNT) {
        visibleRows[PROVIDER_COLLAPSED_MODEL_COUNT - 1] =
          rowsForGroup[currentRowIndex];
      }

      return {
        rows: visibleRows,
        hiddenCount: rowsForGroup.length - visibleRows.length,
        expanded,
      };
    };

    const newRows = newModelIds
      .map((id) => createModelRow(id, 'new'))
      .filter(
        (row): row is ModelRow =>
          row !== null && !shouldHideDisabledModelRow(row)
      );

    const favoriteRows = visibleFavoriteModelIds
      .filter((id) => !newModelIdSet.has(id))
      .map((id) => createModelRow(id, 'favorites'));

    pushClearSpecModel();

    if (newRows.length > 0) {
      if (items.length > 0) {
        items.push({ type: 'sep' as const });
      }
      items.push({
        type: 'header' as const,
        label: t('common:modelSelector.newModelsHeader'),
      });
      pushModelRows(newRows);
    }

    if (items.length > 0) {
      items.push({ type: 'sep' as const });
    }
    items.push({
      type: 'header' as const,
      label: t('common:modelSelector.favoritesHeader'),
    });
    pushModelRows(favoriteRows);

    const groupedModels = new Map<ModelProviderGroup, ModelRow[]>();
    const providerModelIds = [
      ...orderedBuiltInModels,
      ...customModels.map((model) => model.id),
    ].filter((id) => !favoriteModelIdSet.has(id) && !newModelIdSet.has(id));

    for (const modelId of providerModelIds) {
      const group = getModelProviderGroup(modelId);
      const row = createModelRow(modelId, 'provider');
      if (!row) continue;
      if (shouldHideDisabledModelRow(row)) {
        continue;
      }
      const rowsForGroup = groupedModels.get(group) ?? [];
      rowsForGroup.push(row);
      groupedModels.set(group, rowsForGroup);
    }

    for (const group of MODEL_PROVIDER_GROUP_ORDER) {
      const rowsForGroup = groupedModels.get(group);
      if (!rowsForGroup || rowsForGroup.length === 0) continue;
      if (items.length > 0) {
        items.push({ type: 'sep' as const });
      }
      items.push({
        type: 'header' as const,
        label:
          group === 'custom'
            ? t('common:modelSelector.customModelsHeader')
            : t('common:modelSelector.providerHeader', {
                provider: MODEL_PROVIDER_GROUP_LABELS[group],
              }),
      });
      const visibleProvider = getVisibleProviderRows(group, rowsForGroup);
      pushModelRows(visibleProvider.rows);
      if (rowsForGroup.length > PROVIDER_COLLAPSED_MODEL_COUNT) {
        items.push({
          type: 'provider-toggle' as const,
          group,
          hiddenCount: visibleProvider.hiddenCount,
          expanded: visibleProvider.expanded,
        });
      }
    }

    if (shouldShowClearSpecModel && !clearSpecModelInserted) {
      if (items.length > 0) {
        items.push({ type: 'sep' as const });
      }
      pushClearSpecModel();
    }

    return items;
  }, [
    additionalOptions,
    createModelRow,
    customModels,
    expandedProviderGroups,
    favoriteModelIdSet,
    newModelIds,
    newModelIdSet,
    orderedBuiltInModels,
    shouldHideDisabledModelRow,
    visibleFavoriteModelIds,
    onClearSpecModel,
    currentModelForTab,
    hasSpecModel,
    selectedTab,
    t,
  ]);

  const currentReasoningEffortForTab = useMemo(() => {
    if (selectedTab === 'worker' && missionWorkerReasoningEffort) {
      return missionWorkerReasoningEffort;
    }
    if (selectedTab === 'validator' && missionValidatorReasoningEffort) {
      return missionValidatorReasoningEffort;
    }
    if (selectedTab === 'spec') {
      return (
        (hasSpecModel ? specModeReasoningEffort : currentReasoningEffort) ??
        ReasoningEffort.None
      );
    }
    return (
      currentReasoningEffort ?? mainReasoningEffort ?? ReasoningEffort.None
    );
  }, [
    selectedTab,
    hasSpecModel,
    currentReasoningEffort,
    mainReasoningEffort,
    specModeReasoningEffort,
    missionWorkerReasoningEffort,
    missionValidatorReasoningEffort,
  ]);

  const maxModelNameWidth = useMemo(() => {
    let max = 0;
    const allModelIds = [
      ...orderedBuiltInModels,
      ...customModels.map((m) => m.id),
    ];
    for (const id of allModelIds) {
      const config = getTuiModelConfig(id);
      let name = config.shortDisplayName;
      if (
        id === currentModelForTab &&
        config.supportedReasoningEfforts.length > 1
      ) {
        name = `${name} (${getReasoningEffortDisplayName(currentReasoningEffortForTab)})`;
      }
      if (config.variantBadge) {
        name = `${name} (${config.variantBadge})`;
      }
      if (name.length > max) max = name.length;
    }
    for (const option of additionalOptions) {
      if (option.label.length > max) max = option.label.length;
    }
    return max;
  }, [
    additionalOptions,
    orderedBuiltInModels,
    customModels,
    currentModelForTab,
    currentReasoningEffortForTab,
  ]);

  if (!hasInitializedSelection.current) {
    hasInitializedSelection.current = true;
    const clearSpecIdx =
      selectedTab === 'spec'
        ? allRows.findIndex((r) => r.type === 'clear-spec-model')
        : -1;
    const idx =
      clearSpecIdx >= 0
        ? clearSpecIdx
        : allRows.findIndex(
            (r) =>
              (r.type === 'model' || r.type === 'option') &&
              r.id === currentModelForTab
          );
    if (idx >= 0) {
      setSelectedIndex(idx);
    }
  }

  const rows: Row[] = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return allRows;

    const getModelSection = (id: string): ModelRow['section'] =>
      favoriteModelIdSet.has(id) ? 'favorites' : 'provider';

    const allModelRows: ModelSearchRow[] = [
      ...additionalOptions.map((option) => ({
        type: 'option' as const,
        id: option.id,
        label: option.label,
      })),
      ...[
        ...orderedBuiltInModels,
        ...customModels.map((customModel) => customModel.id),
      ].flatMap((id) => {
        const row = createModelRow(id, getModelSection(id));
        return row && !shouldHideDisabledModelRow(row) ? [row] : [];
      }),
    ];

    const fzf = new Fzf(allModelRows, {
      selector: (row: ModelSearchRow) => {
        if (row.type === 'option') return `${row.id} ${row.label}`;
        const config = getTuiModelConfig(row.id);
        return `${row.id} ${config.displayName} ${config.shortDisplayName}`;
      },
    });

    return fzf.find(query).map((result) => result.item);
  }, [
    allRows,
    additionalOptions,
    searchQuery,
    orderedBuiltInModels,
    customModels,
    favoriteModelIdSet,
    createModelRow,
    shouldHideDisabledModelRow,
  ]);

  const isSelectable = (row: Row): boolean => {
    if (row.type === 'sep' || row.type === 'header') return false;
    if (row.type === 'option') return true;
    if (row.type === 'clear-spec-model') return true;
    if (row.type === 'provider-toggle') return true;
    if (row.type === 'model') {
      return !row.disabled || row.section === 'favorites';
    }
    return false;
  };

  const findNextSelectableIndex = (
    currentIdx: number,
    direction: 1 | -1
  ): number => {
    let next = currentIdx + direction;
    let iterations = 0;
    while (iterations < rows.length) {
      if (next < 0 || next >= rows.length) return currentIdx;
      if (isSelectable(rows[next])) return next;
      next += direction;
      iterations++;
    }
    return currentIdx;
  };

  const hasSelectableBefore = (currentIdx: number): boolean =>
    rows.slice(0, currentIdx).some((row) => isSelectable(row));

  const prevSearchQueryRef = useRef(searchQuery);
  const prevSelectedTabRef = useRef(selectedTab);
  if (
    searchQuery !== prevSearchQueryRef.current ||
    selectedTab !== prevSelectedTabRef.current
  ) {
    prevSearchQueryRef.current = searchQuery;
    prevSelectedTabRef.current = selectedTab;
    const clearSpecIdx =
      searchQuery.trim() === '' && selectedTab === 'spec'
        ? rows.findIndex((r) => r.type === 'clear-spec-model')
        : -1;
    const currentIdx =
      clearSpecIdx >= 0
        ? clearSpecIdx
        : rows.findIndex(
            (r) =>
              (r.type === 'model' || r.type === 'option') &&
              r.id === currentModelForTab
          );
    if (currentIdx >= 0) {
      setSelectedIndex(currentIdx);
    } else {
      const firstSelectable = rows.findIndex((r) => isSelectable(r));
      setSelectedIndex(firstSelectable >= 0 ? firstSelectable : 0);
    }
  }

  if (selectedIndex >= rows.length && rows.length > 0) {
    const firstSelectable = rows.findIndex((r) => isSelectable(r));
    setSelectedIndex(firstSelectable >= 0 ? firstSelectable : 0);
  }

  if (pendingFavoriteFocus.current) {
    const pendingFocus = pendingFavoriteFocus.current;
    const focusIdx =
      pendingFocus.type === 'model'
        ? rows.findIndex(
            (r) => r.type === 'model' && r.id === pendingFocus.modelId
          )
        : rows.findIndex((r) => isSelectable(r));
    if (focusIdx >= 0) {
      setSelectedIndex(focusIdx);
    }
    pendingFavoriteFocus.current = null;
  }

  if (pendingProviderToggleFocusGroup.current) {
    const focusIdx = rows.findIndex(
      (r) =>
        r.type === 'provider-toggle' &&
        r.group === pendingProviderToggleFocusGroup.current
    );
    if (focusIdx >= 0) {
      setSelectedIndex(focusIdx);
    }
    pendingProviderToggleFocusGroup.current = null;
  }

  const handleSearchChange = (value: string) => {
    setSearchQuery(cleanPastedText(value));
  };

  const ANCHOR_ROW = 10;
  const effectiveAnchorRow =
    selectedIndex < VISIBLE_ROW_COUNT ? selectedIndex : ANCHOR_ROW;
  const { windowStart, visibleItems: visibleRows } = getWindowedListSlice({
    items: rows,
    selectedIndex,
    visibleCount: VISIBLE_ROW_COUNT,
    anchorRow: effectiveAnchorRow,
  });

  const toggleProviderGroup = (group: ModelProviderGroup) => {
    setExpandedProviderGroups((previous) => {
      const next = new Set(previous);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  useKeypressHandler(
    (input, key) => {
      if (matchKeyboardChord({ input, key }, 'escape')) {
        onCancel();
        return true;
      }

      if (matchKeyboardChord({ input, key }, 'tab') && !hideTabs) {
        setSelectedTab((prev) => {
          if (missionMode) {
            if (prev === 'orchestrator') return 'worker';
            if (prev === 'worker') return 'validator';
            return 'orchestrator';
          }
          return prev === 'main' ? 'spec' : 'main';
        });
        return true;
      }

      if (matchKeyboardChord({ input, key }, 'enter')) {
        const row = rows[selectedIndex];
        if (!row) return false;

        if (row.type === 'option') {
          onOptionSelect?.(row.id);
        } else if (row.type === 'model' && !row.disabled) {
          if (
            missionMode &&
            onMissionSelect &&
            (selectedTab === 'orchestrator' ||
              selectedTab === 'worker' ||
              selectedTab === 'validator')
          ) {
            onMissionSelect(selectedTab, row.id);
          } else if (selectedTab === 'spec' && onSpecSelect) {
            const parsed = parseUserModelSelection(row.id);
            if (parsed !== undefined) onSpecSelect(parsed);
          } else if (selectedTab === 'spec' && onSpecModeConfig) {
            onSpecModeConfig();
          } else {
            const parsed = parseUserModelSelection(row.id);
            if (parsed !== undefined) onSelect(parsed);
          }
        } else if (row.type === 'clear-spec-model' && onClearSpecModel) {
          onClearSpecModel();
        } else if (row.type === 'provider-toggle') {
          pendingProviderToggleFocusGroup.current = row.group;
          toggleProviderGroup(row.group);
        }
        return true;
      }

      if (matchKeyboardChord({ input, key }, 'up-arrow')) {
        if (focusedRegion === 'search') {
          setFocusedRegion('list');
          return true;
        }
        if (!hasSelectableBefore(selectedIndex)) {
          setFocusedRegion('search');
          return true;
        }
        setFocusedRegion('list');
        setSelectedIndex((prev) => findNextSelectableIndex(prev, -1));
        return true;
      }

      if (matchKeyboardChord({ input, key }, 'down-arrow')) {
        if (focusedRegion === 'search') {
          setFocusedRegion('list');
          const firstSelectable = rows.findIndex((row) => isSelectable(row));
          if (firstSelectable >= 0) {
            setSelectedIndex(firstSelectable);
          }
          return true;
        }
        setFocusedRegion('list');
        setSelectedIndex((prev) => findNextSelectableIndex(prev, 1));
        return true;
      }

      const missionTab =
        missionMode &&
        (selectedTab === 'orchestrator' ||
          selectedTab === 'worker' ||
          selectedTab === 'validator')
          ? selectedTab
          : undefined;
      const hasDefaultHandler = missionTab
        ? Boolean(onSetMissionDefault)
        : Boolean(selectedTab === 'spec' ? onSetSpecAsDefault : onSetAsDefault);
      if (
        hasDefaultHandler &&
        focusedRegion === 'list' &&
        matchKeyboardChord({ input, key }, 'model-selector-set-default')
      ) {
        const row = rows[selectedIndex];
        if (row?.type === 'model' && !row.disabled) {
          if (missionTab && onSetMissionDefault) {
            void onSetMissionDefault(missionTab, row.id);
          } else {
            const handler =
              selectedTab === 'spec' ? onSetSpecAsDefault : onSetAsDefault;
            if (handler) {
              void handler(row.id);
            }
          }
        }
        return true;
      }

      if (
        focusedRegion === 'list' &&
        matchKeyboardChord({ input, key }, 'model-selector-favorite-toggle')
      ) {
        const row = rows[selectedIndex];
        if (
          row?.type === 'model' &&
          (!row.disabled || row.section === 'favorites')
        ) {
          if (row.section === 'favorites') {
            const favoriteRows = rows.filter(
              (candidate): candidate is ModelRow =>
                candidate.type === 'model' && candidate.section === 'favorites'
            );
            const favoriteIndex = favoriteRows.findIndex(
              (favoriteRow) => favoriteRow.id === row.id
            );
            const nextFavorite =
              favoriteRows[favoriteIndex + 1] ??
              favoriteRows[favoriteIndex - 1];
            pendingFavoriteFocus.current = nextFavorite
              ? { type: 'model', modelId: nextFavorite.id }
              : { type: 'first-selectable' };
          } else {
            pendingFavoriteFocus.current = { type: 'model', modelId: row.id };
          }
          const wasFavorited = favoriteModelIdSet.has(row.id);
          settingsService.toggleModelFavorite(row.id);
          if (!wasFavorited && row.section === 'new') {
            settingsService.dismissNewModel(row.id);
          }
          setSelectorRevision((revision) => revision + 1);
        }
        return true;
      }

      if (
        focusedRegion === 'list' &&
        input.toLowerCase() === 'x' &&
        !key.ctrl &&
        !key.meta
      ) {
        const row = rows[selectedIndex];
        if (row?.type === 'model' && row.section === 'new') {
          const newRowsForSection = rows.filter(
            (candidate): candidate is ModelRow =>
              candidate.type === 'model' && candidate.section === 'new'
          );
          const newIndex = newRowsForSection.findIndex(
            (candidate) => candidate.id === row.id
          );
          const nextNew =
            newRowsForSection[newIndex + 1] ?? newRowsForSection[newIndex - 1];
          pendingFavoriteFocus.current = nextNew
            ? { type: 'model', modelId: nextNew.id }
            : { type: 'model', modelId: row.id };
          settingsService.dismissNewModel(row.id);
          setSelectorRevision((revision) => revision + 1);
        }
        return true;
      }

      if (
        focusedRegion === 'list' &&
        input &&
        input.length > 0 &&
        !key.ctrl &&
        !key.meta
      ) {
        setFocusedRegion('search');
        setSearchQuery(cleanPastedText(input));
        return true;
      }

      return false;
    },
    { layer: KeypressLayer.Navigation }
  );

  const selectedDefaultModelId =
    selectedTab === 'spec' && defaultSpecModeModelId
      ? defaultSpecModeModelId
      : selectedTab === 'orchestrator'
        ? defaultMissionOrchestratorModelId
        : selectedTab === 'worker'
          ? defaultMissionWorkerModelId
          : selectedTab === 'validator'
            ? defaultMissionValidatorModelId
            : defaultModelId;
  const activeMissionDefaultTab = missionMode
    ? selectedTab === 'orchestrator' ||
      selectedTab === 'worker' ||
      selectedTab === 'validator'
      ? selectedTab
      : undefined
    : undefined;
  const activeDefaultHandler = activeMissionDefaultTab
    ? onSetMissionDefault
    : selectedTab === 'spec'
      ? onSetSpecAsDefault
      : onSetAsDefault;
  const focusedRow = rows[selectedIndex];
  const isFocusedNewRow =
    focusedRow?.type === 'model' && focusedRow.section === 'new';
  const listShortcutHelp =
    focusedRegion === 'list'
      ? ` · F favorite${activeDefaultHandler ? ' · D set default' : ''}${
          isFocusedNewRow ? t('common:modelSelector.dismissNewHelp') : ''
        }`
      : '';

  return (
    <FilterableMenuContainer
      title={title ?? t('common:modelSelector.title')}
      titleBold={false}
      width={hideTabs ? undefined : terminalWidth}
      searchValue={searchQuery}
      onSearchChange={handleSearchChange}
      searchPlaceholder="Filter models..."
      searchFocused={focusedRegion === 'search'}
      shouldIgnoreSearchInput={(input, key) =>
        focusedRegion === 'list' &&
        (input.toLowerCase() === 'f' ||
          (Boolean(activeDefaultHandler) && input.toLowerCase() === 'd') ||
          (isFocusedNewRow && input.toLowerCase() === 'x')) &&
        !key.ctrl &&
        !key.meta
      }
      headerRight={
        hideTabs ? undefined : missionMode ? (
          <Box>
            <Text
              color={
                selectedTab === 'orchestrator'
                  ? COLORS.success
                  : COLORS.text.muted
              }
            >
              {selectedTab === 'orchestrator' ? '◉' : '○'}{' '}
              {t('common:missionModelPicker.orchestratorTab')}
            </Text>
            <Text color={COLORS.text.muted}> | </Text>
            <Text
              color={
                selectedTab === 'worker' ? COLORS.success : COLORS.text.muted
              }
            >
              {selectedTab === 'worker' ? '◉' : '○'}{' '}
              {t('common:missionModelPicker.workerTab')}
            </Text>
            <Text color={COLORS.text.muted}> | </Text>
            <Text
              color={
                selectedTab === 'validator' ? COLORS.success : COLORS.text.muted
              }
            >
              {selectedTab === 'validator' ? '◉' : '○'}{' '}
              {t('common:missionModelPicker.validatorTab')}
            </Text>
          </Box>
        ) : (
          <Box>
            <Text
              color={
                selectedTab === 'main' ? COLORS.primary : COLORS.text.muted
              }
            >
              {selectedTab === 'main' ? '◉ Main' : '○ Main'}
            </Text>
            <Text color={COLORS.text.muted}> | </Text>
            <Text
              color={selectedTab === 'spec' ? COLORS.spec : COLORS.text.muted}
            >
              {selectedTab === 'spec' ? '◉ Spec' : '○ Spec'}
            </Text>
          </Box>
        )
      }
      helpText={`Type search · ↑↓ focus list · Enter select${listShortcutHelp}${
        hideTabs ? '' : ' · Tab switch'
      } · Esc cancel`}
    >
      {isOrchestratorModelSelector && (
        <>
          <Text color={COLORS.warning}>
            {MISSION_ORCHESTRATOR_MODEL_WARNING}
          </Text>
          <Box marginTop={1} />
        </>
      )}

      <Box flexDirection="column" height={VISIBLE_ROW_COUNT}>
        {visibleRows.map((row, i) => {
          const index = windowStart + i;

          if (row.type === 'header') {
            return (
              <Box key={`header-${index}`}>
                <Text color={COLORS.text.menuSectionHeader}>{row.label}</Text>
              </Box>
            );
          }

          if (row.type === 'sep') {
            return (
              <Box key={`sep-${index}`}>
                <Text>{'\u00A0'}</Text>
              </Box>
            );
          }

          if (row.type === 'clear-spec-model') {
            const isSelected =
              focusedRegion === 'list' && index === selectedIndex;
            const color = isSelected
              ? COLORS.text.primary
              : COLORS.text.secondary;
            const mainModelConfig = getTuiModelConfig(currentModel);
            const mainEffort = mainReasoningEffort ?? ReasoningEffort.None;
            const mainEffortName = getReasoningEffortDisplayName(mainEffort);
            const mainModelDisplay =
              mainModelConfig.supportedReasoningEfforts.length > 1
                ? `${mainModelConfig.shortDisplayName} (${mainEffortName})`
                : mainModelConfig.shortDisplayName;

            return (
              <Box key="clear-spec-model" flexDirection="column">
                <Box>
                  <Box width={2}>
                    <Text> </Text>
                  </Box>
                  <Text bold={isSelected} color={color}>
                    {t('common:modelSelector.clearSpecModel')}
                  </Text>
                </Box>
                <Box paddingLeft={4}>
                  <Text dimColor>
                    {t('common:modelSelector.mainModelLabel')}
                    <Text color={COLORS.primary}>{mainModelDisplay}</Text>
                  </Text>
                </Box>
              </Box>
            );
          }

          if (row.type === 'provider-toggle') {
            const isSelected =
              focusedRegion === 'list' && index === selectedIndex;
            const color = isSelected
              ? COLORS.text.primary
              : COLORS.text.secondary;
            const label = row.expanded
              ? t('common:modelSelector.showFewerModels')
              : t('common:modelSelector.showAllModels', {
                  count: row.hiddenCount,
                });

            return (
              <Box key={`provider-toggle-${row.group}`}>
                <Box width={2}>
                  <Text> </Text>
                </Box>
                <Text bold={isSelected} color={color}>
                  {label}
                </Text>
              </Box>
            );
          }

          if (row.type === 'option') {
            const isSelected =
              focusedRegion === 'list' && index === selectedIndex;
            const isCurrent = row.id === currentModelForTab;
            const color = isSelected ? COLORS.text.primary : COLORS.text.muted;

            return (
              <Box key={row.id}>
                <Box width={2}>
                  <Text color={isCurrent ? COLORS.primary : undefined}>
                    {isCurrent ? '●' : ' '}
                  </Text>
                </Box>
                <Text bold={isSelected} color={color}>
                  {padEndByDisplayWidth(row.label, maxModelNameWidth)}
                </Text>
              </Box>
            );
          }

          const model = row.id;
          const isSelected =
            focusedRegion === 'list' && index === selectedIndex;
          const isCurrent = model === currentModelForTab;
          const isDefault = model === selectedDefaultModelId;
          const isDisabled = row.disabled;
          const color: string | undefined = isSelected
            ? COLORS.text.primary
            : isDisabled
              ? COLORS.text.muted
              : COLORS.text.muted;

          const config = getTuiModelConfig(model);
          let displayName = config.shortDisplayName;

          if (isCurrent && config.supportedReasoningEfforts.length > 1) {
            const effortDisplay = getReasoningEffortDisplayName(
              currentReasoningEffortForTab
            );
            displayName = `${displayName} (${effortDisplay})`;
          }

          if (config.variantBadge) {
            displayName = `${displayName} (${config.variantBadge})`;
          }

          const multiplier = config.modelId
            ? getTokenMultiplier(config.modelId)
            : undefined;
          const promoLabel = config.modelId
            ? getPromoLabel(config.modelId)
            : undefined;

          return (
            <Box key={model}>
              <Box width={2}>
                <Text color={isCurrent ? COLORS.primary : undefined}>
                  {isCurrent ? '●' : ' '}
                </Text>
              </Box>
              <Text bold={isSelected} color={color}>
                {padEndByDisplayWidth(
                  displayName,
                  Math.max(maxModelNameWidth, 0)
                )}
              </Text>
              <Text color={COLORS.warning}>{isDefault ? ' ★' : '  '}</Text>
              {row.section === 'new' && (
                <Text color={COLORS.success}>
                  {' '}
                  {t('common:modelSelector.newBadge')}
                </Text>
              )}
              {multiplier !== undefined && (
                <Text color={COLORS.text.modelMultiplier}>
                  {row.section === 'new' ? '  ' : '      '}
                  {getMultiplierDisplay(multiplier, promoLabel)}
                </Text>
              )}
              {model === INDUSTRY_ROUTER_MODEL_ID && (
                <Text color={COLORS.text.modelMultiplier}>
                  {row.section === 'new' ? '  ' : '      '}
                  {t('common:modelSelector.industryRouterDynamicMultiplier')}
                </Text>
              )}
              {isDisabled && (
                <Text color={COLORS.text.muted}>
                  {' '}
                  {t('common:modelSelector.disabledByAdmin')}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={COLORS.text.muted} dimColor>
          {t('common:modelSelector.multiplierNote')}
          {allBuiltInModels.some((modelId) => {
            const modelConfig = getTuiModelConfig(modelId);
            return modelConfig.usesUSBasedInference;
          }) && ` · ${t('common:modelSelector.usBasedInference')}`}
        </Text>
      </Box>
    </FilterableMenuContainer>
  );
}

// ---------------------------------------------------------------------------
// Exported ModelSelector
// ---------------------------------------------------------------------------
export function ModelSelector(props: ModelSelectorProps) {
  return <ModelSelectorContent {...props} />;
}
