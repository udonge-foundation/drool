import chalk from 'chalk';

import {
  displayWidth as getDisplayWidth,
  sliceByDisplayWidth,
} from '@/utils/displayWidth';
import {
  makeHyperlink,
  sanitizeHyperlinkUrl,
  supportsTerminalHyperlinks,
} from '@/utils/hyperlinks';
import { TerminalTruncationPosition } from '@/utils/terminalSegments/enums';
import type {
  TerminalSegment,
  TerminalStyle,
  TwoSidedTerminalRowInput,
} from '@/utils/terminalSegments/types';

const ESC = '\u001b';
const BEL = '\u0007';
const ST = '\u009c';
const ELLIPSIS = '…';
const SGR_RESET = `${ESC}[0m`;

interface SanitizeTerminalTextOptions {
  preserveSgr?: boolean;
}

function getAnsiStringEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === BEL || char === ST) return index + 1;
    if (char === ESC && text[index + 1] === '\\') return index + 2;
    index++;
  }
  return text.length;
}

function isCsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function getCsiEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (isCsiFinalByte(text.charCodeAt(index))) return index + 1;
    index++;
  }
  return text.length;
}

export function sanitizeTerminalText(
  text: string,
  options?: SanitizeTerminalTextOptions
): string {
  let sanitized = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    const code = text.charCodeAt(index);

    if (char === ESC) {
      const next = text[index + 1];
      if (!next) break;

      if (next === '[') {
        const end = getCsiEnd(text, index + 2);
        if (options?.preserveSgr && text[end - 1] === 'm') {
          sanitized += text.slice(index, end);
        }
        index = end;
        continue;
      }

      if (
        next === ']' ||
        next === 'P' ||
        next === 'X' ||
        next === '^' ||
        next === '_'
      ) {
        index = getAnsiStringEnd(text, index + 2);
        continue;
      }

      index += 2;
      continue;
    }

    if (code === 0x9b) {
      const end = getCsiEnd(text, index + 1);
      if (options?.preserveSgr && text[end - 1] === 'm') {
        sanitized += text.slice(index, end);
      }
      index = end;
      continue;
    }

    if (
      code === 0x9d ||
      code === 0x90 ||
      code === 0x98 ||
      code === 0x9e ||
      code === 0x9f
    ) {
      index = getAnsiStringEnd(text, index + 1);
      continue;
    }

    if (
      (code >= 0 && code <= 0x1f && char !== '\t') ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      index++;
      continue;
    }

    sanitized += char;
    index++;
  }

  return sanitized;
}

export function textSegment(
  text: string,
  style?: TerminalStyle,
  options?: SanitizeTerminalTextOptions
): TerminalSegment {
  return {
    kind: 'text',
    text: sanitizeTerminalText(text, options),
    style,
  };
}

export function linkSegment(
  url: string,
  label: TerminalSegment[]
): TerminalSegment | null {
  const sanitizedUrl = sanitizeHyperlinkUrl(url);
  if (!sanitizedUrl) return null;

  return {
    kind: 'link',
    url: sanitizedUrl,
    label,
  };
}

function segmentsWidth(segments: TerminalSegment[]): number {
  return segments.reduce((width, segment) => {
    if (segment.kind === 'text') return width + getDisplayWidth(segment.text);
    return width + segmentsWidth(segment.label);
  }, 0);
}

function stripSgr(text: string): string {
  return sanitizeTerminalText(text);
}

function slicePlainEndByDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';

  let width = 0;
  let result = '';
  const chars = Array.from(text);
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index]!;
    const charWidth = getDisplayWidth(char);
    if (width + charWidth > maxWidth) break;
    result = `${char}${result}`;
    width += charWidth;
  }
  return result;
}

function resetIfStyled(original: string, text: string): string {
  if (!original.includes(ESC) && !original.includes('\u009b')) return text;
  return text.endsWith(SGR_RESET) ? text : `${text}${SGR_RESET}`;
}

function truncateTerminalText(
  text: string,
  maxWidth: number,
  position: TerminalTruncationPosition = TerminalTruncationPosition.End
): string {
  const width = Math.max(0, Math.floor(maxWidth));
  if (width <= 0) return '';
  if (getDisplayWidth(text) <= width) return text;

  if (width <= getDisplayWidth(ELLIPSIS)) return ELLIPSIS;

  const availableWidth = width - getDisplayWidth(ELLIPSIS);
  if (position === TerminalTruncationPosition.Start) {
    return `${ELLIPSIS}${slicePlainEndByDisplayWidth(stripSgr(text), availableWidth)}`;
  }

  if (position === TerminalTruncationPosition.Middle) {
    const startWidth = Math.ceil(availableWidth / 2);
    const endWidth = availableWidth - startWidth;
    const { slice: start } = sliceByDisplayWidth(text, startWidth);
    const end = slicePlainEndByDisplayWidth(stripSgr(text), endWidth);
    return resetIfStyled(text, `${start}${ELLIPSIS}${end}`);
  }

  const { slice } = sliceByDisplayWidth(text, availableWidth);
  return resetIfStyled(text, `${slice}${ELLIPSIS}`);
}

