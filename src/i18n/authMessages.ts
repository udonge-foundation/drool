import { getI18n } from '@/i18n';

/**
 * User-facing copy for authentication failures, centralized so a wording or
 * fallback change happens once instead of drifting across the CLI, daemon, and
 * TUI surfaces that report auth errors.
 */
function appMessage(key: string, fallback: string): string {
  return getI18n().t(`common:appMessages.${key}`) || fallback;
}

/** Shown when a configured INDUSTRY_API_KEY is rejected or otherwise unusable. */
export function invalidApiKeyMessage(): string {
  return appMessage(
    'authRejectedApiKey',
    'Authentication failed. INDUSTRY_API_KEY is set but appears to be invalid. Unset it or replace it with a valid key.'
  );
}

/** Shown when an interactive login session is expired or required. */
export function expiredLoginMessage(): string {
  return appMessage(
    'authRejectedLogin',
    'Authentication failed. Your provider session may have expired. Please log in again using /provider.'
  );
}
