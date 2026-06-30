/**
 * Enums for authentication.
 */

/**
 * Why a validated auth identity could not be resolved.
 *
 * Callers map this to a user-facing (and localized) message at the application
 * layer; this package intentionally stays i18n-free, mirroring how
 * daemon-client surfaces a `ConnectionFailureReason` rather than a message.
 */
export enum AuthFailureReason {
  /** No usable credentials: no API key set and no (refreshable) WorkOS session. */
  Unauthenticated = 'unauthenticated',
  /** A INDUSTRY_API_KEY is configured but the backend rejected it. */
  InvalidApiKey = 'invalid-api-key',
}
