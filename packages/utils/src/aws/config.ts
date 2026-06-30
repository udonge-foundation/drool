import { z } from 'zod';

import { IndustryRegion } from '@industry/common/shared';
import {
  IndustryEnv,
  getIndustryEnv,
  resolveDeploymentEnv,
} from '@industry/environment';
import { EnvironmentError } from '@industry/environment/errors';

import type { AwsConfig } from './types';

const awsConfigSchema: z.ZodType<AwsConfig> = z.object({
  accessKey: z.string().optional(),
  secretAccessKey: z.string().optional(),
  sessionToken: z.string().optional(),
  droolExecuteQueueUrl: z.string().optional(),
  orgEventsQueueUrl: z.string().optional(),
  isDev: z.boolean(),
  region: z.nativeEnum(IndustryRegion).optional(),
});

export function buildAwsConfig(input: AwsConfig): AwsConfig {
  return awsConfigSchema.parse(input);
}

let seededAwsConfig: AwsConfig | null = null;

export function setAwsConfig(config: AwsConfig): void {
  seededAwsConfig = config;
}

function resolveIsDevFromEnv(env: NodeJS.ProcessEnv): boolean {
  const deploymentEnv = resolveDeploymentEnv(
    env.INDUSTRY_DEPLOYMENT_ENV ?? env.INDUSTRY_ENV ?? env.NEXT_PUBLIC_ENV
  );
  return getIndustryEnv(deploymentEnv) !== IndustryEnv.Production;
}

/**
 * Pure derivation of AwsConfig from any `NodeJS.ProcessEnv`-shaped bag.
 */
function buildAwsConfigFromEnv(env: NodeJS.ProcessEnv): AwsConfig {
  return buildAwsConfig({
    accessKey: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    droolExecuteQueueUrl: env.AWS_DROOL_EXECUTE_QUEUE_URL,
    orgEventsQueueUrl: env.AWS_ORG_EVENTS_QUEUE_URL,
    isDev: resolveIsDevFromEnv(env),
  });
}

function buildAwsConfigFromProcessEnv(): AwsConfig {
  // eslint-disable-next-line industry/no-direct-process-env -- seeded DI config file
  return buildAwsConfigFromEnv(process.env);
}

export function getAwsConfig(): AwsConfig {
  if (!seededAwsConfig) {
    seededAwsConfig = buildAwsConfigFromProcessEnv();
  }

  return seededAwsConfig;
}

/**
 * Read the residency region from {@link AwsConfig}. Throws if it hasn't
 * been seeded — only callers that genuinely fork on region (the EU/US
 * OpenAI key + base-URL selection in `./secrets.ts`) should use this.
 * Non-region-sensitive AWS code should read {@link getAwsConfig} directly.
 */
export function getAwsConfigRegion(): IndustryRegion {
  const { region } = getAwsConfig();
  if (!region) {
    throw new EnvironmentError(
      'AwsConfig.region is not set. The backend composition root must seed it via setAwsConfig({..., region: env.region}) before any region-sensitive AWS code path is invoked.'
    );
  }
  return region;
}
