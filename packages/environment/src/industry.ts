import { DeploymentEnv, IndustryEnv } from '@industry/common/environment';
import { IndustryRegion } from '@industry/common/shared';

import { setBaseEnv } from './base-env';
import { INDUSTRY_ENV_DIRS, TEST_DEFAULTS } from './constants';
import { EnvironmentError } from './errors';
import { isTestEnvironment } from './resolve-universal';

import type {
  EnvironmentInput,
  IndustryEnvironment,
  IndustryEnvType,
  ResolveDeploymentEnvOptions,
} from './types';

const VALID_ENVS = Object.values(IndustryEnv);
const VALID_DEPLOYMENT_ENVS = Object.values(DeploymentEnv);
const VALID_REGIONS = Object.values(IndustryRegion);
const VALID_ENV_SET = new Set<string>(VALID_ENVS);
const VALID_DEPLOYMENT_ENV_SET = new Set<string>(VALID_DEPLOYMENT_ENVS);
const VALID_REGION_SET = new Set<string>(VALID_REGIONS);

function isDeploymentEnv(value: string): value is DeploymentEnv {
  return VALID_DEPLOYMENT_ENV_SET.has(value);
}
const EMPTY_EXTRAS: Record<string, never> = {};

const INDUSTRY_TO_DEPLOYMENT_ENV: Record<IndustryEnv, DeploymentEnv> = {
  [IndustryEnv.Development]: DeploymentEnv.Development,
  [IndustryEnv.Production]: DeploymentEnv.Production,
};

/**
 * Type guard to check if a value is a valid IndustryEnvType.
 */
function isValidIndustryEnv(value: unknown): value is IndustryEnvType {
  return typeof value === 'string' && VALID_ENV_SET.has(value);
}

/**
 * Parse and validate a Industry environment string.
 * Falls back to test defaults when running in test environment.
 */
export function parseIndustryEnv(value: string | undefined): IndustryEnvType {
  if (isValidIndustryEnv(value)) {
    return value;
  }

  // Fall back to test default when running in test environment
  if (isTestEnvironment()) {
    return TEST_DEFAULTS.env;
  }

  throw new EnvironmentError('Invalid INDUSTRY_ENV value', {
    value: value ?? 'undefined',
    allowedValues: VALID_ENVS,
  });
}

/**
 * Type guard to check if a value is a valid DeploymentEnv.
 */
function isValidDeploymentEnv(value: unknown): value is DeploymentEnv {
  return typeof value === 'string' && VALID_DEPLOYMENT_ENV_SET.has(value);
}

/**
 * Parse and validate a deployment environment string.
 * Falls back to test defaults when running in test environment.
 */
export function parseDeploymentEnv(value: string | undefined): DeploymentEnv {
  if (isValidDeploymentEnv(value)) {
    return value;
  }

  // Fall back to test default when running in test environment
  if (isTestEnvironment()) {
    return TEST_DEFAULTS.deploymentEnv;
  }

  throw new EnvironmentError('Invalid INDUSTRY_DEPLOYMENT_ENV value', {
    value: value ?? 'undefined',
    allowedValues: VALID_DEPLOYMENT_ENVS,
  });
}

/**
 * Type guard to check if a value is a valid IndustryRegion.
 */
function isValidIndustryRegion(value: unknown): value is IndustryRegion {
  return typeof value === 'string' && VALID_REGION_SET.has(value);
}

/**
 * Parse and validate a Industry region string.
 * Empty/undefined returns Global; unknown non-empty values throw.
 */
export function parseIndustryRegion(value: string | undefined): IndustryRegion {
  if (isValidIndustryRegion(value)) {
    return value;
  }

  if (value !== undefined && value.length > 0) {
    throw new EnvironmentError('Invalid INDUSTRY_REGION value', {
      value,
      allowedValues: VALID_REGIONS,
    });
  }

  return IndustryRegion.Global;
}

