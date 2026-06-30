import { UI_MESSAGE_RENDER_LIMIT } from '@/utils/constants';
import { deriveCliMessages } from '@/utils/deriveCliMessages';
import { findFirstUserMessageInLastN } from '@/utils/messageUtils';

import type { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';

export function deriveUiRenderCutoffMessageId(
  messages: IndustryDroolMessage[],
  limit: number = UI_MESSAGE_RENDER_LIMIT
): string | undefined {
  return findFirstUserMessageInLastN(deriveCliMessages(messages), limit);
}
