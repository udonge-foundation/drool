import { logWarn } from '@industry/logging';

import {
  HookExecutionStatus,
  MessageRole,
  ToolCallStatus,
} from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';
import {
  DroolMessageEvent,
  LocallyPersistedTextBlock,
  LocallyPersistedToolUseBlock,
  LocallyPersistedToolResultBlock,
} from '@/services/types';
import type { ToolExecution } from '@/types/types';
import { UI_MESSAGE_RENDER_LIMIT } from '@/utils/constants';
import { GROUPABLE_TOOLS } from '@/utils/toolGrouping';

let lastLoggedStuckIndex: number | null = null;

interface StaticBoundaryOptions {
  isAgentRunning?: boolean;
  staticToolIds?: ReadonlySet<string>;
}

function shouldRenderToolAsStatic(
  toolExec: ToolExecution,
  staticToolIds?: ReadonlySet<string>
): boolean {
  return (
    staticToolIds?.has(toolExec.id) === true ||
    (toolExec.toolName === 'ExitSpecMode' &&
      (toolExec.status === ToolCallStatus.Completed ||
        toolExec.status === ToolCallStatus.Error) &&
      toolExec.toolInput &&
      typeof toolExec.toolInput.plan === 'string' &&
      toolExec.toolInput.plan.length > 0) ||
    (toolExec.toolName === 'ProposeMission' &&
      (toolExec.status === ToolCallStatus.Completed ||
        toolExec.status === ToolCallStatus.Error) &&
      toolExec.toolInput &&
      typeof toolExec.toolInput.proposal === 'string' &&
      toolExec.toolInput.proposal.length > 0)
  );
}

function findTrailingAssistantOutputStart(
  messages: Array<HistoryMessage | ToolExecution>
): number | null {
  let start = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i];
    if ('toolName' in item && 'status' in item) {
      break;
    }

    if ((item as HistoryMessage).role !== MessageRole.Assistant) {
      break;
    }

    start = i;
  }

  return start < messages.length ? start : null;
}

function findMutableToolBoundaryInLatestTurn(
  messages: Array<HistoryMessage | ToolExecution>,
  staticToolIds?: ReadonlySet<string>
): number | null {
  let latestUserIndex = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i];
    if (
      !('toolName' in item && 'status' in item) &&
      (item as HistoryMessage).role === MessageRole.User
    ) {
      latestUserIndex = i;
      break;
    }
  }

  if (latestUserIndex === -1) {
    return null;
  }

  for (let i = latestUserIndex + 1; i < messages.length; i++) {
    const item = messages[i];

    if ('toolName' in item && 'status' in item) {
      const toolExec = item as ToolExecution;
      if (
        !shouldRenderToolAsStatic(toolExec, staticToolIds) &&
        (toolExec.status === ToolCallStatus.Pending ||
          toolExec.status === ToolCallStatus.Executing)
      ) {
        return i;
      }
    } else {
      const msg = item as HistoryMessage;
      if (
        msg.toolCallStatus &&
        msg.toolCallStatus !== ToolCallStatus.Completed &&
        msg.toolCallStatus !== ToolCallStatus.Error
      ) {
        return i;
      }
    }
  }

  return null;
}

/**
 * Finds the index where static messages end and dynamic messages begin.
 * Static messages are those that are complete and won't change.
 * Dynamic messages are still pending, executing, or streaming.
 */
