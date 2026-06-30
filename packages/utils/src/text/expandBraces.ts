/**
 * Utility functions for working with glob patterns in search tools
 */
/**
 * Expands brace expressions like "{js,ts}" into multiple patterns
 * @param pattern Glob pattern with braces
 * @returns Array of expanded patterns
 */

export function expandBraces(pattern: string): string[] {
  // Simple brace expansion for patterns like "*.{js,ts}"
  const braceRegex = /\{([^{}]*)\}/g;
  const matches = pattern.match(braceRegex);

  if (!matches) return [pattern];

  // Handle the first brace group
  const match = matches[0];
  const options = match.slice(1, -1).split(',');

  return options.map((option) => pattern.replace(match, option));
}