/**
 * Resolve a string to a DeploymentEnv value.
 *
 * 1. If value is a valid DeploymentEnv, return it directly
 * 2. If value matches an alias from options.aliases, return the mapped value
 * 3. Otherwise return options.default ?? DeploymentEnv.Localhost
 */
export function resolveDeploymentEnv(
  value: string | undefined,
  options?: ResolveDeploymentEnvOptions
): DeploymentEnv {
  if (value && isDeploymentEnv(value)) {
    return value;
  }

  if (value && options?.aliases?.[value] !== undefined) {
    return options.aliases[value];
  }

  return options?.default ?? DeploymentEnv.Localhost;
}

/**
 * Map a DeploymentEnv to the two-tier IndustryEnv.
 *
 * Production, Staging, and Preprod all map to IndustryEnv.Production.
 * Localhost and Development map to IndustryEnv.Development.
 */
export function getIndustryEnv(deploymentEnv: DeploymentEnv): IndustryEnv {
  switch (deploymentEnv) {
    case DeploymentEnv.Production:
    case DeploymentEnv.Staging:
    case DeploymentEnv.Preprod:
      return IndustryEnv.Production;
    case DeploymentEnv.Localhost:
    case DeploymentEnv.Development:
    default:
      return IndustryEnv.Development;
  }
}

/**
 * Returns true if the given `DeploymentEnv` represents the production tier
 * (Production, Staging, or Preprod). Centralizes the DeploymentEnv → tier
 * mapping so adding new `DeploymentEnv` values has a single, central place
 * to update.
 *
 * Equivalent to the precomputed `isProductionTier` field on
 * `IndustryEnvironment` for the active env.
 */
export function isProductionTier(deploymentEnv: DeploymentEnv): boolean {
  return getIndustryEnv(deploymentEnv) === IndustryEnv.Production;
}

/**
 * Create an immutable IndustryEnvironment from input values.
 * Returns a base environment with empty extras.
 */
export function createEnvironment(
  input: EnvironmentInput
): Readonly<IndustryEnvironment> {
  if (!input.apiBaseUrl) {
    throw new EnvironmentError('apiBaseUrl is required');
  }
  if (!input.appBaseUrl) {
    throw new EnvironmentError('appBaseUrl is required');
  }
  if (!input.downloadsBucket) {
    throw new EnvironmentError('downloadsBucket is required');
  }

  const deploymentEnv =
    input.deploymentEnv ?? INDUSTRY_TO_DEPLOYMENT_ENV[input.env];
  const env = Object.freeze({
    env: input.env,
    deploymentEnv,
    apiBaseUrl: input.apiBaseUrl,
    appBaseUrl: input.appBaseUrl,
    downloadsBucket: input.downloadsBucket,
    downloadsPathPrefix: input.downloadsPathPrefix,
    ...(input.downloadsEndpoint !== undefined && {
      downloadsEndpoint: input.downloadsEndpoint,
    }),
    industryDirName: INDUSTRY_ENV_DIRS[input.env],
    telemetryIngestBaseUrl:
      input.telemetryIngestBaseUrl ??
      (deploymentEnv === DeploymentEnv.Production
        ? 'https://telemetry.example.com'
        : 'https://dev.telemetry.example.com'),
    publicDownloadsBaseUrl:
      input.publicDownloadsBaseUrl ?? 'https://downloads.example.com',
    isProductionTier: input.env !== IndustryEnv.Development,
    featureFlagsSnapshotPath: input.featureFlagsSnapshotPath,
    featureFlagsOverrides: input.featureFlagsOverrides,
    extras: EMPTY_EXTRAS,
  });
  // Register this env as the canonical base env so shared packages can
  // read IndustryEnvironmentBase fields (industryDirName, deploymentEnv, etc.)
  // via getBaseEnv() without needing their own set*Resolver seam.
  setBaseEnv(env);
  return env;
}
