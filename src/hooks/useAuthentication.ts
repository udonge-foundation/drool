import { useRef, useState } from 'react';

import { logException } from '@industry/logging';
import { getAuthToken, getValidAuthedUser } from '@industry/runtime/auth';

import { getRuntimeAuthConfig } from '@/environment';
import { AuthStatus } from '@/hooks/enums';
import { invalidApiKeyMessage } from '@/i18n/authMessages';

/**
 * Custom hook that handles authentication checking logic.
 *
 * Delegates to runtime/auth's getValidAuthedUser() which decodes the JWT
 * and, if orgId is missing, queries the backend to resolve org membership.
 *
 * @returns {[AuthStatus, () => Promise<void>]} Current auth status and a refresh function
 */
export function useAuthentication(): [
  AuthStatus,
  () => Promise<void>,
  string | null,
] {
  const [authStatus, setAuthStatus] = useState<AuthStatus>(AuthStatus.Checking);
  const [authErrorMessage, setAuthErrorMessage] = useState<string | null>(null);

  const authCheckStarted = useRef(false);

  const refreshStatus = async () => {
    let authConfig: ReturnType<typeof getRuntimeAuthConfig>;

    try {
      authConfig = getRuntimeAuthConfig();
    } catch (error) {
      logException(error, 'Failed to load runtime auth config');
      setAuthErrorMessage(null);
      setAuthStatus(AuthStatus.NeedsAuth);
      return;
    }

    if (authConfig.airgapEnabled) {
      setAuthErrorMessage(null);
      setAuthStatus(AuthStatus.Authenticated);
      return;
    }

    const hasApiKey = !!authConfig.apiKey?.trim();

    try {
      const user = await getValidAuthedUser(authConfig);

      if (user) {
        setAuthErrorMessage(null);
        setAuthStatus(
          user.orgId
            ? AuthStatus.Authenticated
            : AuthStatus.AuthenticatedWithoutOrg
        );
        return;
      }
    } catch {
      if (hasApiKey) {
        setAuthErrorMessage(invalidApiKeyMessage());
        setAuthStatus(AuthStatus.InvalidApiKey);
        return;
      }
    }

    // A bad INDUSTRY_API_KEY takes strict precedence (getTokenWithSource), so
    // interactive login can never take effect: exit with the error instead.
    // TODO: offer an interactive screen to fall through to token auth.
    if (hasApiKey) {
      setAuthErrorMessage(invalidApiKeyMessage());
      setAuthStatus(AuthStatus.InvalidApiKey);
      return;
    }

    // Fallback: accept stored login tokens so offline / test scenarios still
    // authenticate. API keys must verify via getValidAuthedUser() above.
    const token = await getAuthToken(authConfig);
    if (token) {
      setAuthErrorMessage(null);
      setAuthStatus(AuthStatus.Authenticated);
      return;
    }

    setAuthErrorMessage(null);
    setAuthStatus(AuthStatus.NeedsAuth);
  };

  if (!authCheckStarted.current && authStatus === AuthStatus.Checking) {
    authCheckStarted.current = true;

    void refreshStatus();
  }

  return [authStatus, refreshStatus, authErrorMessage];
}
