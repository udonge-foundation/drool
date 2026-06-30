import {
  TOOL_LLM_IDS_WITH_PROPOSAL_CONFIRMATION,
  TOOL_LLM_ID_EXIT_SPEC_MODE,
} from '@industry/drool-sdk-ext/protocol/tools';

import { AgentStatusState, MessageRole, ToolCallStatus } from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';
import type { ToolExecution } from '@/types/types';

const proposalConfirmationToolNames = new Set<string>(
  TOOL_LLM_IDS_WITH_PROPOSAL_CONFIRMATION
);

function isToolExecution(
  item: HistoryMessage | ToolExecution
): item is ToolExecution {
  return 'toolName' in item && 'toolInput' in item;
}

function hasToolInvocationInCurrentTurn(
  uiMessages: Array<HistoryMessage | ToolExecution>,
  predicate: (item: ToolExecution) => boolean
): boolean {
  for (let i = uiMessages.length - 1; i >= 0; i -= 1) {
    const item = uiMessages[i];

    if (isToolExecution(item)) {
      if (predicate(item)) {
        return true;
      }
      continue;
    }

    if (item.role === MessageRole.User) {
      return false;
    }
  }

  return false;
}

function hasPendingToolInvocationInCurrentTurn(
  uiMessages: Array<HistoryMessage | ToolExecution>,
  predicate: (item: ToolExecution) => boolean = () => true
): boolean {
  return hasToolInvocationInCurrentTurn(
    uiMessages,
    (item) => item.status === ToolCallStatus.Pending && predicate(item)
  );
}

function canShowPendingToolStatus(sessionStatus: AgentStatusState): boolean {
  return !(
    sessionStatus === AgentStatusState.Idle ||
    sessionStatus === AgentStatusState.Compressing ||
    sessionStatus === AgentStatusState.ToolConfirmation ||
    sessionStatus === AgentStatusState.ExecutingTool
  );
}

export function shouldShowInvokingToolsStatus(
  sessionStatus: AgentStatusState,
  uiMessages: Array<HistoryMessage | ToolExecution>
): boolean {
  if (!canShowPendingToolStatus(sessionStatus)) {
    return false;
  }

  return hasPendingToolInvocationInCurrentTurn(
    uiMessages,
    (item) => !proposalConfirmationToolNames.has(item.toolName)
  );
}

export function shouldShowPendingSpecEditConfirmationStatus(
  sessionStatus: AgentStatusState,
  uiMessages: Array<HistoryMessage | ToolExecution>
): boolean {
  // Only report pending spec confirmation when the session is actually waiting
  // on the user for approval. During Streaming/Thinking the ExitSpecMode
  // pseudo-tool has been added to uiMessages but the permission request has
  // not been raised yet, so the banner must stay on generation status.
  if (sessionStatus !== AgentStatusState.ToolConfirmation) {
    return false;
  }

  return hasPendingToolInvocationInCurrentTurn(
    uiMessages,
    (item) => item.toolName === TOOL_LLM_ID_EXIT_SPEC_MODE
  );
}

export function shouldShowReviewingSpecChangesStatus(
  sessionStatus: AgentStatusState,
  uiMessages: Array<HistoryMessage | ToolExecution>
): boolean {
  if (sessionStatus !== AgentStatusState.ExecutingTool) {
    return false;
  }

  return hasToolInvocationInCurrentTurn(
    uiMessages,
    (item) =>
      item.toolName === TOOL_LLM_ID_EXIT_SPEC_MODE &&
      (item.status === ToolCallStatus.Pending ||
        item.status === ToolCallStatus.Executing)
  );
}
