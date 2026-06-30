import { Box, Text } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SessionLoadState } from '@industry/common/daemon';
import { formatMissionIndustryStandardCredits } from '@industry/utils/mission';

import { ChatInput } from '@/components/chat/ChatInput';
import { MC_COLORS } from '@/components/mission-control/constants';
import type {
  SessionViewerViewProps,
  WorkerDisplayStatus,
} from '@/components/mission-control/types';
import { shouldProcessMissionControlScroll } from '@/components/mission-control/utils/scrollInputGuard';
import { convertHistoryMessagesToUIItems } from '@/components/mission-control/utils/sessionStoreTranscript';
import { truncateWithEllipsis } from '@/components/mission-control/utils/text';
import {
  CompactMessageEntry,
  CompactToolEntry,
} from '@/components/mission-control/views/CompactTranscriptEntries';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useSessionMessages } from '@/hooks/useSessionMessages';
import { useSessionSettings } from '@/hooks/useSessionSettings';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import {
  getReasoningEffortDisplayName,
  getTuiModelConfig,
} from '@/models/config';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { formatDurationCompact } from '@/utils/format';
import { canViewTokenUsage } from '@/utils/tokenUsageVisibility';

const MIN_LINES_PER_ENTRY = 1;
const MAX_LINES_PER_ENTRY = 5;
const DEFAULT_LINES_PER_ENTRY = 4;
const SESSION_VIEWER_BANNER_BASE_LINES = 6;
const SESSION_VIEWER_SCROLL_INDICATOR_LINES = 2;
const SESSION_VIEWER_MESSAGE_MODE_BASE_LINES = 4;

export function getSessionViewerLayoutMetrics({
  height,
  linesPerEntry,
  itemCount,
  hasFeature,
  hasWorkerModel,
  hasTokenUsage,
  isMessageMode,
  hasStopError,
  hasSendError,
}: {
  height: number;
  linesPerEntry: number;
  itemCount: number;
  hasFeature: boolean;
  hasWorkerModel: boolean;
  hasTokenUsage: boolean;
  isMessageMode: boolean;
  hasStopError: boolean;
  hasSendError: boolean;
}): {
  maxVisibleItems: number;
  showsScrollIndicator: boolean;
} {
  const bannerLines =
    SESSION_VIEWER_BANNER_BASE_LINES +
    Number(hasFeature) +
    Number(hasWorkerModel) +
    Number(hasTokenUsage);
  const messageModeLines = isMessageMode
    ? SESSION_VIEWER_MESSAGE_MODE_BASE_LINES +
      Number(hasStopError) +
      Number(hasSendError)
    : 0;
  const staticLines = bannerLines + messageModeLines;

  let indicatorLines = 0;

  while (true) {
    const availableLines = Math.max(1, height - staticLines - indicatorLines);
    const maxVisibleItems = Math.max(
      1,
      Math.floor(availableLines / linesPerEntry)
    );
    const showsScrollIndicator = itemCount > maxVisibleItems;
    const nextIndicatorLines = showsScrollIndicator
      ? SESSION_VIEWER_SCROLL_INDICATOR_LINES
      : 0;

    if (nextIndicatorLines === indicatorLines) {
      return { maxVisibleItems, showsScrollIndicator };
    }

    indicatorLines = nextIndicatorLines;
  }
}

function getStatusColor(status?: WorkerDisplayStatus): string {
  switch (status) {
    case 'running':
      return MC_COLORS.active;
    case 'paused':
      return MC_COLORS.tertiary;
    case 'success':
      return MC_COLORS.done;
    case 'partial':
      return MC_COLORS.secondary;
    case 'failed':
      return MC_COLORS.fail;
    default:
      return MC_COLORS.tertiary;
  }
}

const STATUS_LABEL_KEYS: Record<WorkerDisplayStatus, string> = {
  running: 'common:sessionViewer.statusRunning',
  paused: 'common:sessionViewer.statusPaused',
  success: 'common:sessionViewer.statusSuccess',
  partial: 'common:sessionViewer.statusPartial',
  failed: 'common:sessionViewer.statusFailed',
};

