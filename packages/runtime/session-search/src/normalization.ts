import {
  SYSTEM_REMINDER_END,
  SYSTEM_REMINDER_START,
} from '@industry/drool-sdk-ext/protocol/drool';

export function stripSystemReminders(text: string): string {
  if (!text) return text;

  // Remove any system reminder blocks, including the markers.
  let out = text;
  while (true) {
    const start = out.indexOf(SYSTEM_REMINDER_START);
    if (start < 0) break;
    const end = out.indexOf(
      SYSTEM_REMINDER_END,
      start + SYSTEM_REMINDER_START.length
    );
    if (end < 0) {
      out = out.slice(0, start);
      break;
    }
    out = `${out.slice(0, start)}${out.slice(end + SYSTEM_REMINDER_END.length)}`;
  }
  return out;
}

export function normalizeForIndex(text: string): string {
  return stripSystemReminders(text).trim();
}
