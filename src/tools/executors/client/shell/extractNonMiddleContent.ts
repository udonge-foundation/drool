import {
  MIDDLE_MESSAGE,
  MAX_CHARACTER_LIMIT,
} from '@/tools/executors/client/shell/constants';

interface ExtractNonMiddleContentParams {
  truncatedLines: string[];
  options: {
    maxLength: number;
  };
}

export function extractNonMiddleContent({
  truncatedLines,
  options: { maxLength = MAX_CHARACTER_LIMIT },
}: ExtractNonMiddleContentParams): string {
  const headLines: string[] = [];
  const tailLines: string[] = [];

  const middleMessage = `\n${MIDDLE_MESSAGE}\n`;
  const actualMaxLength = maxLength - middleMessage.length;

  let top = 0;
  let bottom = truncatedLines.length - 1;
  let totalCharacters = 0;

  while (top <= bottom) {
    // Add from top
    if (top <= bottom) {
      const line = truncatedLines[top];
      totalCharacters += line.length + 1; // +1 for newline
      if (totalCharacters > actualMaxLength) break;
      headLines.push(line);
      top++;
    }

    // Add from bottom
    if (top <= bottom) {
      const line = truncatedLines[bottom];
      totalCharacters += line.length + 1; // +1 for newline
      if (totalCharacters > actualMaxLength) break;
      tailLines.push(line);
      bottom--;
    }
  }
  const tailLinesReversed = tailLines.reverse();

  return [...headLines, middleMessage, ...tailLinesReversed].join('\n');
}
