/**
 * A short marker included in every delegated-session auto-reject
 * system-reminder so that tests (and future diagnostics) can identify
 * that a Cancel was produced by the permission gate rather than by a
 * real user. Used by both mission workers and subagent sessions.
 */
export const DELEGATED_PERMISSION_AUTO_REJECT_MARKER = '[delegated-auto-deny]';
