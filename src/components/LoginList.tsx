import { Box, Text } from 'ink';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException, logInfo } from '@industry/logging';
import {
  enableCodingSubscriptionOAuthOnce,
  loginCodingSubscription,
  type CodingSubscriptionLoginMethod,
  type CodingSubscriptionProvider,
} from '@industry/runtime/auth';

import { COLORS } from '@/components/chat/themedColors';
import { ByokProviderWizard } from '@/components/ByokProviderWizard';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { installCodingSubscriptionModels } from '@/services/coding-subs/modelInstall';
import { openBrowser } from '@/utils/openBrowser';

interface LoginListProps {
  onClose: () => void;
  onSuccess?: (providerName?: string) => void | Promise<void>;
  showContinueWithApiKey?: boolean;
  onContinueWithApiKey?: () => void;
}

type LoginState =
  | 'options'
  | 'byok'
  | 'authenticating'
  | 'waiting_for_browser'
  | 'error';

interface AuthResponseInfo {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  providerLabel?: string;
}

interface CodingSubscriptionLoginOption {
  provider: CodingSubscriptionProvider;
  method: CodingSubscriptionLoginMethod;
  label: string;
  successLabel: string;
}

const PROVIDER_DISPLAY_NAMES: Partial<
  Record<CodingSubscriptionProvider, string>
> = {
  antigravity: 'Antigravity',
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi',
  xai: 'Grok Build / xAI',
};

