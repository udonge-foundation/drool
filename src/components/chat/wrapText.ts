import {
  displayWidth as getDisplayWidth,
  sliceByDisplayWidth,
} from '@/utils/displayWidth';

/**
 * Normalize text to NFC form. This is critical for macOS which uses NFD
 * for filesystem paths (e.g., か+゙ as two codepoints instead of が).
 */
function normalizeNFC(text: string): string {
  return text.normalize('NFC');
}

/**
 * Fast path for common single-width ASCII text used heavily in the chat input.
 * Excludes tabs because they render as 4 columns, and excludes non-ASCII text
 * because width/normalization rules are more complex there.
 */
function isSimpleSingleWidthText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

// --- Kinsoku Shori (禁則処理) character sets per JIS X 4051 ---

/**
 * Characters that cannot appear at the START of a line (行頭禁則).
 * Includes: closing punctuation, small kana, long vowel mark, iteration marks.
 */
const KINSOKU_NOT_AT_LINE_START = new Set([
  // Closing punctuation
  '。',
  '、',
  '）',
  '」',
  '】',
  '』',
  '，',
  '．',
  '！',
  '？',
  // Halfwidth equivalents that may appear
  ')',
  // Small kana (hiragana)
  'ゃ',
  'ゅ',
  'ょ',
  'っ',
  'ぁ',
  'ぃ',
  'ぅ',
  'ぇ',
  'ぉ',
  // Small kana (katakana)
  'ァ',
  'ィ',
  'ゥ',
  'ェ',
  'ォ',
  'ャ',
  'ュ',
  'ョ',
  'ッ',
  // Long vowel mark
  'ー',
  // Iteration marks
  '々',
  'ゝ',
  'ゞ',
  'ヽ',
  'ヾ',
]);

/**
 * Characters that cannot appear at the END of a line (行末禁則).
 * Includes: opening brackets.
 */
const KINSOKU_NOT_AT_LINE_END = new Set(['「', '（', '【', '『', '（']);

/**
 * Check if a character is a CJK ideograph or fullwidth character
 * that allows natural breaks between adjacent characters.
 */
