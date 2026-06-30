import { MessageRole } from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';
import type {
  CollapsedToolGroup,
  GroupedItem,
  ToolExecution,
} from '@/types/types';

export const GROUPABLE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebSearch',
  'FetchUrl',
]);

function isToolExecution(item: HistoryMessage | ToolExecution): boolean {
  return 'toolName' in item && 'status' in item;
}

function isGroupableTool(item: HistoryMessage | ToolExecution): boolean {
  return (
    'toolName' in item &&
    typeof (item as ToolExecution).toolName === 'string' &&
    GROUPABLE_TOOLS.has((item as ToolExecution).toolName)
  );
}

function isSameToolType(
  a: HistoryMessage | ToolExecution,
  b: HistoryMessage | ToolExecution
): boolean {
  return (
    'toolName' in a &&
    'toolName' in b &&
    (a as ToolExecution).toolName === (b as ToolExecution).toolName
  );
}

export function isCollapsedGroup(
  item: GroupedItem
): item is CollapsedToolGroup {
  return 'kind' in item && item.kind === 'collapsed-tool-group';
}

/**
 * Groups same-type tool executions into collapsed groups, merging tools across
 * interleaved non-tool messages (e.g. assistant text between parallel batches).
 * Applies to: Read, Grep, Glob, LS, WebSearch, FetchUrl.
 *
 * When the same tool type appears on both sides of a text message, the tools
 * are merged into one group and the text messages are dropped from the output
 * (they remain visible in the Ctrl+O detailed transcript).
 */
export function groupConsecutiveReadTools(
  messages: Array<HistoryMessage | ToolExecution>,
  _compact = false
): GroupedItem[] {
  const result: GroupedItem[] = [];
  let i = 0;

  while (i < messages.length) {
    const item = messages[i];

    if (isGroupableTool(item)) {
      const group: ToolExecution[] = [item as ToolExecution];
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j];
        if (isGroupableTool(next) && isSameToolType(item, next)) {
          group.push(next as ToolExecution);
          j++;
        } else if (!isToolExecution(next)) {
          // Stop at user messages (turn boundaries)
          if (
            'role' in next &&
            (next as HistoryMessage).role === MessageRole.User
          ) {
            break;
          }
          // Non-tool message (text/thinking) — look past it for more same-type tools
          let k = j + 1;
          while (k < messages.length && !isToolExecution(messages[k])) {
            if (
              'role' in messages[k] &&
              (messages[k] as HistoryMessage).role === MessageRole.User
            ) {
              break;
            }
            k++;
          }
          if (
            k < messages.length &&
            isGroupableTool(messages[k]) &&
            isSameToolType(item, messages[k])
          ) {
            // Skip the text messages and continue collecting tools
            j = k;
          } else {
            break;
          }
        } else {
          break;
        }
      }

      const minGroupSize = 1;
      if (group.length >= minGroupSize) {
        result.push({
          kind: 'collapsed-tool-group',
          id: `tool-group-${group[0].id}`,
          toolName: (item as ToolExecution).toolName,
          tools: group,
        });
      } else {
        result.push(group[0]);
      }
      i = j;
    } else {
      result.push(item);
      i++;
    }
  }

  return result;
}
