import {
  applyPatchCliTool,
  createCliTool,
  editCliTool,
  executeCliTool,
} from '@industry/drool-core/tools/definitions';
import { logWarn } from '@industry/logging';

import { getTUIToolRegistry } from '@/tools/registry';

type ToolUseItem = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

// Map LLM tool name -> registry tool id
export function buildLlmidToIdMap(): Record<string, string> {
  const registry = getTUIToolRegistry();
  const mapping: Record<string, string> = {};
  try {
    const tools = registry.getAllTools();

    for (const tool of tools) {
      const llmId = tool.llmId || tool.id;
      mapping[llmId] = tool.id;
    }
  } catch (error) {
    logWarn('[useToolExecution] Failed to build llmId to id mapping', {
      error,
    });
  }
  return mapping;
}

// File-modifying tools (IDs)
export const FILE_MOD_TOOL_IDS = new Set<string>([
  createCliTool.id,
  editCliTool.id,
  applyPatchCliTool.id,
]);

// Tools that must run sequentially (IDs)
const SEQUENTIAL_TOOL_IDS = new Set<string>([...FILE_MOD_TOOL_IDS]);

const EXECUTION_SEQUENTIAL_TOOL_IDS = new Set<string>([
  ...SEQUENTIAL_TOOL_IDS,
  executeCliTool.id,
]);

function segmentToolUses(
  toolUses: ToolUseItem[],
  sequentialToolIds: ReadonlySet<string>
) {
  const llmToId = buildLlmidToIdMap();
  const segments: Array<{
    parallel: ToolUseItem[];
    sequential: ToolUseItem | null;
  }> = [];

  let currentParallel: ToolUseItem[] = [];
  for (const tu of toolUses) {
    const toolId = llmToId[tu.name] || tu.name;
    if (sequentialToolIds.has(toolId)) {
      segments.push({ parallel: currentParallel, sequential: tu });
      currentParallel = [];
    } else {
      currentParallel.push(tu);
    }
  }
  if (currentParallel.length > 0) {
    segments.push({ parallel: currentParallel, sequential: null });
  }
  return segments;
}

// Compute segments of parallel vs sequential permission handling.
export function segmentToolUsesByConcurrency(toolUses: ToolUseItem[]) {
  return segmentToolUses(toolUses, SEQUENTIAL_TOOL_IDS);
}

export function segmentToolUsesForExecution(toolUses: ToolUseItem[]) {
  return segmentToolUses(toolUses, EXECUTION_SEQUENTIAL_TOOL_IDS);
}
