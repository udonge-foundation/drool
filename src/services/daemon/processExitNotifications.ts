import {
  TOOL_EXECUTION_CANCELLED_BY_USER_RESULT_TEXT,
  TOOL_EXECUTION_INTERRUPTED_RESULT_TEXT,
  TOOL_RESULT_CANCELLED_PREFIX,
  TOOL_RESULT_ERROR_PREFIX,
} from '@industry/common/sessionV2';
import {
  AgentTurnCompletionReason,
  DroolErrorType,
  SessionNotificationType,
} from '@industry/drool-sdk-ext/protocol/drool';

import type { DaemonSessionNotification } from '@industry/common/daemon';

type DaemonNotification = DaemonSessionNotification['params']['notification'];

export function isProcessExitNotification(
  notification: DaemonNotification
): boolean {
  return (
    notification.type === SessionNotificationType.ERROR &&
    notification.errorType === DroolErrorType.PROCESS_EXIT_ERROR
  );
}

const EARLY_EXIT_PERMISSION_PATTERN =
  /exec ended early: insufficient permission/i;

export function getCompletionReasonFromFinalOutput(
  finalOutput: string
): AgentTurnCompletionReason {
  const normalized = finalOutput.trimStart();
  if (EARLY_EXIT_PERMISSION_PATTERN.test(normalized)) {
    return AgentTurnCompletionReason.PermissionRejected;
  }
  if (
    normalized.includes(TOOL_EXECUTION_CANCELLED_BY_USER_RESULT_TEXT) ||
    normalized.includes(TOOL_EXECUTION_INTERRUPTED_RESULT_TEXT)
  ) {
    return AgentTurnCompletionReason.Cancelled;
  }
  if (normalized.includes(TOOL_RESULT_CANCELLED_PREFIX)) {
    return AgentTurnCompletionReason.Error;
  }
  return normalized.startsWith(TOOL_RESULT_ERROR_PREFIX)
    ? AgentTurnCompletionReason.Error
    : AgentTurnCompletionReason.Completed;
}
