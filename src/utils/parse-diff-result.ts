import { normalizeDiffLineArray } from '@/utils/diffLinePayload';
import { ParsedToolResult } from '@/utils/types';

interface DiffData {
  oldContent: string;
  newContent: string;
  filePath: string;
}

export function parseToolResultForDiff(result: string): ParsedToolResult {
  // Try new format - JSON with diffLines property
  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed.diffLines)) {
      const normalizedDiffLines = normalizeDiffLineArray(parsed.diffLines);
      if (!normalizedDiffLines) {
        return { message: result };
      }

      // New format with diffLines key
      return {
        message: '',
        diffLines: normalizedDiffLines,
      };
    }
  } catch {
    // Not JSON, continue to check old format
  }

  // Fall back to old DIFF_DATA format
  const diffMarker = '\n\n---DIFF_DATA---\n';
  const diffIndex = result.indexOf(diffMarker);

  if (diffIndex === -1) {
    return { message: result };
  }

  const message = result.substring(0, diffIndex);
  const diffDataStr = result.substring(diffIndex + diffMarker.length);

  try {
    const diffData: DiffData = JSON.parse(diffDataStr);
    return { message, diffData };
  } catch (_error) {
    // If parsing fails, return the original result
    return { message: result };
  }
}
