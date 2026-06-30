import { Box, Text } from 'ink';
import { useCallback, useRef, useState } from 'react';

import { logException, logInfo } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import { Header } from '@/components/Header';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMountEffect } from '@/hooks/useMountEffect';
import { getI18n } from '@/i18n';
import { getFolderTrustService } from '@/services/FolderTrustService';
import { exitWithCodeSync } from '@/utils/exitWithCode';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';

enum FolderTrustPromptState {
  Prompt = 'prompt',
  Saving = 'saving',
  Error = 'error',
}

interface FolderTrustPromptProps {
  width: number;
  folderPath: string;
  onTrust: () => void;
  /**
   * Target directory to persist trust for. Defaults to the current folder's
   * trust root (startup gate). Provided by the mid-session /cwd gate so the
   * decision is recorded for the folder being switched into.
   */
  trustTargetPath?: string;
  /**
   * What declining does: `exit` terminates the process (startup gate, where
   * continuing would run untrusted config), `cancel` aborts the in-progress
   * action and returns control to the session (mid-session /cwd gate).
   */
  declineBehavior?: 'exit' | 'cancel';
  /** Invoked when the user declines in `cancel` mode. */
  onCancel?: () => void;
}

/**
 * Gate asking the user to confirm they trust a folder before any
 * project-sourced MCP servers or hooks are allowed to load (CLI-897). Used
 * both as the startup gate (declining exits) and the mid-session /cwd gate
 * (declining cancels the cwd change).
 */
export function FolderTrustPrompt({
  width,
  folderPath,
  onTrust,
  trustTargetPath,
  declineBehavior = 'exit',
  onCancel,
}: FolderTrustPromptProps) {
  const [selectedOption, setSelectedOption] = useState(1); // 1 = trust, 2 = exit
  const [promptState, setPromptState] = useState(FolderTrustPromptState.Prompt);
  const [ctrlCPressed, setCtrlCPressed] = useState(false);
  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Paths are attacker-influenced (a cloned repo controls its directory
  // names); strip control/escape sequences so they cannot spoof this prompt.
  const safeFolderPath = sanitizeTerminalDisplayText(folderPath, {
    stripSgr: true,
  });

  const clearCtrlCTimer = useCallback(() => {
    if (ctrlCTimerRef.current) {
      clearTimeout(ctrlCTimerRef.current);
      ctrlCTimerRef.current = null;
    }
  }, []);

  useMountEffect(() => clearCtrlCTimer);

  const handleTrust = useCallback(async () => {
    setPromptState(FolderTrustPromptState.Saving);
    try {
      const folderTrustService = getFolderTrustService();
      if (trustTargetPath) {
        await folderTrustService.trustFolderForPath(trustTargetPath);
      } else {
        await folderTrustService.trustCurrentFolder();
      }
      logInfo('[FolderTrust] User trusted folder');
      clearCtrlCTimer();
      setCtrlCPressed(false);
      onTrust();
    } catch (error) {
      logException(error, '[FolderTrust] Failed to persist trust decision');
      setPromptState(FolderTrustPromptState.Error);
    }
  }, [clearCtrlCTimer, onTrust, trustTargetPath]);

  const handleDecline = useCallback(() => {
    if (declineBehavior === 'cancel') {
      logInfo('[FolderTrust] User declined folder trust, cancelling');
      clearCtrlCTimer();
      setCtrlCPressed(false);
      onCancel?.();
      return;
    }
    logInfo('[FolderTrust] User declined folder trust, exiting');
    exitWithCodeSync(0);
  }, [clearCtrlCTimer, declineBehavior, onCancel]);

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

      if (promptState === FolderTrustPromptState.Error) {
        if (key.return) {
          setPromptState(FolderTrustPromptState.Prompt);
        }
        return;
      }

      if (promptState !== FolderTrustPromptState.Prompt) {
        return;
      }

      if (input === '1' || input === 'y' || input === 'Y') {
        setSelectedOption(1);
        void handleTrust();
      } else if (input === '2' || input === 'n' || input === 'N') {
        handleDecline();
      } else if (key.upArrow || key.downArrow) {
        setSelectedOption((prev) => (prev === 1 ? 2 : 1));
      } else if (key.return) {
        if (selectedOption === 1) {
          void handleTrust();
        } else {
          handleDecline();
        }
      } else if (key.escape) {
        handleDecline();
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
        <Text bold color={COLORS.warning}>
          {getI18n().t('common:folderTrust.title')}
        </Text>
        <Box marginTop={1}>
          <Text bold>{safeFolderPath}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>{getI18n().t('common:folderTrust.safetyCheck')}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>{getI18n().t('common:folderTrust.accessDescription')}</Text>
        </Box>
      </Box>

      {promptState === FolderTrustPromptState.Prompt && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={selectedOption === 1 ? COLORS.primary : undefined}>
            {selectedOption === 1 ? '> ' : '  '}
            {getI18n().t('common:folderTrust.yesTrust')}
          </Text>
          <Text color={selectedOption === 2 ? COLORS.primary : undefined}>
            {selectedOption === 2 ? '> ' : '  '}
            {getI18n().t(
              declineBehavior === 'cancel'
                ? 'common:folderTrust.noCancel'
                : 'common:folderTrust.noExit'
            )}
          </Text>
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {getI18n().t(
                declineBehavior === 'cancel'
                  ? 'common:folderTrust.navigationHintCancel'
                  : 'common:folderTrust.navigationHint'
              )}
            </Text>
          </Box>
        </Box>
      )}

      {promptState === FolderTrustPromptState.Saving && (
        <Box marginBottom={1}>
          <Text color={COLORS.text.muted}>
            {getI18n().t('common:folderTrust.saving')}
          </Text>
        </Box>
      )}

      {promptState === FolderTrustPromptState.Error && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={COLORS.error}>
            {getI18n().t('common:folderTrust.saveFailed')}
          </Text>
          <Box marginTop={1}>
            <Text color={COLORS.primary}>
              {getI18n().t('common:folderTrust.pressEnterRetry')}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
