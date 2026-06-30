/**
 * HTTP 4xx statuses are non-retryable except 429 rate limits.
 */
export function isNonRetryableHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}
