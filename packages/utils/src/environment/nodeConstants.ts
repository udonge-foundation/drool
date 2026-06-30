import { getBaseEnv } from '@industry/environment';

/**
 * Base URL for the Industry web app (e.g., https://app.example.com).
 *
 * Thin accessor over `getBaseEnv().appBaseUrl`. Prefer reading getBaseEnv()
 * directly when you need more than one field.
 */
export function getIndustryAppBaseUrl(): string {
  return getBaseEnv().appBaseUrl;
}

/**
 * Base URL for Industry API calls (e.g., https://api.example.com).
 *
 * Thin accessor over `getBaseEnv().apiBaseUrl`.
 */
export function getIndustryApiBaseUrl(): string {
  return getBaseEnv().apiBaseUrl;
}

/**
 * Base URL for the OTLP / telemetry ingest endpoint.
 *
 * Thin accessor over `getBaseEnv().telemetryIngestBaseUrl`. The URL is
 * derived by `createEnvironment()` from the app's `deploymentEnv` and the
 * optional `INDUSTRY_TELEMETRY_INGEST_BASE_URL` env var override.
 */
export function getIndustryTelemetryIngestBaseUrl(): string {
  return getBaseEnv().telemetryIngestBaseUrl;
}

/**
 * Base URL for public Industry downloads (CLI installers, updater binaries).
 *
 * Thin accessor over `getBaseEnv().publicDownloadsBaseUrl`. The URL is
 * derived by `createEnvironment()` from the optional
 * `INDUSTRY_PUBLIC_DOWNLOADS_BASE_URL` env var override.
 */
export function getIndustryPublicDownloadsBaseUrl(): string {
  return getBaseEnv().publicDownloadsBaseUrl;
}
