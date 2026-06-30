// Common policy helpers for deciding whether to log failed LLM requests

/**
 * Whitelisted HTTP status codes indicating requests that should be logged.
 */
const FAILED_REQUEST_LOG_STATUS_WHITELIST = new Set<number>([400, 413]);

/**
 * Returns true when the provided status code is in the whitelist.
 */
export function shouldLogFailedRequestStatus(
  statusCode: number | undefined
): boolean {
  if (statusCode == null) return false;
  return FAILED_REQUEST_LOG_STATUS_WHITELIST.has(statusCode);
}
