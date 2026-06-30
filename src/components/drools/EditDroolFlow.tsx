import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import { getWindowedListSlice } from '@/components/common/getWindowedListSlice';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { getAllowedModelIds } from '@/models/availability';
import { getTuiModelConfig } from '@/models/config';
import { useAllModelIds } from '@/models/modelRegistry';
//
import { getDroolLoaderSingleton } from '@/services/drools/CustomDroolRegistry';
import { DroolStorageService } from '@/services/drools/DroolStorageService';
import { DroolValidator } from '@/services/drools/DroolValidator';
import { DroolConfig } from '@/services/drools/types';
import { McpServiceEventType } from '@/services/mcp/enums';
import { getMcpService } from '@/services/mcp/McpService';
import { getTUIToolRegistry } from '@/tools/registry';

import type { DroolModel } from '@industry/common/settings';
import type { TFunction } from 'i18next';

const USER_VISIBLE_TOOL_IDS = new Set(
  DroolValidator.getUserSelectableToolIds()
);

interface ToolInfo {
  id: string;
  name: string;
  description: string;
  isMcp?: boolean;
}

const getModelDisplayName = (model: DroolModel, t: TFunction): string => {
  if (model === 'inherit') {
    return t('createDrool.inheritModel');
  }

  const config = getTuiModelConfig(model);
  const base = config?.displayName ?? model;
  if (typeof model === 'string' && model.startsWith('custom:')) {
    return `${base} ${t('createDrool.customSuffix')}`;
  }
  return base;
};

const getModelDescription = (model: DroolModel, t: TFunction): string => {
  if (model === 'inherit') {
    return t('createDrool.inheritDescription');
  }
  return '';
};

interface EditDroolFlowProps {
  drool?: DroolConfig;
  onComplete: () => void;
  onCancel: () => void;
}

