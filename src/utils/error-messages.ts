/**
 * User-friendly error message mappings for tool failures
 * These messages are designed to be less alarming and more actionable
 */

import {
  SPEC_MODE_ERROR_MESSAGE,
  SPEC_MODE_FULL_ERROR,
  ERROR_PREFIX,
} from '@/constants/constants';
import { getI18n } from '@/i18n/index';

export function isUserCancellationMessage(errorText: string): boolean {
  const normalized = errorText.toLowerCase();
  return (
    normalized.includes('cancelled by user') ||
    normalized.includes('interrupted by user')
  );
}

export function getToolErrorMessage(
  toolName: string,
  errorText: string
): string {
  const t = getI18n().t.bind(getI18n());

  // Handle spec mode cancellation - preserve the actual message
  // Check for the spec mode error message
  if (
    errorText.includes(SPEC_MODE_ERROR_MESSAGE) ||
    errorText.includes(SPEC_MODE_FULL_ERROR)
  ) {
    // Remove "Error: " prefix if present for cleaner display
    // Use a simple string replace since ERROR_PREFIX is "Error:"
    if (errorText.startsWith(ERROR_PREFIX)) {
      return errorText.substring(ERROR_PREFIX.length).trim();
    }
    return errorText;
  }

  // Handle common cancellation cases
  if (isUserCancellationMessage(errorText)) {
    return t('errors:operationCancelled');
  }

  // Tool-specific error mappings
  // Each entry maps an error pattern (lowercase) to an i18n key in the errors namespace
  const errorMappings: Record<string, Record<string, string>> = {
    LS: {
      'not found': 'errors:ls.notFound',
      'permission denied': 'errors:ls.permissionDenied',
      'not a directory': 'errors:ls.notADirectory',
      invalid: 'errors:ls.invalid',
      'no such file': 'errors:ls.noSuchFile',
    },
    Create: {
      'already exists': 'errors:create.alreadyExists',
      'permission denied': 'errors:create.permissionDenied',
      'no such file or directory': 'errors:create.noSuchFileOrDirectory',
      'is a directory': 'errors:create.isADirectory',
      'read-only': 'errors:create.readOnly',
    },
    Edit: {
      'text to replace was not found': 'errors:edit.textNotFound',
      'not found': 'errors:edit.notFound',
      'no match found': 'errors:edit.noMatchFound',
      'multiple matches': 'errors:edit.multipleMatches',
      'permission denied': 'errors:edit.permissionDenied',
      'is a directory': 'errors:edit.isADirectory',
    },
    ApplyPatch: {
      'invalid patch': 'errors:applyPatch.invalidPatch',
      'file not found': 'errors:applyPatch.fileNotFound',
      'patch failed': 'errors:applyPatch.patchFailed',
      'hunk failed': 'errors:applyPatch.hunkFailed',
      'permission denied': 'errors:applyPatch.permissionDenied',
    },
  };

  const toolErrors = errorMappings[toolName] || {};
  const lowerError = errorText.toLowerCase();

  // Find matching error pattern
  for (const [pattern, key] of Object.entries(toolErrors)) {
    if (lowerError.includes(pattern)) {
      return t(key);
    }
  }

  // Generic fallback messages based on common patterns
  if (lowerError.includes('permission') || lowerError.includes('denied')) {
    return t('errors:generic.permissionDenied');
  }
  if (lowerError.includes('not found') || lowerError.includes('no such')) {
    return t('errors:generic.notFound');
  }
  if (lowerError.includes('exists')) {
    return t('errors:generic.alreadyExists');
  }
  if (lowerError.includes('invalid') || lowerError.includes('error')) {
    return t('errors:generic.invalid');
  }

  // If no pattern matches, return a generic non-alarming message
  return t('errors:generic.unsuccessful');
}
