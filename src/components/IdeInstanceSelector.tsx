import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException, logInfo } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import { Spinner } from '@/components/Spinner';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { IdeContextManager } from '@/services/IdeContextManager';
import {
  discoverRunningIdeInstances,
  IdeLockFileData,
  matchesWorkspace,
} from '@/utils/ide-lock-files';

interface IdeInstanceSelectorProps {
  onComplete: (connected: boolean, instanceName?: string) => void;
  onConnecting?: () => void;
  onDisconnect?: () => Promise<void>;
  initialConnectedInstance?: {
    ideName: string;
    workspace: string;
  };
}

enum SelectorState {
  LOADING = 'loading',
  SELECT = 'select',
  CONNECTING = 'connecting',
  SUCCESS = 'success',
  ERROR = 'error',
}

interface DisplayInstance extends IdeLockFileData {
  matches: boolean;
}

export function IdeInstanceSelector({
  onComplete,
  onConnecting,
  onDisconnect,
  initialConnectedInstance,
}: IdeInstanceSelectorProps) {
  const { t } = useTranslation();
  const [state, setState] = useState(
    initialConnectedInstance ? SelectorState.SUCCESS : SelectorState.LOADING
  );
  const [matchingInstances, setMatchingInstances] = useState<DisplayInstance[]>(
    []
  );
  const [nonMatchingInstances, setNonMatchingInstances] = useState<
    DisplayInstance[]
  >([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [connectedName, setConnectedName] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const cwd = process.cwd();

  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    []
  );

  // Load instances on mount (skip if showing initial connected instance)
  useEffect(() => {
    if (initialConnectedInstance) return;

    const loadInstances = async () => {
      try {
        const discovered = await discoverRunningIdeInstances();

        if (!isMountedRef.current) return;

        const displayInstances: DisplayInstance[] = discovered.map(
          (instance) => ({
            ...instance,
            matches: matchesWorkspace(instance, cwd),
          })
        );

        // Separate matching and non-matching instances
        const matching = displayInstances
          .filter((inst) => inst.matches)
          .sort((a, b) => a.ideName.localeCompare(b.ideName));
        const nonMatching = displayInstances
          .filter((inst) => !inst.matches)
          .sort((a, b) => a.ideName.localeCompare(b.ideName));

        setMatchingInstances(matching);
        setNonMatchingInstances(nonMatching);
        setSelectedIndex(0);

        setState(SelectorState.SELECT);
      } catch (error) {
        if (!isMountedRef.current) return;

        logException(error, '[IdeInstanceSelector] Failed to load instances');
        setErrorMessage(t('common:ideInstanceSelector.failedToDiscover'));
        setState(SelectorState.ERROR);
      }
    };

    void loadInstances();
  }, [cwd, initialConnectedInstance]);

  // Auto-close after successful connection (skip if showing initial connected instance)
  useEffect(() => {
    if (
      state === SelectorState.SUCCESS &&
      !initialConnectedInstance &&
      isMountedRef.current
    ) {
      const timeoutId = setTimeout(() => {
        if (isMountedRef.current) {
          onComplete(true, connectedName || undefined);
        }
      }, 1500);
      return () => clearTimeout(timeoutId);
    }
  }, [state, onComplete, connectedName, initialConnectedInstance]);

  const handleConnect = async (instance: DisplayInstance) => {
    setState(SelectorState.CONNECTING);
    onConnecting?.();
    logInfo('[IdeInstanceSelector] Connecting to instance', {
      clientType: instance.ideName,
      port: instance.port,
    });

    try {
      const manager = IdeContextManager.getInstance();
      const client = await manager.connectToPort(instance.port, instance);

      if (client) {
        setConnectedName(instance.ideName);
        setState(SelectorState.SUCCESS);
      } else {
        setErrorMessage(t('common:ideInstanceSelector.failedToConnect'));
        setState(SelectorState.ERROR);
      }
    } catch (error) {
      logException(error, '[IdeInstanceSelector] Connection error');
      const message =
        error instanceof Error
          ? error.message
          : t('common:ideInstanceSelector.unknownError');
      setErrorMessage(message);
      setState(SelectorState.ERROR);
    }
  };

  const handleCancel = () => {
    onComplete(false);
  };

  // Handle keyboard input
  useKeypressHandler(
    (input, key) => {
      if (state === SelectorState.LOADING) return;

      // Allow ESC to cancel during CONNECTING state
      if (state === SelectorState.CONNECTING) {
        if (key.escape) {
          onComplete(false);
        }
        return;
      }

      if (state === SelectorState.ERROR) {
        if (key.return || key.escape) {
          onComplete(false, undefined);
        }
        return;
      }

      if (state === SelectorState.SUCCESS) {
        if (input.toLowerCase() === 'd' && onDisconnect) {
          void onDisconnect().then(() => {
            onComplete(false);
          });
          return;
        }
        if (key.return || key.escape) {
          onComplete(true, connectedName || initialConnectedInstance?.ideName);
        }
        return;
      }

      if (state === SelectorState.SELECT) {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
        } else if (key.downArrow) {
          setSelectedIndex((prev) =>
            Math.min(matchingInstances.length - 1, prev + 1)
          );
        } else if (key.return) {
          const selected = matchingInstances[selectedIndex];
          if (selected) {
            void handleConnect(selected);
          }
        } else if (key.escape) {
          handleCancel();
        }
      }
    },
    { isActive: true }
  );

  const getWorkspaceDisplay = (instance: DisplayInstance): string =>
    instance.workspaceFolders.length > 0
      ? instance.workspaceFolders[0]
      : t('common:ideInstanceSelector.noWorkspace');

  const renderMatchingInstance = (instance: DisplayInstance, index: number) => {
    const isSelected = index === selectedIndex;
    const prefix = isSelected ? '> ' : '  ';
    return (
      <Box key={instance.port}>
        <Text color={isSelected ? COLORS.primary : undefined}>
          {prefix}
          {instance.ideName} - {getWorkspaceDisplay(instance)}
        </Text>
      </Box>
    );
  };

  const renderNonMatchingInstance = (instance: DisplayInstance) => (
    <Box key={instance.port}>
      <Text color={COLORS.text.muted} dimColor>
        {'  '}
        {instance.ideName} - {getWorkspaceDisplay(instance)}
      </Text>
    </Box>
  );

  const renderOtherInstancesSection = () =>
    nonMatchingInstances.length > 0 ? (
      <>
        <Box marginTop={1}>
          <Text bold color={COLORS.text.muted}>
            {t('common:ideInstanceSelector.otherInstances')}
          </Text>
        </Box>
        <Box flexDirection="column">
          {nonMatchingInstances.map((instance) =>
            renderNonMatchingInstance(instance)
          )}
        </Box>
      </>
    ) : null;

  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        padding={1}
        flexDirection="column"
        marginBottom={1}
      >
        <Text bold color={COLORS.primary}>
          {t('common:ideInstanceSelector.matchingInstances')}
        </Text>
        <Text color={COLORS.text.muted}>{cwd}</Text>
      </Box>

      {state === SelectorState.LOADING && (
        <Box>
          <Text color={COLORS.success}>
            <Spinner />
          </Text>
          <Text color={COLORS.success}>
            {' '}
            {t('common:ideInstanceSelector.discovering')}
          </Text>
        </Box>
      )}

      {state === SelectorState.SELECT && (
        <Box flexDirection="column" marginBottom={1}>
          {matchingInstances.length === 0 &&
          nonMatchingInstances.length === 0 ? (
            <Box flexDirection="column">
              <Text color={COLORS.text.muted}>
                {t('common:ideInstanceSelector.noInstancesFound')}
              </Text>
              <Box marginTop={1}>
                <Text color={COLORS.text.muted}>
                  {t('common:ideInstanceSelector.pressEscToClose')}
                </Text>
              </Box>
            </Box>
          ) : matchingInstances.length === 0 ? (
            <Box flexDirection="column">
              <Text color={COLORS.text.muted}>
                {t('common:ideInstanceSelector.noMatchingInstances')}
              </Text>
              {renderOtherInstancesSection()}
              <Box marginTop={1}>
                <Text color={COLORS.text.muted}>
                  {t('common:ideInstanceSelector.pressEscToClose')}
                </Text>
              </Box>
            </Box>
          ) : (
            <>
              <Text bold>{t('common:ideInstanceSelector.selectInstance')}</Text>
              <Box flexDirection="column" marginTop={1}>
                {matchingInstances.map((instance, index) =>
                  renderMatchingInstance(instance, index)
                )}
              </Box>
              {renderOtherInstancesSection()}
              <Box marginTop={1}>
                <Text color={COLORS.text.muted}>
                  {t('common:ideInstanceSelector.navigationHint')}
                </Text>
              </Box>
            </>
          )}
        </Box>
      )}

      {state === SelectorState.CONNECTING && (
        <Box>
          <Text color={COLORS.success}>
            <Spinner />
          </Text>
          <Text color={COLORS.success}>
            {' '}
            {t('common:ideInstanceSelector.connecting', {
              name: matchingInstances[selectedIndex]?.ideName,
            })}
          </Text>
        </Box>
      )}

      {state === SelectorState.SUCCESS && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={COLORS.success}>
            {t('common:ideInstanceSelector.connected', {
              name: connectedName || initialConnectedInstance?.ideName,
            })}
          </Text>
          {initialConnectedInstance && (
            <Text color={COLORS.text.muted}>
              {t('common:ideInstanceSelector.workspaceLabel')}
              {initialConnectedInstance.workspace}
            </Text>
          )}
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {onDisconnect ? (
                <>{t('common:ideInstanceSelector.pressDisconnect')}</>
              ) : (
                <>{t('common:ideInstanceSelector.pressEnterContinue')}</>
              )}
            </Text>
          </Box>
        </Box>
      )}

      {state === SelectorState.ERROR && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={COLORS.error}>
            {t('common:ideInstanceSelector.failedToConnectShort')}
          </Text>
          {errorMessage && (
            <Box marginTop={1}>
              <Text color={COLORS.text.muted}>{errorMessage}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {t('common:ideInstanceSelector.pressEnterContinue')}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
