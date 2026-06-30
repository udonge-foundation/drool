import {
  SYSTEM_REMINDER_START,
  SYSTEM_REMINDER_END,
  SYSTEM_NOTIFICATION_START,
  SYSTEM_NOTIFICATION_END,
} from '@industry/drool-sdk-ext/protocol/drool';

/**
 * Remove system-only content from a message string.
 * - Strips <system-reminder>...</system-reminder>
 * - Strips <system-notification>...</system-notification>
 * - Strips inline <[SYSTEM] ...> markers (used in backend)
 * - Collapses whitespace
 */
export function cleanMessage(input: string): string {
  if (!input) return '';

  const stripBetween = (text: string, start: string, end: string): string => {
    let result = text;
    let s = result.indexOf(start);
    while (s !== -1) {
      const e = result.indexOf(end, s + start.length);
      if (e === -1) {
        // If no closing tag, remove everything after start
        result = result.slice(0, s);
        break;
      }
      result = result.slice(0, s) + result.slice(e + end.length);
      s = result.indexOf(start);
    }
    return result;
  };

  let result = input;
  result = stripBetween(result, SYSTEM_REMINDER_START, SYSTEM_REMINDER_END);
  result = stripBetween(
    result,
    SYSTEM_NOTIFICATION_START,
    SYSTEM_NOTIFICATION_END
  );
  result = result.replace(/<\[SYSTEM\][^>]*>/g, '');
  result = result.replace(/\s+/g, ' ').trim();
  return result;
}
