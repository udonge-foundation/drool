import { EnvironmentVariable } from '@industry/environment';
import { AuthFailureReason } from '@industry/runtime/auth';

import { getI18n } from '@/i18n';
import { invalidApiKeyMessage } from '@/i18n/authMessages';

/**
 * Localize an auth failure. This is the one place that turns the runtime auth
 * package's machine-readable {@link AuthFailureReason} into user-facing copy,
 * so entrypoints never re-implement the message logic. The copy itself lives in
 * the shared auth-message module so it stays in sync across surfaces.
 */
function authFailureMessage(reason: AuthFailureReason): string {
  if (reason === AuthFailureReason.InvalidApiKey) {
    // INDUSTRY_API_KEY takes precedence over any stored WorkOS session
    // (CLI-135), so surface that the key itself is invalid rather than the
    // generic "log in or set a key" message, which misleads when a key exists.
    return invalidApiKeyMessage();
  }
  return getI18n().t('commands:authError');
}

export function getAuthErrorMessage(): string {
  // Callers here only know auth was rejected (e.g. a 401), not the precise
  // reason, so infer it from whether a key is configured.
  const hasApiKey = !!process.env[EnvironmentVariable.INDUSTRY_API_KEY]?.trim();
  return authFailureMessage(
    hasApiKey
      ? AuthFailureReason.InvalidApiKey
      : AuthFailureReason.Unauthenticated
  );
}

/**
 * Validate a configured INDUSTRY_API_KEY against the backend and return a
 * user-facing error message when it is rejected.
 *
 * Returns null when no key is set, the key is valid, or in airgap mode. The
 * runtime auth package (`getAuthIdentity`) owns the actual validation and tells
 * us *why* it failed; we only map that reason to copy. Because the validation
 * path can't distinguish a hard rejection from a transient network failure,
 * an `InvalidApiKey` result also covers blips - long-running callers (e.g. the
 * daemon) should warn rather than abort so a network hiccup can't strand them.
 *
 * Entrypoints that only resolve a raw token (getAuthToken/getAuthTokenOrThrow)
 * never hit /whoami, so an invalid key would otherwise pass silently; call this
 * at startup to surface a clear error.
 */
export async function getInvalidApiKeyError(): Promise<string | null> {
  const apiKey = process.env[EnvironmentVariable.INDUSTRY_API_KEY]?.trim();
  if (!apiKey) return null;
  try {
    const { getAuthIdentity } = await import('@industry/runtime/auth');
    const { getRuntimeAuthConfig } = await import('@/environment');
    const identity = await getAuthIdentity(getRuntimeAuthConfig());
    if (identity.authenticated) return null;
    return authFailureMessage(identity.reason);
  } catch {
    return authFailureMessage(AuthFailureReason.InvalidApiKey);
  }
}
