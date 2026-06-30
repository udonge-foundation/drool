import {
  SYSTEM_NOTIFICATION_END,
  SYSTEM_NOTIFICATION_START,
  SYSTEM_REMINDER_END,
  SYSTEM_REMINDER_START,
} from '@industry/drool-sdk-ext/protocol/drool';

const SYSTEM_TAG_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [SYSTEM_REMINDER_START, '&lt;system-reminder&gt;'],
  [SYSTEM_REMINDER_END, '&lt;/system-reminder&gt;'],
  [SYSTEM_NOTIFICATION_START, '&lt;system-notification&gt;'],
  [SYSTEM_NOTIFICATION_END, '&lt;/system-notification&gt;'],
];

export function escapeUserMessageSystemTags(text: string): string {
  let escaped = text;
  for (const [tag, replacement] of SYSTEM_TAG_REPLACEMENTS) {
    escaped = escaped.split(tag).join(replacement);
  }
  return escaped;
}