export function findStaticBoundary(
  messages: Array<HistoryMessage | ToolExecution>,
  options?: StaticBoundaryOptions
): number {
  let originalStaticBoundary = messages.length;
  for (let i = 0; i < messages.length; i++) {
    const item = messages[i];

    if ('toolName' in item && 'status' in item) {
      const toolExec = item as ToolExecution;

      if (shouldRenderToolAsStatic(toolExec, options?.staticToolIds)) {
        continue;
      }

      if (
        toolExec.status === ToolCallStatus.Pending ||
        toolExec.status === ToolCallStatus.Executing
      ) {
        originalStaticBoundary = i;
        break;
      }
    } else {
      const msg = item as HistoryMessage;

      if (msg.hookStatus === HookExecutionStatus.Executing) {
        originalStaticBoundary = i;
        break;
      }

      if (
        msg.toolCallStatus &&
        msg.toolCallStatus !== ToolCallStatus.Completed &&
        msg.toolCallStatus !== ToolCallStatus.Error
      ) {
        originalStaticBoundary = i;
        break;
      }
    }
  }

  let searchLimit = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i];
    const isToolExecution = 'toolName' in item && 'status' in item;

    if (
      !isToolExecution ||
      shouldRenderToolAsStatic(item as ToolExecution, options?.staticToolIds)
    ) {
      searchLimit = i + 1;
      break;
    }
  }

  let newStaticBoundary = messages.length;
  for (let i = 0; i < messages.length; i++) {
    const item = messages[i];
    if (!('toolName' in item && 'status' in item)) {
      const msg = item as HistoryMessage;
      if (msg.hookStatus === HookExecutionStatus.Executing) {
        newStaticBoundary = i;
        break;
      }
    }
  }

  if (newStaticBoundary === messages.length) {
    for (let i = searchLimit; i < messages.length; i++) {
      const item = messages[i];

      if ('toolName' in item && 'status' in item) {
        const toolExec = item as ToolExecution;

        if (
          toolExec.status === ToolCallStatus.Pending ||
          toolExec.status === ToolCallStatus.Executing
        ) {
          newStaticBoundary = i;
          break;
        }
      } else {
        const msg = item as HistoryMessage;
        if (msg.hookStatus === HookExecutionStatus.Executing) {
          newStaticBoundary = i;
          break;
        }
      }
    }
  }

  if (options?.isAgentRunning === true) {
    const activeTurnMutableToolBoundary = findMutableToolBoundaryInLatestTurn(
      messages,
      options.staticToolIds
    );
    if (
      activeTurnMutableToolBoundary !== null &&
      activeTurnMutableToolBoundary < newStaticBoundary
    ) {
      newStaticBoundary = activeTurnMutableToolBoundary;
    }
  }

  // Keep groupable tool groups together in the dynamic region.
  if (newStaticBoundary > 0 && newStaticBoundary < messages.length) {
    const boundaryItem = messages[newStaticBoundary];
    if (
      'toolName' in boundaryItem &&
      GROUPABLE_TOOLS.has((boundaryItem as ToolExecution).toolName)
    ) {
      const toolName = (boundaryItem as ToolExecution).toolName;
      let groupStart = newStaticBoundary;
      while (groupStart > 0) {
        const prev = messages[groupStart - 1];
        if (
          'toolName' in prev &&
          (prev as ToolExecution).toolName === toolName
        ) {
          groupStart--;
        } else if (!('toolName' in prev && 'status' in prev)) {
          if ((prev as HistoryMessage).role === MessageRole.User) break;
          let k = groupStart - 2;
          while (
            k >= 0 &&
            !('toolName' in messages[k] && 'status' in messages[k])
          ) {
            if ((messages[k] as HistoryMessage).role === MessageRole.User)
              break;
            k--;
          }
          if (
            k >= 0 &&
            'toolName' in messages[k] &&
            (messages[k] as ToolExecution).toolName === toolName
          ) {
            groupStart = k + 1;
          } else {
            break;
          }
        } else {
          break;
        }
      }
      if (groupStart < newStaticBoundary) {
        newStaticBoundary = groupStart;
      }
    }
  }

  if (
    options?.isAgentRunning === true &&
    newStaticBoundary === messages.length &&
    newStaticBoundary > 0
  ) {
    const trailingAssistantStart = findTrailingAssistantOutputStart(messages);
    if (trailingAssistantStart !== null) {
      newStaticBoundary = trailingAssistantStart;
    }
  }

  if (
    options?.isAgentRunning === true &&
    newStaticBoundary === messages.length &&
    newStaticBoundary > 0
  ) {
    let tailIdx = newStaticBoundary - 1;

    while (tailIdx >= 0) {
      const m = messages[tailIdx];
      if ('toolName' in m && 'status' in m) break;
      if ((m as HistoryMessage).role === MessageRole.User) {
        tailIdx = -1;
        break;
      }
      tailIdx--;
    }

    if (
      tailIdx >= 0 &&
      'toolName' in messages[tailIdx] &&
      GROUPABLE_TOOLS.has((messages[tailIdx] as ToolExecution).toolName)
    ) {
      const toolName = (messages[tailIdx] as ToolExecution).toolName;

      let sealedByDifferentTool = false;
      for (let s = tailIdx + 1; s < messages.length; s++) {
        const msg = messages[s];
        if (
          'toolName' in msg &&
          'status' in msg &&
          (msg as ToolExecution).toolName !== toolName
        ) {
          sealedByDifferentTool = true;
          break;
        }
      }

      if (!sealedByDifferentTool) {
        let groupStart = tailIdx;

        while (groupStart > 0) {
          const prev = messages[groupStart - 1];
          if (
            'toolName' in prev &&
            (prev as ToolExecution).toolName === toolName
          ) {
            groupStart--;
          } else if (!('toolName' in prev && 'status' in prev)) {
            if ((prev as HistoryMessage).role === MessageRole.User) break;
            let k = groupStart - 2;
            while (
              k >= 0 &&
              !('toolName' in messages[k] && 'status' in messages[k])
            ) {
              if ((messages[k] as HistoryMessage).role === MessageRole.User)
                break;
              k--;
            }
            if (
              k >= 0 &&
              'toolName' in messages[k] &&
              (messages[k] as ToolExecution).toolName === toolName
            ) {
              groupStart = k + 1;
            } else {
              break;
            }
          } else {
            break;
          }
        }

        if (groupStart < newStaticBoundary) {
          newStaticBoundary = groupStart;
        }
      }
    }
  }

  if (
    originalStaticBoundary < newStaticBoundary &&
    originalStaticBoundary < messages.length &&
    originalStaticBoundary !== lastLoggedStuckIndex
  ) {
    lastLoggedStuckIndex = originalStaticBoundary;

    const firstStuckItem = messages[originalStaticBoundary];
    let firstStuckDetails;

    if ('toolName' in firstStuckItem && 'status' in firstStuckItem) {
      const tool = firstStuckItem as ToolExecution;
      firstStuckDetails = {
        index: originalStaticBoundary,
        type: 'ToolExecution',
        details: `${tool.toolName} (${tool.status})`,
      };
    } else {
      const msg = firstStuckItem as HistoryMessage;
      firstStuckDetails = {
        index: originalStaticBoundary,
        type: 'HistoryMessage',
        details: `${msg.role}${msg.toolCallStatus ? ` (toolCallStatus: ${msg.toolCallStatus})` : ''}`,
      };
    }

    logWarn('Static boundary mismatch - potential stuck pending messages', {
      index: newStaticBoundary,
      totalMessages: messages.length,
      // eslint-disable-next-line industry/no-nested-log-metadata -- static-boundary mismatch debug snapshot (boundaries + first stuck item) consumed as a unit
      value: {
        originalStaticBoundary,
        searchLimit,
        firstStuckItem: firstStuckDetails,
      },
    });
  } else if (
    originalStaticBoundary >= newStaticBoundary ||
    originalStaticBoundary >= messages.length
  ) {
    lastLoggedStuckIndex = null;
  }

  return newStaticBoundary;
}

