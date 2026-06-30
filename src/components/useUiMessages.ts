import { useMemo } from 'react';

import { TOOL_RESULT_PENDING_MARKER } from '@industry/common/sessionV2';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import { MessageRole, MessageType, ToolCallStatus } from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';
import { getI18n } from '@/i18n';
import type { ToolExecution } from '@/types/types';
import {
  SPEC_APPROVAL_COMMENT_ID_SUFFIX,
  SPEC_APPROVAL_NOTIFICATION_ID_SUFFIX,
} from '@/utils/constants';
import {
  buildSpecApprovalMessage,
  getSpecApprovalComment,
  parseExitSpecModeResult,
} from '@/utils/specApprovalMessage';

// Tools the model invokes for internal bookkeeping (model self-upgrade) that
// should not surface in any UI — main chat, Ctrl+O detailed transcript, or
// anchored transcript. `isVisibleToUser: false` only controls public listings.
const HIDDEN_FROM_UI_TOOL_NAMES = new Set(['UpgradeSessionModel']);

// Emitted as a sibling item after a completed ExitSpecMode tool because the
// tool's own row is committed to Ink <Static> before its result arrives
// (see `shouldRenderToolAsStatic` in messageUtils.tsx) — growing
// items.length is the only way to render the "Saved to: …" line.
function buildExitSpecModeApprovalNotifications(
  toolExec: ToolExecution
): HistoryMessage[] {
  if (toolExec.toolName !== 'ExitSpecMode') {
    return [];
  }
  if (toolExec.status !== ToolCallStatus.Completed || toolExec.isError) {
    return [];
  }
  const parsed = parseExitSpecModeResult(toolExec.result);
  if (!parsed) {
    return [];
  }
  const notifications: HistoryMessage[] = [];
  const approvalMessage = buildSpecApprovalMessage(parsed, getI18n().t);
  if (approvalMessage) {
    notifications.push({
      id: `${toolExec.id}${SPEC_APPROVAL_NOTIFICATION_ID_SUFFIX}`,
      role: MessageRole.System,
      content: approvalMessage,
      messageType: MessageType.SystemNotification,
      visibility: MessageVisibility.UserOnly,
    });
  }

  const approvalComment = getSpecApprovalComment(parsed);
  if (approvalComment) {
    notifications.push({
      id: `${toolExec.id}${SPEC_APPROVAL_COMMENT_ID_SUFFIX}`,
      role: MessageRole.System,
      content: approvalComment,
      messageType: MessageType.ApprovalComment,
      visibility: MessageVisibility.UserOnly,
    });
  }

  return notifications;
}

