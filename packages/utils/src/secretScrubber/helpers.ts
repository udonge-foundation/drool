import { isKnownSafeValue } from './isKnownSafeValue';
import { scrubSecrets } from './scrubSecrets';

export function scrubbed(value: unknown): string | undefined | string[] {
  if (value === undefined) {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return scrubSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubSecrets);
  }
  return scrubSecrets(JSON.stringify(value));
}

// Strict placeholder patterns that collapse _/- separator variants into single regexes.
// Only clearly non-secret values are matched to avoid false negatives.
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^change[-_]?me$/i,
  /^placeholder$/i,
  /^placeholder[-_]/i, // PLACEHOLDER_KEY, placeholder-token, etc.
  /^replace[-_]?me$/i,
  /^test[-_]/i, // test-api-key, test_token, etc.
  /^x{8,}$/i,
  /^your[_-]api[_-]key[_-]here$/i,
  /^your[_-]password[_-]here$/i,
  /^your[_-]secret[_-]here$/i,
  /^your[_-]token[_-]here$/i,
];

export function isPlaceholderValue(str: string): boolean {
  const normalized = str.trim();
  return PLACEHOLDER_PATTERNS.some((re) => re.test(normalized));
}

export function isLikelyRandom(str: string): boolean {
  if (str.length < 10) return false;

  if (isKnownSafeValue(str)) return false;

  // UUID format (8-4-4-4-12 hex digits with hyphens) is inherently random
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)
  ) {
    return true;
  }

  const uniqueChars = new Set(str.split('')).size;
  const uniqueRatio = uniqueChars / str.length;
  const hasNumbers = /[0-9]/.test(str);
  const hasMixedCase = /[a-z]/.test(str) && /[A-Z]/.test(str);
  const hasSpecialChars = /[+./=~_-]/.test(str);

  if (uniqueRatio > 0.45 && hasNumbers && (hasMixedCase || hasSpecialChars)) {
    return true;
  }

  // Base64-like pattern: must be 32+ chars AND contain numbers to avoid false positives on long function names
  if (/^[A-Za-z0-9+/]{32,}={0,2}$/.test(str) && hasNumbers) {
    return true;
  }

  if (/^[0-9a-f]{32,}$/i.test(str)) {
    return true;
  }

  return false;
}
