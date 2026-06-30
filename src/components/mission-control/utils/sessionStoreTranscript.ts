import { MessageRole } from '@industry/drool-sdk-ext/protocol/sessionV2';

import type {
  CompactMessage,
  TranscriptUIItem,
} from '@/components/mission-control/types';
import { MessageType, ToolCallStatus } from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';
import type { ToolExecution } from '@/types/types';

export function convertHistoryMessagesToUIItems(
  messages: HistoryMessage[]
): TranscriptUIItem[] {
  const items: TranscriptUIItem[] = [];
  const toolExecutions = new Map<string, ToolExecution>();
  let nextItemIndex = 0;

  function nextTranscriptItemId(prefix: 'message' | 'tool', baseId: string) {
    return `${prefix}:${baseId}:${nextItemIndex++}`;
  }

  for (const message of messages) {
    if (
      message.messageType === MessageType.ToolCall &&
      message.toolCallId &&
      message.toolName
    ) {
      const toolExecution: ToolExecution = {
        id: nextTranscriptItemId('tool', message.toolCallId),
        toolName: message.toolName,
        toolInput: message.toolInput ?? {},
        status:
          message.toolCallStatus === ToolCallStatus.Error
            ? ToolCallStatus.Error
            : message.toolCallStatus === ToolCallStatus.Completed
              ? ToolCallStatus.Completed
              : ToolCallStatus.Pending,
        result:
          message.progressUpdates && message.progressUpdates.length > 0
            ? message.progressUpdates
                .map(
                  (update) =>
                    update.text ??
                    update.details ??
                    update.valueSnippet ??
                    update.status
                )
                .filter(Boolean)
                .join('\n')
            : undefined,
      };

      toolExecutions.set(message.toolCallId, toolExecution);
      items.push({ kind: 'tool', data: toolExecution });
      continue;
    }

    if (
      message.messageType === MessageType.ToolResult &&
      message.toolCallId &&
      toolExecutions.has(message.toolCallId)
    ) {
      const toolExecution = toolExecutions.get(message.toolCallId)!;
      toolExecution.result = message.content;
      toolExecution.isError = message.toolCallStatus === ToolCallStatus.Error;
      toolExecution.status = toolExecution.isError
        ? ToolCallStatus.Error
        : ToolCallStatus.Completed;
      continue;
    }

    const compactMessage: CompactMessage = {
      id: nextTranscriptItemId('message', message.id),
      role: message.role === 'user' ? MessageRole.User : MessageRole.Assistant,
      content: message.content,
    };
    items.push({ kind: 'message', data: compactMessage });
  }

  return items;
}
