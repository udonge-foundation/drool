import { z } from 'zod';

import { DeploymentEnv, resolveDeploymentEnv } from '@industry/environment';

import type {
  LoggerConfig,
  LoggerConfigInput,
  LogToConsoleFunction,
} from './types';

const TRUTHY_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSY_VALUES = new Set(['false', '0', 'no', 'off']);

function parseBoolean(
  value: boolean | string | undefined
): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (TRUTHY_VALUES.has(normalized)) return true;
  if (FALSY_VALUES.has(normalized)) return false;
  return undefined;
}

function parseString(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

const loggerConfigInputSchema: z.ZodType<LoggerConfigInput> = z.object({
  deploymentEnv: z.nativeEnum(DeploymentEnv).optional(),
  sentryEnabled: z.string().optional(),
  backendApiHost: z.string().optional(),
  githubSha: z.string().optional(),
  nextRuntime: z.string().optional(),
  logTimestamps: z.union([z.boolean(), z.string()]).optional(),
  disableConsoleLogsInTests: z.union([z.boolean(), z.string()]).optional(),
  logToConsole: z
    .custom<LogToConsoleFunction>((v) => typeof v === 'function')
    .optional(),
});

function buildLoggerConfig(input: LoggerConfigInput): LoggerConfig {
  const parsed = loggerConfigInputSchema.parse(input);
  return {
    deploymentEnv: parsed.deploymentEnv ?? DeploymentEnv.Localhost,
    sentryEnabled: parsed.sentryEnabled,
    backendApiHost: parsed.backendApiHost,
    githubSha: parsed.githubSha,
    nextRuntime: parsed.nextRuntime,
    logTimestamps: parsed.logTimestamps,
    disableConsoleLogsInTests: parsed.disableConsoleLogsInTests,
    logToConsole: parsed.logToConsole,
  };
}

let seededConfig: LoggerConfig | null = null;

function buildLoggerConfigFromProcessEnv(): LoggerConfig {
  return buildLoggerConfig({
    deploymentEnv: resolveDeploymentEnv(
      // eslint-disable-next-line industry/no-direct-process-env -- seeded DI config file
      process.env.NEXT_PUBLIC_ENV ??
        // eslint-disable-next-line industry/no-direct-process-env -- seeded DI config file
        process.env.VERCEL_ENV ??
        // eslint-disable-next-line industry/no-direct-process-env -- seeded DI config file
        process.env.VITE_VERCEL_ENV,
      { aliases: { dev: DeploymentEnv.Development } }
    ),
    sentryEnabled:
      // eslint-disable-next-line industry/no-direct-process-env -- seeded DI config file
      process.env.LOGGING_SENTRY_ENABLED ?? process.env.BACKEND_SENTRY_ENABLED,
    backendApiHost:
      // eslint-disable-next-line industry/no-direct-process-env -- seeded DI config file
      process.env.LOGGING_BACKEND_API_HOST ?? process.env.VITE_BACKEND_API_HOST,
    // eslint-disable-next-line industry/no-direct-process-env -- seeded DI config file
    githubSha: process.env.GITHUB_SHA,
    // eslint-disable-next-line industry/no-direct-process-env -- seeded DI config file
    nextRuntime: process.env.NEXT_RUNTIME,
    // eslint-disable-next-line industry/no-direct-process-env -- seeded DI config file
    logTimestamps: process.env.LOG_TIMESTAMPS,
    // eslint-disable-next-line industry/no-direct-process-env -- seeded DI config file
    disableConsoleLogsInTests: process.env.DISABLE_CONSOLE_LOGS_IN_TESTS,
  });
}

function getLoggerConfig(): LoggerConfig {
  if (!seededConfig) {
    seededConfig = buildLoggerConfigFromProcessEnv();
  }
  return seededConfig;
}

/**
 * Seed the package-level logger configuration. Call once at the composition
 * root of each app (apps/web, apps/cli, apps/backend, …). Mirrors
 * `setFirebaseConfig`, `setStripeConfig`, etc. from `packages/services`.
 */
export function setLoggerConfig(input: LoggerConfigInput): void {
  seededConfig = buildLoggerConfig(input);
}

/**
 * Install or replace the custom `logToConsole` sink on the seeded config.
 * Use this when the telemetry client is created AFTER the app's initial
 * `setLoggerConfig(...)` call (e.g. CLI/desktop initialize the
 * NodeTelemetryClient lazily at module load time). If the config hasn't
 * been seeded yet, the process.env fallback is materialized first.
 */
export function setLogToConsole(fn: LogToConsoleFunction): void {
  const current = getLoggerConfig();
  seededConfig = { ...current, logToConsole: fn };
}

// ---- Derived predicates (replace the old Logger interface methods) ----

export function isSentryEnabledFromConfig(): boolean {
  const c = getLoggerConfig();
  const sentryOverride = parseString(c.sentryEnabled);
  return c.deploymentEnv !== DeploymentEnv.Localhost || Boolean(sentryOverride);
}

export function isProductionDeployment(): boolean {
  return getLoggerConfig().deploymentEnv === DeploymentEnv.Production;
}

export function shouldLogTimestamps(): boolean {
  return parseBoolean(getLoggerConfig().logTimestamps) ?? false;
}

export function shouldDisableConsoleLogsInTests(): boolean {
  const c = getLoggerConfig();
  return (
    c.deploymentEnv === DeploymentEnv.Localhost &&
    (parseBoolean(c.disableConsoleLogsInTests) ?? false)
  );
}

export function getGithubSha(): string | undefined {
  return parseString(getLoggerConfig().githubSha);
}

/**
 * INTERNAL: returns just the override `logToConsole` from the seeded config
 * (without pulling in the default pino-backed sink). Callers that need the
 * fallback should use `./getLogToConsole.ts` instead.
 */
export function getSeededLogToConsole(): LogToConsoleFunction | undefined {
  return getLoggerConfig().logToConsole;
}
