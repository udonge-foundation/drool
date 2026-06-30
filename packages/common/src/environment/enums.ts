/**
 * Industry environment enum.
 *
 * Controls behavioral differences between development and production modes:
 * - Directory name (.industry vs .industry-dev)
 * - Default ports
 * - CLI binary name (drool vs drool-dev)
 * - Verbose logging/debugging behavior
 *
 * Note: Staging and preprod releases use Production mode (prod-like behavior)
 * but connect to different backend URLs via INDUSTRY_API_BASE_URL etc.
 * We eventually want to migrate such environment-based values are set explicitly (see packages/environment)
 * and to minimize how this is used to fork behavior.
 */
export enum IndustryEnv {
  Development = 'development',
  Production = 'production',
}

/**
 * Deployment environment enum.
 *
 * More granular than IndustryEnv - used for telemetry and environment-specific
 * configuration. While IndustryEnv controls behavioral modes (dev vs prod),
 * DeploymentEnv identifies the specific deployment tier.
 *
 * Examples:
 * - localhost: Local development machine
 * - development: Shared development environment
 * - staging: Pre-release testing environment
 * - preprod: Final validation before production
 * - production: Live production environment
 */
export enum DeploymentEnv {
  Localhost = 'localhost',
  Development = 'development',
  Staging = 'staging',
  Preprod = 'preprod',
  Production = 'production',
}
