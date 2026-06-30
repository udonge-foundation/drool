import {
  createTruncatedDiffLineMarker,
  normalizeDiffLineArray,
} from '@/utils/diffLinePayload';

interface JsonCompactionOptions {
  maxStringLength: number;
  maxArrayItems: number;
  maxObjectKeys: number;
}

const JSON_COMPACTION_PASSES: JsonCompactionOptions[] = [
  { maxStringLength: 1200, maxArrayItems: 50, maxObjectKeys: 80 },
  { maxStringLength: 512, maxArrayItems: 20, maxObjectKeys: 40 },
  { maxStringLength: 160, maxArrayItems: 8, maxObjectKeys: 20 },
];

function getTruncationSuffix(removedCount: number): string {
  return `\n\n[... truncated ${removedCount} characters for memory efficiency]`;
}

function truncateStringWithSuffix(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  let visibleLength = maxLength;
  while (visibleLength > 0) {
    const suffix = getTruncationSuffix(value.length - visibleLength);
    const nextVisibleLength = Math.max(0, maxLength - suffix.length);
    if (nextVisibleLength === visibleLength) {
      return `${value.slice(0, visibleLength)}${suffix}`;
    }
    visibleLength = nextVisibleLength;
  }

  return value.slice(0, maxLength);
}

function compactJsonValue(
  value: unknown,
  options: JsonCompactionOptions
): unknown {
  if (typeof value === 'string') {
    return truncateStringWithSuffix(value, options.maxStringLength);
  }

  if (Array.isArray(value)) {
    const normalizedDiffLines = normalizeDiffLineArray(value);
    if (normalizedDiffLines) {
      const compactedItems = normalizedDiffLines
        .slice(0, options.maxArrayItems)
        .map((item) => compactJsonValue(item, options));

      if (normalizedDiffLines.length > options.maxArrayItems) {
        compactedItems.push(
          createTruncatedDiffLineMarker(
            normalizedDiffLines.length - options.maxArrayItems
          )
        );
      }

      return compactedItems;
    }

    const compactedItems = value
      .slice(0, options.maxArrayItems)
      .map((item) => compactJsonValue(item, options));

    if (value.length > options.maxArrayItems) {
      compactedItems.push(
        `[... truncated ${value.length - options.maxArrayItems} items]`
      );
    }

    return compactedItems;
  }

  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const entries = Object.entries(objectValue);
    const compactedEntries = entries
      .slice(0, options.maxObjectKeys)
      .map(([key, nestedValue]) => [
        key,
        compactJsonValue(nestedValue, options),
      ]);

    if (entries.length > options.maxObjectKeys) {
      let markerKey = '__truncatedKeys';
      let markerIndex = 1;
      while (Object.prototype.hasOwnProperty.call(objectValue, markerKey)) {
        markerKey = `__truncatedKeys_${markerIndex++}`;
      }

      compactedEntries.push([
        markerKey,
        entries.length - options.maxObjectKeys,
      ]);
    }

    return Object.fromEntries(compactedEntries);
  }

  return value;
}

function stringifyWithinLimit(
  value: unknown,
  maxLength: number
): string | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxLength) {
      return serialized;
    }
  } catch {
    // Fall through to null result
  }

  return null;
}

export function truncateToolResultStringPreview(
  result: string,
  maxLength: number
): string {
  if (result.length <= maxLength) {
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return truncateStringWithSuffix(result, maxLength);
  }

  for (const pass of JSON_COMPACTION_PASSES) {
    const compactedValue = compactJsonValue(parsed, pass);
    const serialized = stringifyWithinLimit(compactedValue, maxLength);
    if (serialized) {
      return serialized;
    }
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const fallbackObject: Record<string, unknown> = {};
    const entries = Object.entries(parsed as Record<string, unknown>);
    for (const [key, value] of entries.slice(0, 8)) {
      if (typeof value === 'string') {
        fallbackObject[key] = truncateStringWithSuffix(value, 96);
      } else if (
        value === null ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        fallbackObject[key] = value;
      } else {
        fallbackObject[key] = '[truncated]';
      }
    }

    const serialized = stringifyWithinLimit(fallbackObject, maxLength);
    if (serialized) {
      return serialized;
    }
  }

  return truncateStringWithSuffix(result, maxLength);
}