function isCJKChar(char: string): boolean {
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

/**
 * Check if a token contains CJK characters and thus needs character-by-character
 * line breaking (as opposed to English word-level breaking).
 */
function containsCJK(text: string): boolean {
  for (const char of text) {
    if (isCJKChar(char)) return true;
  }
  return false;
}

/**
 * Split a string into individual characters, preserving surrogate pairs.
 */
function toChars(text: string): string[] {
  return [...text];
}

/**
 * Fast wrapping path for simple single-width ASCII text.
 * Preserves the existing English/space behavior while avoiding repeated
 * string-width scans over large substrings.
 */
function wrapSimpleText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  if (text.length <= maxWidth) return [text];

  const tokens = text.match(/\S+|\s+/g) ?? [''];
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;

  const pushCurrent = () => {
    lines.push(current);
    current = '';
    currentWidth = 0;
  };

  for (const token of tokens) {
    const isWord = token.length > 0 && /\S/.test(token[0]!);
    const tokenWidth = token.length;
    let rest = token;
    let restWidth = tokenWidth;

    while (rest.length > 0) {
      const remaining = maxWidth - currentWidth;
      if (remaining <= 0) {
        pushCurrent();
        continue;
      }

      if (restWidth <= remaining) {
        current += rest;
        currentWidth += restWidth;
        rest = '';
        restWidth = 0;
        continue;
      }

      if (isWord && tokenWidth <= maxWidth && currentWidth > 0) {
        pushCurrent();
        continue;
      }

      const slice = rest.slice(0, remaining);
      current += slice;
      currentWidth += slice.length;
      rest = rest.slice(remaining);
      restWidth -= slice.length;
      pushCurrent();
    }
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Wrap text with support for kinsoku shori (禁則処理) line-breaking rules.
 *
 * Rules applied:
 * 1. Characters in KINSOKU_NOT_AT_LINE_START cannot appear at the start of a line.
 *    When a break would place such a character at line start, it is pulled back
 *    to the previous line (even if this makes the line slightly wider than maxWidth).
 * 2. Characters in KINSOKU_NOT_AT_LINE_END cannot appear at the end of a line.
 *    When a break would place such a character at line end, it is pushed to the next line.
 * 3. CJK text allows natural breaks between any two non-forbidden characters.
 * 4. English word-level breaking is preserved (unchanged from before).
 * 5. Input is NFC-normalized before processing.
 */
export function wrapText(text: string, maxWidth: number): string[] {
  // NFC normalize input
  const normalized = normalizeNFC(text);

  if (maxWidth <= 0) return [normalized];
  if (isSimpleSingleWidthText(normalized)) {
    return wrapSimpleText(normalized, maxWidth);
  }
  if (getDisplayWidth(normalized) <= maxWidth) return [normalized];

  const tokens = normalized.match(/\S+|\s+/g) ?? [''];
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;

  const pushCurrent = () => {
    lines.push(current);
    current = '';
    currentWidth = 0;
  };

  for (const token of tokens) {
    const isWord = token.length > 0 && /\S/.test(token[0]!);
    const tokenHasCJK = isWord && containsCJK(token);
    const tokenWidth = getDisplayWidth(token);
    let rest = token;
    let restWidth = tokenWidth;

    while (rest.length > 0) {
      const remaining = maxWidth - currentWidth;
      if (remaining <= 0) {
        pushCurrent();
        continue;
      }

      if (restWidth <= remaining) {
        // Fits entirely on current line — but check line-end kinsoku
        const lastChar = rest[rest.length - 1]!;
        if (KINSOKU_NOT_AT_LINE_END.has(lastChar) && restWidth === remaining) {
          // The last char would be at exact line end but cannot end a line.
          // Only matters if there's more text coming; handled naturally
          // since the text fits and it will be followed by more tokens.
        }
        current += rest;
        currentWidth += restWidth;
        rest = '';
        restWidth = 0;
      } else if (tokenHasCJK) {
        // CJK word: break character-by-character with kinsoku rules
        const chars = toChars(rest);
        let consumed = 0;

        while (consumed < chars.length) {
          const char = chars[consumed]!;
          const charWidth = getDisplayWidth(char);
          const lineRemaining = maxWidth - currentWidth;

          if (charWidth > lineRemaining) {
            // This char doesn't fit on current line — need to break
            if (current.length > 0) {
              // Before pushing, check line-end kinsoku:
              // If the last char of current is an opening bracket, pull it to next line
              const currentChars = toChars(current);
              const lastOnLine = currentChars[currentChars.length - 1]!;
              if (KINSOKU_NOT_AT_LINE_END.has(lastOnLine)) {
                // Pull the opening bracket off this line
                const pulled = currentChars.pop()!;
                current = currentChars.join('');
                currentWidth -= getDisplayWidth(pulled);
                pushCurrent();
                // Re-prepend the pulled character for the next line
                current = pulled;
                currentWidth = getDisplayWidth(pulled);
                continue; // retry current char on new line
              }
              pushCurrent();
            }
            // Now check if this char can start a new line (line-start kinsoku)
            if (KINSOKU_NOT_AT_LINE_START.has(char) && lines.length > 0) {
              // This character cannot start a line — pull it back to previous line
              lines[lines.length - 1] += char;
              consumed++;
              continue;
            }
            // Place char on new line
            current += char;
            currentWidth += charWidth;
            consumed++;
          } else {
            // Char fits on current line
            current += char;
            currentWidth += charWidth;
            consumed++;

            // Check if we've filled the line
            if (currentWidth >= maxWidth && consumed < chars.length) {
              // About to break — check kinsoku rules

              // Check if next char cannot start a line
              const nextChar = chars[consumed];
              if (nextChar && KINSOKU_NOT_AT_LINE_START.has(nextChar)) {
                // Pull next char onto this line (allow slight overflow)
                current += nextChar;
                currentWidth += getDisplayWidth(nextChar);
                consumed++;
              }

              // Check if current last char cannot end a line
              const currentChars = toChars(current);
              const lastOnLine = currentChars[currentChars.length - 1]!;
              if (
                KINSOKU_NOT_AT_LINE_END.has(lastOnLine) &&
                consumed < chars.length
              ) {
                // Pull the opening bracket off this line to next line
                const pulled = currentChars.pop()!;
                current = currentChars.join('');
                currentWidth -= getDisplayWidth(pulled);
                pushCurrent();
                current = pulled;
                currentWidth = getDisplayWidth(pulled);
                continue;
              }

              if (consumed < chars.length) {
                pushCurrent();
              }
            }
          }
        }
        rest = '';
        restWidth = 0;
      } else if (isWord) {
        // ASCII/Latin word would overflow current line
        if (tokenWidth <= maxWidth && currentWidth > 0) {
          // Move the entire word to the next line
          pushCurrent();
          // Loop will retry with fresh remaining
          continue;
        }
        // Word itself exceeds max width or we're at line start → hard break
        const { slice, rest: newRest } = sliceByDisplayWidth(rest, remaining);
        const sliceWidth = getDisplayWidth(slice);
        if (sliceWidth > remaining && currentWidth > 0) {
          pushCurrent();
          continue;
        }
        current += slice;
        currentWidth += sliceWidth;
        rest = newRest;
        restWidth -= sliceWidth;
        pushCurrent();
      } else {
        // Spaces: fill remaining, then continue on next line
        const { slice, rest: newRest } = sliceByDisplayWidth(rest, remaining);
        const sliceWidth = getDisplayWidth(slice);
        if (sliceWidth > remaining && currentWidth > 0) {
          pushCurrent();
          continue;
        }
        current += slice;
        currentWidth += sliceWidth;
        rest = newRest;
        restWidth -= sliceWidth;
        pushCurrent();
      }
    }
  }

  if (current.length > 0) lines.push(current);
  return lines;
}
