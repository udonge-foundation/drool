import { normalizeToSingleLine } from '@/components/mission-control/utils/compactResultSummary';

/**
 * Get a compact parameter summary for a tool.
 * Returns key information like file paths, commands, patterns, etc.
 */
export function getCompactToolParams(
  _toolName: string,
  input: Record<string, unknown>
): string {
  const filePath =
    (input as { file_path?: unknown }).file_path ||
    (input as { filePath?: unknown }).filePath ||
    (input as { path?: unknown }).path ||
    (input as { folder?: unknown }).folder;
  if (typeof filePath === 'string') {
    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
  }

  const command = (input as { command?: unknown }).command;
  if (typeof command === 'string') {
    return normalizeToSingleLine(command);
  }

  const pattern = (input as { pattern?: unknown }).pattern;
  if (typeof pattern === 'string') {
    return `"${pattern}"`;
  }

  const url = (input as { url?: unknown }).url;
  if (typeof url === 'string') {
    return url;
  }

  const prompt = (input as { prompt?: unknown }).prompt;
  if (typeof prompt === 'string') {
    return normalizeToSingleLine(prompt);
  }

  const query = (input as { query?: unknown }).query;
  if (typeof query === 'string') {
    return normalizeToSingleLine(query);
  }

  // Fallback: stringify first non-empty value
  const firstValue = Object.values(input).find(
    (v) => v !== undefined && v !== null && v !== ''
  );
  if (typeof firstValue === 'string') {
    return normalizeToSingleLine(firstValue);
  }

  return '';
}
