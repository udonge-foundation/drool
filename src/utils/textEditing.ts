import type { TextEditResult } from '@/utils/types';

/**
 * Check if a character is a CJK (Chinese/Japanese/Korean) character.
 * CJK characters should be navigated one at a time rather than as word blocks,
 * since CJK languages do not use spaces to separate words.
 */
function isCJKCharacter(char: string): boolean {
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  return (
    // CJK Unified Ideographs
    (code >= 0x4e00 && code <= 0x9fff) ||
    // CJK Unified Ideographs Extension A
    (code >= 0x3400 && code <= 0x4dbf) ||
    // CJK Unified Ideographs Extension B
    (code >= 0x20000 && code <= 0x2a6df) ||
    // CJK Compatibility Ideographs
    (code >= 0xf900 && code <= 0xfaff) ||
    // Hiragana
    (code >= 0x3040 && code <= 0x309f) ||
    // Katakana
    (code >= 0x30a0 && code <= 0x30ff) ||
    // Fullwidth Forms
    (code >= 0xff01 && code <= 0xff60) ||
    // Halfwidth Katakana
    (code >= 0xff65 && code <= 0xff9f) ||
    // CJK Symbols and Punctuation
    (code >= 0x3000 && code <= 0x303f) ||
    // Hangul Syllables
    (code >= 0xac00 && code <= 0xd7af) ||
    // Hangul Jamo
    (code >= 0x1100 && code <= 0x11ff) ||
    // Hangul Compatibility Jamo
    (code >= 0x3130 && code <= 0x318f) ||
    // Katakana Phonetic Extensions
    (code >= 0x31f0 && code <= 0x31ff) ||
    // CJK iteration mark
    code === 0x3005
  );
}

export function deleteWordBeforeCursor(
  value: string,
  cursorOffset: number
): TextEditResult {
  if (cursorOffset === 0) return { value, cursorOffset };

  let i = cursorOffset - 1;
  // Phase 1: Skip whitespace backward (checking value[i-1] to match original algorithm)
  while (i > 0 && /\s/.test(value[i - 1]!)) i--;

  // Phase 2: Determine what type of content is before us
  // After the initial i = cursorOffset - 1 and whitespace skip,
  // 'i' points to: the first non-whitespace char going backward from cursor,
  // or the char at cursorOffset-1 if there was no whitespace.
  // value[i] is the char that will be at the boundary.

  // Check the character at position 'i' (the one we're about to decide about)
  if (isCJKCharacter(value[i]!)) {
    // CJK: the initial i = cursorOffset - 1 already moved back one position.
    // For CJK, we only want to delete one character, so don't skip further.
    // 'i' is already at the right position (one char back from where we started skipping).
  } else {
    // ASCII: skip word characters backward, stopping at whitespace and CJK boundaries
    while (i > 0 && !/\s/.test(value[i - 1]!) && !isCJKCharacter(value[i - 1]!))
      i--;
  }

  return {
    value: value.slice(0, i) + value.slice(cursorOffset),
    cursorOffset: i,
  };
}

export function deleteWordAfterCursor(
  value: string,
  cursorOffset: number
): TextEditResult {
  if (cursorOffset >= value.length) return { value, cursorOffset };

  let i = cursorOffset;
  // Skip whitespace
  while (i < value.length && /\s/.test(value[i]!)) i++;

  // If the character at cursor (after skipping whitespace) is CJK,
  // delete only one character
  if (i < value.length && isCJKCharacter(value[i]!)) {
    return {
      value: value.slice(0, cursorOffset) + value.slice(i + 1),
      cursorOffset,
    };
  }

  // Skip ASCII word characters, stopping at CJK boundaries
  while (
    i < value.length &&
    !/\s/.test(value[i]!) &&
    !isCJKCharacter(value[i]!)
  )
    i++;

  return {
    value: value.slice(0, cursorOffset) + value.slice(i),
    cursorOffset,
  };
}

export function deleteToLineStart(
  value: string,
  cursorOffset: number
): TextEditResult {
  return {
    value: value.slice(cursorOffset),
    cursorOffset: 0,
  };
}

export function deleteToLineEnd(
  value: string,
  cursorOffset: number
): TextEditResult {
  return {
    value: value.slice(0, cursorOffset),
    cursorOffset,
  };
}

export function findPreviousWordBoundary(
  value: string,
  cursorOffset: number
): number {
  if (cursorOffset === 0) return 0;

  let i = cursorOffset;

  // Skip whitespace moving backward
  while (i > 0 && /\s/.test(value[i - 1]!)) i--;

  if (i === 0) return 0;

  // Check the character immediately before our position
  const charBefore = value[i - 1]!;

  if (isCJKCharacter(charBefore)) {
    // CJK: move back exactly one character
    return i - 1;
  }

  // ASCII word: skip back through non-whitespace, non-CJK characters
  while (i > 0 && !/\s/.test(value[i - 1]!) && !isCJKCharacter(value[i - 1]!))
    i--;

  return i;
}

export function findNextWordBoundary(
  value: string,
  cursorOffset: number
): number {
  if (cursorOffset >= value.length) return value.length;

  let i = cursorOffset;

  // If current char is CJK, move forward exactly one character
  // (CJK doesn't use space-separated words, so Ctrl+Right moves char-by-char)
  if (isCJKCharacter(value[i]!)) {
    return i + 1;
  }

  // If starting on whitespace, skip it first
  if (/\s/.test(value[i]!)) {
    while (i < value.length && /\s/.test(value[i]!)) i++;
    return i;
  }

  // Skip ASCII word characters, stopping at CJK boundaries
  while (
    i < value.length &&
    !/\s/.test(value[i]!) &&
    !isCJKCharacter(value[i]!)
  )
    i++;
  // Skip trailing whitespace
  while (i < value.length && /\s/.test(value[i]!)) i++;

  return i;
}

export function filterControlChars(text: string): string {
  let result = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    // Allow tab (9), newline (10), carriage return (13), and all printable chars (>= 32)
    // Reject other control chars (0-8, 11-12, 14-31) and DEL (127)
    if (
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 32 && code !== 127)
    ) {
      result += char;
    }
  }
  return result;
}

export function filterInputChars(text: string): string {
  let result = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    // Only printable chars (>= 32, != 127)
    if (code >= 32 && code !== 127) {
      result += char;
    }
  }
  return result;
}

export function normalizePasteText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u2028/g, '\n')
    .replace(/\u2029/g, '\n');
}
