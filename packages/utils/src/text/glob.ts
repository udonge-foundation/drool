import { expandBraces } from './expandBraces';
import { convertGlobToRegex } from './globToRegex';

/**
 * Checks if a file path matches a single glob pattern (without braces or negation)
 */
function matchesSingleGlobPattern(
  filePath: string,
  pattern: string,
  caseSensitive = true
): boolean {
  // Don't add the beginning anchor (^) to allow partial path matching which matches with Zoekt
  const regexPattern = `${convertGlobToRegex(pattern, true)}`;

  // Create regex with appropriate case sensitivity
  const regex = new RegExp(regexPattern, caseSensitive ? undefined : 'i');
  return regex.test(filePath);
}

/**
 * Checks if a file path matches a glob pattern
 * @param filePath File path to check
 * @param pattern Glob pattern (supports *, **, ?, [...], {a,b,c}, and ! for negation)
 * @param caseSensitive Whether matching should be case-sensitive
 * @returns True if the file path matches the pattern
 */
export function matchesGlobPattern(
  filePath: string,
  pattern: string,
  caseSensitive = true
): boolean {
  // Handle exclude patterns
  const isExcludePattern = pattern.startsWith('!');
  const actualPattern = isExcludePattern ? pattern.substring(1) : pattern;

  // Handle brace expansion
  if (actualPattern.includes('{') && actualPattern.includes('}')) {
    const expandedPatterns = expandBraces(actualPattern);
    const matches = expandedPatterns.some((p) =>
      matchesSingleGlobPattern(filePath, p, caseSensitive)
    );
    return isExcludePattern ? !matches : matches;
  }

  // Handle single pattern
  const matches = matchesSingleGlobPattern(
    filePath,
    actualPattern,
    caseSensitive
  );
  return isExcludePattern ? !matches : matches;
}
