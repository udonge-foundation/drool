import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { generateDroolCliTool } from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import { DroolLocation } from '@industry/drool-sdk-ext/protocol/settings';
import { logException } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { ChatInput } from '@/components/chat/ChatInput';
import { COLORS } from '@/components/chat/themedColors';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useAvailableModels } from '@/models/availability';
import { getTuiModelConfig } from '@/models/config';
import { useAllModelIds } from '@/models/modelRegistry';
//
import { DroolStorageService } from '@/services/drools/DroolStorageService';
import { DroolValidator } from '@/services/drools/DroolValidator';
import { McpServiceEventType } from '@/services/mcp/enums';
import { getMcpService } from '@/services/mcp/McpService';
import { getTUIToolRegistry } from '@/tools/registry';
// Import to ensure tools are registered
import '@/tools/tui';
import { CliClientToolDependencies } from '@/tools/types';

import type { DroolMetadata, DroolModel } from '@industry/common/settings';
import type { TFunction } from 'i18next';

const USER_SELECTABLE_TOOL_IDS = DroolValidator.getUserSelectableToolIds();
const USER_SELECTABLE_TOOL_SET = new Set(USER_SELECTABLE_TOOL_IDS);

interface ToolInfo {
  id: string;
  name: string;
  description: string;
  isMcp?: boolean;
}

type CreationStep =
  | 'location'
  | 'method'
  | 'describe'
  | 'generating'
  | 'identifier'
  | 'systemPrompt'
  | 'metaDescription'
  | 'model'
  | 'tools'
  | 'toolsAdvanced'
  | 'review';

type CreationMethod = 'generate' | 'manual';

interface CreateDroolFlowProps {
  onComplete: () => void;
  onCancel: () => void;
}

