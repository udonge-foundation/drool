import {
  askUserTool,
  exitSpecModeTool,
  getAgentEffectivenessUsageTool,
  slackPostFileTool,
  slackPostMessageTool,
  storeAgentReadinessReportRemoteTool,
  taskCliTool,
  toolSearchCliTool,
} from '@industry/drool-core/tools/definitions';
import { MetaError } from '@industry/logging/errors';

import { ExecCommandOptions, ToolSelectionResult } from '@/commands/types';
import { getDefaultModelId } from '@/models/availability';
import { getTuiModelConfig } from '@/models/config';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { getSessionService } from '@/services/SessionService';
import { evaluateToolEnabled } from '@/utils/toolAvailability';
import {
  buildIdentifierMap,
  getReadOnlyModeToolIds,
  getRegisteredTools,
  isHiddenTool,
} from '@/utils/toolCatalog';

import type { IndustryTool } from '@industry/drool-core/tools/types';

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

interface ResolveToolSelectionOptions {
  allowCombinedToolOverrides?: boolean;
  additiveToolIds?: string[];
  persistEnabledSpecialTools?: boolean;
}

/**
 * Model-specific file tool routing: maps tools that are disabled for certain
 * model providers to their equivalent alternative. Used to generate helpful
 * warning messages instead of confusing "not available" errors.
 *
 * OpenAI models use ApplyPatch; non-OpenAI models use Edit + Create.
 */
const FILE_TOOL_ALTERNATIVES: Partial<Record<string, string>> = {
  'edit-cli': 'ApplyPatch',
  'create-cli': 'ApplyPatch',
  'apply-patch-cli': 'Edit + Create',
};

function addToolWithDeferredLoader(
  target: Set<string>,
  tool: IndustryTool
): void {
  target.add(tool.id);
  if (tool.deferred) {
    target.add(toolSearchCliTool.id);
  }
}

function addToolToAllowedSets(
  allowed: Set<string>,
  baseAllowed: Set<string>,
  tool: IndustryTool
): void {
  addToolWithDeferredLoader(allowed, tool);
  addToolWithDeferredLoader(baseAllowed, tool);
}

function ensureDeferredLoaderForAllowedTools(
  tools: IndustryTool[],
  allowed: Set<string>,
  baseAllowed: Set<string>
): void {
  if (tools.some((tool) => allowed.has(tool.id) && tool.deferred)) {
    allowed.add(toolSearchCliTool.id);
    baseAllowed.add(toolSearchCliTool.id);
  }
}

/**
 * Get tool IDs organized by category for auto-approval
 */