export function EditDroolFlow({
  drool,
  onComplete,
  onCancel,
}: EditDroolFlowProps) {
  const { t } = useTranslation('common');
  // Get built-ins + customs in one place
  const MODEL_OPTIONS = useAllModelIds() as DroolModel[];

  const [drools, setDrools] = useState<DroolConfig[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedDrool, setSelectedDrool] = useState<DroolConfig | null>(
    drool || null
  );
  const [loading, setLoading] = useState(!drool);
  const [mode, setMode] = useState<
    'selectDrool' | 'menu' | 'opening' | 'editTools' | 'editModel'
  >(drool ? 'menu' : 'selectDrool');
  const [error, setError] = useState<string | null>(null);

  // Model state for editModel mode
  const [selectedModel, setSelectedModel] = useState<DroolModel>('inherit');

  // Tools state for editTools mode
  const [useAllTools, setUseAllTools] = useState(true);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [toolsScrollOffset, setToolsScrollOffset] = useState(0);
  const visibleToolsCount = 10;

  // Track MCP service reloads to refresh tool list
  const [mcpReloadCount, setMcpReloadCount] = useState(0);

  // Listen for MCP service reloads to refresh tool list and ensure MCP is started
  useEffect(() => {
    const mcpService = getMcpService();

    const handleReloaded = () => {
      setMcpReloadCount((prev) => prev + 1);
    };

    mcpService.on(McpServiceEventType.SERVERS_RELOADED, handleReloaded);

    // Ensure MCP service is started so MCP tools are available
    void mcpService.start().catch(() => {
      // Ignore errors - MCP tools will simply not appear in the list
    });

    return () => {
      mcpService.off(McpServiceEventType.SERVERS_RELOADED, handleReloaded);
    };
  }, []);

  const availableTools = useMemo((): ToolInfo[] => {
    const registry = getTUIToolRegistry();
    const allTools = registry.getAllTools();

    const toolDescriptions: Record<string, string> = {
      LS: 'List directory contents',
      Grep: 'Search in files',
      Glob: 'Find files by pattern',
      Read: 'Read file contents',
      Create: 'Create new files',
      Edit: 'Edit code (mode-aware)',
      Execute: 'Execute shell commands',
      WebSearch: 'Search the web',
      FetchUrl: 'Fetch URL content',
    };

    const result: ToolInfo[] = [];

    // Add built-in tools
    for (const tool of allTools) {
      const id = tool.llmId || tool.id;
      if (USER_VISIBLE_TOOL_IDS.has(id) && !tool.isMcpTool) {
        result.push({
          id,
          name: tool.displayName || id,
          description: toolDescriptions[id] || 'Tool',
          isMcp: false,
        });
      }
    }

    // Add MCP tools
    for (const tool of allTools) {
      if (tool.isMcpTool) {
        const id = tool.llmId || tool.id;
        const displayName = tool.displayName || id;
        // Truncate long descriptions to avoid UI issues
        const maxDescLength = 50;
        let desc = tool.description || 'MCP tool';
        if (desc.length > maxDescLength) {
          desc = `${desc.slice(0, maxDescLength - 3)}...`;
        }
        result.push({
          id,
          name: displayName,
          description: desc,
          isMcp: true,
        });
      }
    }

    return result;
  }, [mcpReloadCount]);

  const loadDrools = async () => {
    try {
      const loader = getDroolLoaderSingleton();
      const loadedDrools = await loader.loadAllDrools();
      setDrools(loadedDrools);
      setLoading(false);
    } catch (err) {
      logException(err, 'Failed to load drools for editing');
      onCancel();
    }
  };

  const initToolsStateFromDrool = (d: DroolConfig) => {
    const model = d.metadata.model ?? 'inherit';
    setSelectedModel(model);

    const result = DroolValidator.resolveUserFacingTools({
      tools: d.metadata.tools,
      model,
    });

    // Validate metadata as well to surface invalid model errors prominently.
    // Use the org-policy-aware model list so blocked models are flagged.
    const metaValidation = DroolValidator.validateMetadata(d.metadata, [
      ...getAllowedModelIds(),
    ]);

    const combinedErrors = [...metaValidation.errors, ...result.errors];
    setError(combinedErrors.length > 0 ? combinedErrors.join(', ') : null);

    if (result.isFullAccess) {
      setUseAllTools(true);
      setSelectedTools(new Set());
    } else {
      setUseAllTools(false);
      setSelectedTools(new Set(result.userTools));
    }

    setToolsScrollOffset(0);
  };

  const openInEditor = async () => {
    if (!selectedDrool) return;
    try {
      setMode('opening');
      const open = (await import('open')).default;
      await open(selectedDrool.filePath);
      onComplete();
    } catch (err) {
      logException(err, 'Failed to open editor');
      setError(t('editDrool.failedToOpen'));
      setMode('menu');
    }
  };

  const saveModel = async (model: DroolModel) => {
    if (!selectedDrool) return;
    try {
      const storage = new DroolStorageService();
      await storage.updateDrool(
        selectedDrool.metadata.name,
        {
          metadata: {
            model,
          },
        },
        selectedDrool.location
      );
      setError(null);
      onComplete();
    } catch (err) {
      logException(err, 'Failed to update drool model');
      setError(t('editDrool.failedToUpdateModel'));
    }
  };

  const saveTools = async () => {
    if (!selectedDrool) return;
    try {
      const model = selectedDrool.metadata.model ?? 'inherit';
      let toolsToPersist: string[] | undefined;

      if (useAllTools) {
        toolsToPersist = undefined;
      } else {
        const selectedList = Array.from(selectedTools);
        if (selectedList.length === 0) {
          setError(t('editDrool.selectAtLeastOneTool'));
          return;
        }

        const normalization = DroolValidator.normalizeTools(
          selectedList,
          model
        );
        if (normalization.errors.length > 0) {
          setError(normalization.errors.join(', '));
          return;
        }

        toolsToPersist = normalization.resolved;
      }

      const storage = new DroolStorageService();
      await storage.updateDrool(
        selectedDrool.metadata.name,
        {
          metadata: {
            tools: toolsToPersist,
          },
        },
        selectedDrool.location
      );
      setError(null);
      onComplete();
    } catch (err) {
      logException(err, 'Failed to update drool tools');
      setError(t('editDrool.failedToUpdateTools'));
    }
  };

  useEffect(() => {
    if (!drool) {
      void loadDrools();
    } else {
      // Initialize state from provided drool
      setSelectedDrool(drool);
      initToolsStateFromDrool(drool);
    }
  }, [drool]);

  useKeypressHandler(
    (_input, key) => {
      if (key.escape) {
        if (mode === 'menu') {
          onCancel();
        } else if (mode === 'editTools' || mode === 'editModel') {
          setMode('menu');
          setSelectedIndex(0);
        } else if (mode === 'selectDrool') {
          onCancel();
        }
        return;
      }

      if (mode === 'selectDrool' && drools.length > 0) {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((prev) => Math.min(drools.length - 1, prev + 1));
          return;
        }
        if (key.return) {
          const d = drools[selectedIndex];
          setSelectedDrool(d);
          initToolsStateFromDrool(d);
          setMode('menu');
          setSelectedIndex(0);
          return;
        }
      }

      if (mode === 'menu') {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((prev) => Math.min(2, prev + 1));
          return;
        }
        if (key.return) {
          if (selectedIndex === 0) {
            void openInEditor();
          } else if (selectedIndex === 1) {
            setMode('editTools');
          } else if (selectedIndex === 2) {
            setMode('editModel');
            const modelIndex = MODEL_OPTIONS.indexOf(selectedModel);
            setSelectedIndex(modelIndex >= 0 ? modelIndex : 0);
          }
          return;
        }
      }

      if (mode === 'editModel') {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((prev) =>
            Math.min(MODEL_OPTIONS.length - 1, prev + 1)
          );
          return;
        }
        if (key.return) {
          const model = MODEL_OPTIONS[selectedIndex];
          if (model) {
            void saveModel(model);
          }
          return;
        }
      }

      if (mode === 'editTools') {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          if (!useAllTools) {
            const newIndex = Math.max(0, selectedIndex - 1);
            if (newIndex < toolsScrollOffset) setToolsScrollOffset(newIndex);
          }
          return;
        }
        if (key.downArrow) {
          if (!useAllTools) {
            const maxIndex = availableTools.length - 1;
            const newIndex = Math.min(maxIndex, selectedIndex + 1);
            setSelectedIndex(newIndex);
            if (newIndex >= toolsScrollOffset + visibleToolsCount) {
              setToolsScrollOffset(newIndex - visibleToolsCount + 1);
            }
          }
          return;
        }
        // toggle all
        if (_input === 'a' || _input === 'A') {
          const nextValue = !useAllTools;
          setUseAllTools(nextValue);
          if (nextValue) {
            setSelectedTools(new Set());
          }
          return;
        }
        // toggle single
        if (_input === ' ' && !useAllTools) {
          const tool = availableTools[selectedIndex];
          if (tool) {
            const newTools = new Set(selectedTools);
            if (newTools.has(tool.id)) newTools.delete(tool.id);
            else newTools.add(tool.id);
            setSelectedTools(newTools);
          }
          return;
        }
        if (key.return) void saveTools();
      }
    },
    { isActive: true }
  );

  if (loading) {
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Text color={COLORS.text.muted}>{t('editDrool.loadingDrools')}</Text>
      </Box>
    );
  }

  if (!selectedDrool && drools.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Box flexDirection="column">
          <Text bold>{t('editDrool.title')}</Text>
          <Text color={COLORS.text.muted}>
            {t('editDrool.noDroolsAvailable')}
          </Text>
        </Box>
      </Box>
    );
  }

  if (!selectedDrool || mode === 'selectDrool') {
    // Show drool selector
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Box flexDirection="column">
          <Text bold>{t('editDrool.title')}</Text>
          <Text color={COLORS.text.muted}>{t('editDrool.selectToEdit')}</Text>
          <Box marginTop={1} />

          <Box flexDirection="column">
            {drools.map((d, index) => {
              const isSelected = index === selectedIndex;
              const color = isSelected ? COLORS.primary : COLORS.text.primary;
              const locationBadge =
                d.location === 'project'
                  ? t('editDrool.projectBadge')
                  : t('editDrool.personalBadge');

              return (
                <Text key={d.metadata.name} color={color}>
                  {isSelected ? '> ' : '  '}
                  {d.metadata.name} {locationBadge}
                </Text>
              );
            })}
          </Box>

          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {t('editDrool.navigationSelectCancel')}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (mode === 'opening') {
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Box flexDirection="column">
          <Text bold>{t('editDrool.title')}</Text>
          <Text>
            {t('editDrool.opening', { name: selectedDrool.metadata.name })}
          </Text>
          <Text color={COLORS.text.muted}>
            {t('editDrool.fileLabel', { path: selectedDrool.filePath })}
          </Text>
        </Box>
      </Box>
    );
  }

  if (mode === 'menu') {
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Box flexDirection="column">
          <Text bold>{t('editDrool.title')}</Text>
          <Text color={COLORS.text.muted}>
            {selectedDrool.metadata.name} (
            {selectedDrool.location === 'project' ? 'Project' : 'Personal'})
          </Text>
          <Box marginTop={1} />
          {(
            [
              t('editDrool.openInEditor'),
              t('editDrool.editTools'),
              t('editDrool.editModel'),
            ] as const
          ).map((label, idx) => (
            <Text
              key={label}
              color={
                selectedIndex === idx ? COLORS.primary : COLORS.text.primary
              }
            >
              {selectedIndex === idx ? '> ' : '  '}
              {label}
            </Text>
          ))}
          {error && (
            <Box marginTop={1}>
              <Text color={COLORS.error}>
                {t('editDrool.errorPrefix', { error })}
              </Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {t('editDrool.navigationSelectBack')}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (mode === 'editTools') {
    const visibleTools = availableTools.slice(
      toolsScrollOffset,
      toolsScrollOffset + visibleToolsCount
    );

    // Find the index where MCP tools start
    const firstMcpIndex = availableTools.findIndex((tool) => tool.isMcp);
    const hasMcpTools = firstMcpIndex !== -1;

    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Box flexDirection="column">
          <Text bold>{t('editDrool.editToolsTitle')}</Text>
          <Text color={COLORS.text.muted}>{selectedDrool.metadata.name}</Text>
          <Box marginTop={1} />

          <Text color={useAllTools ? COLORS.primary : COLORS.text.primary}>
            [{useAllTools ? '✓' : ' '}] {t('editDrool.allToolsToggle')}
          </Text>

          {!useAllTools && (
            <>
              <Box marginTop={1} />
              <Text color={COLORS.text.muted}>
                {t('editDrool.selectIndividualTools')}
              </Text>

              {toolsScrollOffset > 0 && (
                <Text color={COLORS.text.muted}>
                  {t('editDrool.moreAbove')}
                </Text>
              )}

              {visibleTools.map((tool, index) => {
                const actualIndex = toolsScrollOffset + index;
                const isSelected = selectedTools.has(tool.id);
                const isCurrent = actualIndex === selectedIndex;

                // Show section headers
                const showBuiltInHeader = actualIndex === 0;
                const showMcpHeader =
                  hasMcpTools && actualIndex === firstMcpIndex;

                return (
                  <Box key={tool.id} flexDirection="column">
                    {showBuiltInHeader && (
                      <Text color={COLORS.text.muted}>
                        {t('editDrool.builtInTools')}
                      </Text>
                    )}
                    {showMcpHeader && (
                      <>
                        <Box marginTop={1} />
                        <Text color={COLORS.text.muted}>
                          {t('editDrool.mcpTools')}
                        </Text>
                      </>
                    )}
                    <Text
                      color={isCurrent ? COLORS.primary : COLORS.text.primary}
                    >
                      {isCurrent ? '> ' : '  '}[{isSelected ? '✓' : ' '}]{' '}
                      {tool.name}
                      <Text color={COLORS.text.muted}>
                        {' '}
                        - {tool.description}
                      </Text>
                    </Text>
                  </Box>
                );
              })}

              {toolsScrollOffset + visibleToolsCount <
                availableTools.length && (
                <Text color={COLORS.text.muted}>
                  {t('editDrool.moreBelow')}
                </Text>
              )}

              <Box marginTop={1} />
              <Text color={COLORS.text.muted}>
                {t('editDrool.toolsSelectedCount', {
                  count: selectedTools.size,
                  suffix: selectedTools.size !== 1 ? 's' : '',
                })}
              </Text>
            </>
          )}

          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {!useAllTools
                ? t('editDrool.toolsHintIndividual')
                : t('editDrool.toolsHintAll')}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (mode === 'editModel') {
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Box flexDirection="column">
          <Text bold>{t('editDrool.editModelTitle')}</Text>
          <Text color={COLORS.text.muted}>{selectedDrool.metadata.name}</Text>
          <Box marginTop={1} />

          {(() => {
            const VISIBLE_COUNT = 10;
            const { windowStart, visibleItems, padCount } =
              getWindowedListSlice({
                items: MODEL_OPTIONS,
                selectedIndex,
                visibleCount: VISIBLE_COUNT,
                anchorRow: 7,
              });
            const selectedModel_ = MODEL_OPTIONS[selectedIndex];
            const selectedDescription = selectedModel_
              ? getModelDescription(selectedModel_, t)
              : '';

            return (
              <>
                <Box flexDirection="column" height={VISIBLE_COUNT}>
                  {visibleItems.map((model, visibleIdx) => {
                    const globalIndex = windowStart + visibleIdx;
                    const isCurrent = globalIndex === selectedIndex;
                    const isChosen = model === selectedModel;
                    const label = getModelDisplayName(model, t);

                    return (
                      <Text
                        key={model}
                        color={isCurrent ? COLORS.primary : COLORS.text.primary}
                      >
                        {isCurrent ? '> ' : '  '}[{isChosen ? '✓' : ' '}]{' '}
                        {label}
                      </Text>
                    );
                  })}
                  {Array.from({ length: padCount }).map((_, i) => (
                    <Box key={`pad-${i}`} height={1}>
                      <Text> </Text>
                    </Box>
                  ))}
                </Box>
                {selectedDescription ? (
                  <Text color={COLORS.text.muted}>
                    {'    '}
                    {selectedDescription}
                  </Text>
                ) : null}
              </>
            );
          })()}

          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {t('editDrool.navigationSaveBack')}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return null;
}