interface GenerateDroolResult {
  identifier: string;
  description: string;
  systemPrompt: string;
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

export function CreateDroolFlow({
  onComplete,
  onCancel,
}: CreateDroolFlowProps) {
  const { t } = useTranslation('common');
  // Get built-ins + customs in one place
  const MODEL_OPTIONS = useAllModelIds() as DroolModel[];
  // Built-ins only for validation
  const builtinModels = useAvailableModels();
  const firstCustomIndex = useMemo(
    () =>
      MODEL_OPTIONS.findIndex(
        (m) => typeof m === 'string' && (m as string).startsWith('custom:')
      ),
    [MODEL_OPTIONS]
  );

  const [currentStep, setCurrentStep] = useState<CreationStep>('location');
  const [selectedLocation, setSelectedLocation] = useState<DroolLocation>(
    DroolLocation.Project
  );
  const [_selectedMethod, setSelectedMethod] =
    useState<CreationMethod>('generate');
  const [description, setDescription] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [selectedModel, setSelectedModel] = useState<DroolModel>('inherit');
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [useAllTools, setUseAllTools] = useState(true);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    new Set(['all'])
  );
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isInputting, setIsInputting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolsScrollOffset, setToolsScrollOffset] = useState(0);
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

  // Get available tools from registry (built-in + MCP)
  const availableTools = useMemo((): ToolInfo[] => {
    const registry = getTUIToolRegistry();
    const allTools = registry.getAllTools();

    // Map of tool definitions to get descriptions for built-in tools
    const toolDescriptions: Record<string, string> = {
      Read: t('createDrool.toolDesc.read'),
      LS: t('createDrool.toolDesc.ls'),
      Grep: t('createDrool.toolDesc.grep'),
      Glob: t('createDrool.toolDesc.glob'),
      Create: t('createDrool.toolDesc.create'),
      Edit: t('createDrool.toolDesc.edit'),
      Execute: t('createDrool.toolDesc.execute'),
      WebSearch: t('createDrool.toolDesc.webSearch'),
      FetchUrl: t('createDrool.toolDesc.fetchUrl'),
    };

    const result: ToolInfo[] = [];

    // Add built-in tools
    for (const tool of allTools) {
      const id = tool.llmId || tool.id;
      if (USER_SELECTABLE_TOOL_SET.has(id) && !tool.isMcpTool) {
        result.push({
          id,
          name: tool.displayName || id,
          description: toolDescriptions[id] || t('createDrool.toolFallback'),
          isMcp: false,
        });
      }
    }

    // Add MCP tools
    for (const tool of allTools) {
      if (tool.isMcpTool) {
        const id = tool.llmId || tool.id;
        // MCP display names are like "[MCP] serverName:toolName"
        // Extract a cleaner name for display
        const displayName = tool.displayName || id;
        // Truncate long descriptions to avoid UI issues
        const maxDescLength = 50;
        let desc = tool.description || t('createDrool.mcpToolFallback');
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

  const visibleToolsCount = 10; // Number of tools visible at once

  // Helper function to get tools for a category
  const getToolsForCategory = (category: string): Set<string> => {
    switch (category) {
      case 'all':
        return new Set(availableTools.map((tool) => tool.id));
      case 'read-only':
        return new Set(['Read', 'LS', 'Grep', 'Glob']);
      case 'edit':
        return new Set(['Create', 'Edit']);
      case 'execute':
        return new Set(['Execute']);
      default:
        return new Set();
    }
  };

  const handleLocationSelect = () => {
    const locations: DroolLocation[] = [
      DroolLocation.Project,
      DroolLocation.Personal,
    ];
    setSelectedLocation(locations[selectedIndex]);
    setCurrentStep('method');
    setSelectedIndex(0);
  };

  const handleMethodSelect = () => {
    const methods: CreationMethod[] = ['generate', 'manual'];
    setSelectedMethod(methods[selectedIndex]);

    if (methods[selectedIndex] === 'generate') {
      setCurrentStep('describe');
      setIsInputting(true);
    } else {
      setCurrentStep('identifier');
      setIsInputting(true);
    }
    setSelectedIndex(0);
  };

  const handleGenerateFromDescription = async (rawDescription?: string) => {
    const effectiveDescription = (rawDescription ?? description).trim();
    setDescription(effectiveDescription);

    if (effectiveDescription.length < 10) {
      setError(t('createDrool.descriptionTooShort'));
      setCurrentStep('describe');
      setIsInputting(true);
      return;
    }

    setCurrentStep('generating');
    setIsInputting(false);
    setError(null);

    try {
      const registry = getTUIToolRegistry();
      const executor = registry.getExecutor(generateDroolCliTool.id);

      if (!executor) {
        throw new MetaError(t('createDrool.generateToolNotRegistered'));
      }

      // Execute the tool
      const abortController = new AbortController();
      const generator = executor.execute(
        { abortSignal: abortController.signal } as CliClientToolDependencies,
        { description: effectiveDescription, location: selectedLocation }
      );

      // Get the result
      let result: GenerateDroolResult | null = null;
      for await (const feedback of generator) {
        if (feedback.type === DraftToolFeedbackType.Result) {
          if ('isError' in feedback && feedback.isError) {
            throw new MetaError(
              ('userError' in feedback && feedback.userError) ||
                t('createDrool.generationFailed')
            );
          } else if ('value' in feedback && feedback.value) {
            result = feedback.value as GenerateDroolResult;
          }
        }
      }

      if (!result) {
        throw new MetaError(t('createDrool.noResultFromGeneration'));
      }

      // Populate form fields with generated values
      setIdentifier(result.identifier);
      setDescription(result.description);
      setSystemPrompt(result.systemPrompt);
      setUseAllTools(true);
      setSelectedTools(new Set());
      setSelectedModel('inherit');

      const modelIndex = MODEL_OPTIONS.indexOf('inherit');
      setSelectedIndex(modelIndex >= 0 ? modelIndex : 0);
      setCurrentStep('model');
    } catch (err) {
      logException(err, 'Failed to generate drool');
      const errorMessage =
        err instanceof Error ? err.message : t('createDrool.failedToGenerate');
      setError(errorMessage);
      setCurrentStep('describe');
      setIsInputting(true);
    }
  };

  const handleSaveDrool = async () => {
    try {
      const effectiveModel: DroolModel = selectedModel;

      let toolsToPersist: string[] | undefined;

      if (!useAllTools) {
        const selectedList = Array.from(selectedTools);
        if (selectedList.length === 0) {
          setError(t('createDrool.selectAtLeastOneTool'));
          return;
        }

        const normalization = DroolValidator.normalizeTools(
          selectedList,
          effectiveModel
        );

        if (normalization.errors.length > 0) {
          setError(normalization.errors.join(', '));
          return;
        }

        toolsToPersist = normalization.resolved;
      }

      const metadata: DroolMetadata = {
        name: identifier,
        description: description || undefined,
        model: effectiveModel,
        tools: useAllTools ? undefined : toolsToPersist,
      };

      // For validation, pass built-in list only; Validator handles customs internally
      const validation = DroolValidator.validateMetadata(
        metadata,
        builtinModels
      );

      if (!validation.valid) {
        setError(validation.errors.join(', '));
        return;
      }

      setError(null);

      const storage = new DroolStorageService();
      await storage.createDrool(
        identifier,
        systemPrompt,
        {
          description: description || undefined,
          model: effectiveModel,
          tools: useAllTools ? undefined : toolsToPersist,
        },
        selectedLocation
      );

      onComplete();
    } catch (err) {
      logException(err, 'Failed to save drool');
      setError(t('createDrool.failedToSave'));
    }
  };

  useKeypressHandler(
    (input, key) => {
      // When using ChatInput for text entry, defer all key handling to it
      if (isInputting) {
        return;
      }
      // Handle ESC key even when inputting
      if (key.escape) {
        // Handle normal ESC when not inputting
        if (currentStep === 'location') {
          onCancel();
        } else {
          // Go back to previous step
          switch (currentStep) {
            case 'method':
              setCurrentStep('location');
              break;
            case 'identifier':
            case 'describe':
              setCurrentStep('method');
              break;
            case 'systemPrompt':
              setCurrentStep('identifier');
              setIsInputting(true);
              break;
            case 'metaDescription':
              setCurrentStep('systemPrompt');
              setIsInputting(true);
              break;
            case 'model':
              setCurrentStep('metaDescription');
              setIsInputting(true);
              setSelectedIndex(0);
              break;
            case 'tools':
              setCurrentStep('metaDescription');
              setIsInputting(true);
              break;
            case 'review':
              setCurrentStep('tools');
              break;
            default:
              break;
          }
          setSelectedIndex(0);
        }
        return;
      }

      if (key.upArrow) {
        if (currentStep === 'toolsAdvanced') {
          const newIndex = Math.max(0, selectedIndex - 1);
          setSelectedIndex(newIndex);

          // Adjust scroll if needed
          if (newIndex < toolsScrollOffset) {
            setToolsScrollOffset(newIndex);
          }
        } else if (currentStep === 'tools') {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
        } else {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
        }
        return;
      }

      if (key.downArrow) {
        if (currentStep === 'toolsAdvanced') {
          const maxIndex = availableTools.length - 1;
          const newIndex = Math.min(maxIndex, selectedIndex + 1);
          setSelectedIndex(newIndex);

          // Adjust scroll if needed
          if (newIndex >= toolsScrollOffset + visibleToolsCount) {
            setToolsScrollOffset(newIndex - visibleToolsCount + 1);
          }
        } else if (currentStep === 'tools') {
          const maxIndex = 4; // 4 categories + Advanced Options = 5 items (index 0-4)
          setSelectedIndex((prev) => Math.min(maxIndex, prev + 1));
        } else {
          let maxIndex = 0;
          if (currentStep === 'location' || currentStep === 'method') {
            maxIndex = 1;
          } else if (currentStep === 'model') {
            maxIndex = MODEL_OPTIONS.length - 1;
          }
          setSelectedIndex((prev) => Math.min(maxIndex, prev + 1));
        }
        return;
      }

      // Handle space for toggling tool selection
      if (input === ' ') {
        if (currentStep === 'tools') {
          const toolCategories = ['all', 'read-only', 'edit', 'execute'];
          if (selectedIndex < toolCategories.length) {
            const category = toolCategories[selectedIndex];
            const newCategories = new Set(selectedCategories);

            if (category === 'all') {
              // If toggling "All", clear other categories or set only "All"
              if (newCategories.has('all')) {
                newCategories.clear();
              } else {
                newCategories.clear();
                newCategories.add('all');
              }
            } else {
              // If toggling other categories, remove "All" if present
              if (newCategories.has('all')) {
                newCategories.delete('all');
              }

              if (newCategories.has(category)) {
                newCategories.delete(category);
              } else {
                newCategories.add(category);
              }
            }

            setSelectedCategories(newCategories);
          }
          return;
        }
        if (currentStep === 'toolsAdvanced') {
          const tool = availableTools[selectedIndex];
          if (tool) {
            const newTools = new Set(selectedTools);
            if (newTools.has(tool.id)) {
              newTools.delete(tool.id);
            } else {
              newTools.add(tool.id);
            }
            setSelectedTools(newTools);
          }
          return;
        }
      }

      // Handle 'b' key to go back from advanced tools
      if ((input === 'b' || input === 'B') && currentStep === 'toolsAdvanced') {
        setCurrentStep('tools');
        setSelectedIndex(4); // Set to Advanced Options
        setShowAdvancedTools(false);
        // Clear categories when coming back from advanced
        setSelectedCategories(new Set());
        return;
      }

      if (key.return) {
        switch (currentStep) {
          case 'location':
            handleLocationSelect();
            break;
          case 'method':
            handleMethodSelect();
            break;
          case 'model': {
            const chosenModel = MODEL_OPTIONS[selectedIndex] ?? 'inherit';
            setSelectedModel(chosenModel);
            setCurrentStep('tools');
            setSelectedIndex(0);
            setToolsScrollOffset(0);
            break;
          }
          case 'tools': {
            const toolCategories = ['all', 'read-only', 'edit', 'execute'];
            if (selectedIndex < toolCategories.length) {
              // Pressing enter on a category - go to review
              // Combine all selected category tools
              if (selectedCategories.has('all')) {
                setUseAllTools(true);
                setSelectedTools(new Set());
              } else if (selectedCategories.size > 0) {
                setUseAllTools(false);
                const combinedTools = new Set<string>();
                for (const cat of selectedCategories) {
                  const categoryTools = getToolsForCategory(cat);
                  categoryTools.forEach((tool) => combinedTools.add(tool));
                }
                setSelectedTools(combinedTools);
              } else {
                // No categories selected, treat as no tools
                setUseAllTools(false);
                setSelectedTools(new Set());
              }
              setCurrentStep('review');
              setSelectedIndex(0);
            } else {
              // User selected Advanced Options
              setCurrentStep('toolsAdvanced');
              setSelectedIndex(0);
              setToolsScrollOffset(0);
              setShowAdvancedTools(true);
              setUseAllTools(false);
            }
            break;
          }
          case 'toolsAdvanced':
            setCurrentStep('review');
            setSelectedIndex(0);
            break;
          case 'review':
            if (key.return) {
              void handleSaveDrool();
            }
            break;
          default:
            break;
        }
      }
    },
    { isActive: true } // Always active to handle ESC key
  );

  const renderLocationStep = () => (
    <Box flexDirection="column">
      <Text bold>{t('createDrool.title')}</Text>
      <Text color={COLORS.text.muted}>{t('createDrool.chooseLocation')}</Text>
      <Box marginTop={1} />

      <Box flexDirection="column">
        <Text
          color={selectedIndex === 0 ? COLORS.primary : COLORS.text.primary}
        >
          {selectedIndex === 0 ? '> ' : '  '}
          {t('createDrool.projectOption')}
        </Text>
        <Text
          color={selectedIndex === 1 ? COLORS.primary : COLORS.text.primary}
        >
          {selectedIndex === 1 ? '> ' : '  '}
          {t('createDrool.personalOption')}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>
          {t('createDrool.navigationSelectCancel')}
        </Text>
      </Box>
    </Box>
  );

  const renderMethodStep = () => (
    <Box flexDirection="column">
      <Text bold>{t('createDrool.title')}</Text>
      <Text color={COLORS.text.muted}>{t('createDrool.methodTitle')}</Text>
      <Box marginTop={1} />

      <Box flexDirection="column">
        <Text
          color={selectedIndex === 0 ? COLORS.primary : COLORS.text.primary}
        >
          {selectedIndex === 0 ? '> ' : '  '}
          {t('createDrool.generateOption')}
        </Text>
        <Text
          color={selectedIndex === 1 ? COLORS.primary : COLORS.text.primary}
        >
          {selectedIndex === 1 ? '> ' : '  '}
          {t('createDrool.manualOption')}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>
          {t('createDrool.navigationSelectBack')}
        </Text>
      </Box>
    </Box>
  );

  const renderDescribeStep = () => (
    <Box flexDirection="column">
      <Text bold>{t('createDrool.title')}</Text>
      <Text color={COLORS.text.muted}>{t('createDrool.describeTitle')}</Text>
      <Text color={COLORS.text.muted}>{t('createDrool.describeHint')}</Text>
      <Box marginTop={1} />

      <ChatInput
        placeholder={t('createDrool.describePlaceholder')}
        isFocused={isInputting}
        disableSlashCommands
        disableFileSuggestions
        onSubmit={(text) => {
          const trimmed = text.trim();
          setIsInputting(false);
          void handleGenerateFromDescription(trimmed);
        }}
        onEscape={() => {
          setIsInputting(false);
          setCurrentStep('method');
          setDescription('');
          setSelectedIndex(0);
        }}
        width={80}
      />

      {error && (
        <Box marginTop={1}>
          <Text color={COLORS.error}>
            {t('createDrool.errorPrefix', { error })}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>{t('createDrool.generateHint')}</Text>
      </Box>
    </Box>
  );

  const renderGeneratingStep = () => (
    <Box flexDirection="column">
      <Text bold>{t('createDrool.title')}</Text>
      <Text color={COLORS.text.muted}>{t('createDrool.describeTitle')}</Text>
      <Text color={COLORS.text.muted}>{t('createDrool.describeHint')}</Text>
      <Box marginTop={1} />

      <Text color={COLORS.primary}>{t('createDrool.generating')}</Text>
    </Box>
  );

  const renderIdentifierStep = () => (
    <Box flexDirection="column">
      <Text bold>{t('createDrool.title')}</Text>
      <Text color={COLORS.text.muted}>{t('createDrool.identifierTitle')}</Text>
      <Box marginTop={1} />

      <Text>{t('createDrool.identifierPrompt')}</Text>
      <Box marginTop={1} />

      <Box flexDirection="column">
        <Text>{t('createDrool.identifierExamples')}</Text>
        <ChatInput
          placeholder={t('createDrool.identifierPlaceholder')}
          isFocused={isInputting}
          disableSlashCommands
          disableFileSuggestions
          onSubmit={(text) => {
            setIdentifier(text.trim());
            setIsInputting(false);
            setCurrentStep('systemPrompt');
            setIsInputting(true);
          }}
          onEscape={() => {
            setIsInputting(false);
            setCurrentStep('method');
            setIdentifier('');
            setSelectedIndex(0);
          }}
          width={60}
        />
      </Box>
    </Box>
  );

  const renderSystemPromptStep = () => (
    <Box flexDirection="column">
      <Text bold>{t('createDrool.title')}</Text>
      <Text color={COLORS.text.muted}>
        {t('createDrool.systemPromptTitle')}
      </Text>
      <Box marginTop={1} />

      <Text>{t('createDrool.systemPromptPrompt')}</Text>
      <Text color={COLORS.text.muted}>{t('createDrool.systemPromptHint')}</Text>
      <Box marginTop={1} />

      <ChatInput
        placeholder={t('createDrool.systemPromptPlaceholder')}
        isFocused={isInputting}
        disableSlashCommands
        disableFileSuggestions
        onSubmit={(text) => {
          setSystemPrompt(text);
          setIsInputting(false);
          setCurrentStep('metaDescription');
          setIsInputting(true);
          setSelectedIndex(0);
        }}
        onEscape={() => {
          setIsInputting(false);
          setCurrentStep('identifier');
          setSystemPrompt('');
        }}
        width={80}
      />

      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>{t('createDrool.continueHint')}</Text>
      </Box>
    </Box>
  );

  const renderMetaDescriptionStep = () => (
    <Box flexDirection="column">
      <Text bold>{t('createDrool.title')}</Text>
      <Text color={COLORS.text.muted}>
        {t('createDrool.descriptionOptional')}
      </Text>
      <Box marginTop={1} />

      <Text>{t('createDrool.descriptionPrompt')}</Text>
      <Box marginTop={1} />

      <ChatInput
        placeholder={t('createDrool.descriptionPlaceholder')}
        isFocused={isInputting}
        disableSlashCommands
        disableFileSuggestions
        onSubmit={(text) => {
          setDescription(text.trim());
          setIsInputting(false);
          const modelIndex = MODEL_OPTIONS.indexOf(selectedModel);
          setSelectedIndex(modelIndex >= 0 ? modelIndex : 0);
          setCurrentStep('model');
        }}
        onEscape={() => {
          setIsInputting(false);
          setCurrentStep('systemPrompt');
        }}
        width={80}
      />

      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>{t('createDrool.continueHint')}</Text>
      </Box>
    </Box>
  );

  const renderModelStep = () => (
    <Box flexDirection="column">
      <Text bold>{t('createDrool.title')}</Text>
      <Text color={COLORS.text.muted}>{t('createDrool.selectModel')}</Text>
      <Box marginTop={1} />

      <Box flexDirection="column">
        {MODEL_OPTIONS.map((model, index) => {
          const isCurrent = index === selectedIndex;
          const isChosen = model === selectedModel;
          const label = getModelDisplayName(model, t);
          const descriptionText = getModelDescription(model, t);

          return (
            <Box key={model} flexDirection="column">
              {index === 0 ? (
                <Text color={COLORS.text.muted}>
                  {t('createDrool.builtInModels')}
                </Text>
              ) : null}
              {index === firstCustomIndex && firstCustomIndex > 0 ? (
                <>
                  <Box marginTop={1} />
                  <Text color={COLORS.text.muted}>
                    {t('createDrool.customModels')}
                  </Text>
                </>
              ) : null}
              <Text color={isCurrent ? COLORS.primary : COLORS.text.primary}>
                {isCurrent ? '> ' : '  '}[{isChosen ? '✓' : ' '}] {label}
              </Text>
              {descriptionText ? (
                <Text color={COLORS.text.muted}>
                  {'    '}
                  {descriptionText}
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>
          {t('createDrool.navigationSelectBack')}
        </Text>
      </Box>
    </Box>
  );

  const renderToolsStep = () => {
    const toolCategories = [
      {
        id: 'all',
        label: t('createDrool.allToolsLabel'),
        description: t('createDrool.allToolsDescription'),
      },
      {
        id: 'read-only',
        label: t('createDrool.readOnlyTools'),
        description: t('createDrool.readOnlyDescription'),
      },
      {
        id: 'edit',
        label: t('createDrool.editToolsLabel'),
        description: t('createDrool.editDescription'),
      },
      {
        id: 'execute',
        label: t('createDrool.executeToolsLabel'),
        description: t('createDrool.executeDescription'),
      },
    ];

    // Check if "all" is selected
    const allSelected = selectedCategories.has('all');

    return (
      <Box flexDirection="column">
        <Text bold>{t('createDrool.title')}</Text>
        <Text color={COLORS.text.muted}>
          {t('createDrool.selectToolCategories')}
        </Text>
        <Box marginTop={1} />

        <Box flexDirection="column">
          {toolCategories.map((category, index) => {
            const isCurrent = index === selectedIndex && !showAdvancedTools;
            const isSelected = selectedCategories.has(category.id);
            // Disable other categories if "All tools" is selected
            const isDisabled = category.id !== 'all' && allSelected;

            return (
              <Box key={category.id} flexDirection="column" marginBottom={1}>
                <Text
                  color={
                    isDisabled
                      ? COLORS.text.muted
                      : isCurrent
                        ? COLORS.primary
                        : COLORS.text.primary
                  }
                >
                  {isCurrent ? '> ' : '  '}[{isSelected ? '✓' : ' '}]{' '}
                  {category.label}
                </Text>
                <Text color={COLORS.text.muted}>
                  {'      '}
                  {category.description}
                </Text>
              </Box>
            );
          })}

          <Box marginTop={1} />
          <Text
            color={
              selectedIndex === toolCategories.length && !showAdvancedTools
                ? COLORS.primary
                : COLORS.text.secondary
            }
          >
            {selectedIndex === toolCategories.length && !showAdvancedTools
              ? '> '
              : '  '}
            {t('createDrool.advancedOptions')}
          </Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text color={COLORS.text.muted}>
            {allSelected
              ? t('createDrool.allToolsSelectedHint')
              : selectedCategories.size === 0
                ? t('createDrool.noCategoriesSelected')
                : t('createDrool.categoriesSelectedCount', {
                    count: selectedCategories.size,
                    label:
                      selectedCategories.size === 1
                        ? t('createDrool.categoryWord_one')
                        : t('createDrool.categoryWord_other'),
                  })}
          </Text>
          <Text color={COLORS.text.muted}>
            {t('createDrool.toolsNavigateHint', {
              action:
                selectedIndex === toolCategories.length
                  ? t('createDrool.openAdvancedAction')
                  : t('createDrool.continueAction'),
            })}
          </Text>
        </Box>
      </Box>
    );
  };

  const renderToolsAdvancedStep = () => {
    const visibleTools = availableTools.slice(
      toolsScrollOffset,
      toolsScrollOffset + visibleToolsCount
    );

    // Find the index where MCP tools start
    const firstMcpIndex = availableTools.findIndex((tool) => tool.isMcp);
    const hasMcpTools = firstMcpIndex !== -1;

    return (
      <Box flexDirection="column">
        <Text bold>{t('createDrool.title')}</Text>
        <Text color={COLORS.text.muted}>
          {t('createDrool.selectIndividualTools')}
        </Text>
        <Box marginTop={1} />

        <Box flexDirection="column">
          {toolsScrollOffset > 0 && (
            <Text color={COLORS.text.muted}>
              {t('createDrool.moreToolsAbove')}
            </Text>
          )}

          {visibleTools.map((tool, index) => {
            const actualIndex = toolsScrollOffset + index;
            const isSelected = selectedTools.has(tool.id);
            const isCurrent = actualIndex === selectedIndex;

            // Show section headers
            const showBuiltInHeader = actualIndex === 0;
            const showMcpHeader = hasMcpTools && actualIndex === firstMcpIndex;

            return (
              <Box key={tool.id} flexDirection="column">
                {showBuiltInHeader && (
                  <Text color={COLORS.text.muted}>
                    {t('createDrool.builtInToolsHeader')}
                  </Text>
                )}
                {showMcpHeader && (
                  <>
                    <Box marginTop={1} />
                    <Text color={COLORS.text.muted}>
                      {t('createDrool.mcpToolsHeader')}
                    </Text>
                  </>
                )}
                <Text color={isCurrent ? COLORS.primary : COLORS.text.primary}>
                  {isCurrent ? '> ' : '  '}[{isSelected ? '✓' : ' '}]{' '}
                  {tool.name}
                  <Text color={COLORS.text.muted}> - {tool.description}</Text>
                </Text>
              </Box>
            );
          })}

          {toolsScrollOffset + visibleToolsCount < availableTools.length && (
            <Text color={COLORS.text.muted}>
              {t('createDrool.moreToolsBelow')}
            </Text>
          )}

          <Box marginTop={1} />
          <Text color={COLORS.text.muted}>
            {t('createDrool.toolsSelectedCount', {
              count: selectedTools.size,
              suffix: selectedTools.size !== 1 ? 's' : '',
            })}
          </Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text color={COLORS.text.muted}>
            {t('createDrool.advancedToolsHint')}
          </Text>
        </Box>
      </Box>
    );
  };

  const renderReviewStep = () => (
    <Box flexDirection="column">
      <Text bold>{t('createDrool.title')}</Text>
      <Text color={COLORS.text.muted}>{t('createDrool.confirmTitle')}</Text>
      <Box marginTop={1} />

      <Box flexDirection="column">
        <Text>
          {t('createDrool.nameLabel')} {identifier}
        </Text>
        <Text>
          {t('createDrool.locationLabel')}{' '}
          {selectedLocation === 'project'
            ? '.industry/drools/'
            : '~/.industry/drools/'}
        </Text>
        <Text>
          {t('createDrool.toolsLabel')}{' '}
          {useAllTools
            ? t('createDrool.allToolsLabel')
            : selectedCategories.size > 0 && !selectedCategories.has('all')
              ? t('createDrool.categorySummary', {
                  categories: Array.from(selectedCategories).join(', '),
                  count: selectedTools.size,
                })
              : t('createDrool.individualSummary', {
                  count: selectedTools.size,
                })}
        </Text>
        <Text>
          {t('createDrool.modelLabel')} {getModelDisplayName(selectedModel, t)}
        </Text>
        {getModelDescription(selectedModel, t) && (
          <Text color={COLORS.text.muted}>
            {'  '}
            {getModelDescription(selectedModel, t)}
          </Text>
        )}

        {description && (
          <>
            <Box marginTop={1} />
            <Text>{t('createDrool.descriptionLabel')}</Text>
            <Text color={COLORS.text.muted}> {description}</Text>
          </>
        )}

        <Box marginTop={1} />
        <Text>{t('createDrool.systemPromptLabel')}</Text>
        <Text color={COLORS.text.muted}> {systemPrompt.slice(0, 100)}...</Text>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color={COLORS.error}>
            {t('createDrool.errorPrefix', { error })}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>{t('createDrool.saveHint')}</Text>
      </Box>
    </Box>
  );

  return (
    <Box
      borderStyle="round"
      borderColor={COLORS.border}
      paddingX={2}
      paddingY={1}
    >
      {currentStep === 'location' && renderLocationStep()}
      {currentStep === 'method' && renderMethodStep()}
      {currentStep === 'describe' && renderDescribeStep()}
      {currentStep === 'generating' && renderGeneratingStep()}
      {currentStep === 'identifier' && renderIdentifierStep()}
      {currentStep === 'systemPrompt' && renderSystemPromptStep()}
      {currentStep === 'metaDescription' && renderMetaDescriptionStep()}
      {currentStep === 'model' && renderModelStep()}
      {currentStep === 'tools' && renderToolsStep()}
      {currentStep === 'toolsAdvanced' && renderToolsAdvancedStep()}
      {currentStep === 'review' && renderReviewStep()}
    </Box>
  );
}
