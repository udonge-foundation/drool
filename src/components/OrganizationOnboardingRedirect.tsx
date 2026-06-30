import ansiEscapes from 'ansi-escapes';
import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';
import { getAuthedUser, logout, type AuthedUser } from '@industry/runtime/auth';
import { clearFeatureFlagDiskCache } from '@industry/runtime/feature-flags';

import { COLORS } from '@/components/chat/themedColors';
import { Header } from '@/components/Header';
import { getRuntimeAuthConfig, getEnv } from '@/environment';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { exitWithCodeSync } from '@/utils/exitWithCode';
import {
  sanitizeHyperlinkUrl,
  supportsTerminalHyperlinks,
} from '@/utils/hyperlinks';

const MENU_OPTIONS = 3;

interface OrganizationOnboardingRedirectProps {
  width: number;
  onCheckComplete: () => Promise<void> | void;
}

export function OrganizationOnboardingRedirect({
  width,
  onCheckComplete,
}: OrganizationOnboardingRedirectProps) {
  const { t } = useTranslation();
  const [selectedOption, setSelectedOption] = useState(1);
  const [user, setUser] = useState<AuthedUser | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);

  const onboardingUrl = `${getEnv().appBaseUrl}/cli-onboarding`;
  const sanitizedUrl = sanitizeHyperlinkUrl(onboardingUrl);
  const displayUrl =
    sanitizedUrl && supportsTerminalHyperlinks()
      ? ansiEscapes.link(onboardingUrl, sanitizedUrl)
      : onboardingUrl;

  // Load user async
  useEffect(() => {
    void getAuthedUser(getRuntimeAuthConfig()).then(setUser);
  }, []);

  useEffect(() => {
    // Automatically open the onboarding URL in the user's browser
    const openBrowser = async () => {
      try {
        const { default: open } = await import('open');
        await open(onboardingUrl);
      } catch (error) {
        logException(error, 'Failed to open browser for onboarding');
      }
    };

    void openBrowser();
  }, []);

  // Handle keyboard input
  useKeypressHandler(
    (_input, key) => {
      if (checking) return;

      if (key.upArrow) {
        setSelectedOption((prev) => (prev > 1 ? prev - 1 : MENU_OPTIONS));
      } else if (key.downArrow) {
        setSelectedOption((prev) => (prev < MENU_OPTIONS ? prev + 1 : 1));
      } else if (key.return) {
        if (selectedOption === 1) {
          setChecking(true);
          setCheckFailed(false);
          void (async () => {
            try {
              await onCheckComplete();
            } catch {
              // refreshStatus handles its own errors
            } finally {
              setChecking(false);
              setCheckFailed(true);
            }
          })();
        } else if (selectedOption === 2) {
          exitWithCodeSync(0);
        } else if (selectedOption === 3) {
          clearFeatureFlagDiskCache();
          void logout(getRuntimeAuthConfig()).then(() => exitWithCodeSync(0));
        }
      }
    },
    { isActive: true }
  );

  return (
    <Box flexDirection="column" width={width}>
      <Header width={width} />
      {user && (
        <Box marginBottom={1}>
          <Text>
            {t('common:onboarding.loggedInAs')}{' '}
            <Text bold color={COLORS.primary}>
              {user.email}
            </Text>
          </Text>
        </Box>
      )}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{t('common:onboarding.noOrgTitle')}</Text>
        <Text> </Text>
        <Text>
          {t('common:onboarding.noOrgStep1')}{' '}
          <Text bold color={COLORS.primary}>
            {displayUrl}
          </Text>
        </Text>
        <Text>{t('common:onboarding.noOrgStep2')}</Text>
      </Box>
      {checkFailed && !checking && (
        <Box>
          <Text color={COLORS.text.muted}>
            {t('common:onboarding.checkFailed')}
          </Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text color={selectedOption === 1 ? COLORS.primary : undefined}>
          {selectedOption === 1 ? '> ' : '  '}
          {checking
            ? t('common:onboarding.checking')
            : checkFailed
              ? t('common:onboarding.checkAgain')
              : t('common:onboarding.check')}
        </Text>
        <Text color={selectedOption === 2 ? COLORS.primary : undefined}>
          {selectedOption === 2 ? '> ' : '  '}
          {t('common:onboarding.exit')}
        </Text>
        <Text color={selectedOption === 3 ? COLORS.primary : undefined}>
          {selectedOption === 3 ? '> ' : '  '}
          {t('common:onboarding.logout')}
        </Text>
      </Box>
    </Box>
  );
}
