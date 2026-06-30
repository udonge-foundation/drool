import { z } from 'zod';

import { MachineType } from '@industry/common/daemon';
import {
  EnvironmentVariable,
  createEnvLoader,
  createEnvironment,
  parseDeploymentEnv,
  parseIndustryEnv,
  parsePositiveIntEnv,
  resolveEnv,
  resolveHomeDir,
  resolveShell,
} from '@industry/environment';
import * as logging from '@industry/logging';
import {
  buildWorkosConfig,
  getCachedRegion,
  setWorkosConfig,
} from '@industry/runtime/auth';
import {
  setFeatureFlagConfig,
  buildFeatureFlagConfig,
} from '@industry/runtime/feature-flags/config';
import { buildAwsConfig, setAwsConfig } from '@industry/utils/aws/config';

import type { RuntimeAuthConfig } from '@industry/runtime/auth';

const VALID_MACHINE_TYPES = new Set<string>(Object.values(MachineType));

function parseMachineType(value: string | undefined): MachineType | undefined {
  if (value && VALID_MACHINE_TYPES.has(value)) {
    return value as MachineType;
  }
  return undefined;
}

function isTestRuntime(source: NodeJS.ProcessEnv): boolean {
  return source.NODE_ENV === 'test' || source.VITEST_WORKER_ID != null;
}

// Build-time defines injected by bun build --define in scripts/build-sea.ts.
// Replaced at compile time with string literals.
// Use typeof checks to safely access - these don't exist when running unbundled.
declare const __INDUSTRY_ENV__: string | undefined;
declare const __INDUSTRY_DEPLOYMENT_ENV__: string | undefined;
declare const __INDUSTRY_API_BASE_URL__: string | undefined;
declare const __INDUSTRY_API_BASE_URL_EU__: string | undefined;
declare const __INDUSTRY_APP_BASE_URL__: string | undefined;
declare const __INDUSTRY_DOWNLOADS_BUCKET__: string | undefined;
declare const __INDUSTRY_DOWNLOADS_PREFIX__: string | undefined;
declare const __INDUSTRY_AUTO_UPDATE_ENABLED__: boolean | undefined;
declare const __INDUSTRY_AIRGAP_ENABLED__: boolean | undefined;

// Safe accessors for build-time defines (typeof check avoids ReferenceError when unbundled)
const buildDefines = {
  env: typeof __INDUSTRY_ENV__ !== 'undefined' ? __INDUSTRY_ENV__ : undefined,
  deploymentEnv:
    typeof __INDUSTRY_DEPLOYMENT_ENV__ !== 'undefined'
      ? __INDUSTRY_DEPLOYMENT_ENV__
      : undefined,
  apiBaseUrl:
    typeof __INDUSTRY_API_BASE_URL__ !== 'undefined'
      ? __INDUSTRY_API_BASE_URL__
      : undefined,
  apiBaseUrlEu:
    typeof __INDUSTRY_API_BASE_URL_EU__ !== 'undefined'
      ? __INDUSTRY_API_BASE_URL_EU__
      : undefined,
  appBaseUrl:
    typeof __INDUSTRY_APP_BASE_URL__ !== 'undefined'
      ? __INDUSTRY_APP_BASE_URL__
      : undefined,
  downloadsBucket:
    typeof __INDUSTRY_DOWNLOADS_BUCKET__ !== 'undefined'
      ? __INDUSTRY_DOWNLOADS_BUCKET__
      : undefined,
  downloadsPrefix:
    typeof __INDUSTRY_DOWNLOADS_PREFIX__ !== 'undefined'
      ? __INDUSTRY_DOWNLOADS_PREFIX__
      : undefined,
  autoUpdateEnabled:
    typeof __INDUSTRY_AUTO_UPDATE_ENABLED__ !== 'undefined'
      ? __INDUSTRY_AUTO_UPDATE_ENABLED__
      : undefined,
  airgapEnabled:
    typeof __INDUSTRY_AIRGAP_ENABLED__ !== 'undefined'
      ? __INDUSTRY_AIRGAP_ENABLED__
      : undefined,
};