/**
 * Finds the first user message ID within the last N UI messages.
 * This is used to limit Static rendering during compaction.
 *
 * If no user message is found within the last N messages, extends the search
 * backwards to find the nearest user message (to avoid orphaned assistant/tool messages).
 */
export function findFirstUserMessageInLastN(
  messages: Array<HistoryMessage | ToolExecution>,
  lastN: number = UI_MESSAGE_RENDER_LIMIT
): string | undefined {
  if (messages.length <= lastN) {
    return undefined;
  }

  const cutoffIndex = messages.length - lastN;

  for (let i = cutoffIndex; i < messages.length; i++) {
    const item = messages[i];
    if (!('toolName' in item)) {
      const msg = item as HistoryMessage;
      if (msg.role === MessageRole.User) {
        return msg.id;
      }
    }
  }

  for (let i = cutoffIndex - 1; i >= 0; i--) {
    const item = messages[i];
    if (!('toolName' in item)) {
      const msg = item as HistoryMessage;
      if (msg.role === MessageRole.User) {
        return msg.id;
      }
    }
  }

  return undefined;
}

/**
 * Calculates session metrics from message events.
 * Converts raw message events to UI messages format and calculates static boundary.
 */
export function calculateSessionMetrics(
  messageEvents: DroolMessageEvent[]
): { staticBoundaryIndex: number; totalMessages: number } | null {
  try {
    const uiMessages: Array<HistoryMessage | ToolExecution> = [];
    const pendingToolCalls = new Map<string, ToolExecution>();

    for (const event of messageEvents) {
      const message = event.message;
      let textContent = '';

      if (typeof message.content === 'string') {
        textContent = message.content;
      } else if (Array.isArray(message.content)) {
        textContent = message.content
          .filter((block) => block.type === 'text')
          .map((block) => (block as LocallyPersistedTextBlock).text || '')
          .join('\n');

        if (message.role === MessageRole.Assistant) {
          const toolUseBlocks = message.content.filter(
            (block) => block.type === 'tool_use'
          );
          for (const block of toolUseBlocks) {
            const toolBlock = block as LocallyPersistedToolUseBlock;
            const toolExec: ToolExecution = {
              id: toolBlock.id,
              toolName: toolBlock.name,
              toolInput: toolBlock.input || {},
              status: ToolCallStatus.Completed,
            };
            pendingToolCalls.set(toolBlock.id, toolExec);
            uiMessages.push(toolExec);
          }
        }

        const toolResultBlocks = message.content.filter(
          (block) => block.type === 'tool_result'
        );
        for (const block of toolResultBlocks) {
          const resultBlock = block as LocallyPersistedToolResultBlock;
          const toolExec = pendingToolCalls.get(resultBlock.tool_use_id);
          if (toolExec) {
            if (typeof resultBlock.content === 'string') {
              toolExec.result = resultBlock.content;
            } else if (Array.isArray(resultBlock.content)) {
              toolExec.result = resultBlock.content
                .filter((b) => b.type === 'text')
                .map((b) => (b as LocallyPersistedTextBlock).text || '')
                .join('\n');
            }
            toolExec.isError = resultBlock.is_error || false;
          }
        }
      }

      if (textContent || message.role === MessageRole.User) {
        const historyMessage: HistoryMessage = {
          id: event.id,
          role: message.role,
          content: textContent,
          visibility: message.visibility,
        };
        uiMessages.push(historyMessage);
      }
    }

    const staticBoundaryIndex = findStaticBoundary(uiMessages);
    const totalMessages = uiMessages.length;

    return { staticBoundaryIndex, totalMessages };
  } catch {
    logWarn('Failed to calculate session metrics');
    return null;
  }
}
