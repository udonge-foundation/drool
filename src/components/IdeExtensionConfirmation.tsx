import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException, logInfo } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import { Spinner } from '@/components/Spinner';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { IdeContextManager } from '@/services/IdeContextManager';
import { ideDetector } from '@/utils/ide-detector';
import { findMatchingIdeInstance } from '@/utils/ide-lock-files';

interface IdeExtensionConfirmationProps {
  onComplete: (result: { installed: boolean; connected: boolean }) => void;
  onConnected?: () => void;
  isUpdate?: boolean;
}

enum InstallState {
  PROMPT = 'prompt',
  INSTALLING = 'installing',
  CONNECTING = 'connecting',
  ERROR = 'error',
}

export function IdeExtensionConfirmation({
  onComplete,
  onConnected,
  isUpdate = false,
}: IdeExtensionConfirmationProps) {
  const { t } = useTranslation();
  const [selectedOption, setSelectedOption] = useState(1); // 1 = Install, 2 = Skip
  const [installState, setInstallState] = useState(InstallState.PROMPT);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  // Get IDE info
  const ideInfo = ideDetector.detectIde();
  const { displayName } = ideInfo;

  // Cleanup on unmount
  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    []
  );

  const handleInstall = async () => {
    setInstallState(InstallState.INSTALLING);
    logInfo('[IdeExtensionConfirmation] Starting installation', {
      clientType: ideInfo.type,
      displayName,
    });

    try {
      const success = await ideDetector.checkAndInstallExtension({
        forceCheck: true,
      });

      if (success) {
        logInfo('[IdeExtensionConfirmation] Installation successful');

        // Only auto-connect if inside IDE terminal (workspaces will match)
        const isInIdeTerminal = ideDetector.isRunningInSupportedIde();
        if (isInIdeTerminal) {
          setInstallState(InstallState.CONNECTING);

          // Wait for extension to create lock file
          await new Promise((resolve) => {
            setTimeout(resolve, 2500);
          });

          if (!isMountedRef.current) return;

          const cwd = process.cwd();
          const matchingInstance = await findMatchingIdeInstance(
            cwd,
            displayName
          );

          if (matchingInstance && isMountedRef.current) {
            const manager = IdeContextManager.getInstance();
            const client = await manager.connectToPort(
              matchingInstance.port,
              matchingInstance
            );
            if (client && isMountedRef.current) {
              // Connection successful
              onConnected?.();
              onComplete({ installed: true, connected: true });
              return;
            }
          }

          // Connection failed - close and show message
          if (isMountedRef.current) {
            onComplete({ installed: true, connected: false });
          }
        } else {
          // Not in IDE terminal - close and show message
          onComplete({ installed: true, connected: false });
        }
      } else {
        setErrorMessage(t('common:ideExtension.installFailed'));
        setInstallState(InstallState.ERROR);
      }
    } catch (error) {
      logException(error, '[IdeExtensionConfirmation] Installation error');
      const message =
        error instanceof Error
          ? error.message
          : t('common:ideExtension.unknownError');
      setErrorMessage(message);
      setInstallState(InstallState.ERROR);
    }
  };

  const handleSkip = () => {
    logInfo('[IdeExtensionConfirmation] User skipped installation');
    onComplete({ installed: false, connected: false });
  };

  // Handle keyboard input
  useKeypressHandler(
    (input, key) => {
      // Only handle input during prompt state
      if (installState !== InstallState.PROMPT) {
        // Allow Enter to close after error
        if (installState === InstallState.ERROR && key.return) {
          onComplete({ installed: false, connected: false });
        }
        return;
      }

      // Handle arrow keys for navigation
      if (key.upArrow || key.downArrow) {
        setSelectedOption((prev) => (prev === 1 ? 2 : 1));
      } else if (key.return) {
        if (selectedOption === 1) {
          void handleInstall();
        } else {
          handleSkip();
        }
      } else if (key.escape) {
        handleSkip();
      }
    },
    { isActive: true }
  );

  // Text varies based on install vs update
  const actionVerb = isUpdate
    ? t('common:ideExtension.update')
    : t('common:ideExtension.install');
  const actionVerbCapitalized = isUpdate
    ? t('common:ideExtension.updateCap')
    : t('common:ideExtension.installCap');
  const headerText = isUpdate
    ? t('common:ideExtension.updateAvailable', { name: displayName })
    : t('common:ideExtension.extensionAvailable', { name: displayName });
  const descriptionText = isUpdate
    ? t('common:ideExtension.updateDescription', { name: displayName })
    : t('common:ideExtension.installDescription', { name: displayName });

  return (
    <Box flexDirection="column">
      {(installState === InstallState.PROMPT ||
        installState === InstallState.INSTALLING ||
        installState === InstallState.CONNECTING) && (
        <Box
          borderStyle="round"
          borderColor={COLORS.border}
          padding={1}
          flexDirection="column"
          marginBottom={1}
        >
          <Text bold color={COLORS.primary}>
            {headerText}
          </Text>
          <Text>{descriptionText}</Text>
        </Box>
      )}

      {installState === InstallState.PROMPT && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>
            {t('common:ideExtension.wouldYouLike', { action: actionVerb })}
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={selectedOption === 1 ? COLORS.primary : undefined}>
              {selectedOption === 1 ? '> ' : '  '}
              {t('common:ideExtension.actionExtension', {
                action: actionVerbCapitalized,
              })}
            </Text>
            <Text color={selectedOption === 2 ? COLORS.primary : undefined}>
              {selectedOption === 2 ? '> ' : '  '}
              {t('common:ideExtension.skipForNow')}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {t('common:ideExtension.navigationHint')}
            </Text>
          </Box>
        </Box>
      )}

      {installState === InstallState.INSTALLING && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={COLORS.success}>
              <Spinner />
            </Text>
            <Text color={COLORS.success}>
              {' '}
              {t('common:ideExtension.installingExtension', {
                action: isUpdate
                  ? t('common:ideExtension.updating')
                  : t('common:ideExtension.installing'),
                name: displayName,
              })}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {t('common:ideExtension.waitMessage')}
            </Text>
          </Box>
        </Box>
      )}

      {installState === InstallState.CONNECTING && (
        <Box marginBottom={1}>
          <Text color={COLORS.success}>
            <Spinner />
          </Text>
          <Text color={COLORS.success}>
            {' '}
            {t('common:ideExtension.installedConnecting')}
          </Text>
        </Box>
      )}

      {installState === InstallState.ERROR && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={COLORS.error}>
            {t('common:ideExtension.failedToAction', {
              action: actionVerb,
              name: displayName,
            })}
          </Text>
          {errorMessage && (
            <Box marginTop={1}>
              <Text color={COLORS.text.muted}>{errorMessage}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={COLORS.primary}>
              {t('common:ideExtension.pressEnterContinue')}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