/**
 * Resolve auto-update enabled status.
 *
 * Priority:
 * 1. INDUSTRY_DROOL_AUTO_UPDATE_ENABLED env var (if 'false' or '0', disabled)
 * 2. Build-time constant from --disable-auto-update flag in build-sea.ts
 * 3. Defaults to true (enabled) when not defined
 */
function resolveAutoUpdateEnabled(source: NodeJS.ProcessEnv): boolean {
  const envValue =
    source[EnvironmentVariable.INDUSTRY_DROOL_AUTO_UPDATE_ENABLED];
  if (envValue === 'false' || envValue === '0') {
    return false;
  }
  if (envValue === 'true' || envValue === '1') {
    return true;
  }
  return buildDefines.autoUpdateEnabled ?? true;
}

/**
 * Resolve INDUSTRY_AIRGAP_ENABLED.
 *
 * Airgap is forced on for this distribution and cannot be disabled at runtime.
 */
function resolveAirgapEnabled(_source: NodeJS.ProcessEnv): boolean {
  return true;
}

const cliSourceSchema = z
  .object({
    industryEnv: z.string().optional(),
    deploymentEnv: z.string().optional(),
    apiBaseUrl: z.string(),
    apiBaseUrlEu: z.string(),
    appBaseUrl: z.string(),
    downloadsBucket: z.string(),
    downloadsPathPrefix: z.string(),
    featureFlagsSnapshotPath: z.string().optional(),
    featureFlagsOverrides: z.string().optional(),
    telemetryIngestBaseUrl: z.string().optional(),
    publicDownloadsBaseUrl: z.string().optional(),
    autoUpdateEnabled: z.boolean(),
    shell: z.string(),
    homeDir: z.string(),
    remoteMachineId: z.string().optional(),
    disableDynamicConfig: z.boolean(),
    disableIncrementalRendering: z.boolean(),
    e2eMockLlm: z.boolean(),
    enableReadinessReport: z.boolean(),
    machineType: z.nativeEnum(MachineType).optional(),
    runtimeAuthWorkosBaseUrl: z.string().optional(),
    runtimeAuthApiKey: z.string().optional(),
    runtimeAuthTestingBypassTokenPassword: z.string().optional(),
    runtimeAuthDisableKeyring: z.boolean(),
    runtimeAuthAirgapEnabled: z.boolean(),
    logRotationMaxBytesPerFragment: z.number().int().nonnegative().optional(),
    logRotationMaxDays: z.number().int().nonnegative().optional(),
    logRotationMaxTotalBytes: z.number().int().nonnegative().optional(),
  })
  .transform((source) => ({
    ...createEnvironment({
      env: parseIndustryEnv(source.industryEnv),
      deploymentEnv: parseDeploymentEnv(source.deploymentEnv),
      apiBaseUrl: source.apiBaseUrl,
      appBaseUrl: source.appBaseUrl,
      downloadsBucket: source.downloadsBucket,
      downloadsPathPrefix: source.downloadsPathPrefix,
      featureFlagsSnapshotPath: source.featureFlagsSnapshotPath,
      featureFlagsOverrides: source.featureFlagsOverrides,
      telemetryIngestBaseUrl: source.telemetryIngestBaseUrl,
      publicDownloadsBaseUrl: source.publicDownloadsBaseUrl,
    }),
    apiBaseUrlEu: source.apiBaseUrlEu,
    extras: {
      autoUpdateEnabled: source.autoUpdateEnabled,
      shell: source.shell,
      homeDir: source.homeDir,
      remoteMachineId: source.remoteMachineId,
      disableDynamicConfig: source.disableDynamicConfig,
      disableIncrementalRendering: source.disableIncrementalRendering,
      e2eMockLlm: source.e2eMockLlm,
      enableReadinessReport: source.enableReadinessReport,
      machineType: source.machineType,
      runtimeAuthWorkosBaseUrl: source.runtimeAuthWorkosBaseUrl,
      runtimeAuthApiKey: source.runtimeAuthApiKey,
      runtimeAuthTestingBypassTokenPassword:
        source.runtimeAuthTestingBypassTokenPassword,
      runtimeAuthDisableKeyring: source.runtimeAuthDisableKeyring,
      runtimeAuthAirgapEnabled: source.runtimeAuthAirgapEnabled,
      logRotationMaxBytesPerFragment: source.logRotationMaxBytesPerFragment,
      logRotationMaxDays: source.logRotationMaxDays,
      logRotationMaxTotalBytes: source.logRotationMaxTotalBytes,
    },
  }));

