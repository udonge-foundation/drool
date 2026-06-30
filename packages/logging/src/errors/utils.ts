import { FetchError } from './errors';

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function getResponseStatus(response: unknown): number | undefined {
  if (!isRecord(response)) return undefined;
  const { status } = response;
  return typeof status === 'number' ? status : undefined;
}

function getResponseUrl(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  const { url } = response;
  return typeof url === 'string' && url.length > 0 ? url : undefined;
}

const DROOL_CORE_LLM_REQUEST_ERROR_PROPERTY = 'isDroolCoreLlmRequestError';

function getErrorCause(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

/**
 * Extracts the HTTP status from a FetchError, including duck-typed instances
 * created across module boundaries.
 */
function getFetchErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;

  if (error instanceof FetchError) {
    return getResponseStatus(error.response);
  }

  if (error.name !== 'FetchError') return undefined;

  return getResponseStatus(error.response);
}

function getFetchErrorRequestUrl(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;

  const { requestUrl } = error;
  if (typeof requestUrl === 'string' && requestUrl.length > 0) {
    return requestUrl;
  }

  return getResponseUrl(error.response);
}

function getFetchErrorIndustryBackendFlag(error: unknown): boolean | undefined {
  if (!isRecord(error)) return undefined;

  const { isIndustryBackendApi } = error;
  return typeof isIndustryBackendApi === 'boolean'
    ? isIndustryBackendApi
    : undefined;
}

function isIndustryBackendHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === 'api.example.com' ||
    normalizedHostname === 'dev.api.example.com' ||
    normalizedHostname === 'localhost' ||
    normalizedHostname === '127.0.0.1' ||
    normalizedHostname === '::1' ||
    normalizedHostname === '[::1]'
  );
}

function isIndustryBackendUrl(url: string): boolean {
  try {
    return isIndustryBackendHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isDroolCoreLlmRequestError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error[DROOL_CORE_LLM_REQUEST_ERROR_PROPERTY] === true;
}

/**
 * Type guard to check if an error is a FetchError
 */
export function isFetchError(err: unknown): err is FetchError {
  return err instanceof Error && getFetchErrorStatus(err) !== undefined;
}

export function isFetchErrorWithStatus(
  error: unknown,
  statuses: readonly number[]
): boolean {
  const status = getFetchErrorStatus(error);
  return status !== undefined && statuses.includes(status);
}

function isDirectIndustryBackendFetchError(error: unknown): boolean {
  if (!isFetchError(error)) return false;

  const explicitIndustryBackendFlag = getFetchErrorIndustryBackendFlag(error);
  if (explicitIndustryBackendFlag !== undefined) {
    return explicitIndustryBackendFlag;
  }

  const requestUrl = getFetchErrorRequestUrl(error);
  return requestUrl !== undefined && isIndustryBackendUrl(requestUrl);
}

/**
 * Industry backend fetches are identifiable from FetchError request metadata,
 * but drool-core LLM SDK/proxy failures often surface as provider-specific
 * errors without request URLs. Check both the FetchError metadata and the
 * explicit drool-core marker so logException can keep these request failures
 * at warning severity while preserving error-level logging for generic client
 * errors.
 */
export function isIndustryBackendWarningError(error: unknown): boolean {
  let currentError: unknown = error;
  let depth = 0;

  while (currentError && depth < 3) {
    if (
      isDirectIndustryBackendFetchError(currentError) ||
      isDroolCoreLlmRequestError(currentError)
    ) {
      return true;
    }

    currentError = getErrorCause(currentError);
    depth++;
  }

  return false;
}

export function markDroolCoreLlmRequestError(error: unknown): void {
  if (!isRecord(error)) return;

  try {
    Object.defineProperty(error, DROOL_CORE_LLM_REQUEST_ERROR_PROPERTY, {
      value: true,
      configurable: true,
    });
  } catch {
    // Ignore non-extensible SDK error objects.
  }
}
