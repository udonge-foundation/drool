import {
  IndustryDroolMessage,
  MessageContentBlockType,
  MessageVisibility,
  TextBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { shouldFilterTextBlock } from '@industry/utils/messages';

import { MessageRole, MessageType } from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';

type UiAnnotatedIndustryDroolMessage = IndustryDroolMessage & {
  messageType?: MessageType;
  transient?: boolean;
};

export function deriveVisibleTextHistoryMessages(
  msg: UiAnnotatedIndustryDroolMessage
): HistoryMessage[] {
  if (msg.role !== 'user' && msg.role !== 'system') {
    return [];
  }

  const visibility = msg.visibility || MessageVisibility.Both;
  const messageType = msg.messageType ?? MessageType.Text;
  const uiRole =
    msg.role === 'system'
      ? MessageRole.System
      : visibility === MessageVisibility.UserOnly
        ? MessageRole.System
        : MessageRole.User;

  if (typeof msg.content === 'string') {
    if (shouldFilterTextBlock(msg.content)) {
      return [];
    }

    return [
      {
        id: msg.id,
        role: uiRole,
        content: msg.content,
        messageType,
        visibility,
        transient: msg.transient,
      },
    ];
  }

  if (!Array.isArray(msg.content)) {
    return [];
  }

  const imageCount = msg.content.filter(
    (block) => block.type === MessageContentBlockType.Image
  ).length;
  let firstTextAdded = false;
  const messages: HistoryMessage[] = [];

  msg.content.forEach((block) => {
    if (
      block.type !== MessageContentBlockType.Text ||
      shouldFilterTextBlock((block as TextBlock).text)
    ) {
      return;
    }

    const historyMsg: HistoryMessage = {
      id: msg.id,
      role: uiRole,
      content: (block as TextBlock).text,
      messageType,
      visibility,
      transient: msg.transient,
    };

    if (!firstTextAdded && imageCount > 0) {
      historyMsg.images = Array.from({ length: imageCount }, (_, i) => ({
        id: `${msg.id}-img-${i}`,
        filename: `Image ${i + 1}`,
        path: '',
        size: 0,
        mimeType: 'image/png',
        displayIndex: i + 1,
      }));
      firstTextAdded = true;
    }

    messages.push(historyMsg);
  });

  return messages;
}
