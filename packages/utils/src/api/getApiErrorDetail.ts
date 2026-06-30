import { ApiError } from './errors';

/**
 * Extract the human-readable `detail` field from an ApiError's response body
 * (RFC 7807 / ResponseError shape). Returns null if the error is not an
 * ApiError or the body has no string `detail`. Use this to surface the
 * server's user-facing message in the UI without having to parse the
 * `HTTP <status>:` prefix that `useApi` prepends to `error.message`.
 */
export function getApiErrorDetail(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const data = error.response?.data;
  if (!data || typeof data !== 'object') return null;
  const detail = (data as { detail?: unknown }).detail;
  if (typeof detail !== 'string') return null;
  return detail.trim() ? detail : null;
}
