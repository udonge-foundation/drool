import { FileEditChange } from './types';

function alignLineEndingsToContent(content: string, text: string): string {
  if (!text) {
    return text;
  }

  const usesCRLF = content.includes('\r\n');

  // First normalize to LF only
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Then convert to target format
  if (usesCRLF) {
    return normalized.replace(/\n/g, '\r\n');
  }

  return normalized;
}

export function normalizeChangeLineEndings(
  content: string,
  change: FileEditChange
): FileEditChange {
  // Explicitly create a new plain object to avoid readonly property issues
  const normalized: FileEditChange = {
    old_str: alignLineEndingsToContent(content, change.old_str),
    new_str: alignLineEndingsToContent(content, change.new_str),
  };

  // Only add change_all if it exists in the original
  if (change.change_all !== undefined) {
    normalized.change_all = change.change_all;
  }

  return normalized;
}