type CliEnvironment = z.infer<typeof cliSourceSchema>;

function preprocessCliSource(source: NodeJS.ProcessEnv) {
  return {
    industryEnv: source[EnvironmentVariable.INDUSTRY_ENV] ?? buildDefines.env,
    deploymentEnv:
      source[EnvironmentVariable.INDUSTRY_DEPLOYMENT_ENV] ??
      buildDefines.deploymentEnv,
    apiBaseUrl: resolveEnv({
      name: EnvironmentVariable.INDUSTRY_API_BASE_URL,
      define: buildDefines.apiBaseUrl,
      overrideName: 'INDUSTRY_API_BASE_URL',
    }),
    apiBaseUrlEu: resolveEnv({
      name: EnvironmentVariable.INDUSTRY_API_BASE_URL_EU,
      define: buildDefines.apiBaseUrlEu,
      overrideName: 'INDUSTRY_API_BASE_URL_EU',
    }),
    appBaseUrl: resolveEnv({
      name: EnvironmentVariable.INDUSTRY_APP_BASE_URL,
      define: buildDefines.appBaseUrl,
      overrideName: 'INDUSTRY_APP_BASE_URL',
    }),
    downloadsBucket: resolveEnv({
      name: EnvironmentVariable.INDUSTRY_DOWNLOADS_BUCKET,
      define: buildDefines.downloadsBucket,
      overrideName: 'INDUSTRY_DOWNLOADS_BUCKET',
    }),
    downloadsPathPrefix:
      source.INDUSTRY_DOWNLOADS_PREFIX ??
      resolveEnv({
        name: EnvironmentVariable.INDUSTRY_DOWNLOADS_PREFIX,
        define: buildDefines.downloadsPrefix,
        fallback: '',
      }),
    featureFlagsSnapshotPath: resolveEnv({
      name: EnvironmentVariable.INDUSTRY_FEATURE_FLAGS_SNAPSHOT_PATH,
    }),
    featureFlagsOverrides: resolveEnv({
      name: EnvironmentVariable.INDUSTRY_FEATURE_FLAGS_OVERRIDES,
    }),
    telemetryIngestBaseUrl: resolveEnv({
      name: EnvironmentVariable.INDUSTRY_TELEMETRY_INGEST_BASE_URL,
    }),
    publicDownloadsBaseUrl: resolveEnv({
      name: EnvironmentVariable.INDUSTRY_PUBLIC_DOWNLOADS_BASE_URL,
    }),
    autoUpdateEnabled: resolveAutoUpdateEnabled(source),
    shell: resolveShell(),
    homeDir: resolveHomeDir(),
    remoteMachineId: resolveEnv({
      name: EnvironmentVariable.REMOTE_MACHINE_ID,
    }),
    disableDynamicConfig:
      resolveEnv({
        name: EnvironmentVariable.INDUSTRY_DISABLE_DYNAMIC_CONFIG,
      }) === 'true',
    disableIncrementalRendering:
      resolveEnv({
        name: EnvironmentVariable.INDUSTRY_DISABLE_INCREMENTAL_RENDERING,
      }) === 'true',
    e2eMockLlm: source.E2E_MOCK_LLM === 'true',
    enableReadinessReport:
      resolveEnv({
        name: EnvironmentVariable.ENABLE_READINESS_REPORT,
      }) === 'true',
    machineType: parseMachineType(
      resolveEnv({ name: EnvironmentVariable.INDUSTRY_MACHINE_TYPE })
    ),
    runtimeAuthWorkosBaseUrl: resolveEnv({ name: 'INDUSTRY_WORKOS_BASE_URL' }),
    runtimeAuthApiKey: resolveEnv({ name: 'INDUSTRY_API_KEY' }),
    runtimeAuthTestingBypassTokenPassword: resolveEnv({
      name: 'TESTING_BYPASS_TOKEN_PASSWORD',
    }),
    runtimeAuthDisableKeyring: ['1', 'true'].includes(
      (
        resolveEnv({ name: 'INDUSTRY_DISABLE_KEYRING', fallback: '' }) ?? ''
      ).toLowerCase()
    ),
    runtimeAuthAirgapEnabled: resolveAirgapEnabled(source),
    logRotationMaxBytesPerFragment: parsePositiveIntEnv(
      source[EnvironmentVariable.INDUSTRY_LOG_MAX_BYTES]
    ),
    logRotationMaxDays: parsePositiveIntEnv(
      source[EnvironmentVariable.INDUSTRY_LOG_MAX_DAYS]
    ),
    logRotationMaxTotalBytes: parsePositiveIntEnv(
      source[EnvironmentVariable.INDUSTRY_LOG_MAX_TOTAL_BYTES]
    ),
  };
}

