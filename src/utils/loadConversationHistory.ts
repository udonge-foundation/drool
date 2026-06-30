import { getConversationStateManager } from '@/services/ConversationStateManager';

import type { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';

export function loadConversationHistory(
  conversationHistory: IndustryDroolMessage[]
): void {
  getConversationStateManager().loadConversationHistory(conversationHistory);
}
