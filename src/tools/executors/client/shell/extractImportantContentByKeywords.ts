import { isImportantLine } from '@/tools/executors/client/shell/cli-summarizer';

interface ExtractImportantContentParams {
  truncatedLines: string[];
  keywords: readonly string[];
  options: {
    surroundingContextLines: number;
    headTailLines: number;
  };
}

export function extractImportantContentByKeywords({
  truncatedLines,
  keywords,
  options: { surroundingContextLines, headTailLines },
}: ExtractImportantContentParams) {
  const importantLineIndicesSet = new Set<number>();
  truncatedLines.forEach((line, index) => {
    if (isImportantLine({ line, keywords })) {
      importantLineIndicesSet.add(index);

      // Add context lines
      for (
        let i = Math.max(0, index - surroundingContextLines);
        i <=
        Math.min(truncatedLines.length - 1, index + surroundingContextLines);
        i++
      ) {
        importantLineIndicesSet.add(i);
      }
    }
  });

  // always include the first and last few lines as they often contain important context
  for (let i = 0; i < Math.min(headTailLines, truncatedLines.length); i++) {
    importantLineIndicesSet.add(i);
  }

  for (
    let i = Math.max(0, truncatedLines.length - headTailLines);
    i < truncatedLines.length;
    i++
  ) {
    importantLineIndicesSet.add(i);
  }

  const sortedImportantLineIndices = Array.from(importantLineIndicesSet).sort(
    (a, b) => a - b
  );

  const summarizedLines: string[] = [];
  let lastIncludedIndex = -1;

  for (const index of sortedImportantLineIndices) {
    if (index > lastIncludedIndex + 1) {
      const skippedLines = index - lastIncludedIndex - 1;
      summarizedLines.push(`[... ${skippedLines} lines skipped ...]`);
    }

    summarizedLines.push(truncatedLines[index]);
    lastIncludedIndex = index;
  }

  if (lastIncludedIndex < truncatedLines.length - 1) {
    const skippedLines = truncatedLines.length - lastIncludedIndex - 1;
    summarizedLines.push(`[... ${skippedLines} lines skipped ...]`);
  }

  return summarizedLines.join('\n').trim();
}
