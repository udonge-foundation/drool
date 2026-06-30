// Edge Runtime compatible -- no process.cwd(), process.platform, fs, path, etc.
// Only process.env reads and pure string logic.

import { TEST_DEFAULTS } from './constants';

import type { ResolveEnvOptions } from './types';

/**
 * Check if running in a test environment (Vitest, etc.)
 */
export function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === 'test' || process.env.VITEST_WORKER_ID != null
  );
}

/**
 * Get test default value for a given environment variable name.
 */
function getTestDefault(name: string): string | undefined {
  switch (name) {
    case 'INDUSTRY_API_BASE_URL':
      return TEST_DEFAULTS.apiBaseUrl;
    case 'INDUSTRY_API_BASE_URL_EU':
      return TEST_DEFAULTS.apiBaseUrlEu;
    case 'INDUSTRY_APP_BASE_URL':
      return TEST_DEFAULTS.appBaseUrl;
    case 'INDUSTRY_DOWNLOADS_BUCKET':
      return TEST_DEFAULTS.downloadsBucket;
    case 'INDUSTRY_DOWNLOADS_PREFIX':
      return TEST_DEFAULTS.downloadsPathPrefix;
    default:
      return undefined;
  }
}

/**
 * Resolve an environment value from multiple sources in priority order:
 *   1. `process.env[overrideName]`    (if provided)
 *   2. `process.env[name]`
 *   3. `define`                       (bundler-baked)
 *   4. `TEST_DEFAULTS[name]`          (only in test runs)
 *   5. `''`                           (during Next.js phase-production-build)
 *   6. `fallback`                     (if provided)
 *   7. `undefined`                    (lets downstream zod schemas emit a
 *                                      domain-appropriate "Required" error)
 *
 * Callers distinguish required vs optional via `fallback`:
 *  - Omit `fallback` for required values -- zod will throw on `undefined`.
 *  - Provide `fallback: ''` (or any string) for optional values with a default.
 */
export function resolveEnv(options: ResolveEnvOptions): string | undefined {
  const { name, define, overrideName, fallback } = options;

  const value =
    (overrideName && process.env[overrideName]) ?? process.env[name] ?? define;
  if (value) return value;

  if (isTestEnvironment()) {
    const testDefault = getTestDefault(name);
    if (testDefault !== undefined) return testDefault;
  }

  if (process.env.NEXT_PHASE === 'phase-production-build') return '';

  return fallback;
}

/**
 * Parse an unknown value as a string.
 * Returns undefined for anything that is not a string.
 */
export function toString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function resolveEnvAsPositiveInt(
  options: ResolveEnvOptions
): number | undefined {
  const value = resolveEnv(options);
  if (value === undefined || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}
