import { Box, Text } from 'ink';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException, logInfo } from '@industry/logging';
import { loginWithDeviceCode } from '@industry/runtime/auth';

import { COLORS } from '@/components/chat/themedColors';
import { Header } from '@/components/Header';
import { getRuntimeAuthConfig } from '@/environment';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { getI18n } from '@/i18n';
import { exitWithCodeSync } from '@/utils/exitWithCode';
import { openBrowser } from '@/utils/openBrowser';

interface AuthenticationCheckProps {
  onAuthenticated: () => void;
  width: number;
  message?: string | null;
}

type OAuthFlowState = 'notStarted' | 'waitingForBrowser' | 'error';

interface AuthResponseInfo {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
}

// Combined state interface to avoid race conditions
interface AuthState {
  selectedOption: number;
  oauthFlowState: OAuthFlowState;
  authResponse: AuthResponseInfo | null;
  errorMessage: string;
  pollingMessage: string;
  ctrlCPressed: boolean;
}

export function AuthenticationCheck({
  onAuthenticated,
  width,
  message,
}: AuthenticationCheckProps) {
  const { t } = useTranslation();

  // Single state object for all state variables
  const [state, setState] = useState<AuthState>({
    selectedOption: 1,
    oauthFlowState: 'notStarted',
    authResponse: null,
    errorMessage: '',
    pollingMessage: '',
    ctrlCPressed: false,
  });

  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const flowRef = useRef<AsyncGenerator | null>(null);

  // Handle OAuth flow using loginWithDeviceCode
  const startAuthentication = useCallback(async () => {
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      setState((prev) => ({ ...prev, oauthFlowState: 'waitingForBrowser' }));
      logInfo('Starting CLI authentication flow (auth check)');
      const flow = loginWithDeviceCode(getRuntimeAuthConfig());
      flowRef.current = flow;
      let browserOpened = false;

      for await (const status of flow) {
        if (abortController.signal.aborted) {
          return;
        }

        if (status.type === 'pending') {
          setState((prev) => ({
            ...prev,
            authResponse: {
              userCode: status.userCode,
              verificationUri: status.verificationUri,
              verificationUriComplete: status.verificationUriComplete,
            },
          }));
          logInfo('Device authorization initiated (auth check)', {
            key: status.userCode,
            url: status.verificationUri,
          });

          if (!browserOpened) {
            browserOpened = true;
            const opened = await openBrowser(status.verificationUriComplete);
            if (opened) {
              logInfo('Browser opened for authentication (auth check)');
            } else {
              logInfo(
                'Browser not opened - manual URL visit required (auth check)'
              );
            }
          }
        } else if (status.type === 'polling') {
          setState((prev) => ({
            ...prev,
            pollingMessage: t('common:login.waitingForAuth'),
          }));
        }
      }

      // Flow completed successfully
      logInfo('CLI authentication successful (auth check)');
      onAuthenticated();
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }
      logException(error, 'Authentication failed (auth check)');
      setState((prev) => ({
        ...prev,
        errorMessage:
          error instanceof Error
            ? error.message
            : t('common:login.authFailedDefault'),
        oauthFlowState: 'error',
      }));
    }
  }, [onAuthenticated]);

  // Handle keyboard input
  useKeypressHandler(
    (input, key) => {
      // Global Ctrl+C handling (works in any auth state)
      if (key.ctrl && input === 'c') {
        if (state.ctrlCPressed) {
          // Second press - exit immediately
          exitWithCodeSync(0);
        } else {
          // First press - warn user and set timer
          setState((prev) => ({ ...prev, ctrlCPressed: true }));
          process.stdout.write(getI18n().t('common:process.ctrlCToExit'));
          ctrlCTimerRef.current = setTimeout(() => {
            setState((prev) => ({ ...prev, ctrlCPressed: false }));
            ctrlCTimerRef.current = null;
          }, 2000);
          return;
        }
      }

      // Retry after an error: Enter key resets flow
      if (state.oauthFlowState === 'error' && key.return) {
        setState((prev) => ({
          ...prev,
          oauthFlowState: 'notStarted',
          errorMessage: '',
          authResponse: null,
          pollingMessage: '',
        }));
        return;
      }

      // If OAuth flow is not started, handle option selection
      if (state.oauthFlowState === 'notStarted') {
        if (key.upArrow || key.downArrow) {
          // No API key present OR feature flag disabled - handle login/exit options
          setState((prev) => ({
            ...prev,
            selectedOption: prev.selectedOption === 1 ? 2 : 1,
          }));
        } else if (key.return) {
          if (state.selectedOption === 1) {
            void startAuthentication();
          } else if (state.selectedOption === 2) {
            exitWithCodeSync(0);
          }
        }
      }

      // Allow ESC to cancel OAuth flow and return to options
      if (key.escape && state.oauthFlowState === 'waitingForBrowser') {
        abortControllerRef.current?.abort();
        void flowRef.current?.return(undefined);
        setState((prev) => ({
          ...prev,
          oauthFlowState: 'notStarted',
          authResponse: null,
          pollingMessage: '',
        }));
      }
    },
    { isActive: true }
  );

  return (
    <Box flexDirection="column" width={width}>
      {/* DROOL logo header */}
      <Header width={width} />

      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        padding={1}
        flexDirection="column"
        marginBottom={1}
      >
        <Text bold color={COLORS.primary}>
          {t('common:onboarding.welcomeTitle')}
        </Text>
        <Text>{t('common:onboarding.welcomeDescription')}</Text>
      </Box>

      {state.oauthFlowState === 'notStarted' && (
        <Box flexDirection="column" marginBottom={1}>
          {message && (
            <Box marginBottom={1}>
              <Text color={COLORS.error}>{message}</Text>
            </Box>
          )}
          <Text>{t('common:login.pleaseLogin')}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text
              color={state.selectedOption === 1 ? COLORS.primary : undefined}
            >
              {state.selectedOption === 1 ? '> ' : '  '}
              {t('common:login.loginButton')}
            </Text>
            <Text
              color={state.selectedOption === 2 ? COLORS.primary : undefined}
            >
              {state.selectedOption === 2 ? '> ' : '  '}
              {t('common:login.exitButton')}
            </Text>
          </Box>
        </Box>
      )}

      {state.oauthFlowState === 'waitingForBrowser' && state.authResponse && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text>
              {t('common:login.browserPrompt')}{' '}
              <Text color={COLORS.primary} bold>
                {state.authResponse.verificationUri}
              </Text>{' '}
              {t('common:login.enterCode')}{' '}
              <Text color={COLORS.primary} bold>
                {state.authResponse.userCode}
              </Text>{' '}
              {t('common:login.toComplete')}
            </Text>
          </Box>

          {state.pollingMessage && (
            <Box marginBottom={1}>
              <Text color={COLORS.text.muted}>{state.pollingMessage}</Text>
            </Box>
          )}
        </Box>
      )}

      {state.oauthFlowState === 'error' && (
        <Box flexDirection="column">
          <Text color={COLORS.error}>{t('common:login.authFailed')}</Text>
          <Text color={COLORS.text.muted}>{state.errorMessage}</Text>
          <Box marginTop={1}>
            <Text color={COLORS.primary}>
              {t('common:login.pressEnterRetry')}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
