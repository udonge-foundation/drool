import { logWarn } from '@industry/logging';

import { SEGMENT_TYPE } from './constants';
import { jsonRenderSpecSchema } from './schemas';

import type { ContentSegment, JsonRenderSpec } from './types';

const TAG_OPEN = '<json-render>';
const TAG_CLOSE = '</json-render>';

/**
 * Attempt to repair truncated JSON by appending missing closing braces/brackets.
 * LLMs sometimes omit trailing delimiters when the output is long.
 */
function repairTruncatedJson(str: string): string {
  const stack: Array<'{' | '['> = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    const top = stack[stack.length - 1];
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' && top === '{') stack.pop();
    else if (ch === ']' && top === '[') stack.pop();
  }

  let out = str;
  while (stack.length > 0) {
    out += stack.pop() === '{' ? '}' : ']';
  }
  return out;
}

function tryParseJson(str: string): unknown | undefined {
  try {
    return JSON.parse(str);
  } catch (err) {
    logWarn('Failed to parse JSON render spec', { cause: err });
    return undefined;
  }
}

function tryParseSpec(jsonStr: string): JsonRenderSpec | null {
  const trimmed = jsonStr.trim();

  const attempts = [
    trimmed,
    // LLMs may insert literal newlines inside JSON string values.
    trimmed.replace(/\n/g, ' '),
  ];

  for (const attempt of attempts) {
    const parsed =
      tryParseJson(attempt) ?? tryParseJson(repairTruncatedJson(attempt));
    if (parsed !== undefined) {
      const result = jsonRenderSpecSchema.safeParse(parsed);
      if (result.success) return result.data;
    }
  }

  return null;
}

/**
 * Heuristic: does the inner content of a tag pair look like a JSON object
 * (as opposed to natural-language text that happens to mention the tag)?
 * We trim and check for a leading '{' — LLM-generated specs always start
 * with an object literal, while backtick-quoted tag references or
 * descriptions like "this" or "not valid json" never do.
 */
function looksLikeJsonSpec(inner: string): boolean {
  return inner.trimStart().startsWith('{');
}

/**
 * Find all <json-render>...</json-render> regions in the content.
 * Returns both successfully-parsed specs (spec !== null) and regions that
 * look like intended spec blocks but failed to parse (spec === null).
 * False positives (e.g. backtick-quoted tag mentions with non-JSON inner
 * content) are still skipped.
 */
function findJsonRenderRegions(
  content: string
): Array<{ start: number; end: number; spec: JsonRenderSpec | null }> {
  const regions: Array<{
    start: number;
    end: number;
    spec: JsonRenderSpec | null;
  }> = [];
  let searchFrom = 0;

  while (searchFrom < content.length) {
    const openIdx = content.indexOf(TAG_OPEN, searchFrom);
    if (openIdx === -1) break;

    const closeIdx = content.indexOf(TAG_CLOSE, openIdx + TAG_OPEN.length);
    if (closeIdx === -1) break;

    const inner = content.slice(openIdx + TAG_OPEN.length, closeIdx);
    const spec = tryParseSpec(inner);

    if (spec) {
      regions.push({
        start: openIdx,
        end: closeIdx + TAG_CLOSE.length,
        spec,
      });
      searchFrom = closeIdx + TAG_CLOSE.length;
    } else if (looksLikeJsonSpec(inner)) {
      // The inner content looks like an attempted JSON spec that failed
      // validation — claim the region so it doesn't leak as raw text.
      regions.push({
        start: openIdx,
        end: closeIdx + TAG_CLOSE.length,
        spec: null,
      });
      searchFrom = closeIdx + TAG_CLOSE.length;
    } else {
      searchFrom = openIdx + TAG_OPEN.length;
    }
  }

  return regions;
}

/**
 * Parse assistant message content, splitting on <json-render>...</json-render> tags.
 * Returns an array of text segments and parsed json-render specs.
 * Gracefully skips false positives (e.g. backtick-quoted tag mentions).
 */
export function parseJsonRenderTags(content: string): ContentSegment[] {
  const regions = findJsonRenderRegions(content);

  if (regions.length === 0) {
    return content.length > 0 ? [{ type: SEGMENT_TYPE.TEXT, content }] : [];
  }

  const segments: ContentSegment[] = [];
  let cursor = 0;

  for (const region of regions) {
    if (region.start > cursor) {
      const textBefore = content.slice(cursor, region.start);
      if (textBefore.trim().length > 0) {
        segments.push({ type: SEGMENT_TYPE.TEXT, content: textBefore });
      }
    }

    segments.push(
      region.spec
        ? { type: SEGMENT_TYPE.JSON_RENDER, spec: region.spec }
        : { type: SEGMENT_TYPE.JSON_RENDER_ERROR }
    );
    cursor = region.end;
  }

  if (cursor < content.length) {
    const remaining = content.slice(cursor);
    if (remaining.trim().length > 0) {
      segments.push({ type: SEGMENT_TYPE.TEXT, content: remaining });
    }
  }

  return segments;
}

/**
 * Check if a string contains any valid <json-render> blocks.
 * More accurate than a simple substring check - verifies that at least
 * one tag pair contains parseable JSON with the expected spec structure.
 */
export function hasJsonRenderTags(content: string): boolean {
  if (!content.includes(TAG_OPEN)) return false;
  return findJsonRenderRegions(content).length > 0;
}