const { getEnv: getLoadedEnv } = createEnvLoader({
  schema: cliSourceSchema,
  getSource: () => process.env,
  preprocess: preprocessCliSource,
});

let initialized = false;

export function getEnv(): Readonly<CliEnvironment> {
  return getLoadedEnv();
}

export function getRuntimeAuthConfig(): RuntimeAuthConfig {
  const env = getEnv();
  return {
    apiBaseUrl: env.apiBaseUrl,
    apiBaseUrlEu: env.apiBaseUrlEu,
    workosBaseUrl: env.extras.runtimeAuthWorkosBaseUrl,
    apiKey: env.extras.runtimeAuthApiKey,
    testingBypassTokenPassword:
      env.extras.runtimeAuthTestingBypassTokenPassword,
    disableKeyring: env.extras.runtimeAuthDisableKeyring,
    airgapEnabled: env.extras.runtimeAuthAirgapEnabled,
  };
}

/**
 * Initialize CLI environment values.
 * Must be called once at application startup before the first environment read.
 */
export function initializeEnvironment(): void {
  if (!isTestRuntime(process.env) && initialized) {
    return;
  }

  initialized = true;
  const env = getEnv();

  logging.setLoggerConfig({
    deploymentEnv: env.deploymentEnv,
    backendApiHost: env.apiBaseUrl,
    githubSha: process.env.GITHUB_SHA,
  });
  // CLI/daemon serves one org for its lifetime, so pin once instead of
  // wrapping every async boundary; gates EU-only content redaction.
  logging.setRegionResolver(() => getCachedRegion());
  setAwsConfig(
    buildAwsConfig({
      accessKey: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      droolExecuteQueueUrl: process.env.AWS_DROOL_EXECUTE_QUEUE_URL,
      orgEventsQueueUrl: process.env.AWS_ORG_EVENTS_QUEUE_URL,
      isDev: !env.isProductionTier,
    })
  );
  setWorkosConfig(
    buildWorkosConfig({
      clientId: process.env.NEXT_PUBLIC_WORKOS_CLIENT_ID,
      industryEnv: env.env,
    })
  );
  setFeatureFlagConfig(
    buildFeatureFlagConfig({
      featureFlagsSnapshotPath: env.featureFlagsSnapshotPath,
      featureFlagsOverrides: env.featureFlagsOverrides,
    })
  );
}
