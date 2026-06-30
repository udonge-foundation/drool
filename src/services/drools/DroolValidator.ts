import {
  applyPatchCliTool,
  askUserTool,
  createCliTool,
  editCliTool,
  executeCliTool,
  exitSpecModeTool,
  fetchUrlTool,
  generateDroolCliTool,
  globSearchCliTool,
  grepSearchCliTool,
  lsCliTool,
  readCliTool,
  skillTool,
  slackPostFileTool,
  slackPostMessageTool,
  todoWriteTool,
  webSearchTool,
} from '@industry/drool-core/tools/definitions';
import {
  ModelID,
  ModelProvider,
  ReasoningEffort as LlmReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn } from '@industry/logging';

import { getTuiModelConfig } from '@/models/config';
import { listCustomModelIds } from '@/models/modelRegistry';
import { DroolConfig } from '@/services/drools/types';
import { getTUIToolRegistry } from '@/tools/registry';

import type {
  DroolMetadata,
  DroolModel,
  DroolToolConfig,
  DroolValidationResult,
} from '@industry/common/settings';
import type { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';

// Cache for available tools to avoid repeated registry access
// Note: MCP tools are NOT cached since they change dynamically
let cachedBuiltInTools: string[] | null = null;
let cachedToolCategories: Record<string, string[]> | null = null;

interface DroolToolSelectionOptions {
  tools?: DroolToolConfig;
  model?: DroolModel;
  mcpServers?: string[];
}

const toolId = (definition: { llmId?: string; id: string }): string =>
  definition.llmId || definition.id;

const TOOL_IDS = {
  Read: toolId(readCliTool),
  Grep: toolId(grepSearchCliTool),
  Glob: toolId(globSearchCliTool),
  Ls: toolId(lsCliTool),
  Create: toolId(createCliTool),
  Edit: toolId(editCliTool),
  Execute: toolId(executeCliTool),
  AskUser: toolId(askUserTool),
  WebSearch: toolId(webSearchTool),
  FetchUrl: toolId(fetchUrlTool),
  ApplyPatch: toolId(applyPatchCliTool),
  TodoWrite: toolId(todoWriteTool),
  Skill: toolId(skillTool),
  ExitSpecMode: toolId(exitSpecModeTool),
  GenerateDrool: toolId(generateDroolCliTool),
  slackPostFile: toolId(slackPostFileTool),
  slackPostMessage: toolId(slackPostMessageTool),
} as const;

const HIDDEN_TOOL_IDS = new Set<string>([TOOL_IDS.TodoWrite, TOOL_IDS.Skill]);
const FORBIDDEN_TOOL_IDS = new Set<string>([
  TOOL_IDS.ExitSpecMode,
  TOOL_IDS.GenerateDrool,
]);
const USER_VISIBLE_TOOL_IDS = [
  TOOL_IDS.Read,
  TOOL_IDS.Ls,
  TOOL_IDS.Grep,
  TOOL_IDS.Glob,
  TOOL_IDS.Create,
  TOOL_IDS.Edit,
  TOOL_IDS.Execute,
  TOOL_IDS.AskUser,
  TOOL_IDS.WebSearch,
  TOOL_IDS.FetchUrl,
];

/**
 * Get built-in tool names from the registry (cached)
 */
function getBuiltInTools(): string[] {
  if (cachedBuiltInTools) {
    return cachedBuiltInTools;
  }

  const registry = getTUIToolRegistry();
  const tools = registry.getAllTools();

  const unique = new Set<string>();
  for (const tool of tools) {
    const id = tool.llmId || tool.id;
    if (FORBIDDEN_TOOL_IDS.has(id) || tool.isMcpTool) {
      continue;
    }
    unique.add(id);
  }

  cachedBuiltInTools = Array.from(unique);
  return cachedBuiltInTools;
}

/**
 * Get MCP tool names from the registry.
 * NOT cached - MCP tools can change dynamically as servers connect/disconnect.
 */
function getMcpTools(): string[] {
  const registry = getTUIToolRegistry();
  const tools = registry.getAllTools();

  const mcpTools: string[] = [];
  for (const tool of tools) {
    if (tool.isMcpTool) {
      const id = tool.llmId || tool.id;
      mcpTools.push(id);
    }
  }

  return mcpTools;
}

function getMcpToolsForServers(serverNames: string[]): string[] {
  const selectedToolkits = new Set(
    serverNames.map((serverName) => `mcp:${serverName.trim().toLowerCase()}`)
  );
  const registry = getTUIToolRegistry();

  return registry
    .getAllTools()
    .filter(
      (tool) =>
        tool.isMcpTool &&
        typeof tool.toolkit === 'string' &&
        selectedToolkits.has(tool.toolkit.toLowerCase())
    )
    .map((tool) => tool.llmId || tool.id);
}

/**
 * Get all available tool names from the registry (built-in + MCP)
 */
function getAvailableTools(): string[] {
  return [...getBuiltInTools(), ...getMcpTools()];
}

/**
 * Tool categories for predefined tool configurations
 */
function getToolCategories(): Record<string, string[]> {
  if (cachedToolCategories) {
    return cachedToolCategories;
  }

  const allTools = getAvailableTools();

  // Define tool categories based on the UI requirements
  const readOnlyTools = [
    TOOL_IDS.Read,
    TOOL_IDS.Grep,
    TOOL_IDS.Glob,
    TOOL_IDS.Ls,
  ];
  const editTools = [TOOL_IDS.Edit, TOOL_IDS.Create, TOOL_IDS.ApplyPatch];
  const executeTools = [TOOL_IDS.Execute];
  const webTools = [TOOL_IDS.WebSearch, TOOL_IDS.FetchUrl];

  cachedToolCategories = {
    // Individual categories
    'read-only': allTools.filter((t) => readOnlyTools.includes(t)),
    edit: allTools.filter((t) => editTools.includes(t)),
    execute: allTools.filter((t) => executeTools.includes(t)),
    execution: allTools.filter((t) => executeTools.includes(t)), // Keep for backwards compatibility
    web: allTools.filter((t) => webTools.includes(t)),
    mcp: [], // MCP tools are dynamically registered
  };

  return cachedToolCategories;
}

/**
 * Validator for drool configurations
 */
export class DroolValidator {
  /**
   * Invalidate cached tool lists. Call this when MCP servers are reloaded.
   * Note: MCP tools are not cached, so this only affects built-in tools cache.
   */
  static invalidateToolCaches(): void {
    cachedBuiltInTools = null;
    cachedToolCategories = null;
  }

  /**
   * Validate a complete drool configuration.
   * Requires availableModels to validate against feature flags.
   *
   * @param config - The drool configuration to validate
   * @param availableModels - Models available based on feature flags (required)
   */
  static validate(
    config: DroolConfig,
    availableModels: ModelID[]
  ): DroolValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate metadata
    const metadataValidation = this.validateMetadata(
      config.metadata,
      availableModels
    );
    errors.push(...metadataValidation.errors);
    warnings.push(...metadataValidation.warnings);

    // Validate system prompt
    const promptValidation = this.validateSystemPrompt(config.systemPrompt);
    errors.push(...promptValidation.errors);
    warnings.push(...promptValidation.warnings);

    // Validate file path
    if (!config.filePath) {
      errors.push('File path is required');
    }

    // Validate location
    if (!['project', 'personal'].includes(config.location)) {
      errors.push(`Invalid location: ${config.location}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate drool metadata.
   * Requires availableModels to validate model selection against feature flags.
   *
   * @param metadata - The drool metadata to validate
   * @param availableModels - Models available based on feature flags (required)
   */
  static validateMetadata(
    metadata: DroolMetadata,
    availableModels: string[]
  ): DroolValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const effectiveModel: DroolModel = metadata.model ?? 'inherit';

    // Validate name (required)
    if (!metadata.name) {
      errors.push('Drool name is required');
    } else if (!this.isValidName(metadata.name)) {
      errors.push(
        'Drool name must be alphanumeric with hyphens or underscores only'
      );
    }

    // Validate description (optional but recommended)
    if (!metadata.description) {
      warnings.push(
        'Consider adding a description to help users understand when to use this drool'
      );
    } else if (metadata.description.length > 500) {
      warnings.push(
        'Description is very long (>500 chars). Consider being more concise'
      );
    }

    const modelValidation = this.validateModel(metadata.model, availableModels);
    errors.push(...modelValidation.errors);

    // Validate reasoning effort compatibility
    if (metadata.reasoningEffort !== undefined) {
      if (effectiveModel === 'inherit') {
        warnings.push(
          'Reasoning effort is ignored when inheriting the parent model'
        );
      } else if (
        !this.validateReasoningEffort(effectiveModel, metadata.reasoningEffort)
      ) {
        errors.push(
          `Reasoning effort "${metadata.reasoningEffort}" is not supported by model ${effectiveModel}`
        );
      }
    }

    // Validate tools
    const toolsValidation = this.validateTools(metadata.tools, effectiveModel);
    errors.push(...toolsValidation.errors);
    warnings.push(...toolsValidation.warnings);

    for (const error of errors) {
      logWarn('Drool validation error', { error });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate system prompt
   */
  static validateSystemPrompt(systemPrompt: string): DroolValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!systemPrompt || systemPrompt.trim().length === 0) {
      errors.push('System prompt cannot be empty');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate tools configuration
   */
  static validateTools(
    tools?: DroolToolConfig,
    model?: DroolModel
  ): DroolValidationResult {
    const normalization = this.normalizeTools(tools, model);

    if (tools && normalization.selected.length === 0) {
      normalization.errors.push(
        'Tools selection must include at least one valid tool'
      );
    }

    return {
      valid: normalization.errors.length === 0,
      errors: normalization.errors,
      warnings: normalization.warnings,
    };
  }

  static normalizeTools(
    tools?: DroolToolConfig,
    model?: DroolModel
  ): {
    resolved: string[];
    selected: string[];
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const available = getAvailableTools();
    const availableSet = new Set(available);

    let requested: string[] = [];

    if (tools === undefined) {
      warnings.push('No tools specified. Drool will have access to all tools');
      requested = [...available];
    } else if (typeof tools === 'string') {
      if (tools.includes(',')) {
        requested = tools
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
      } else if (tools === 'all') {
        errors.push(
          'The special value "all" is no longer supported. Omit the tools field to allow every tool.'
        );
      } else {
        const category = getToolCategories()[tools];
        if (category) {
          requested = [...category];
        } else {
          requested = [tools];
        }
      }
    } else if (Array.isArray(tools)) {
      requested = [];
      for (const entry of tools) {
        if (typeof entry !== 'string') {
          errors.push('Tool array must contain only strings');
          continue;
        }
        requested.push(entry);
      }
    } else {
      errors.push('Tools must be a string (category) or array of tool names');
    }

    const normalized: string[] = [];
    const seen = new Set<string>();
    const invalidTools = new Set<string>();
    const legacyToolAliases: Record<string, string> = {
      MultiEdit: TOOL_IDS.Edit,
    };

    for (const raw of requested) {
      const value = raw.trim();
      if (!value) {
        continue;
      }

      const effectiveValue = legacyToolAliases[value] ?? value;

      if (legacyToolAliases[value]) {
        warnings.push(
          `Tool ${value} is deprecated and will be replaced with ${effectiveValue}.`
        );
      }

      if (FORBIDDEN_TOOL_IDS.has(effectiveValue)) {
        errors.push(`Tool ${effectiveValue} cannot be enabled.`);
        continue;
      }

      if (!availableSet.has(effectiveValue)) {
        invalidTools.add(effectiveValue);
        continue;
      }

      if (seen.has(effectiveValue)) {
        warnings.push(`Duplicate tool specified: ${effectiveValue}`);
        continue;
      }

      seen.add(effectiveValue);
      normalized.push(effectiveValue);
    }

    if (invalidTools.size > 0) {
      errors.push(
        `Invalid tools: ${Array.from(invalidTools).join(', ')}. Available tools: ${available.join(', ')}`
      );
    }

    let resolved = [...normalized];
    const selected = [...normalized];

    if (resolved.includes(TOOL_IDS.Edit)) {
      const provider = this.getModelProvider(model);

      if (provider === ModelProvider.OPENAI) {
        resolved = resolved.filter((tool) => tool !== TOOL_IDS.Edit);
        if (!resolved.includes(TOOL_IDS.ApplyPatch)) {
          resolved.push(TOOL_IDS.ApplyPatch);
        }
      } else if (!provider) {
        warnings.push(
          'Model inherits from parent. Enabling Edit will include ApplyPatch to cover OpenAI providers.'
        );
        if (!resolved.includes(TOOL_IDS.ApplyPatch)) {
          resolved.push(TOOL_IDS.ApplyPatch);
        }
      }
    }

    const hiddenApplied = this.ensureHiddenTools(resolved);
    const finalSet = new Set(
      hiddenApplied.filter((tool) => !FORBIDDEN_TOOL_IDS.has(tool))
    );

    if (finalSet.has(TOOL_IDS.Execute) && !finalSet.has(TOOL_IDS.Read)) {
      warnings.push(
        "Execute without Read access may limit the drool's ability to verify command effects"
      );
    }

    return {
      resolved: Array.from(finalSet),
      selected,
      errors,
      warnings,
    };
  }

  /**
   * Check if a name is valid
   */
  private static isValidName(name: string): boolean {
    return /^[a-z0-9-_]+$/.test(name);
  }

  /**
   * Get expanded tool list from configuration
   */
  static expandTools({
    tools,
    model,
    mcpServers,
  }: DroolToolSelectionOptions): string[] {
    const resolved = this.normalizeTools(tools, model).resolved;
    if (mcpServers === undefined) {
      return resolved;
    }

    const mcpTools = new Set(getMcpTools());
    return Array.from(
      new Set([
        ...resolved.filter((tool) => !mcpTools.has(tool)),
        ...getMcpToolsForServers(mcpServers),
      ])
    );
  }

  static getUserSelectableToolIds(): string[] {
    return [...USER_VISIBLE_TOOL_IDS];
  }

  /**
   * Get MCP tool IDs that can be selected by users.
   * This is separate from getUserSelectableToolIds() since MCP tools change dynamically.
   */
  static getMcpToolIds(): string[] {
    return getMcpTools();
  }

  static deriveUserVisibleTools(
    resolvedTools: string[],
    model?: DroolModel
  ): string[] {
    const provider = this.getModelProvider(model);
    const resolvedSet = new Set(resolvedTools);
    const selection = new Set<string>();

    USER_VISIBLE_TOOL_IDS.forEach((visibleToolId) => {
      if (visibleToolId === TOOL_IDS.Edit) {
        const hasApplyPatch = resolvedSet.has(TOOL_IDS.ApplyPatch);
        const hasEdit = resolvedSet.has(TOOL_IDS.Edit);

        if (provider === ModelProvider.OPENAI) {
          if (hasApplyPatch) selection.add(TOOL_IDS.Edit);
        } else if (provider) {
          if (hasEdit) selection.add(TOOL_IDS.Edit);
        } else if (hasApplyPatch || hasEdit) {
          selection.add(TOOL_IDS.Edit);
        }
      } else if (resolvedSet.has(visibleToolId)) {
        selection.add(visibleToolId);
      }
    });

    // Also include MCP tools that are in the resolved list
    const mcpToolIds = getMcpTools();
    for (const mcpToolId of mcpToolIds) {
      if (resolvedSet.has(mcpToolId)) {
        selection.add(mcpToolId);
      }
    }

    return [...selection];
  }

  static resolveUserFacingTools({
    tools,
    model,
    mcpServers,
  }: DroolToolSelectionOptions): {
    isFullAccess: boolean;
    userTools: string[];
    resolved: string[];
    selected: string[];
    warnings: string[];
    errors: string[];
  } {
    const normalization = this.normalizeTools(tools, model);
    const resolved = this.expandTools({ tools, model, mcpServers });
    const userTools = this.deriveUserVisibleTools(resolved, model);

    // A server selection scopes MCP access even when built-in tools are unrestricted.
    // We check 'selected' rather than 'resolved' because resolved includes hidden tools.
    const isFullAccess: boolean =
      mcpServers === undefined &&
      (!tools || normalization.selected.length === 0);

    return {
      isFullAccess,
      userTools,
      resolved,
      selected: normalization.selected,
      warnings: normalization.warnings,
      errors: normalization.errors,
    };
  }

  /**
   * Suggest fixes for common validation errors
   */
  private static ensureHiddenTools(tools: string[]): string[] {
    const deduped = new Set(tools);
    for (const hidden of HIDDEN_TOOL_IDS) {
      deduped.add(hidden);
    }
    return Array.from(deduped);
  }

  /**
   * Validate a drool's configured model against the available model list.
   */
  static validateModel(
    model: DroolModel | undefined,
    availableModels: string[]
  ): DroolValidationResult {
    const errors: string[] = [];
    if (model && model !== 'inherit') {
      const isBuiltIn = availableModels.includes(model);
      const isCustom =
        !isBuiltIn &&
        typeof model === 'string' &&
        listCustomModelIds().includes(model);
      if (!isBuiltIn && !isCustom) {
        errors.push(
          `Invalid model: ${model}. Will fall back to 'inherit' unless changed. Available models: ${['inherit', ...availableModels].join(', ')}`
        );
      }
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  static getModelProvider(model?: DroolModel): ModelProvider | null {
    if (!model || model === 'inherit') {
      return null;
    }

    const cfg = getTuiModelConfig(model);
    return cfg?.modelProvider ?? null;
  }

  static validateReasoningEffort(
    model: DroolModel,
    effort: ReasoningEffort
  ): boolean {
    if (model === 'inherit') {
      return true;
    }

    const config = getTuiModelConfig(model);
    // Cast settings ReasoningEffort to llm ReasoningEffort for comparison
    return config.supportedReasoningEfforts.includes(
      effort as LlmReasoningEffort
    );
  }

  static getSuggestions(errors: string[]): string[] {
    const suggestions: string[] = [];

    for (const error of errors) {
      if (error.includes('Invalid model')) {
        suggestions.push(`Use a valid model`);
      } else if (error.includes('Invalid tools')) {
        suggestions.push(
          'Check tool names against the available tools list or use a category like "read-only"'
        );
      } else if (error.includes('name must be alphanumeric')) {
        suggestions.push(
          'Use only lowercase letters, numbers, hyphens, and underscores in the name'
        );
      }
    }

    return suggestions;
  }
}