export function LoginList({
  onClose,
  onSuccess,
  showContinueWithApiKey: _showContinueWithApiKey,
  onContinueWithApiKey,
}: LoginListProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoginState>('options');
  const [authResponse, setAuthResponse] = useState<AuthResponseInfo | null>(
    null
  );
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pollingMessage, setPollingMessage] = useState('');
  const [byokMessage, setByokMessage] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const flowRef = useRef<AsyncGenerator | null>(null);

  const startCodingSubscriptionAuthentication = async (
    option: CodingSubscriptionLoginOption
  ) => {
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      setState('authenticating');
      setPollingMessage('');
      setAuthResponse(null);
      logInfo('Starting coding subscription authentication flow', {
        provider: option.provider,
        method: option.method,
      });

      await enableCodingSubscriptionOAuthOnce();
      const flow = loginCodingSubscription(option.provider, option.method);
      flowRef.current = flow;
      let browserOpened = false;

      while (true) {
        const next = await flow.next();
        if (abortController.signal.aborted) return;
        if (next.done) {
          await installCodingSubscriptionModels(next.value);
          break;
        }

        const status = next.value;
        if (status.type === 'browser') {
          setAuthResponse({
            userCode: '',
            verificationUri: status.authUrl,
            verificationUriComplete: status.authUrl,
            providerLabel: option.label,
          });
          setState('waiting_for_browser');
          if (!browserOpened) {
            browserOpened = true;
            await openBrowser(status.authUrl);
          }
        } else if (status.type === 'pending') {
          setAuthResponse({
            userCode: status.userCode,
            verificationUri: status.verificationUri,
            verificationUriComplete: status.verificationUriComplete,
            providerLabel: option.label,
          });
          setState('waiting_for_browser');
          if (!browserOpened) {
            browserOpened = true;
            await openBrowser(status.verificationUriComplete);
          }
        } else if (status.type === 'polling') {
          setPollingMessage(`Waiting for ${option.label} authorization...`);
        } else if (status.type === 'slow_down') {
          setPollingMessage(
            `Waiting for ${option.label} authorization (${status.newInterval}s polling interval)...`
          );
        }
      }

      if (onSuccess) {
        await onSuccess(
          option.successLabel ??
            PROVIDER_DISPLAY_NAMES[option.provider] ??
            option.label
        );
      } else {
        onClose();
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      logException(error, 'Coding subscription authentication failed');
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Coding subscription authentication failed'
      );
      setState('error');
    }
  };

  const openByokWizard = () => {
    if (onContinueWithApiKey) {
      onContinueWithApiKey();
      onClose();
      return;
    }
    setByokMessage('');
    setState('byok');
  };

  const codingSubscriptionOptions: CodingSubscriptionLoginOption[] = [
    {
      provider: 'codex',
      method: 'browser',
      label: 'Login with Codex',
      successLabel: 'Codex',
    },
    {
      provider: 'codex',
      method: 'device',
      label: 'Login with Codex (device code)',
      successLabel: 'Codex',
    },
    {
      provider: 'claude',
      method: 'browser',
      label: 'Login with Claude Code',
      successLabel: 'Claude Code',
    },
    {
      provider: 'antigravity',
      method: 'browser',
      label: 'Login with Antigravity',
      successLabel: 'Antigravity',
    },
    {
      provider: 'kimi',
      method: 'device',
      label: 'Login with Kimi (device code)',
      successLabel: 'Kimi',
    },
    {
      provider: 'xai',
      method: 'browser',
      label: 'Login with Grok Build / xAI',
      successLabel: 'Grok Build / xAI',
    },
  ];

  const menuItems =
    state === 'options'
      ? [
          {
            id: 'api-key',
            label: 'Add BYOK / Custom provider',
            value: '',
            action: openByokWizard,
            disabled: false,
          },
          ...codingSubscriptionOptions.map((option) => ({
            id: `${option.provider}-${option.method}`,
            label: option.label,
            value: '',
            action: () => {
              void startCodingSubscriptionAuthentication(option);
            },
            disabled: false,
          })),
          {
            id: 'cancel',
            label: t('common:login.cancel'),
            value: '',
            action: onClose,
            disabled: false,
          },
        ]
      : state === 'waiting_for_browser' && authResponse
        ? []
        : [];

  useKeypressHandler(
    (_input, key) => {
      if (state === 'byok') {
        return false;
      }

      if (key.escape) {
        abortControllerRef.current?.abort();
        void flowRef.current?.return(undefined);
        onClose();
        return;
      }

      if (state === 'options') {
        if (
          key.return &&
          menuItems[selectedIndex] &&
          !menuItems[selectedIndex].disabled
        ) {
          menuItems[selectedIndex].action();
          return;
        }

        if (key.upArrow) {
          setSelectedIndex((prev) => {
            const enabledItems = menuItems.filter((item) => !item.disabled);
            const currentEnabledIndex = enabledItems.findIndex(
              (item) => item === menuItems[prev]
            );
            const nextIndex = Math.max(0, currentEnabledIndex - 1);
            return menuItems.indexOf(enabledItems[nextIndex]);
          });
          return;
        }

        if (key.downArrow) {
          setSelectedIndex((prev) => {
            const enabledItems = menuItems.filter((item) => !item.disabled);
            const currentEnabledIndex = enabledItems.findIndex(
              (item) => item === menuItems[prev]
            );
            const nextIndex = Math.min(
              enabledItems.length - 1,
              currentEnabledIndex + 1
            );
            return menuItems.indexOf(enabledItems[nextIndex]);
          });
        }
      }
    },
    { isActive: true }
  );

  return (
    <Box
      borderStyle="round"
      borderColor={COLORS.border}
      paddingX={1}
      marginTop={1}
    >
      <Box flexDirection="column">
        {state === 'byok' && (
          <ByokProviderWizard
            onCancel={() => {
              setState('options');
            }}
            onSaved={(displayName, warning) => {
              setByokMessage(
                warning
                  ? `Added ${displayName}. ${warning}`
                  : `Added ${displayName}. Select it with /model.`
              );
              setState('options');
            }}
          />
        )}

        {state === 'authenticating' && (
          <Text color={COLORS.text.muted}>{t('common:login.initiating')}</Text>
        )}

        {state === 'options' && (
          <>
            {menuItems.map((item, index) => {
              const isSelected = index === selectedIndex;
              const color: string | undefined = item.disabled
                ? COLORS.text.muted
                : isSelected
                  ? COLORS.primary
                  : undefined;

              return (
                <Text key={item.id} color={color}>
                  {isSelected ? '> ' : '  '}
                  {item.label}
                </Text>
              );
            })}
            {byokMessage && (
              <Box marginTop={1}>
                <Text color={COLORS.text.muted}>{byokMessage}</Text>
              </Box>
            )}
          </>
        )}

        {state === 'waiting_for_browser' && authResponse && (
          <>
            <Box marginBottom={1}>
              {authResponse.userCode ? (
                <Text>
                  {t('common:login.browserPrompt')}{' '}
                  <Text color={COLORS.primary} bold>
                    {authResponse.verificationUri}
                  </Text>{' '}
                  {t('common:login.enterCode')}{' '}
                  <Text color={COLORS.primary} bold>
                    {authResponse.userCode}
                  </Text>{' '}
                  {t('common:login.toComplete')}
                </Text>
              ) : (
                <Text>
                  Complete {authResponse.providerLabel ?? 'OAuth'} in your
                  browser:{' '}
                  <Text color={COLORS.primary} bold>
                    {authResponse.verificationUri}
                  </Text>
                </Text>
              )}
            </Box>

            {pollingMessage && (
              <Box marginBottom={1}>
                <Text color={COLORS.text.muted}>{pollingMessage}</Text>
              </Box>
            )}
          </>
        )}

        {state === 'error' && (
          <Box flexDirection="column">
            <Text color={COLORS.error}>{t('common:login.authFailed')}</Text>
            <Text color={COLORS.text.muted}>{errorMessage}</Text>
          </Box>
        )}

        {state !== 'byok' && (
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {state === 'options'
                ? t('common:login.navigationAuth')
                : state === 'waiting_for_browser'
                  ? t('common:login.navigationWaiting')
                  : t('common:login.navigationDefault')}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
