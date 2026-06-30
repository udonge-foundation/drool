import {
  TOOL_RESULT_CANCELLED_PREFIX,
  TOOL_RESULT_ERROR_PREFIX,
} from '@industry/common/sessionV2';
import { EXIT_SPEC_MODE_REJECTED_MESSAGE } from '@industry/drool-sdk-ext/protocol/drool';

/**
 * Constants for error messages used throughout the application
 */

// Spec mode related error messages
const SPEC_MODE_ERROR_PREFIX = 'Tool cancelled:';
export const SPEC_MODE_ERROR_MESSAGE =
  'Spec mode is active - file edits and other state mutations are not allowed until the spec is approved';
export const SPEC_MODE_FULL_ERROR = `${SPEC_MODE_ERROR_PREFIX} ${SPEC_MODE_ERROR_MESSAGE}`;
export const SPEC_MODE_FULL_ERROR_WITH_PREFIX = `Error: ${SPEC_MODE_FULL_ERROR}`;

// Exit spec mode messages
export const EXIT_SPEC_MODE_REJECTED = EXIT_SPEC_MODE_REJECTED_MESSAGE;

// Generic error prefixes
export const ERROR_PREFIX = TOOL_RESULT_ERROR_PREFIX;
export const TOOL_CANCELLED_PREFIX = TOOL_RESULT_CANCELLED_PREFIX;
