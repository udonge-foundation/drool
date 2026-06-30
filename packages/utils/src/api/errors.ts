import { MetaError } from '@industry/common/errors';

// eslint-disable-next-line industry/errors-file-organization
import type { ApiResponse } from './response';

/**
 * API error with structured error information
 * Includes status code, request ID, and full response for debugging
 */
export class ApiError extends Error {
  readonly statusCode: number;

  readonly vercelId: string;

  readonly response?: ApiResponse;

  constructor(message: string, response?: ApiResponse) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = response?.status ?? 0;
    this.vercelId = response?.vercelId ?? '';
    this.response = response;
  }
}

/**
 * Thrown by `customFetch` (and `fetchBackend`) when an outbound HTTP request
 * targets the Industry backend / proxy while `INDUSTRY_AIRGAP_ENABLED=true`.
 *
 * Airgap mode is intended for BYOK-only deployments. The CLI must never
 * contact Industry-controlled hosts (telemetry, auto-update, /whoami, usage
 * metrics, cloud sync, etc.) in this mode -- only BYOK provider hosts,
 * user-configured MCP servers, and plugin marketplace `git clone`s.
 *
 * Callers that fire-and-forget background traffic (CloudSync, telemetry
 * exporters, updater) should still try to short-circuit at init time so
 * this error is not raised on every tick.
 */
export class AirgapBlockedError extends MetaError {
  readonly url: string;

  constructor(url: string, options?: { cause?: unknown }) {
    super(
      'Outbound request blocked because Airgap Mode is enabled; only BYOK, MCP, and marketplaces are permitted.',
      { ...options, url }
    );
    Object.setPrototypeOf(this, AirgapBlockedError.prototype);
    this.name = 'AirgapBlockedError';
    this.url = url;
  }
}
