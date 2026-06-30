import type { DiffLine } from '@/utils/types';

const DIFF_LINE_TYPES = new Set<DiffLine['type']>([
  'unchanged',
  'added',
  'removed',
]);

function isDiffLineType(value: unknown): value is DiffLine['type'] {
  return (
    typeof value === 'string' && DIFF_LINE_TYPES.has(value as DiffLine['type'])
  );
}

function normalizeLineNumber(
  value: unknown
): DiffLine['lineNumber'] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const lineNumberValue = value as { old?: unknown; new?: unknown };
  const oldLine =
    typeof lineNumberValue.old === 'number' ? lineNumberValue.old : undefined;
  const newLine =
    typeof lineNumberValue.new === 'number' ? lineNumberValue.new : undefined;

  if (oldLine === undefined && newLine === undefined) {
    return undefined;
  }

  return {
    ...(oldLine !== undefined && { old: oldLine }),
    ...(newLine !== undefined && { new: newLine }),
  };
}

function normalizeDiffLine(value: unknown): DiffLine | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    type?: unknown;
    content?: unknown;
    lineNumber?: unknown;
  };

  if (
    !isDiffLineType(candidate.type) ||
    typeof candidate.content !== 'string'
  ) {
    return null;
  }

  const lineNumber = normalizeLineNumber(candidate.lineNumber);

  return {
    type: candidate.type,
    content: candidate.content.replace(/\r/g, ''),
    ...(lineNumber && { lineNumber }),
  };
}

function isLegacyTruncationMarker(value: string): boolean {
  return /^\[\.\.\. truncated \d+ items\]$/.test(value);
}

function getLegacyTruncationCount(value: string): number {
  const match = value.match(/\d+/);
  return parseInt(match?.[0] ?? '0', 10);
}

export function createTruncatedDiffLineMarker(removedCount: number): DiffLine {
  return {
    type: 'unchanged',
    content: `[... truncated ${removedCount} items]`,
  };
}

export function normalizeDiffLineArray(value: unknown): DiffLine[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  if (value.length === 0) {
    return [];
  }

  let sawStructuredDiffLine = false;
  const normalized: DiffLine[] = [];

  for (const item of value) {
    const normalizedLine = normalizeDiffLine(item);
    if (normalizedLine) {
      normalized.push(normalizedLine);
      sawStructuredDiffLine = true;
      continue;
    }

    if (typeof item === 'string' && isLegacyTruncationMarker(item)) {
      normalized.push(
        createTruncatedDiffLineMarker(getLegacyTruncationCount(item))
      );
      continue;
    }

    return null;
  }

  return sawStructuredDiffLine ? normalized : null;
}
