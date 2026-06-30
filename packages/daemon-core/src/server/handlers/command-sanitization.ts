import { MetaError } from '@industry/logging/errors';

// eslint-disable-next-line no-control-regex -- intentional: detecting control chars for security sanitization
const CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Validates that a string is safe to use as a CLI flag value (e.g., --title "X").
 * Rejects control characters and null bytes.
 *
 * Note: Bun.spawn with array args is already safe from shell injection
 * (no shell interpretation). This provides defense-in-depth against
 * argument injection (CWE-88).
 */
export function validateCLIValue(value: string, paramName: string): string {
  if (CONTROL_CHAR_REGEX.test(value)) {
    throw new MetaError('Param contains invalid control characters', {
      name: paramName,
    });
  }
  return value;
}

/**
 * Validates a git ref name (branch, tag).
 * Rejects values that start with "-" (argument injection),
 * values containing ".." (path traversal in git),
 * and control characters.
 */
export function validateGitRef(value: string, paramName: string): string {
  validateCLIValue(value, paramName);
  if (value.startsWith('-')) {
    throw new MetaError('Param must not start with "-"', {
      name: paramName,
    });
  }
  if (value.includes('..')) {
    throw new MetaError('Param must not contain ".."', {
      name: paramName,
    });
  }
  return value;
}
