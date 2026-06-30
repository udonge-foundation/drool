/**
 * Type guard for Node.js system errors (ENOENT, EACCES, etc.).
 *
 * Cannot use `instanceof Error` because bun's vitest runtime creates
 * filesystem errors in a different VM realm where the prototype
 * chain doesn't match the test module's `Error` constructor.
 */
export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    typeof err.code === 'string'
  );
}

/**
 * Extract the error code from an unknown caught value.
 * Returns undefined if the value is not an Error with a string `code` property.
 */
export function getErrorCode(error: unknown): string | undefined {
  if (isErrnoException(error)) {
    return error.code;
  }
  return undefined;
}

/**
 * Coerce an unknown caught value into an Error instance.
 * If the value is already an Error, returns it directly.
 * Otherwise wraps it in a new Error with String(value) as the message.
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