function SessionBanner({
  sessionId,
  featureId,
  workerModelDisplay,
  tokenUsage,
  status,
  duration,
  contentWidth,
}: {
  sessionId: string;
  featureId?: string;
  workerModelDisplay?: string | null;
  tokenUsage?: import('@industry/common/session/settings').TokenUsage;
  status?: WorkerDisplayStatus;
  duration?: string;
  contentWidth: number;
}) {
  const { t } = useTranslation('common');
  const sessionLabel = t('common:sessionViewer.sessionLabel');
  const featureLabel = t('common:sessionViewer.featureLabel');
  const modelLabel = t('common:sessionViewer.modelLabel');
  const showTokenUsage = canViewTokenUsage();
  const industryCreditsLabel = t('common:missionControlHeader.industryCredits');

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={MC_COLORS.emphasis}>
        {t('common:sessionViewer.title')}
      </Text>
      <Box marginTop={1}>
        <Text color={MC_COLORS.tertiary}>{sessionLabel}</Text>
        <Text wrap="truncate-end">
          {truncateWithEllipsis(
            sessionId,
            Math.max(8, contentWidth - sessionLabel.length)
          )}
        </Text>
      </Box>
      {featureId ? (
        <Box>
          <Text color={MC_COLORS.tertiary}>{featureLabel}</Text>
          <Text wrap="truncate-end">
            {truncateWithEllipsis(
              featureId,
              Math.max(10, contentWidth - featureLabel.length)
            )}
          </Text>
        </Box>
      ) : null}
      {workerModelDisplay ? (
        <Box>
          <Text color={MC_COLORS.tertiary}>{modelLabel}</Text>
          <Text wrap="truncate-end">
            {truncateWithEllipsis(
              workerModelDisplay,
              Math.max(10, contentWidth - modelLabel.length)
            )}
          </Text>
        </Box>
      ) : null}
      <Box>
        <Text color={MC_COLORS.tertiary}>
          {t('common:sessionViewer.statusLabel')}
        </Text>
        <Text color={getStatusColor(status)}>
          {status
            ? t(STATUS_LABEL_KEYS[status])
            : t('common:sessionViewer.statusUnknown')}
        </Text>
        {duration ? (
          <>
            <Text color={MC_COLORS.tertiary}>
              {t('common:sessionViewer.durationLabel')}
            </Text>
            <Text>{duration}</Text>
          </>
        ) : null}
      </Box>
      {tokenUsage && showTokenUsage ? (
        <Box>
          <Text color={MC_COLORS.tertiary}>{industryCreditsLabel} </Text>
          <Text color={MC_COLORS.dataValue}>
            {formatMissionIndustryStandardCredits(tokenUsage)}
          </Text>
        </Box>
      ) : null}
      <Text color={MC_COLORS.border}>
        {'─'.repeat(Math.min(contentWidth, 60))}
      </Text>
    </Box>
  );
}

