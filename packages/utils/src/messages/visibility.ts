import {
  SYSTEM_REMINDER_START,
  SYSTEM_NOTIFICATION_START,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  IndustryDroolMessage,
  MessageVisibility,
  MessageContentBlockType,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

import { stripSystemTags } from './stripSystemTags';

/**
 * Checks if a text block contains system reminders or notifications.
 */
export function shouldFilterTextBlock(text: string): boolean {
  return (
    text.includes(SYSTEM_REMINDER_START) ||
    text.includes(SYSTEM_NOTIFICATION_START)
  );
}

/**
 * Get visibility from a message, handling legacy messages without visibility field.
 * Defaults to Both for backward compatibility.
 */
function getVisibilityFromLegacyMessage(
  msg: IndustryDroolMessage
): MessageVisibility {
  // If visibility is already set, use it
  if (msg.visibility) {
    return msg.visibility;
  }
  // Default to Both for legacy messages
  return MessageVisibility.Both;
}

/**
 * Check if a message should be visible to the LLM based on its visibility setting.
 */
export function shouldBeVisibleToLLM(msg: IndustryDroolMessage): boolean {
  const visibility = getVisibilityFromLegacyMessage(msg);
  return visibility !== MessageVisibility.UserOnly;
}

/**
 * Check if a message should be visible in the UI based on its visibility setting.
 */
export function shouldBeVisibleToUI(msg: IndustryDroolMessage): boolean {
  const visibility = getVisibilityFromLegacyMessage(msg);
  return visibility !== MessageVisibility.LLMOnly;
}

/**
 * Filter messages for UI display by:
 * 1. Removing messages with visibility=LLMOnly
 * 2. Stripping system-reminder/notification content from text blocks (keeping remaining text)
 * 3. Removing text blocks that are empty after stripping
 * 4. Removing messages with no content after filtering
 *
 * This is the canonical filtering logic used across the app.
 */
export function filterMessagesForUI(
  messages: IndustryDroolMessage[]
): IndustryDroolMessage[] {
  return messages
    .filter(shouldBeVisibleToUI)
    .map((msg) => {
      if (!Array.isArray(msg.content)) {
        return { ...msg, content: [] };
      }
      const filteredContent = msg.content
        .map((block) => {
          if (
            block.type === MessageContentBlockType.Text &&
            shouldFilterTextBlock(block.text)
          ) {
            const stripped = stripSystemTags(block.text).trim();
            if (!stripped) return null;
            return { ...block, text: stripped };
          }
          return block;
        })
        .filter((block): block is NonNullable<typeof block> => block !== null);

      return {
        ...msg,
        content: filteredContent,
      };
    })
    .filter((msg) => msg.content.length > 0);
}
