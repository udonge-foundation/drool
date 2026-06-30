import { z } from 'zod';

import {
  DEV_WORKOS_CLIENT_ID,
  PROD_WORKOS_CLIENT_ID,
} from '@industry/common/workos';
import { IndustryEnv, parseIndustryEnv } from '@industry/environment';

import type { WorkosConfig, WorkosConfigInput } from './types';

const workosConfigSchema: z.ZodType<WorkosConfig> = z.object({
  clientId: z.string().min(1),
  industryEnv: z.nativeEnum(IndustryEnv),
});

/**
 * Returns the public WorkOS client ID for the given industry env. Used internally
 * by `buildWorkosConfig` as the fallback when no explicit `clientId` is provided.
 */
function getPublicWorkosClientId(industryEnv: IndustryEnv): string {
  return industryEnv === IndustryEnv.Production
    ? PROD_WORKOS_CLIENT_ID
    : DEV_WORKOS_CLIENT_ID;
}

/**
 * Build a `WorkosConfig` from raw input. Defaults `industryEnv` to
 * `IndustryEnv.Development` when omitted, and falls back from a
 * caller-supplied `clientId` (typically `NEXT_PUBLIC_WORKOS_CLIENT_ID` from
 * env) to the hardcoded public Industry client for the resolved env.
 * Throws on schema violations.
 */
export function buildWorkosConfig(input: WorkosConfigInput): WorkosConfig {
  const industryEnv = input.industryEnv ?? IndustryEnv.Development;
  return workosConfigSchema.parse({
    clientId: input.clientId || getPublicWorkosClientId(industryEnv),
    industryEnv,
  });
}

let seededWorkosConfig: WorkosConfig | null = null;

export function setWorkosConfig(config: WorkosConfig): void {
  seededWorkosConfig = config;
}

/**
 * Pure derivation of WorkosConfig from any `NodeJS.ProcessEnv`-shaped bag.
 * All defaulting/fallback logic lives in `buildWorkosConfig`; this is just a
 * name mapping.
 */
function buildWorkosConfigFromEnv(env: NodeJS.ProcessEnv): WorkosConfig {
  return buildWorkosConfig({
    clientId: env.NEXT_PUBLIC_WORKOS_CLIENT_ID,
    industryEnv: parseIndustryEnv(env.INDUSTRY_ENV),
  });
}

function buildWorkosConfigFromProcessEnv(): WorkosConfig {
  // eslint-disable-next-line industry/no-direct-process-env -- seeded DI config file
  return buildWorkosConfigFromEnv(process.env);
}

export function getWorkosConfig(): WorkosConfig {
  if (!seededWorkosConfig) {
    seededWorkosConfig = buildWorkosConfigFromProcessEnv();
  }

  return seededWorkosConfig;
}
