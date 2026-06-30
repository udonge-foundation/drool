import {
  IndustryDroolMessage,
  MessageContentBlockType,
  MessageVisibility,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

import { MessageRole, MessageType } from '@/hooks/enums';
import type { HistoryMessage, StateAction } from '@/hooks/types';
import { getSessionService } from '@/services/SessionService';
import { generateUUID } from '@/utils/uuid';

/**
 * Persist a system message locally (UI state) and to the session log for compaction visibility.
 * Returns the HistoryMessage created for UI state.
 */
export function persistSystem(
  updateAction: (action: StateAction) => void,
  text: string,
  visibility?: MessageVisibility,
  meta?: { requestId?: string }
): HistoryMessage {
  const id = generateUUID();
  const resolvedVisibility = visibility ?? MessageVisibility.Both;

  updateAction({
    type: 'ADD_MESSAGE',
    id,
    role: MessageRole.System,
    content: text,
    options: { messageType: MessageType.Text, visibility: resolvedVisibility },
  });

  try {
    const sessionService = getSessionService();
    const message: IndustryDroolMessage = {
      id,
      role: MessageRole.System,
      content: [{ type: MessageContentBlockType.Text, text }],
      visibility: resolvedVisibility,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (meta) {
      void sessionService.appendMessage(message, meta);
    } else {
      void sessionService.appendMessage(message);
    }
  } catch {
    // ignore persistence errors for system notices
  }

  return {
    id,
    role: MessageRole.System,
    content: text,
    messageType: MessageType.Text,
    visibility: resolvedVisibility,
  } as HistoryMessage;
}
