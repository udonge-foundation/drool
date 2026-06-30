import {
  ABORT_NOTICE_DISPLAY_TEXT,
  ABORT_NOTICE_TEXT,
  LEGACY_ABORT_NOTICE_TEXT,
} from '@/components/chat/constants';

export function isAbortNoticeText(text: string): boolean {
  return text === ABORT_NOTICE_TEXT || text === LEGACY_ABORT_NOTICE_TEXT;
}

export function getAbortNoticeDisplayText(text: string): string {
  return isAbortNoticeText(text) ? ABORT_NOTICE_DISPLAY_TEXT : text;
}
