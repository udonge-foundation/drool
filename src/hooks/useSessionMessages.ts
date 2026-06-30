import { useMemo } from 'react';

import { useSessionDisplayMessages } from '@industry/daemon-client/messages';
import {
  isHookExecutionData,
  type HookExecutionData,
} from '@industry/daemon-client/session';

import {
  HookEventName,
  HookExecutionStatus,
  MessageRole,
  MessageType,
} from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { deriveCliMessages } from '@/utils/deriveCliMessages';

import type {
  IndustryDroolMessage,
  MessageVisibility,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

const EMPTY_MESSAGES: HistoryMessage[] = [];

function hookExecutionToHistoryMessage(
  hook: HookExecutionData
): HistoryMessage {
  return {
    id: hook.hookId,
    role: MessageRole.System,
    content: `Hook execution: ${hook.hookEventName}`,
    messageType: MessageType.HookExecution,
    visibility: 'user_only' as MessageVisibility,
    hookEventName: hook.hookEventName as HookEventName,
    hookMatcher: hook.hookMatcher,
    hookCommands: hook.hookCommands,
    hookStatus:
      hook.hookStatus === 'executing'
        ? HookExecutionStatus.Executing
        : hook.hookStatus === 'error'
          ? HookExecutionStatus.Error
          : HookExecutionStatus.Completed,
    hookResults: hook.hookResults,
    isParallelExecution: hook.isParallelExecution,
    parallelGroupId: hook.parallelGroupId,
    hookToolCallId: hook.hookToolCallId,
  };
}

/**
 * Hook that reads centralized protocol display messages from the active
 * session's SSM and derives HistoryMessage[] suitable for the CLI MessageList.
 *
 * @param sessionId - The active session ID, or null if no session is active.
 * @returns HistoryMessage[] — empty array when sessionId is null or session not found.
 */
export function useSessionMessages(sessionId: string | null): HistoryMessage[] {
  const adapter = getTuiDaemonAdapter();
  const ssm = adapter.getSessionStateManager();
  const protocolMessages = useSessionDisplayMessages({
    ssm,
    sessionId,
    isChunkLevel: false,
  });

  return useMemo(() => {
    if (!sessionId) return EMPTY_MESSAGES;

    const mgr = ssm.getSessionManager(sessionId);
    const uiRenderCutoffMessageId = mgr?.getUiRenderCutoff() ?? null;
    const store = mgr?.getStore();
    const hookExecutions = store?.getHookExecutions() ?? [];
    const displayItems =
      hookExecutions.length === 0
        ? protocolMessages
        : [...protocolMessages, ...hookExecutions].sort(
            (a, b) => a.createdAt - b.createdAt
          );
    const result: HistoryMessage[] = [];
    let protoBatch: IndustryDroolMessage[] = [];

    const flushProtoBatch = () => {
      if (protoBatch.length > 0) {
        result.push(
          ...deriveCliMessages(protoBatch, { uiRenderCutoffMessageId })
        );
        protoBatch = [];
      }
    };

    for (const item of displayItems) {
      if (isHookExecutionData(item)) {
        flushProtoBatch();
        result.push(hookExecutionToHistoryMessage(item));
      } else {
        protoBatch.push(item);
      }
    }
    flushProtoBatch();

    if (!store) {
      return result;
    }

    for (const msg of result) {
      if (msg.messageType === MessageType.ToolCall && msg.toolCallId) {
        const updates = store.getUpdates(msg.toolCallId);
        if (updates.length > 0) {
          msg.progressUpdates = updates;
        }
      }
    }

    return result;
  }, [protocolMessages, sessionId, ssm]);
}
