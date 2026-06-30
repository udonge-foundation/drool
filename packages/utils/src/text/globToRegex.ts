/**
 * Converts a glob pattern to a regular expression
 * @param pattern The glob pattern to convert
 * @param addEndAnchor Whether to add end anchor ($) to the pattern
 * @returns A regular expression string
 */

export function convertGlobToRegex(
  pattern: string,
  addEndAnchor = false
): string {
  let regexPattern = '';
  let i = 0;

  // Process the pattern character by character
  while (i < pattern.length) {
    const char = pattern[i];

    // Handle character classes [...]
    if (char === '[') {
      const startIndex = i;
      const endIndex = pattern.indexOf(']', startIndex + 1);

      // If no closing bracket, treat as literal
      if (endIndex === -1) {
        regexPattern += '\\[';
      } else {
        // Include the character class as is
        regexPattern += pattern.substring(startIndex, endIndex + 1);
        i = endIndex;
      }
    }

    // Handle ** (match any directory)
    else if (char === '*' && i + 1 < pattern.length && pattern[i + 1] === '*') {
      regexPattern += '.*';
      i++; // Skip the next * since we've handled both

      // If ** is followed by /, consume the / as part of the pattern
      if (i + 1 < pattern.length && pattern[i + 1] === '/') {
        i++; // Skip the / character
      }
    }

    // Handle * (match any character except directory separator)
    else if (char === '*') {
      regexPattern += '[^/]*';
    }

    // Handle ? (match single character)
    else if (char === '?') {
      regexPattern += '.';
    }

    // Escape special regex characters
    else if ('.+^$(){}|\\'.includes(char)) {
      regexPattern += `\\${char}`;
    }

    // Pass through other characters
    else {
      regexPattern += char;
    }

    i++;
  }

  // Add end anchor if requested
  if (addEndAnchor && !regexPattern.endsWith('$')) {
    regexPattern += '$';
  }

  return regexPattern;
}