export function resolveToolSelection(
  options: ExecCommandOptions,
  resolveOptions: ResolveToolSelectionOptions = {}
): ToolSelectionResult {
  if (
    !resolveOptions.allowCombinedToolOverrides &&
    (options.enabledTools?.length ?? 0) > 0 &&
    (options.disabledTools?.length ?? 0) > 0
  ) {
    throw new MetaError(
      'Invalid flags: --enabled-tools and --disabled-tools cannot be used together.'
    );
  }

  // Use the provided model, or fall back to the hardcoded default
  const activeModel = options.model ?? getDefaultModelId();

  const modelConfig = getTuiModelConfig(activeModel);

  const tools = getRegisteredTools();
  const identifierMap = buildIdentifierMap(tools);

  // Enable special tools if explicitly requested via --enabled-tools
  // These tools are disabled by default and need to be added to enabledToolIds
  const specialTools = [
    slackPostFileTool,
    slackPostMessageTool,
    storeAgentReadinessReportRemoteTool,
    getAgentEffectivenessUsageTool,
  ];
  if (resolveOptions.persistEnabledSpecialTools !== false) {
    for (const tool of specialTools) {
      if (
        options.enabledTools?.some(
          (id) => normalizeIdentifier(id) === normalizeIdentifier(tool.id)
        )
      ) {
        const currentEnabled = getSessionService().getEnabledToolIds() ?? [];
        if (!currentEnabled.includes(tool.id)) {
          getSessionService().setEnabledToolIds([...currentEnabled, tool.id]);
        }
      }
    }
  }

  const allToolIds = tools.map((tool) => tool.id);
  const readOnlyToolIds = getReadOnlyModeToolIds();

  const availability = new Map<string, boolean>();
  const isAvailableForModel = (tool: IndustryTool): boolean => {
    if (!availability.has(tool.id)) {
      const { enabled } = evaluateToolEnabled(tool, activeModel, {
        enabledToolIds: resolveOptions.additiveToolIds,
      });
      availability.set(tool.id, enabled);
    }
    return availability.get(tool.id) ?? false;
  };

  for (const tool of tools) {
    if (isHiddenTool(tool.id)) {
      readOnlyToolIds.delete(tool.id);
    }
  }

  // Tool availability is determined here, not by autonomyMode.
  // Without --auto, only read-only tools (+ Execute for low-risk commands) are available.
  // With --auto or --skip-permissions-unsafe, all tools are available and autonomyMode
  // separately governs what risk level the Execute tool auto-approves.
  const autoLevelBaseAllowed =
    options.skipPermissionsUnsafe || options.auto
      ? new Set(allToolIds)
      : new Set(readOnlyToolIds);

  for (const tool of tools) {
    isAvailableForModel(tool);
  }

  const enableRaw = options.enabledTools ?? [];
  const disableRaw = options.disabledTools ?? [];

  const unknownIdentifiers: string[] = [];
  const disallowedIdentifiers: string[] = [];
  const warningMessages = new Set<string>();
  const enableSet = new Set<string>();
  const disableSet = new Set<string>();

  const modelDisplay = modelConfig.displayName ?? activeModel;

  for (const raw of enableRaw) {
    const lookup = identifierMap.get(normalizeIdentifier(raw));
    if (!lookup) {
      unknownIdentifiers.push(raw);
      continue;
    }
    if (isHiddenTool(lookup.id)) {
      disallowedIdentifiers.push(raw);
      continue;
    }
    if (!isAvailableForModel(lookup)) {
      const llmId = lookup.llmId ?? lookup.id;
      const alternative = FILE_TOOL_ALTERNATIVES[lookup.id];
      const reason = alternative
        ? `${modelDisplay} uses ${alternative} instead`
        : `not supported by ${modelDisplay}`;
      warningMessages.add(`Tool "${llmId}" skipped (${reason}).`);
      continue;
    }
    addToolWithDeferredLoader(enableSet, lookup);
  }

  for (const raw of disableRaw) {
    const lookup = identifierMap.get(normalizeIdentifier(raw));
    if (!lookup) {
      unknownIdentifiers.push(raw);
      continue;
    }
    if (isHiddenTool(lookup.id)) {
      disallowedIdentifiers.push(raw);
      continue;
    }
    disableSet.add(lookup.id);
  }

  if (unknownIdentifiers.length > 0) {
    throw new MetaError('Unknown tool identifier(s)', {
      matches: unknownIdentifiers,
    });
  }

  if (disallowedIdentifiers.length > 0) {
    throw new MetaError('Tool not available in exec mode', {
      matches: disallowedIdentifiers,
    });
  }

  const hasEnableOverrides = enableSet.size > 0;
  const baseAllowed = hasEnableOverrides
    ? new Set<string>(enableSet)
    : autoLevelBaseAllowed;

  const allowed = new Set<string>(baseAllowed);
  for (const id of enableSet) {
    allowed.add(id);
  }
  for (const id of disableSet) {
    allowed.delete(id);
  }

  // Additive opt-ins from `additiveToolIds` (typically session state from the
  // protocol layer). Unlike the restrictive `options.enabledTools`, these ADD
  // to `allowed` without collapsing `baseAllowed`. Invalid entries are skipped
  // silently because this is persisted state, not typed input.
  for (const raw of resolveOptions.additiveToolIds ?? []) {
    const lookup = identifierMap.get(normalizeIdentifier(raw));
    if (!lookup) continue;
    if (isHiddenTool(lookup.id)) continue;
    if (!isAvailableForModel(lookup)) continue;
    if (disableSet.has(lookup.id)) continue;
    addToolWithDeferredLoader(allowed, lookup);
  }

  // Special handling for ExitSpecMode tool when --use-spec is provided
  if (options.useSpec || options.specModel) {
    addToolToAllowedSets(allowed, baseAllowed, exitSpecModeTool);
    if (!disableSet.has(askUserTool.id) && isAvailableForModel(askUserTool)) {
      addToolToAllowedSets(allowed, baseAllowed, askUserTool);
    }
  }

  for (const tool of tools) {
    if (isHiddenTool(tool.id)) {
      baseAllowed.delete(tool.id);
      allowed.delete(tool.id);
    }
  }

  // Task tool is opt-in: enable only for --auto high or --skip-permissions-unsafe
  // at depth 0 (prevents subagent recursion). At depth > 0, always remove it
  // even if the "all tools" path added it. Respect explicit --disabled-tools override.
  const currentDepth = options.depth ?? getExecRuntimeConfig().getDepth();
  if (
    (options.auto === 'high' || options.skipPermissionsUnsafe) &&
    currentDepth === 0 &&
    !disableSet.has(taskCliTool.id)
  ) {
    addToolToAllowedSets(allowed, baseAllowed, taskCliTool);
  } else if (!enableSet.has(taskCliTool.id)) {
    allowed.delete(taskCliTool.id);
    baseAllowed.delete(taskCliTool.id);
  }

  ensureDeferredLoaderForAllowedTools(tools, allowed, baseAllowed);

  return {
    tools,
    allowed,
    baseAllowed,
    readOnlyToolIds,
    availability,
    warnings: Array.from(warningMessages),
    model: activeModel,
  };
}
