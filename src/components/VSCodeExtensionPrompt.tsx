import { Box, Text } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';

import { logException, logInfo } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { COLORS } from '@/components/chat/themedColors';
import { Header } from '@/components/Header';
import { Spinner } from '@/components/Spinner';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { getI18n } from '@/i18n';
import {
  VSCodeExtensionPromptState,
  VSCodeExtensionStatus,
} from '@/services/enums';
import { getSettingsService } from '@/services/SettingsService';
import { exitWithCodeSync } from '@/utils/exitWithCode';
import { ideDetector } from '@/utils/ide-detector';

interface VSCodeExtensionPromptProps {
  onComplete: () => void;
  onStatusUpdate: (status: VSCodeExtensionStatus) => void;
  width: number;
}

export function VSCodeExtensionPrompt({
  onComplete,
  onStatusUpdate,
  width,
}: VSCodeExtensionPromptProps) {
  const [selectedOption, setSelectedOption] = useState(1); // 1 = Yes, 2 = No
  const [promptState, setPromptState] = useState(
    VSCodeExtensionPromptState.PROMPT
  );
  const [ctrlCPressed, setCtrlCPressed] = useState(false);
  const [countdown, setCountdown] = useState(5);

  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);
  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Get IDE info for backend functionality (but UI still says "VSCode")
  const ideInfo = ideDetector.detectIde();

  // Cleanup timers on unmount
  useEffect(
    () => () => {
      if (ctrlCTimerRef.current) {
        clearTimeout(ctrlCTimerRef.current);
      }
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
      }
    },
    []
  );

  const handleInstallExtension = useCallback(async () => {
    setPromptState(VSCodeExtensionPromptState.INSTALLING);
    logInfo('Starting VSCode extension installation');

    try {
      const success = await ideDetector.checkAndInstallExtension({
        forceCheck: true,
      });

      if (success) {
        logInfo('VSCode extension installed successfully');
        setPromptState(VSCodeExtensionPromptState.COMPLETED);

        // Mark as prompted and update hook status immediately
        getSettingsService().setIdeExtensionPromptedAt(ideInfo.type);
        onStatusUpdate(VSCodeExtensionStatus.SKIP);

        // Start countdown timer
        countdownTimerRef.current = setInterval(() => {
          setCountdown((prev) => {
            const newCountdown = prev - 1;
            if (newCountdown <= 0) {
              clearInterval(countdownTimerRef.current!);
              countdownTimerRef.current = null;
              onComplete();
            }
            return Math.max(0, newCountdown);
          });
        }, 1000);
      } else {
        throw new MetaError('Installation failed');
      }
    } catch (error) {
      logException(error, 'VSCode extension installation failed');
      setPromptState(VSCodeExtensionPromptState.ERROR);
    }
  }, [onComplete]);

  const handleSkip = useCallback(() => {
    logInfo('User skipped VSCode extension installation');
    getSettingsService().setIdeExtensionPromptedAt(ideInfo.type);
    onStatusUpdate(VSCodeExtensionStatus.SKIP);
    onComplete();
  }, [onComplete, onStatusUpdate]);

  // Handle keyboard input
  useKeypressHandler(
    (input, key) => {
      // Global Ctrl+C handling
      if (key.ctrl && input === 'c') {
        if (ctrlCPressed) {
          exitWithCodeSync(0);
        } else {
          setCtrlCPressed(true);
          process.stdout.write(getI18n().t('common:process.ctrlCToExit'));
          ctrlCTimerRef.current = setTimeout(() => {
            setCtrlCPressed(false);
            ctrlCTimerRef.current = null;
          }, 2000);
          return;
        }
      }

      // Only handle input during prompt state
      if (promptState !== VSCodeExtensionPromptState.PROMPT) {
        // Allow Enter to retry after error
        if (promptState === VSCodeExtensionPromptState.ERROR && key.return) {
          setPromptState(VSCodeExtensionPromptState.PROMPT);
        }
        // Allow Enter to continue immediately after successful installation
        if (
          promptState === VSCodeExtensionPromptState.COMPLETED &&
          key.return
        ) {
          // Clear countdown timer if user presses Enter early
          if (countdownTimerRef.current) {
            clearInterval(countdownTimerRef.current);
            countdownTimerRef.current = null;
          }
          onComplete();
        }
        return;
      }

      // Handle y/n direct input
      if (input === 'y' || input === 'Y') {
        setSelectedOption(1);
        void handleInstallExtension();
      } else if (input === 'n' || input === 'N') {
        setSelectedOption(2);
        handleSkip();
      } else if (key.upArrow || key.downArrow) {
        setSelectedOption((prev) => (prev === 1 ? 2 : 1));
      } else if (key.return) {
        if (selectedOption === 1) {
          void handleInstallExtension();
        } else {
          handleSkip();
        }
      } else if (key.escape) {
        handleSkip();
      }
    },
    { isActive: true }
  );

  return (
    <Box flexDirection="column" width={width}>
      <Header width={width} />

      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        padding={1}
        flexDirection="column"
        marginBottom={1}
      >
        <Text bold color={COLORS.primary}>
          {getI18n().t('common:vsCodePrompt.extensionAvailable')}
        </Text>
        <Text>{getI18n().t('common:vsCodePrompt.extensionDescription')}</Text>
      </Box>

      {promptState === VSCodeExtensionPromptState.PROMPT && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{getI18n().t('common:vsCodePrompt.installQuestion')}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={selectedOption === 1 ? COLORS.primary : undefined}>
              {selectedOption === 1 ? '> ' : '  '}
              {getI18n().t('common:vsCodePrompt.yesInstall')}
            </Text>
            <Text color={selectedOption === 2 ? COLORS.primary : undefined}>
              {selectedOption === 2 ? '> ' : '  '}
              {getI18n().t('common:vsCodePrompt.noSkip')}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {getI18n().t('common:vsCodePrompt.navigationHint')}
            </Text>
          </Box>
        </Box>
      )}

      {promptState === VSCodeExtensionPromptState.INSTALLING && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={COLORS.success}>
              <Spinner />
            </Text>
            <Text color={COLORS.success}>
              {' '}
              {getI18n().t('common:vsCodePrompt.installing')}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {getI18n().t('common:vsCodePrompt.installMayTakeMoment')}
            </Text>
          </Box>
        </Box>
      )}

      {promptState === VSCodeExtensionPromptState.COMPLETED && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={COLORS.success}>
            {getI18n().t('common:vsCodePrompt.installedSuccess')}
          </Text>
          <Text color={COLORS.text.muted}>
            {getI18n().t('common:vsCodePrompt.ideConnect')}
          </Text>
          <Box marginTop={1}>
            <Text color={COLORS.primary}>
              {getI18n().t('common:vsCodePrompt.continueCountdown', {
                countdown,
              })}
            </Text>
          </Box>
        </Box>
      )}

      {promptState === VSCodeExtensionPromptState.ERROR && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={COLORS.error}>
            {getI18n().t('common:vsCodePrompt.installFailed')}
          </Text>
          <Box marginTop={1}>
            <Text color={COLORS.primary}>
              {getI18n().t('common:vsCodePrompt.pressEnterRetry')}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
