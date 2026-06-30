import { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logWarn } from '@industry/logging';

/**
 * Orders messages by walking the parent-child chain from root to tip.
 * This ensures messages are in conversation order even if they were
 * stored or retrieved out of order.
 *
 * Algorithm:
 * 1. Build a map of messages by ID
 * 2. Find the "tip" message (the one with the latest createdAt)
 * 3. Walk backwards via parentId to build the chain from root to tip
 *
 * Appends orphan messages (not in the chain) sorted by createdAt.
 */
export function orderMessagesByParentChain(
  messages: IndustryDroolMessage[]
): IndustryDroolMessage[] {
  if (messages.length === 0) {
    return [];
  }

  // Build a map of messages by ID for O(1) lookup
  const messageMap = new Map<string, IndustryDroolMessage>();
  for (const msg of messages) {
    messageMap.set(msg.id, msg);
  }

  // Find the tip message (latest by createdAt)
  const tipMessage = messages.reduce((latest, msg) =>
    msg.createdAt > latest.createdAt ? msg : latest
  );

  // Walk backwards from tip to root via parentId chain
  const orderedMessages: IndustryDroolMessage[] = [];
  const visitedIds = new Set<string>();
  let currentMessage: IndustryDroolMessage | undefined = tipMessage;

  while (currentMessage) {
    // Detect circular references to prevent infinite loop
    if (visitedIds.has(currentMessage.id)) {
      logWarn(
        'Circular reference detected in message parent chain (orderMessages)',
        {
          messageId: currentMessage.id,
          parentId: currentMessage.parentId,
          visitedCount: visitedIds.size,
          totalMessages: messages.length,
        }
      );
      break;
    }
    visitedIds.add(currentMessage.id);

    orderedMessages.unshift(currentMessage);
    currentMessage = currentMessage.parentId
      ? messageMap.get(currentMessage.parentId)
      : undefined;
  }

  // If we didn't get all messages (some orphans not in the chain),
  // append them sorted by createdAt
  if (orderedMessages.length < messages.length) {
    const includedIds = new Set(orderedMessages.map((m) => m.id));
    const orphans = messages
      .filter((m) => !includedIds.has(m.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    orderedMessages.push(...orphans);
  }

  return orderedMessages;
}