export function useUiMessages(
  messages: HistoryMessage[]
): Array<HistoryMessage | ToolExecution> {
  return useMemo(() => {
    const toolCalls = new Map<string, ToolExecution>();
    const processedToolResults = new Set<string>();

    // First pass: collect all tool calls and their results
    for (const msg of messages) {
      if (
        msg.messageType === MessageType.ToolCall &&
        msg.toolCallId &&
        msg.toolName
      ) {
        const existing = toolCalls.get(msg.toolCallId);
        // If this tool already has a result from a previous match, preserve it.
        // Duplicate ToolCall messages can appear when CREATE_MESSAGE upserts
        // trigger re-derivation; overwriting would lose the matched result.
        if (existing?.result !== undefined) {
          const progressUpdates =
            msg.progressUpdates && msg.progressUpdates.length > 0
              ? msg.progressUpdates
              : existing.progressUpdates;
          existing.status = msg.toolCallStatus || existing.status;
          if (progressUpdates && progressUpdates.length > 0) {
            existing.progressUpdates = progressUpdates;
            existing.lastUpdateAt = progressUpdates.at(-1)?.timestamp;
          }
        } else {
          const progressUpdates =
            msg.progressUpdates && msg.progressUpdates.length > 0
              ? msg.progressUpdates
              : (existing?.progressUpdates ?? []);
          const toolExecution: ToolExecution = {
            id: msg.toolCallId,
            toolName: msg.toolName,
            toolInput: msg.toolInput || {},
            status: msg.toolCallStatus || ToolCallStatus.Pending,
            startTime: msg.startTime,
            endTime: msg.endTime,
            progressUpdates,
            lastUpdateAt:
              existing?.lastUpdateAt ?? progressUpdates.at(-1)?.timestamp,
          };
          toolCalls.set(msg.toolCallId, toolExecution);
        }
      } else if (msg.messageType === MessageType.ToolResult) {
        // Find corresponding tool call and update result
        // First try to match by toolCallId if available, otherwise by toolName
        for (const [toolCallId, toolExec] of toolCalls) {
          // Match by toolCallId if available
          const isMatch = msg.toolCallId
            ? msg.toolCallId === toolCallId
            : toolExec.toolName === msg.toolName;

          if (isMatch && msg.content === TOOL_RESULT_PENDING_MARKER) {
            const progressUpdates =
              msg.progressUpdates && msg.progressUpdates.length > 0
                ? msg.progressUpdates
                : toolExec.progressUpdates;
            if (progressUpdates && progressUpdates.length > 0) {
              toolExec.progressUpdates = progressUpdates;
              toolExec.lastUpdateAt = progressUpdates.at(-1)?.timestamp;
              if (toolExec.status === ToolCallStatus.Pending) {
                toolExec.status = ToolCallStatus.Executing;
              }
            }
            break;
          }

          const isCompleted =
            (msg.toolCallStatus &&
              [ToolCallStatus.Completed, ToolCallStatus.Error].includes(
                msg.toolCallStatus
              )) ||
            msg?.content.length > 0;

          if (isMatch && isCompleted) {
            toolExec.result = msg.content;

            // Prefer the structured status coming from the ToolResult message
            if (msg.toolCallStatus !== undefined) {
              toolExec.status = msg.toolCallStatus;
            } else {
              // No explicit status on the result message — mark as completed
              toolExec.status = ToolCallStatus.Completed;
            }

            // Derive isError strictly from status (not from content heuristics)
            toolExec.isError = toolExec.status === ToolCallStatus.Error;

            // Preserve toolInput from the result message if it has more info
            if (msg.toolInput && Object.keys(msg.toolInput).length > 0) {
              toolExec.toolInput = msg.toolInput;
            }

            const progressUpdates =
              msg.progressUpdates && msg.progressUpdates.length > 0
                ? msg.progressUpdates
                : toolExec.progressUpdates;
            if (progressUpdates && progressUpdates.length > 0) {
              toolExec.progressUpdates = progressUpdates;
              toolExec.lastUpdateAt = progressUpdates.at(-1)?.timestamp;
            }

            processedToolResults.add(msg.toolCallId || '');
            break;
          }
        }
      }
    }

    // Second pass: build chronologically ordered array
    const grouped: Array<HistoryMessage | ToolExecution> = [];
    const addedToolIds = new Set<string>();

    for (const msg of messages) {
      if (
        msg.messageType === MessageType.ToolCall &&
        msg.toolCallId &&
        msg.toolName
      ) {
        // Only add tool execution if not already added
        if (!addedToolIds.has(msg.toolCallId)) {
          const toolExecution = toolCalls.get(msg.toolCallId);
          if (toolExecution) {
            addedToolIds.add(msg.toolCallId);
            if (!HIDDEN_FROM_UI_TOOL_NAMES.has(toolExecution.toolName)) {
              grouped.push(toolExecution);
              grouped.push(
                ...buildExitSpecModeApprovalNotifications(toolExecution)
              );
            }
          }
        }
      } else if (msg.messageType === MessageType.ToolResult) {
        // Skip tool results - they're already incorporated into tool executions
        continue;
      } else {
        // Add regular messages (user, assistant, system)
        grouped.push(msg);
      }
    }

    return grouped;
  }, [messages]);
}

export function filterMainChatMessages(
  messages: Array<HistoryMessage | ToolExecution>
): Array<HistoryMessage | ToolExecution> {
  return messages.filter((message) => {
    if (!('toolName' in message)) {
      return true;
    }
    // ToolSearch is a discovery/bookkeeping step; keep it out of the main chat
    // (it stays visible in the Ctrl+O detailed transcript).
    if (message.toolName === 'ToolSearch') {
      return false;
    }
    // The Connectors tool's `list_tools` action is the equivalent discovery
    // step. Hide it from the main chat too, but keep actual `call_tool`
    // invocations (including authentication-required prompts) visible.
    if (
      message.toolName === 'ConnectorSearch' &&
      message.toolInput?.action === 'list_tools'
    ) {
      return false;
    }
    return true;
  });
}
