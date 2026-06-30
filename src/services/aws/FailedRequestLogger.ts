// Utility functions for failed request logging
// S3 upload logic has been moved to the server-side API endpoint

// Type for error objects that may have status codes in various locations
import { shouldLogFailedRequestStatus } from '@industry/utils/aws/failedRequestPolicy';

type ErrorWithStatus = {
  status?: number;
  statusCode?: number;
  response?: {
    status?: number;
    statusCode?: number;
  };
};

/**
 * Extract status code from error object
 */
export function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;

  const errorObj = error as ErrorWithStatus;
  return (
    errorObj.status ??
    errorObj.statusCode ??
    errorObj.response?.status ??
    errorObj.response?.statusCode
  );
}

/**
 * Check if an error should be logged to S3 based on status code whitelist.
 * Delegates the status policy to a shared helper.
 */
export function shouldLogFailedRequest(error: unknown): boolean {
  const statusCode = extractStatusCode(error);
  return shouldLogFailedRequestStatus(statusCode);
}

/**
 * Serialize error object to JSON string, including non-enumerable properties
 */
export function serializeError(error: unknown): string {
  if (!error) return '{}';

  try {
    // Use Object.getOwnPropertyNames to include non-enumerable properties like 'stack'
    return JSON.stringify(error, Object.getOwnPropertyNames(error));
  } catch {
    // Fallback to basic stringification if the above fails
    return JSON.stringify({
      message: String(error),
      type: typeof error,
    });
  }
}