export function wrapTerminalText(
  text: string,
  width: number,
  maxRows: number
): string[] {
  const boundedWidth = Math.max(1, Math.floor(width));
  const boundedRows = Math.max(1, Math.floor(maxRows));
  let rest = text;
  const rows: string[] = [];

  for (let rowIndex = 0; rowIndex < boundedRows && rest; rowIndex++) {
    const isLastRow = rowIndex === boundedRows - 1;
    if (getDisplayWidth(rest) <= boundedWidth) {
      rows.push(rest);
      break;
    }

    if (isLastRow) {
      rows.push(
        truncateTerminalText(
          rest,
          boundedWidth,
          TerminalTruncationPosition.Middle
        )
      );
      break;
    }

    const { slice, rest: nextRest } = sliceByDisplayWidth(rest, boundedWidth);
    if (!slice) {
      rows.push(
        truncateTerminalText(rest, boundedWidth, TerminalTruncationPosition.End)
      );
      break;
    }
    rows.push(slice);
    rest = nextRest;
  }

  return rows.length > 0 ? rows : [''];
}

function applyStyle(text: string, style?: TerminalStyle): string {
  if (!style) return text;

  let styled = chalk;
  if (style.color) {
    switch (style.color) {
      case 'black':
        styled = styled.black;
        break;
      case 'blue':
        styled = styled.blue;
        break;
      case 'cyan':
        styled = styled.cyan;
        break;
      case 'gray':
      case 'grey':
        styled = styled.gray;
        break;
      case 'green':
        styled = styled.green;
        break;
      case 'magenta':
        styled = styled.magenta;
        break;
      case 'red':
        styled = styled.red;
        break;
      case 'white':
        styled = styled.white;
        break;
      case 'yellow':
        styled = styled.yellow;
        break;
      default:
        styled = styled.hex(style.color);
    }
  }
  if (style.bold) styled = styled.bold;
  if (style.dim) styled = styled.dim;
  if (style.italic) styled = styled.italic;
  if (style.strikethrough) styled = styled.strikethrough;
  return styled(text);
}

interface TerminalAtom {
  text: string;
  width: number;
  style?: TerminalStyle;
  url?: string;
}

function terminalStylesEqual(
  left: TerminalStyle | undefined,
  right: TerminalStyle | undefined
): boolean {
  return (
    (left?.color ?? '') === (right?.color ?? '') &&
    Boolean(left?.bold) === Boolean(right?.bold) &&
    Boolean(left?.dim) === Boolean(right?.dim) &&
    Boolean(left?.italic) === Boolean(right?.italic) &&
    Boolean(left?.strikethrough) === Boolean(right?.strikethrough)
  );
}

function flattenSegments(
  segments: TerminalSegment[],
  url?: string
): TerminalAtom[] {
  const atoms: TerminalAtom[] = [];

  for (const segment of segments) {
    if (segment.kind === 'text') {
      for (const char of Array.from(segment.text)) {
        atoms.push({
          text: char,
          width: getDisplayWidth(char),
          style: segment.style,
          url,
        });
      }
      continue;
    }

    atoms.push(...flattenSegments(segment.label, segment.url));
  }

  return atoms;
}

function atomsWidth(atoms: TerminalAtom[]): number {
  return atoms.reduce((width, atom) => width + atom.width, 0);
}

function isWhitespaceAtom(atom: TerminalAtom): boolean {
  return /\s/.test(atom.text);
}

