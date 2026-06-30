import '@/tools/tui';

import {
  askUserTool,
  executeCliTool,
  exitSpecModeTool,
  getAgentEffectivenessUsageTool,
  renderAgentEffectivenessReportTool,
  skillTool,
  slackPostFileTool,
  slackPostMessageTool,
  storeAgentReadinessReportRemoteTool,
  taskCliTool,
  toolSearchCliTool,
} from '@industry/drool-core/tools/definitions';
import { IndustryTool } from '@industry/drool-core/tools/types';

import type { ToolSelectionResult } from '@/commands/types';
import { buildToolGroups } from '@/exec/tool-groups';
import { getTUIToolRegistry } from '@/tools/registry';
import { ToolCategory } from '@/utils/toolCatalog/enums';

// Tools that are always hidden in exec mode (none currently)
const HIDDEN_TOOL_IDS = new Set<string>([]);

interface ToolCategorySets {
  readOnly: Set<string>;
  edit: Set<string>;
  execute: Set<string>;
}

function getCategorySets(): ToolCategorySets {
  const { readOnlyToolIds, editToolIds, executeToolIds } = buildToolGroups();
  return {
    readOnly: new Set(readOnlyToolIds),
    edit: new Set(editToolIds),
    execute: new Set(executeToolIds),
  };
}

function getToolCategoryFromSets(
  toolId: string,
  categorySets: ToolCategorySets
): ToolCategory {
  if (categorySets.readOnly.has(toolId)) return ToolCategory.Read;
  if (categorySets.edit.has(toolId)) return ToolCategory.Edit;
  if (categorySets.execute.has(toolId)) return ToolCategory.Execute;
  return ToolCategory.Other;
}

export function getRegisteredTools(): IndustryTool[] {
  const registry = getTUIToolRegistry();
  return registry.getAllTools();
}

export function getToolCategory(toolId: string): ToolCategory {
  return getToolCategoryFromSets(toolId, getCategorySets());
}

/**
 * Returns the set of tool IDs available in read-only exec mode (when --auto is not provided).
 * Includes all read-only tools plus Execute (for low-risk commands) and Skill.
 * Edit tools (Create, Edit, ApplyPatch), Task, and other privileged tools are excluded.
 */
export function getReadOnlyModeToolIds(): Set<string> {
  const { readOnly } = getCategorySets();
  const defaults = new Set(readOnly);
  defaults.add(executeCliTool.id);
  defaults.add(toolSearchCliTool.id);
  // Skill tool is always available (filtering happens in generateToolsFromRegistry if no skills exist)
  defaults.add(skillTool.id);
  // Exclude exitSpecMode from defaults - it's added conditionally when --use-spec is used
  defaults.delete(exitSpecModeTool.id);
  // Slack tools require explicit enabling via --enabled-tools flag
  defaults.delete(slackPostFileTool.id);
  defaults.delete(slackPostMessageTool.id);
  // Readiness tool is disabled by default, enabled via /readiness-report command
  defaults.delete(storeAgentReadinessReportRemoteTool.id);
  // Agent effectiveness usage tool is disabled by default, enabled via /agent-effectiveness-report command
  defaults.delete(getAgentEffectivenessUsageTool.id);
  defaults.delete(renderAgentEffectivenessReportTool.id);
  // AskUser requires askUserToolEnabled=true and interactive drool mode
  defaults.delete(askUserTool.id);
  // Task tool is disabled by default and should only be added if we are at an allowed depth
  defaults.delete(taskCliTool.id);
  return defaults;
}

export function buildIdentifierMap(
  tools: IndustryTool[]
): Map<string, IndustryTool> {
  const map = new Map<string, IndustryTool>();
  for (const tool of tools) {
    map.set(tool.id.toLowerCase(), tool);
    const llmId = tool.llmId ?? tool.id;
    map.set(llmId.toLowerCase(), tool);
  }
  return map;
}

export function isHiddenTool(toolId: string): boolean {
  return HIDDEN_TOOL_IDS.has(toolId);
}

export function buildToolCatalogEntries(selection: ToolSelectionResult): Array<{
  tool: IndustryTool;
  llmId: string;
  displayName: string;
  description: string;
  category: ToolCategory;
  defaultAllowed: boolean;
  enabledForModel: boolean;
  currentlyAllowed: boolean;
}> {
  const categorySets = getCategorySets();

  return selection.tools
    .map((tool) => {
      const llmId = tool.llmId ?? tool.id;
      return {
        tool,
        llmId,
        displayName: tool.displayName ?? llmId,
        description: tool.description ?? '',
        category: getToolCategoryFromSets(tool.id, categorySets),
        defaultAllowed: selection.readOnlyToolIds.has(tool.id),
        enabledForModel: selection.availability.get(tool.id) ?? false,
        currentlyAllowed: selection.allowed.has(tool.id),
      };
    })
    .filter((entry) => entry.enabledForModel && !isHiddenTool(entry.tool.id))
    .sort((a, b) => a.llmId.localeCompare(b.llmId));
}

export function buildToolCatalogResponse(
  selection: ToolSelectionResult
): Array<{
  id: string;
  llmId: string;
  displayName: string;
  description: string;
  category: ToolCategory;
  defaultAllowed: boolean;
  currentlyAllowed: boolean;
}> {
  return buildToolCatalogEntries(selection).map((entry) => ({
    id: entry.tool.id,
    llmId: entry.llmId,
    displayName: entry.displayName,
    description: entry.description,
    category: entry.category,
    defaultAllowed: entry.defaultAllowed,
    currentlyAllowed: entry.currentlyAllowed,
  }));
}
