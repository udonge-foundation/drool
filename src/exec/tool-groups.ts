import { ToolUIGroupId } from '@industry/drool-core/tools/enums';

import { getTUIToolRegistry } from '@/tools/registry';

export function buildToolGroups(): {
  readOnlyToolIds: string[];
  editToolIds: string[];
  executeToolIds: string[];
  allToolIds: string[];
} {
  const registry = getTUIToolRegistry();
  const tools = registry.getAllTools();

  const allToolIds = tools.map((t) => t.id);

  const editToolIds = tools
    .filter(
      (t) =>
        t.uiGroupId === ToolUIGroupId.EditFile ||
        t.uiGroupId === ToolUIGroupId.CreateFile
    )
    .map((t) => t.id);

  const executeToolIds = tools
    .filter((t) => t.uiGroupId === ToolUIGroupId.ExecuteTerminalCommand)
    .map((t) => t.id);

  const readOnlyToolIds = tools
    .filter(
      (t) => !editToolIds.includes(t.id) && !executeToolIds.includes(t.id)
    )
    .map((t) => t.id);

  return { readOnlyToolIds, editToolIds, executeToolIds, allToolIds };
}
