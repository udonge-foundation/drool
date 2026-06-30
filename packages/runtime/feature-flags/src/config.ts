import { z } from 'zod';

import type { FeatureFlagConfig } from './types';

const featureFlagConfigSchema: z.ZodType<FeatureFlagConfig> = z.object({
  featureFlagsSnapshotPath: z.string().optional(),
  featureFlagsOverrides: z.string().optional(),
});

export function buildFeatureFlagConfig(
  input: FeatureFlagConfig
): FeatureFlagConfig {
  return featureFlagConfigSchema.parse(input);
}

let seededFeatureFlagConfig: FeatureFlagConfig | null = null;

export function setFeatureFlagConfig(config: FeatureFlagConfig): void {
  seededFeatureFlagConfig = config;
}

/**
 * Pure derivation of FeatureFlagConfig from any `NodeJS.ProcessEnv`-shaped bag.
 */
function buildFeatureFlagConfigFromEnv(
  env: NodeJS.ProcessEnv
): FeatureFlagConfig {
  return buildFeatureFlagConfig({
    featureFlagsSnapshotPath:
      env.INDUSTRY_FEATURE_FLAGS_SNAPSHOT_PATH || undefined,
    featureFlagsOverrides: env.INDUSTRY_FEATURE_FLAGS_OVERRIDES || undefined,
  });
}

function buildFeatureFlagConfigFromProcessEnv(): FeatureFlagConfig {
  // eslint-disable-next-line industry/no-direct-process-env -- seeded DI config file
  return buildFeatureFlagConfigFromEnv(process.env);
}

export function getFeatureFlagConfig(): FeatureFlagConfig {
  if (!seededFeatureFlagConfig) {
    seededFeatureFlagConfig = buildFeatureFlagConfigFromProcessEnv();
  }
  return seededFeatureFlagConfig;
}

/** Reset seeded config. Exported for test isolation only. */
export function _resetFeatureFlagConfigForTesting(): void {
  seededFeatureFlagConfig = null;
}
