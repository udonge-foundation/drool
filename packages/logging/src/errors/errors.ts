import { MetaError, type ErrorMetadata } from '@industry/common/errors';

// Re-exported so existing `import { MetaError } from '@industry/logging/errors'`
// callers keep working. The canonical definition lives in @industry/common/errors
// to keep @industry/environment (and other leaves) independent of @industry/logging.
// eslint-disable-next-line no-barrel-files/no-barrel-files -- back-compat alias for the many existing consumers of @industry/logging/errors; see #12549.
export { MetaError };

/**
 * A custom error type for fetch operations
 */

export class FetchError extends MetaError {
  response: Response;

  readonly requestUrl?: string;

  readonly isIndustryBackendApi?: boolean;

  constructor(
    errorMessage: string,
    response: Response,
    options?: {
      readonly requestUrl?: string;
      readonly isIndustryBackendApi?: boolean;
    }
  ) {
    // Include status code and actual error message for better debugging
    const message = `${response.status} ${errorMessage || 'Fetch failed'}`;
    super(message, { errorMessage, statusCode: response.status });
    Object.setPrototypeOf(this, FetchError.prototype);
    this.response = response;
    if (options?.requestUrl !== undefined) {
      Object.defineProperty(this, 'requestUrl', {
        value: options.requestUrl,
      });
    }
    if (options?.isIndustryBackendApi !== undefined) {
      Object.defineProperty(this, 'isIndustryBackendApi', {
        value: options.isIndustryBackendApi,
      });
    }
    this.name = 'FetchError';
  }
}

/**
 * Permanent authentication error — no valid token available.
 * Non-retryable: the user must re-authenticate or provide an API key.
 */
export class AuthenticationError extends MetaError {
  constructor(message?: string, options?: ErrorMetadata) {
    super(message ?? 'No access token available', options);
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

export class ToolAbortError extends Error {
  constructor(message: string = 'Tool execution timed out or was cancelled') {
    super(message);
    this.name = 'ToolAbortError';
  }
}
