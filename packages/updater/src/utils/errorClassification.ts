/**
 * Classify update failures into actionable categories so UIs can show
 * specific guidance instead of a raw system-error code.
 *
 * Keep this module pure (no i18n, no env inspection, no side effects) so it
 * can be consumed identically from the CLI, daemon, and tests.
 */

import { getErrorCode } from '@industry/utils/errors';

import { UpdateErrorCategory } from '../enums';

const FILE_LOCKED_CODES = new Set(['EBUSY', 'ETXTBSY']);
const PERMISSION_CODES = new Set(['EACCES', 'EPERM']);
const DISK_FULL_CODES = new Set(['ENOSPC']);
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'EPROTO',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

const VERIFICATION_MESSAGE_PATTERNS = [
  /checksum (?:mismatch|invalid|did not match|verification)/i,
  /signature (?:invalid|verification failed|could not be verified)/i,
  /integrity (?:check failed|mismatch|violation)/i,
  /hash mismatch/i,
];

const NETWORK_MESSAGE_PATTERNS = [
  /\bfetch failed\b/i,
  /\bnetwork\b/i,
  // Match "HTTP 500", "HTTP/1.1 500", or "HTTP/2 500". The optional
  // "/<major>[.<minor>]" covers the `response.statusLine`-style strings
  // returned by several HTTP libraries in addition to the bare form.
  /\bhttp(?:\/\d(?:\.\d)?)?\s+\d{3}\b/i,
  /\bstatus (?:code )?\d{3}\b/i,
  /\btimeout\b/i,
];

/**
 * Classify an update failure into an actionable category.
 *
 * Inspects the error's Node.js `code` first (most reliable), then falls back
 * to lightweight message-pattern matching for errors that don't carry a code
 * (e.g., fetch failures, checksum mismatches thrown as plain `Error`s).
 */
export function classifyUpdateError(error: unknown): UpdateErrorCategory {
  const code = getErrorCode(error);

  if (code !== undefined) {
    if (FILE_LOCKED_CODES.has(code)) return UpdateErrorCategory.FileLocked;
    if (PERMISSION_CODES.has(code)) return UpdateErrorCategory.PermissionDenied;
    if (DISK_FULL_CODES.has(code)) return UpdateErrorCategory.DiskFull;
    if (NETWORK_CODES.has(code)) return UpdateErrorCategory.Network;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';

  if (message.length > 0) {
    if (VERIFICATION_MESSAGE_PATTERNS.some((re) => re.test(message))) {
      return UpdateErrorCategory.VerificationFailed;
    }
    if (NETWORK_MESSAGE_PATTERNS.some((re) => re.test(message))) {
      return UpdateErrorCategory.Network;
    }
  }

  return UpdateErrorCategory.Unknown;
}
