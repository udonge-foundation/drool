// Constants to avoid magic numbers.
// IMPORTANT: this is currently hardcoded in scrubSecrets.ts due to
// issues with regex and string interpolation.
export const INDUSTRY_API_KEY_PREFIX = 'fk-';
export const SECRET_BYTES = 32;
export const SALT_BYTES = 16;
export const SCRYPT_KEYLEN = 32;
export const FINGERPRINT_LENGTH = 8; // Displayable suffix length

/** 30 days in milliseconds — matches E2B sandbox max lifetime. */
export const SESSION_API_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
