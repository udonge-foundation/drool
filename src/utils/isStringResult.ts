import type { ToolResultContent } from '@/hooks/types';

/**
 * Type guard to check if a tool result is a string
 */
export function isStringResult(
  result: ToolResultContent | undefined
): result is string {
  return typeof result === 'string';
}
