import { convertMessageEventToIndustryDroolMessage } from '@industry/common/session';

import type { DroolMessageEvent } from '@/services/types';

import type { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';

type LoadRewindHistoryParams = {
  sessionId: string | null;
  getStoreMessages: (sessionId: string) => IndustryDroolMessage[];
  getPersistedMessageEvents: (
    sessionId: string
  ) => Promise<DroolMessageEvent[]>;
  onPersistedReadError?: (error: unknown) => void;
};

export async function loadRewindHistory({
  sessionId,
  getStoreMessages,
  getPersistedMessageEvents,
  onPersistedReadError,
}: LoadRewindHistoryParams): Promise<IndustryDroolMessage[]> {
  if (!sessionId) {
    return [];
  }

  const storeMessages = getStoreMessages(sessionId);

  try {
    const persistedMessages = (await getPersistedMessageEvents(sessionId)).map(
      convertMessageEventToIndustryDroolMessage
    );

    return persistedMessages.length >= storeMessages.length
      ? persistedMessages
      : storeMessages;
  } catch (error) {
    onPersistedReadError?.(error);
    return storeMessages;
  }
}
