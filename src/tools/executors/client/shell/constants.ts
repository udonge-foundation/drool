export const MAX_CHARACTER_LIMIT = 12000;
export const MIDDLE_MESSAGE = '[... output too long to summarize ...]';

/**
 * Maximum stdout/stderr buffer for git invocations made by the secret
 * scanner. Diffs larger than this are blocked via the fail-closed branch
 * rather than silently allowed. See FAC-18955.
 */
export const SECRET_SCANNER_MAX_BUFFER = 64 * 1024 * 1024;