function tokenizeAtoms(atoms: TerminalAtom[]): TerminalAtom[][] {
  const tokens: TerminalAtom[][] = [];
  let current: TerminalAtom[] = [];
  let currentIsWhitespace: boolean | undefined;

  for (const atom of atoms) {
    const atomIsWhitespace = isWhitespaceAtom(atom);
    if (
      current.length > 0 &&
      currentIsWhitespace !== undefined &&
      currentIsWhitespace !== atomIsWhitespace
    ) {
      tokens.push(current);
      current = [];
    }

    current.push(atom);
    currentIsWhitespace = atomIsWhitespace;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

function sliceAtomsByDisplayWidth(
  atoms: TerminalAtom[],
  targetWidth: number
): { slice: TerminalAtom[]; rest: TerminalAtom[] } {
  if (targetWidth <= 0) {
    return { slice: [], rest: atoms };
  }

  let width = 0;
  let index = 0;

  for (; index < atoms.length; index++) {
    const atom = atoms[index]!;
    if (width + atom.width > targetWidth) {
      if (index === 0) index = 1;
      break;
    }

    width += atom.width;
  }

  return {
    slice: atoms.slice(0, index),
    rest: atoms.slice(index),
  };
}

function wrapTerminalAtoms(
  atoms: TerminalAtom[],
  width: number
): TerminalAtom[][] {
  const boundedWidth = Math.max(1, Math.floor(width));
  const rows: TerminalAtom[][] = [];
  let current: TerminalAtom[] = [];
  let currentWidth = 0;

  const pushCurrent = () => {
    rows.push(current);
    current = [];
    currentWidth = 0;
  };

  for (const token of tokenizeAtoms(atoms)) {
    const isWord = token.length > 0 && !isWhitespaceAtom(token[0]!);
    const tokenWidth = atomsWidth(token);
    let rest = token;
    let restWidth = tokenWidth;

    while (rest.length > 0) {
      const remaining = boundedWidth - currentWidth;
      if (remaining <= 0) {
        pushCurrent();
        continue;
      }

      if (restWidth <= remaining) {
        current.push(...rest);
        currentWidth += restWidth;
        rest = [];
        restWidth = 0;
        continue;
      }

      if (isWord && tokenWidth <= boundedWidth && currentWidth > 0) {
        pushCurrent();
        continue;
      }

      const { slice, rest: nextRest } = sliceAtomsByDisplayWidth(
        rest,
        remaining
      );
      if (slice.length === 0) {
        if (current.length > 0) {
          pushCurrent();
          continue;
        }
        break;
      }

      current.push(...slice);
      currentWidth += atomsWidth(slice);
      rest = nextRest;
      restWidth = atomsWidth(rest);
      pushCurrent();
    }
  }

  if (current.length > 0) rows.push(current);
  return rows.length > 0 ? rows : [[]];
}

function renderTerminalAtomRow(row: TerminalAtom[]): string {
  let rendered = '';
  let run = '';
  let runStyle: TerminalStyle | undefined;
  let runUrl: string | undefined;

  const flush = () => {
    if (!run) return;
    const styled = applyStyle(run, runStyle);
    rendered += runUrl ? makeHyperlink(styled, runUrl) : styled;
    run = '';
  };

  for (const atom of row) {
    if (
      run &&
      (runUrl !== atom.url || !terminalStylesEqual(runStyle, atom.style))
    ) {
      flush();
    }

    run += atom.text;
    runStyle = atom.style;
    runUrl = atom.url;
  }

  flush();
  return rendered;
}

export function renderWrappedTerminalRows(
  segments: TerminalSegment[],
  width: number
): string[] {
  return wrapTerminalAtoms(
    flattenSegments(segments),
    Math.max(1, Math.floor(width))
  ).map(renderTerminalAtomRow);
}

function truncateSegments(
  segments: TerminalSegment[],
  maxWidth: number,
  position: TerminalTruncationPosition = TerminalTruncationPosition.End
): TerminalSegment[] {
  if (maxWidth <= 0) return [];

  const truncated: TerminalSegment[] = [];
  let remaining = maxWidth;

  for (const segment of segments) {
    if (remaining <= 0) break;

    if (segment.kind === 'text') {
      const width = getDisplayWidth(segment.text);
      if (width <= remaining) {
        truncated.push(segment);
        remaining -= width;
        continue;
      }

      const slice = truncateTerminalText(segment.text, remaining, position);
      if (slice) truncated.push({ ...segment, text: slice });
      break;
    }

    const label = truncateSegments(segment.label, remaining, position);
    const labelWidth = segmentsWidth(label);
    if (labelWidth <= 0) break;
    truncated.push({ ...segment, label });
    remaining -= labelWidth;
  }

  return truncated;
}

function renderSegments(segments: TerminalSegment[]): string {
  return segments
    .map((segment) => {
      if (segment.kind === 'text') {
        return applyStyle(segment.text, segment.style);
      }

      const label = renderSegments(segment.label);
      if (!label) return '';
      return supportsTerminalHyperlinks()
        ? makeHyperlink(label, segment.url)
        : label;
    })
    .join('');
}

export function renderTerminalLine(
  segments: TerminalSegment[],
  width: number,
  position: TerminalTruncationPosition = TerminalTruncationPosition.End
): string {
  return renderSegments(
    truncateSegments(segments, Math.max(1, Math.floor(width)), position)
  );
}

export function renderTwoSidedTerminalRow({
  left = [],
  right = [],
  width,
  gap = 1,
}: TwoSidedTerminalRowInput): string {
  const boundedWidth = Math.max(1, Math.floor(width));
  const boundedGap = Math.max(0, Math.floor(gap));
  const rightSegments = truncateSegments(right, boundedWidth);
  const rightWidth = segmentsWidth(rightSegments);
  const minimumGap = rightWidth > 0 ? boundedGap : 0;
  const leftBudget = Math.max(0, boundedWidth - rightWidth - minimumGap);
  const leftSegments = truncateSegments(left, leftBudget);
  const leftWidth = segmentsWidth(leftSegments);
  const actualGap = Math.max(0, boundedWidth - leftWidth - rightWidth);

  return `${renderSegments(leftSegments)}${' '.repeat(actualGap)}${renderSegments(
    rightSegments
  )}`;
}