export function SessionViewerView({
  sessionId,
  featureId,
  status,
  duration,
  activeDurationAnchorMs,
  workingDirectory: _workingDirectory,
  missionDir: _missionDir,
  tokenUsage,
  viewport,
  allowInterruptAndChat = true,
  onMessageModeChange,
  onNavigateToHandoff,
}: SessionViewerViewProps) {
  const { t } = useTranslation('common');
  const terminalDimensions = useTerminalDimensions();
  const width = viewport?.width ?? terminalDimensions.width;
  const height = viewport?.height ?? terminalDimensions.height;
  const contentWidth = Math.max(1, width);

  const isActiveWorker = status === 'running';
  const canInterruptAndChat = allowInterruptAndChat && isActiveWorker;
  const [durationTick, forceDurationTick] = useState(0);

  useEffect(() => {
    if (!isActiveWorker || activeDurationAnchorMs == null) {
      return;
    }

    const timer = setInterval(() => {
      forceDurationTick((tick) => tick + 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [activeDurationAnchorMs, isActiveWorker]);

  const displayDuration = useMemo(() => {
    if (!isActiveWorker || activeDurationAnchorMs == null) {
      return duration;
    }

    return formatDurationCompact(
      Math.max(0, Date.now() - activeDurationAnchorMs)
    );
  }, [activeDurationAnchorMs, duration, durationTick, isActiveWorker]);
  const sessionMessages = useSessionMessages(sessionId);
  const { model, reasoningEffort } = useSessionSettings(sessionId);

  const [scrollOffset, setScrollOffset] = useState(0);
  const [isMessageMode, setIsMessageMode] = useState(false);
  const [messageInput, setMessageInput] = useState('');
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(
    () =>
      getTuiDaemonAdapter()
        .getSessionStateManager()
        .getSessionLoadState(sessionId) === SessionLoadState.NotLoaded
  );
  const [linesPerEntry, setLinesPerEntry] = useState(DEFAULT_LINES_PER_ENTRY);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);

  useMountEffect(() => {
    let cancelled = false;
    let loadedForViewer = false;
    let closedLoadedSession = false;
    const adapter = getTuiDaemonAdapter();
    const shouldCloseLoadedSession =
      status !== 'running' && status !== 'paused';
    const closeLoadedSession = () => {
      if (!shouldCloseLoadedSession || closedLoadedSession) {
        return;
      }
      closedLoadedSession = true;
      void adapter.closeSession(sessionId).catch(() => {});
    };

    if (
      adapter.getSessionStateManager().getSessionLoadState(sessionId) !==
      SessionLoadState.NotLoaded
    ) {
      return () => {
        cancelled = true;
      };
    }

    setIsLoadingTranscript(true);
    setLoadError(null);
    void adapter
      .loadSession(sessionId)
      .then(() => {
        loadedForViewer = true;
        if (cancelled) {
          closeLoadedSession();
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setLoadError(
          error instanceof Error
            ? error.message
            : t('common:sessionViewer.unknownError')
        );
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingTranscript(false);
        }
      });

    return () => {
      cancelled = true;
      if (loadedForViewer) {
        closeLoadedSession();
      }
    };
  });

  useEffect(() => {
    onMessageModeChange?.(isMessageMode);
  }, [isMessageMode, onMessageModeChange]);

  useEffect(() => {
    setScrollOffset(0);
    setIsMessageMode(false);
    setMessageInput('');
    setStopError(null);
    setSendError(null);
    setLoadError(null);
    setIsFollowingLatest(true);
  }, [sessionId]);

  const workerModelDisplay = useMemo(() => {
    if (!model) {
      return null;
    }
    const modelConfig = getTuiModelConfig(model);
    const modelName =
      modelConfig.shortDisplayName || modelConfig.displayName || model;
    if (!reasoningEffort) {
      return modelName;
    }
    return `${modelName} (${getReasoningEffortDisplayName(reasoningEffort)})`;
  }, [model, reasoningEffort]);

  const uiItems = useMemo(
    () => convertHistoryMessagesToUIItems(sessionMessages),
    [sessionMessages]
  );

  const { maxVisibleItems, showsScrollIndicator } = useMemo(
    () =>
      getSessionViewerLayoutMetrics({
        height,
        linesPerEntry,
        itemCount: uiItems.length,
        hasFeature: Boolean(featureId),
        hasWorkerModel: Boolean(workerModelDisplay),
        hasTokenUsage: Boolean(tokenUsage),
        isMessageMode,
        hasStopError: Boolean(stopError),
        hasSendError: Boolean(sendError),
      }),
    [
      featureId,
      height,
      isMessageMode,
      linesPerEntry,
      sendError,
      stopError,
      tokenUsage,
      uiItems.length,
      workerModelDisplay,
    ]
  );
  const maxScrollOffset = Math.max(0, uiItems.length - maxVisibleItems);
  const visibleItems = useMemo(
    () => uiItems.slice(scrollOffset, scrollOffset + maxVisibleItems),
    [maxVisibleItems, scrollOffset, uiItems]
  );

  useEffect(() => {
    setScrollOffset((current) =>
      isFollowingLatest ? maxScrollOffset : Math.min(current, maxScrollOffset)
    );
  }, [isFollowingLatest, maxScrollOffset]);

  const enterMessageMode = useCallback(() => {
    if (!canInterruptAndChat || isSendingMessage) {
      return;
    }

    onMessageModeChange?.(true);
    setIsMessageMode(true);
    setMessageInput('');
    setStopError(null);
    setSendError(null);
    void getTuiDaemonAdapter()
      .interruptSession(sessionId)
      .catch((error) => {
        setStopError(
          error instanceof Error ? error.message : 'Failed to stop worker'
        );
      });
  }, [canInterruptAndChat, isSendingMessage, onMessageModeChange, sessionId]);

  const exitMessageMode = useCallback(() => {
    setIsMessageMode(false);
    setMessageInput('');
    setStopError(null);
    setSendError(null);
  }, []);

  const handleSubmitMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isSendingMessage) {
        return;
      }

      setIsSendingMessage(true);
      setSendError(null);
      try {
        await getTuiDaemonAdapter().addUserMessage({
          sessionId,
          text: trimmed,
        });
        setMessageInput('');
        setIsFollowingLatest(true);
        exitMessageMode();
      } catch (error) {
        setSendError(
          error instanceof Error ? error.message : 'Failed to send message'
        );
      } finally {
        setIsSendingMessage(false);
      }
    },
    [exitMessageMode, isSendingMessage, sessionId]
  );

  useKeypressHandler((input, key) => {
    if (key.escape && isMessageMode) {
      exitMessageMode();
      return;
    }

    if (isMessageMode) {
      return;
    }

    if (input === ']') {
      setLinesPerEntry((value) => Math.min(MAX_LINES_PER_ENTRY, value + 1));
      return;
    }

    if (input === '[') {
      setLinesPerEntry((value) => Math.max(MIN_LINES_PER_ENTRY, value - 1));
      return;
    }

    if (key.upArrow) {
      if (!shouldProcessMissionControlScroll()) {
        return;
      }
      setIsFollowingLatest(false);
      setScrollOffset((value) => Math.max(0, value - 1));
      return;
    }

    if (key.downArrow) {
      if (!shouldProcessMissionControlScroll()) {
        return;
      }
      const nextScrollOffset = Math.min(maxScrollOffset, scrollOffset + 1);
      setIsFollowingLatest(nextScrollOffset >= maxScrollOffset);
      setScrollOffset(nextScrollOffset);
      return;
    }

    if (input === 'g') {
      setIsFollowingLatest(false);
      setScrollOffset(0);
      return;
    }

    if (input === 'G') {
      setIsFollowingLatest(true);
      setScrollOffset(maxScrollOffset);
      return;
    }

    if (input === 's' && canInterruptAndChat) {
      enterMessageMode();
      return;
    }

    if (input === 'h' && onNavigateToHandoff) {
      onNavigateToHandoff();
    }
  });

  return (
    <Box flexDirection="column">
      <SessionBanner
        sessionId={sessionId}
        featureId={featureId}
        workerModelDisplay={workerModelDisplay}
        tokenUsage={tokenUsage}
        status={status}
        duration={displayDuration}
        contentWidth={contentWidth}
      />

      {visibleItems.length === 0 && loadError ? (
        <Text color={MC_COLORS.fail}>
          {t('common:sessionViewer.errorPrefix', { message: loadError })}
        </Text>
      ) : visibleItems.length === 0 && isLoadingTranscript ? (
        <Text color={MC_COLORS.tertiary}>
          {t('common:sessionViewer.waitingForTranscript')}
        </Text>
      ) : visibleItems.length === 0 && !isActiveWorker ? (
        <Box flexDirection="column">
          <Text color={MC_COLORS.tertiary}>
            {t('common:sessionViewer.transcriptUnavailable')}
          </Text>
          <Text color={MC_COLORS.ghost}>
            {t('common:sessionViewer.transcriptUnavailableHint')}
          </Text>
        </Box>
      ) : visibleItems.length === 0 ? (
        <Text color={MC_COLORS.tertiary}>
          {t('common:missionControl.noWorkerActivity')}
        </Text>
      ) : (
        visibleItems.map((item) =>
          item.kind === 'message' ? (
            <CompactMessageEntry
              key={item.data.id}
              message={item.data}
              contentWidth={contentWidth}
              linesPerEntry={linesPerEntry}
            />
          ) : (
            <CompactToolEntry
              key={item.data.id}
              tool={item.data}
              contentWidth={contentWidth}
              linesPerEntry={linesPerEntry}
            />
          )
        )
      )}

      {showsScrollIndicator ? (
        <Box marginTop={1}>
          <Text color={MC_COLORS.tertiary}>
            {scrollOffset + 1}-
            {Math.min(uiItems.length, scrollOffset + maxVisibleItems)} /{' '}
            {uiItems.length}
          </Text>
        </Box>
      ) : null}

      {isMessageMode ? (
        <Box flexDirection="column" marginTop={1}>
          {stopError ? <Text color={MC_COLORS.fail}>{stopError}</Text> : null}
          {sendError ? <Text color={MC_COLORS.fail}>{sendError}</Text> : null}
          <ChatInput
            initialValue={messageInput}
            onInputChange={setMessageInput}
            onSubmit={handleSubmitMessage}
            placeholder=""
            isFocused={!isSendingMessage}
          />
        </Box>
      ) : null}
    </Box>
  );
}
