/**
 * Content Security Policy configuration shared across web and desktop applications.
 */

import {
  BASE_CSP_SOURCES,
  CLOUDFLARED_URLS,
  OTEL_URLS,
} from '@industry/common/security/constants';

// eslint-disable-next-line import/extensions
import type { CSPSources } from './types.ts';

const CSP_DIRECTIVES: ReadonlyArray<[keyof CSPSources, string]> = [
  ['defaultSrc', 'default-src'],
  ['scriptSrc', 'script-src'],
  ['styleSrc', 'style-src'],
  ['imgSrc', 'img-src'],
  ['fontSrc', 'font-src'],
  ['connectSrc', 'connect-src'],
  ['frameSrc', 'frame-src'],
  ['mediaSrc', 'media-src'],
  ['objectSrc', 'object-src'],
  ['baseUri', 'base-uri'],
  ['formAction', 'form-action'],
  ['frameAncestors', 'frame-ancestors'],
];

/**
 * Merge base CSP sources with app-specific additions.
 * App-specific sources are concatenated with base sources.
 *
 * @param appSpecific - App-specific CSP source overrides
 * @returns Merged CSP sources
 */

export function buildCSPSources(
  appSpecific: Partial<CSPSources> = {},
  isDev: boolean = false
): CSPSources {
  const devConnectSrc = isDev ? [...CLOUDFLARED_URLS, ...OTEL_URLS] : [];
  const merged = {} as CSPSources;
  for (const [key] of CSP_DIRECTIVES) {
    const base = BASE_CSP_SOURCES[key];
    const extra = appSpecific[key] ?? [];
    merged[key] =
      key === 'connectSrc'
        ? [...base, ...devConnectSrc, ...extra]
        : [...base, ...extra];
  }
  return merged;
}

/**
 * Build a CSP header/meta tag string from CSP sources configuration.
 *
 * @param sources - CSP sources configuration
 * @returns CSP header string
 */

export function buildCSPHeader(sources: CSPSources): string {
  const directives = CSP_DIRECTIVES.map(
    ([key, directive]) => `${directive} ${sources[key].join(' ')}`
  );

  return `${directives.join('; ')};`;
}

/**
 * CORS (Cross-Origin Resource Sharing) configuration.
 *
 * Pre-compile allowed origin patterns for performance.
 * Converts wildcard patterns (with *) to regex, keeps exact URLs as strings.
 */
function compileOriginPatterns(patterns: string[]): Array<string | RegExp> {
  return patterns.map((pattern) => {
    if (pattern.includes('*')) {
      const escapedPattern = pattern
        .replace(/\*/g, '__WILDCARD__')
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/__WILDCARD__/g, '.*');
      return new RegExp(`^${escapedPattern}$`);
    }
    return pattern;
  });
}

/**
 * Check if an origin matches any of the allowed patterns.
 * Supports exact matches and wildcard patterns (e.g., "https://*.vercel.app").
 */

/**
 * Create a pre-compiled origin validator for performance-critical use cases.
 * The returned function checks if an origin matches any of the allowed patterns.
 *
 * Patterns are compiled once at creation time and reused for all checks.
 * Supports exact matches and wildcard patterns (e.g., "https://*.vercel.app").
 *
 * @param allowedPatterns - Array of allowed origin patterns (supports wildcards with *)
 * @returns Validator function that checks if an origin is allowed
 *
 * @example
 * ```ts
 * const isAllowed = createOriginValidator([
 *   'https://app.example.com',
 *   'https://*.vercel.app',
 * ]);
 *
 * isAllowed('https://app.example.com'); // true
 * isAllowed('https://my-app.vercel.app'); // true
 * isAllowed('https://malicious.com'); // false
 * ```
 */

export function createOriginValidator(
  allowedPatterns: string[]
): (origin: string | null) => boolean {
  const compiledPatterns = compileOriginPatterns(allowedPatterns);

  return (origin: string | null): boolean => {
    if (!origin) return true; // No origin, allow by default (e.g., same-origin requests)

    return compiledPatterns.some((pattern) => {
      if (typeof pattern === 'string') {
        return origin === pattern; // Exact match
      }
      return pattern.test(origin); // Regex match for wildcards
    });
  };
}
