import { SECRET_DETECTION_REGEXES } from './constants';
import { isLikelyRandom } from './helpers';

function getPredefinedSecretRegexes(): RegExp[] {
  // Call the function to get compiled regexes
  return SECRET_DETECTION_REGEXES();
}

function maskRange(
  resultChars: string[],
  baseIdx: number,
  source: string
): void {
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '\n') {
      resultChars[baseIdx + i] = '*';
    }
  }
}

export function scrubSecrets(text: string): string {
  if (!text) return text;

  try {
    const resultChars = text.split('');
    const regexes = getPredefinedSecretRegexes();

    for (const regex of regexes) {
      const matches = [...text.matchAll(regex)];
      // Check if this is a pattern that should always scrub captured groups
      // (bypassing the randomness/entropy check)
      const isAlwaysScrub =
        regex.source.includes('ENV\\s+') ||
        regex.source.includes('://') ||
        regex.source.includes('Basic|BASIC') ||
        regex.source.includes('usercontent') ||
        regex.source.includes('DB_PASS') ||
        regex.source.includes('--form|--data|-d');

      for (const match of matches) {
        const fullMatch = match[0];
        const startIdx = match.index!;

        // Check if we have a valid first capturing group
        if (match.length > 1 && match[1] && typeof match[1] === 'string') {
          const group = match[1];
          // For patterns that should always scrub, skip the randomness check
          if (isAlwaysScrub || isLikelyRandom(group)) {
            // Find position of the group in the full match
            const groupOffset = fullMatch.indexOf(group);
            if (groupOffset !== -1) {
              maskRange(resultChars, startIdx + groupOffset, group);
            }
          }
        } else {
          maskRange(resultChars, startIdx, fullMatch);
        }
      }
    }

    return resultChars.join('');
    // eslint-disable-next-line industry/require-catch-handling -- cannot import @industry/logging here; it pulls in pino/node:async_hooks which breaks workflow bundles
  } catch {
    // Return the original text if scrubbing fails
    return text;
  }
}
