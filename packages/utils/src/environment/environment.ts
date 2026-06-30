/**
 * Industry environment utilities
 */

/**
 * Get the current Industry environment.
 * Defaults to 'production' if INDUSTRY_ENV is not set.
 */
function getIndustryEnv(): string {
  return process.env.INDUSTRY_ENV ?? 'production';
}

/**
 * Check if running in production environment.
 */
function isProduction(): boolean {
  return getIndustryEnv() === 'production';
}

/**
 * Check if running in development environment (non-production).
 */
export function isDevelopment(): boolean {
  return !isProduction();
}
