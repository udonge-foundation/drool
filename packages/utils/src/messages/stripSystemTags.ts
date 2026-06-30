import {
  SYSTEM_REMINDER_START,
  SYSTEM_REMINDER_END,
  SYSTEM_NOTIFICATION_START,
  SYSTEM_NOTIFICATION_END,
} from '@industry/drool-sdk-ext/protocol/drool';

function stripTaggedBlocks(
  text: string,
  startTag: string,
  endTag: string
): string {
  let out = text;

  while (true) {
    const start = out.indexOf(startTag);
    if (start < 0) break;
    const end = out.indexOf(endTag, start + startTag.length);
    if (end < 0) {
      out = out.slice(0, start);
      break;
    }
    out = out.slice(0, start) + out.slice(end + endTag.length);
  }
  return out;
}

export function stripSystemTags(text: string): string {
  let result = text;
  result = stripTaggedBlocks(
    result,
    SYSTEM_REMINDER_START,
    SYSTEM_REMINDER_END
  );
  result = stripTaggedBlocks(
    result,
    SYSTEM_NOTIFICATION_START,
    SYSTEM_NOTIFICATION_END
  );
  return result;
}
