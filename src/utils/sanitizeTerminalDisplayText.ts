import { logError } from '@industry/logging';

const ESC = '\u001b';
const BEL = '\u0007';
const ST = '\u009c';
const TAB_REPLACEMENT = '    ';

function isParamByte(code: number): boolean {
  return code >= 0x30 && code <= 0x3f;
}

function isIntermediateByte(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

function isFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function isControlByte(code: number): boolean {
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

function consumeCsi(input: string, start: number): number | null {
  let index = start;
  while (index < input.length && isParamByte(input.charCodeAt(index))) {
    index++;
  }
  while (index < input.length && isIntermediateByte(input.charCodeAt(index))) {
    index++;
  }
  if (index >= input.length || !isFinalByte(input.charCodeAt(index))) {
    return null;
  }
  return index;
}

function consumeToStringTerminator(input: string, start: number): number {
  let index = start;
  while (index < input.length) {
    const char = input[index];
    if (char === BEL || char === ST) {
      return index + 1;
    }
    if (char === ESC && input[index + 1] === '\\') {
      return index + 2;
    }
    index++;
  }
  return input.length;
}

/**
 * `stripSgr`: when true, also strips SGR (color/styling) escape sequences. The
 * default behavior preserves SGR so tool output can render colors. Set this to
 * true for security-sensitive surfaces (e.g. command approval dialogs) where a
 * crafted string could use SGR codes like `\x1b[8m` (conceal) to hide parts of
 * the content it is meant to represent.
 */
export function sanitizeTerminalDisplayText(
  text: string,
  options: { stripSgr?: boolean } = {}
): string {
  if (typeof text !== 'string') {
    logError('Expected string input for sanitizeTerminalDisplayText', {
      value: typeof text,
    });
    return String(text ?? '');
  }
  if (!text) {
    return text;
  }

  const stripSgr = options.stripSgr === true;

  let sanitized = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    const code = text.charCodeAt(index);

    // ESC-prefixed ANSI sequence
    if (char === ESC) {
      const next = text[index + 1];
      if (!next) {
        break;
      }

      // CSI: keep SGR (final 'm') unless caller opted into stripping it.
      if (next === '[') {
        const csiEnd = consumeCsi(text, index + 2);
        if (csiEnd !== null) {
          if (text[csiEnd] === 'm' && !stripSgr) {
            sanitized += text.slice(index, csiEnd + 1);
          }
          index = csiEnd + 1;
          continue;
        }
        index += 2;
        continue;
      }

      // OSC
      if (next === ']') {
        index = consumeToStringTerminator(text, index + 2);
        continue;
      }

      // DCS/SOS/PM/APC - all string commands terminated by ST.
      if (next === 'P' || next === 'X' || next === '^' || next === '_') {
        index = consumeToStringTerminator(text, index + 2);
        continue;
      }

      // Single-character escape sequence (including RIS ESC c).
      index += 2;
      continue;
    }

    // C1 CSI (0x9B): keep SGR unless stripping.
    if (code === 0x9b) {
      const csiEnd = consumeCsi(text, index + 1);
      if (csiEnd !== null) {
        if (text[csiEnd] === 'm' && !stripSgr) {
          sanitized += text.slice(index, csiEnd + 1);
        }
        index = csiEnd + 1;
        continue;
      }
      index++;
      continue;
    }

    // C1 OSC (0x9D)
    if (code === 0x9d) {
      index = consumeToStringTerminator(text, index + 1);
      continue;
    }

    // C1 DCS/SOS/PM/APC
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = consumeToStringTerminator(text, index + 1);
      continue;
    }

    // Safe controls only
    if (isControlByte(code)) {
      if (char === '\n') {
        sanitized += char;
      } else if (char === '\t') {
        sanitized += TAB_REPLACEMENT;
      }
      index++;
      continue;
    }

    sanitized += char;
    index++;
  }

  return sanitized;
}
