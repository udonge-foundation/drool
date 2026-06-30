import { FetchError } from '@industry/logging/errors';
import { OtelTracing } from '@industry/logging/tracing';

import { getIndustryApiConfig } from './config';
import { AirgapBlockedError } from './errors';
import { IndustryApiConfig } from './types';

function urlMatchesBaseUrl(url: string, baseUrl: string): boolean {
  if (!URL.canParse(url) || !URL.canParse(baseUrl)) return false;

  const requestUrl = new URL(url);
  const industryUrl = new URL(baseUrl);
  if (requestUrl.origin !== industryUrl.origin) return false;

  const industryPath = industryUrl.pathname === '/' ? '' : industryUrl.pathname;
  return (
    industryPath === '' ||
    requestUrl.pathname === industryPath ||
    requestUrl.pathname.startsWith(`${industryPath}/`)
  );
}

function getRequestHeaders(input: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  input.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function removeCaseInsensitiveOverriddenHeaders(
  headers: Record<string, string>,
  overridingHeaders: Record<string, string>
): Record<string, string> {
  const overridingHeaderNames = new Set(
    Object.keys(overridingHeaders).map((headerName) => headerName.toLowerCase())
  );

  return Object.fromEntries(
    Object.entries(headers).filter(
      ([headerName]) => !overridingHeaderNames.has(headerName.toLowerCase())
    )
  );
}

/**
 * Enhanced fetch function with Industry API configuration support.
 *
 * **Configuration Note:**
 * The global Industry API configuration is typically set up during Drool initialization
 * via `configureIndustryApi()` in the Drool constructor. This allows all API calls
 * throughout the drool-core to automatically use the correct baseUrl and headers.
 *
 * **Intended Usage:**
 * - **External APIs**: Use normal fetch behavior - just pass `input` and `init`
 *   - No Industry-specific auth tokens or headers are applied
 *   - Preserves existing headers from `init`
 *
 * - **Industry Internal APIs**: Automatically enhanced with auth and config
 *   - Relative URLs (e.g., `/api/sessions/123`) are converted to absolute URLs
 *   - URLs matching the configured baseUrl get Industry auth tokens and headers
 *   - Override config can be provided for per-request customization
 *
 * @param input - URL or Request object (same as native fetch)
 * @param init - RequestInit options (same as native fetch)
 * @param industryApiConfig - Optional override for Industry API configuration
 * @returns Promise<Response> with error handling via FetchError
 *
 * @example
 * // External API - normal fetch behavior
 * await customFetch('https://external-api.com/data', { method: 'GET' });
 *
 * @example
 * // Industry internal API - enhanced with auth
 * await customFetch('/api/sessions/123', { method: 'POST', body: data });
 */
async function customFetch(
  // eslint-disable-next-line no-restricted-globals -- typeof reference; this is the wrapper itself
  input: Parameters<typeof fetch>[0],
  // eslint-disable-next-line no-restricted-globals -- typeof reference; this is the wrapper itself
  init?: Parameters<typeof fetch>[1],
  industryApiConfig?: IndustryApiConfig
): Promise<Response> {
  const industryConfig = industryApiConfig || getIndustryApiConfig();

  const isRequestInput =
    typeof Request !== 'undefined' && input instanceof Request;
  let url = isRequestInput ? input.url : input.toString();
  const fetchOptions = { ...init };
  let isIndustryApiCall = false;

  if (industryConfig) {
    // Determine if this is an internal Industry API call
    const isRelativeUrl = url.startsWith('/');
    isIndustryApiCall =
      isRelativeUrl ||
      Boolean(
        industryConfig.baseUrl && urlMatchesBaseUrl(url, industryConfig.baseUrl)
      );

    // Transform relative URLs to absolute. Prefer the per-call resolver so
    // region-aware callers can pick the regional host on each request; fall
    // back to the static baseUrl otherwise.
    if (isRelativeUrl) {
      const effectiveBaseUrl = industryConfig.getBaseUrl
        ? await industryConfig.getBaseUrl()
        : industryConfig.baseUrl;
      if (effectiveBaseUrl) {
        url = `${effectiveBaseUrl}${url}`;
      }
    }

    if (isIndustryApiCall && industryConfig.airgapEnabled?.()) {
      // INDUSTRY_AIRGAP_ENABLED: refuse to issue any request that would hit
      // the Industry backend / proxy. BYOK and other absolute URLs outside
      // the configured baseUrl fall through to the normal fetch path.
      throw new AirgapBlockedError(url);
    }

    if (isIndustryApiCall) {
      // Internal Industry API: Apply custom headers
      const industryConfigHeaders = industryConfig.getHeaders
        ? await industryConfig.getHeaders()
        : {};

      // Inject trace context for distributed tracing. This helper is the
      // generic non-React fetch path used by SDKs/CLIs; we don't have a
      // closure-captured span context here, so use the current active
      // context explicitly. Callers wanting bulletproof linkage should
      // wrap their own OtelTracing.trace around the call and let the
      // backend's incoming-traceparent extraction wire things up.
      const traceHeaders: Record<string, string> = {};
      OtelTracing.injectContext(traceHeaders, OtelTracing.getCurrentContext());

      const requestHeaders = isRequestInput ? getRequestHeaders(input) : {};
      const initHeaders =
        (fetchOptions.headers as Record<string, string> | undefined) || {};
      const baseHeaders = removeCaseInsensitiveOverriddenHeaders(
        requestHeaders,
        {
          ...industryConfigHeaders,
          ...traceHeaders,
          ...initHeaders,
        }
      );

      const headers: Record<string, string> = {
        ...baseHeaders,
        ...industryConfigHeaders,
        ...traceHeaders,
        ...initHeaders,
      };

      fetchOptions.headers = headers;
    } else if (!isRequestInput || fetchOptions.headers) {
      // External API: Use normal fetch behavior, preserve existing headers only
      fetchOptions.headers = fetchOptions.headers || {};
    }
  } else if (!isRequestInput || fetchOptions.headers) {
    // No config: Standard fetch behavior
    fetchOptions.headers = fetchOptions.headers || {};
  }

  // eslint-disable-next-line no-restricted-globals -- this is the wrapper itself
  const response = await fetch(isRequestInput ? input : url, fetchOptions);

  if (!response.ok) {
    const errorMessage = await response.text();
    throw new FetchError(errorMessage, response, {
      requestUrl: url,
      ...(isIndustryApiCall && { isIndustryBackendApi: true }),
    });
  }

  return response;
}

export { customFetch as fetch };
