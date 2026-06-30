import stringWidth from 'string-width';

import type { DisplayWidthCacheStats } from '@/utils/types';

const DISPLAY_TAB_WIDTH = 4;
const ESC = '\u001b';
const BEL = '\u0007';
const ST = '\u009c';
const MAX_CACHE_ENTRIES = 10_000;
const MAX_CACHE_KEY_LENGTH = 512;

type DisplayWidthMode = 'plain' | 'ansi';

const widthCache = new Map<string, number>();
let cacheHits = 0;
let cacheMisses = 0;
let cacheEvictions = 0;

function isSimpleSingleWidthText(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

function countTabs(text: string): number {
  let tabCount = 0;
  for (const char of text) {
    if (char === '\t') tabCount++;
  }
  return tabCount;
}

function measureStringWidth(text: string): number {
  return stringWidth(text) + countTabs(text) * DISPLAY_TAB_WIDTH;
}

function cachedDisplayWidth(
  mode: DisplayWidthMode,
  text: string,
  measure: (value: string) => number
): number {
  if (text.length > MAX_CACHE_KEY_LENGTH) {
    return measure(text);
  }

  const key = `${mode}\u0000${text}`;
  const cached = widthCache.get(key);
  if (cached !== undefined || widthCache.has(key)) {
    cacheHits++;
    return cached ?? 0;
  }

  cacheMisses++;
  const width = measure(text);
  if (widthCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = widthCache.keys().next().value;
    if (firstKey !== undefined) {
      widthCache.delete(firstKey);
      cacheEvictions++;
    }
  }
  widthCache.set(key, width);
  return width;
}

export function displayWidth(text: string): number {
  const normalized = text.normalize('NFC');

  if (isSimpleSingleWidthText(normalized)) {
    return normalized.length;
  }

  return cachedDisplayWidth('plain', normalized, measureStringWidth);
}

export function ansiDisplayWidth(text: string): number {
  const normalized = text.normalize('NFC');

  if (isSimpleSingleWidthText(normalized)) {
    return normalized.length;
  }

  return cachedDisplayWidth('ansi', normalized, measureStringWidth);
}

export function clearDisplayWidthCache(): void {
  widthCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
  cacheEvictions = 0;
}

export function getDisplayWidthCacheStats(): DisplayWidthCacheStats {
  return {
    entries: widthCache.size,
    hits: cacheHits,
    misses: cacheMisses,
    evictions: cacheEvictions,
  };
}

function isAnsiParamByte(code: number): boolean {
  return code >= 0x30 && code <= 0x3f;
}

function isAnsiIntermediateByte(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

function isAnsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function getAnsiCsiEnd(text: string, start: number): number | undefined {
  let index = start;
  while (index < text.length && isAnsiParamByte(text.charCodeAt(index))) {
    index++;
  }
  while (
    index < text.length &&
    isAnsiIntermediateByte(text.charCodeAt(index))
  ) {
    index++;
  }
  if (index >= text.length || !isAnsiFinalByte(text.charCodeAt(index))) {
    return undefined;
  }
  return index + 1;
}

function getAnsiStringEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === BEL || char === ST) {
      return index + 1;
    }
    if (char === ESC && text[index + 1] === '\\') {
      return index + 2;
    }
    index++;
  }
  return text.length;
}

function getAnsiSgrSequenceEnd(
  text: string,
  start: number
): number | undefined {
  const char = text[start];
  const code = text.charCodeAt(start);

  if (char === ESC) {
    const next = text[start + 1];
    if (!next) {
      return undefined;
    }
    if (next === '[') {
      const csiEnd = getAnsiCsiEnd(text, start + 2);
      return csiEnd !== undefined && text[csiEnd - 1] === 'm'
        ? csiEnd
        : undefined;
    }
    return undefined;
  }

  if (code === 0x9b) {
    const csiEnd = getAnsiCsiEnd(text, start + 1);
    return csiEnd !== undefined && text[csiEnd - 1] === 'm'
      ? csiEnd
      : undefined;
  }

  return undefined;
}

function stripNonSgrAnsiSequences(text: string): string {
  let stripped = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    const code = text.charCodeAt(index);

    if (char === ESC) {
      const next = text[index + 1];
      if (!next) {
        break;
      }
      if (next === '[') {
        const csiEnd = getAnsiCsiEnd(text, index + 2);
        if (csiEnd !== undefined) {
          if (text[csiEnd - 1] === 'm') {
            stripped += text.slice(index, csiEnd);
          }
          index = csiEnd;
          continue;
        }
        index += 2;
        continue;
      }
      if (next === ']') {
        index = getAnsiStringEnd(text, index + 2);
        continue;
      }
      if (next === 'P' || next === 'X' || next === '^' || next === '_') {
        index = getAnsiStringEnd(text, index + 2);
        continue;
      }
      index += 2;
      continue;
    }

    if (code === 0x9b) {
      const csiEnd = getAnsiCsiEnd(text, index + 1);
      if (csiEnd !== undefined) {
        if (text[csiEnd - 1] === 'm') {
          stripped += text.slice(index, csiEnd);
        }
        index = csiEnd;
        continue;
      }
      index++;
      continue;
    }
    if (code === 0x9d) {
      index = getAnsiStringEnd(text, index + 1);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = getAnsiStringEnd(text, index + 1);
      continue;
    }

    stripped += char;
    index++;
  }

  return stripped;
}

export function sliceByDisplayWidth(
  text: string,
  targetWidth: number
): { slice: string; rest: string } {
  const safeText = stripNonSgrAnsiSequences(text);

  if (targetWidth <= 0) return { slice: '', rest: safeText };

  if (isSimpleSingleWidthText(safeText)) {
    return {
      slice: safeText.slice(0, targetWidth),
      rest: safeText.slice(targetWidth),
    };
  }

  let currentWidth = 0;
  let sliceIndex = 0;
  let index = 0;

  while (index < safeText.length) {
    const ansiEnd = getAnsiSgrSequenceEnd(safeText, index);
    if (ansiEnd !== undefined) {
      sliceIndex = ansiEnd;
      index = ansiEnd;
      continue;
    }

    const char = String.fromCodePoint(safeText.codePointAt(index)!);
    const charWidth = displayWidth(char);
    if (currentWidth + charWidth > targetWidth) {
      if (currentWidth === 0) {
        sliceIndex = index + char.length;
      }
      break;
    }
    currentWidth += charWidth;
    index += char.length;
    sliceIndex = index;
  }

  return {
    slice: safeText.slice(0, sliceIndex),
    rest: safeText.slice(sliceIndex),
  };
}

export function padEndByDisplayWidth(
  text: string,
  targetWidth: number,
  fillChar: string = ' '
): string {
  const currentWidth = displayWidth(text);
  if (currentWidth >= targetWidth) return text;
  const padding = targetWidth - currentWidth;
  return text + fillChar.repeat(padding);
}
