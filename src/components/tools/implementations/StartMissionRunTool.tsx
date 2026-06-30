import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { getI18n } from 'react-i18next';

import {
  FeatureStatus,
  MissionPauseReason,
  MissionState,
} from '@industry/drool-sdk-ext/protocol/drool';

import { COLORS } from '@/components/chat/themedColors';
import { MC_COLORS } from '@/components/mission-control/constants';
import { isMissionStateTimingActive } from '@/components/mission-control/utils/missionElapsedTime';
import {
  allocateProgressBarSegments,
  getProgressDisplayTotal,
} from '@/components/mission-control/utils/progressBar';
import { Spinner } from '@/components/Spinner';
import { ToolPreviewTier } from '@/components/tools/enums';
import { buildStartMissionRunWorkerActivity } from '@/components/tools/implementations/startMissionRunWorkerActivity';
import type { StartMissionRunWorkerActivity } from '@/components/tools/implementations/types';
import type {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import { getToolPreviewBudget } from '@/components/tools/utils/previewBudget';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useSessionMessages } from '@/hooks/useSessionMessages';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import { ensureSessionLoadedForPreview } from '@/services/daemon/ensureSessionLoadedForPreview';
import {
  getLatestStartMissionRunProgressSnapshot,
  isStartMissionRunProgressSnapshot,
} from '@/services/mission/startMissionRunProgress';
import type {
  StartMissionRunFeaturePreview,
  StartMissionRunProgressDetails,
} from '@/services/mission/types';
import { isUserCancellationMessage } from '@/utils/error-messages';
import { getTextContent } from '@/utils/tool-result-helpers';

import type { StartMissionRunResult } from '@industry/drool-core/tools/definitions';

type DisplayedFeature = StartMissionRunFeaturePreview & {
  isPrimary: boolean;
};

const MAX_ACTIVITY_LINES_BY_TIER: Record<ToolPreviewTier, number> = {
  [ToolPreviewTier.XS]: 1,
  [ToolPreviewTier.SM]: 1,
  [ToolPreviewTier.MD]: 2,
  [ToolPreviewTier.LG]: 3,
};

function getFeatureStatusPresentation(status: string): {
  icon: string;
  iconColor: string;
  textColor?: string;
  isActive: boolean;
} {
  switch (status) {
    case FeatureStatus.Completed:
      return {
        icon: '✓',
        iconColor: MC_COLORS.done,
        textColor: MC_COLORS.tertiary,
        isActive: false,
      };
    case FeatureStatus.InProgress:
      return {
        icon: '●',
        iconColor: MC_COLORS.active,
        textColor: MC_COLORS.active,
        isActive: true,
      };
    case FeatureStatus.Cancelled:
      return {
        icon: '✗',
        iconColor: MC_COLORS.fail,
        isActive: false,
      };
    default:
      return {
        icon: '○',
        iconColor: MC_COLORS.tertiary,
        isActive: false,
      };
  }
}

const KNOWN_MISSION_STATES = new Set<string>(Object.values(MissionState));

function getMissionStatePresentation(state: string): {
  label: string;
  icon: string;
  color: string;
} {
  switch (state) {
    case MissionState.Running:
      return {
        label: getI18n().t('common:toolDisplay.startMission.running'),
        icon: '●',
        color: MC_COLORS.done,
      };
    case MissionState.Paused:
      return {
        label: getI18n().t('common:toolDisplay.startMission.paused'),
        icon: '○',
        color: MC_COLORS.secondary,
      };
    case MissionState.Completed:
      return {
        label: getI18n().t('common:toolDisplay.startMission.completed'),
        icon: '✓',
        color: MC_COLORS.done,
      };
    case MissionState.OrchestratorTurn:
      return {
        label: getI18n().t(
          'common:toolDisplay.startMission.returnedToOrchestrator'
        ),
        icon: '◆',
        color: MC_COLORS.active,
      };
    case MissionState.Initializing:
      return {
        label: getI18n().t('common:toolDisplay.startMission.initializing'),
        icon: '◐',
        color: MC_COLORS.active,
      };
    case MissionState.Planning:
    case MissionState.AwaitingInput:
      return {
        label: getI18n().t('common:toolDisplay.startMission.waiting'),
        icon: '○',
        color: MC_COLORS.tertiary,
      };
    default:
      return { label: state, icon: '○', color: MC_COLORS.tertiary };
  }
}

function truncateDescription(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function isMissionElapsedTimerActive(state: string): boolean {
  return (
    KNOWN_MISSION_STATES.has(state) &&
    isMissionStateTimingActive(state as MissionState)
  );
}

function formatElapsedMs(elapsed: number | null): string | null {
  if (elapsed === null) return null;
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  return `${hours}h ${remainingMins}m`;
}

function parseResultData(resultText: string): StartMissionRunResult | null {
  try {
    return JSON.parse(resultText) as StartMissionRunResult;
  } catch {
    return null;
  }
}

function getResultProgressSnapshot(
  resultData: StartMissionRunResult | null
): StartMissionRunProgressDetails | null {
  const snapshot = resultData?.progressSnapshot;
  return isStartMissionRunProgressSnapshot(snapshot) ? snapshot : null;
}

function getDisplayProgressSnapshot(
  progressUpdates: ToolComponentProps['progressUpdates'],
  resultData: StartMissionRunResult | null
): StartMissionRunProgressDetails | null {
  return (
    getLatestStartMissionRunProgressSnapshot(progressUpdates) ??
    getResultProgressSnapshot(resultData)
  );
}

function useStartMissionRunWorkerActivity(
  workerSessionId: string | null
): StartMissionRunWorkerActivity | null {
  useEffect(() => {
    if (!workerSessionId) return;
    ensureSessionLoadedForPreview(workerSessionId, 'StartMissionRunTool');
  }, [workerSessionId]);

  const workerMessages = useSessionMessages(workerSessionId);

  return useMemo(
    () =>
      buildStartMissionRunWorkerActivity({
        workerSessionId,
        workerMessages,
      }),
    [workerSessionId, workerMessages]
  );
}

function getElapsedMsFromActiveTime(
  activeTime: StartMissionRunProgressDetails['activeTime'],
  missionState: string,
  now = Date.now()
): number | null {
  if (!activeTime) {
    return null;
  }

  if (isMissionElapsedTimerActive(missionState)) {
    return Math.max(0, activeTime.elapsedMs + now - activeTime.measuredAtMs);
  }

  return Math.max(0, activeTime.elapsedMs);
}

function ElapsedTimeSuffix({
  activeTime,
  missionState,
}: {
  activeTime: StartMissionRunProgressDetails['activeTime'];
  missionState: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useMountEffect(() => {
    if (!activeTime || !isMissionElapsedTimerActive(missionState)) {
      return;
    }

    let interval: ReturnType<typeof setInterval> | undefined;
    const currentElapsedMs = getElapsedMsFromActiveTime(
      activeTime,
      missionState
    );
    if (currentElapsedMs === null) {
      return;
    }

    const msUntilNextMinute = 60000 - (currentElapsedMs % 60000);
    const timeout = setTimeout(
      () => {
        setNow(Date.now());
        interval = setInterval(() => setNow(Date.now()), 60_000);
      },
      Math.max(100, msUntilNextMinute)
    );

    return () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (interval) {
        clearInterval(interval);
      }
    };
  });

  const elapsedTime = formatElapsedMs(
    getElapsedMsFromActiveTime(activeTime, missionState, now)
  );
  if (!elapsedTime) {
    return null;
  }

  return <Text color={MC_COLORS.tertiary}> · {elapsedTime}</Text>;
}

function getDisplayedFeatures(
  featureWindow: StartMissionRunProgressDetails['featureWindow'],
  tier: ToolPreviewTier
): DisplayedFeature[] {
  const { previous, focus, next } = featureWindow;
  if (!focus) {
    return [];
  }

  const features =
    tier === ToolPreviewTier.LG
      ? [previous, focus, next]
      : tier === ToolPreviewTier.MD
        ? next
          ? [focus, next]
          : [previous, focus]
        : [focus];

  return features
    .filter(
      (feature): feature is StartMissionRunFeaturePreview =>
        feature !== undefined
    )
    .map((feature) => ({
      ...feature,
      isPrimary: feature.id === focus.id,
    }));
}

function MissionProgressStatusRow({
  missionStatePresentation,
  missionState,
  completedFeatures,
  displayTotal,
  pendingInjectedCount,
  activeTime,
  elapsedKey,
  width,
}: {
  missionStatePresentation: ReturnType<typeof getMissionStatePresentation>;
  missionState: string;
  completedFeatures: number;
  displayTotal: number;
  pendingInjectedCount: number;
  activeTime: StartMissionRunProgressDetails['activeTime'];
  elapsedKey: string;
  width?: number;
}) {
  const statusColor = missionStatePresentation.color;

  return (
    <Box justifyContent="space-between" width={width}>
      <Box>
        <Text color={statusColor}>
          {missionStatePresentation.icon}
          {'  '}
        </Text>
        <Text color={statusColor}>{missionStatePresentation.label}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={statusColor}>
          {completedFeatures}/{displayTotal}
        </Text>
        {pendingInjectedCount > 0 && (
          <Text color={MC_COLORS.tertiary}> [+{pendingInjectedCount}]</Text>
        )}
        <ElapsedTimeSuffix
          key={elapsedKey}
          activeTime={activeTime}
          missionState={missionState}
        />
        {missionState === MissionState.Running && (
          <Text color={statusColor}>
            {' '}
            <Spinner />
          </Text>
        )}
      </Box>
    </Box>
  );
}

function MissionProgressBar({
  progressSegments,
  marginTop,
}: {
  progressSegments: ReturnType<typeof allocateProgressBarSegments>;
  marginTop?: number;
}) {
  return (
    <Box marginTop={marginTop}>
      <Text color={MC_COLORS.done}>{'█'.repeat(progressSegments.filled)}</Text>
      {progressSegments.pending > 0 && (
        <Text color={MC_COLORS.secondary}>
          {'▒'.repeat(progressSegments.pending)}
        </Text>
      )}
      <Text color={MC_COLORS.barEmpty}>
        {'░'.repeat(progressSegments.estimate)}
      </Text>
    </Box>
  );
}

function MissionFeatureRow({
  feature,
  innerWidth,
  descriptionMaxLength,
  showDescription = Boolean(feature.description),
  marginLeft,
  detailed = false,
}: {
  feature: DisplayedFeature;
  innerWidth?: number;
  descriptionMaxLength?: number;
  showDescription?: boolean;
  marginLeft?: number;
  detailed?: boolean;
}) {
  const featureStatus = getFeatureStatusPresentation(feature.status);
  const label = detailed
    ? feature.id
    : truncateDescription(feature.id, Math.max(10, (innerWidth ?? 30) - 3));
  const description = detailed
    ? feature.description
    : feature.description && descriptionMaxLength
      ? truncateDescription(feature.description, descriptionMaxLength)
      : feature.description;

  return (
    <Box flexDirection="column" marginLeft={marginLeft}>
      <Box>
        <Text color={featureStatus.iconColor}>{featureStatus.icon} </Text>
        <Text
          color={featureStatus.textColor ?? MC_COLORS.secondary}
          bold={!detailed && featureStatus.isActive}
          wrap={detailed ? undefined : 'truncate'}
        >
          {label}
          {feature.milestone ? (
            detailed ? (
              ` [${feature.milestone}]`
            ) : (
              <Text color={MC_COLORS.tertiary}> [{feature.milestone}]</Text>
            )
          ) : (
            ''
          )}
        </Text>
      </Box>
      {showDescription && description && (
        <Text
          color={detailed ? MC_COLORS.secondary : MC_COLORS.tertiary}
          wrap={detailed ? 'wrap' : 'truncate'}
        >
          {'   '}
          {description}
        </Text>
      )}
    </Box>
  );
}

interface ProgressPanelProps {
  snapshot: StartMissionRunProgressDetails;
  workerActivity?: StartMissionRunWorkerActivity | null;
  borderColor?: string;
  footerMessage?: string;
  footerColor?: string;
  contentWidth?: number;
  overrideState?: string;
}

function ProgressPanel({
  snapshot,
  workerActivity,
  borderColor,
  footerMessage,
  footerColor,
  contentWidth,
  overrideState,
}: ProgressPanelProps) {
  const { width: terminalWidth, height: terminalHeight } =
    useTerminalDimensions();
  const effectiveWidth = contentWidth ?? terminalWidth;
  const effectivePreviewBudget = getToolPreviewBudget(terminalHeight);
  const { maxLines, tier } = effectivePreviewBudget;
  // Border takes 2 chars each side + 2 chars paddingX
  const innerWidth = Math.max(30, effectiveWidth - 4);
  const descriptionMaxLength = Math.max(innerWidth - 5, 20);
  const activityMaxLength = Math.max(innerWidth - 7, 20);

  const completedFeatures = snapshot.counts.completed;
  const totalFeatures = snapshot.counts.total;
  const workerActivityEntries = workerActivity?.recentActivity ?? [];
  const missionState = overrideState ?? snapshot.state;
  const missionStatePresentation = getMissionStatePresentation(missionState);
  const workerSessionId = snapshot.currentWorkerId;
  const workerToolCount = workerActivity?.toolCount ?? 0;

  // Determine border color from state if not explicitly provided
  const effectiveBorderColor =
    borderColor ??
    (missionState === MissionState.Completed
      ? MC_COLORS.done
      : MC_COLORS.border);

  const displayedFeatures = getDisplayedFeatures(snapshot.featureWindow, tier);
  const hiddenCount = Math.max(0, totalFeatures - displayedFeatures.length);

  // Progress bar
  const cancelledCount = snapshot.counts.cancelled;
  const pendingInjectedCount = snapshot.counts.estimatedValidation;
  const activeTotal = totalFeatures - cancelledCount;
  const remainingCount = Math.max(0, activeTotal - completedFeatures);
  const progressCounts = {
    completed: completedFeatures,
    pending: remainingCount,
    estimated: pendingInjectedCount,
  };
  const displayTotal = getProgressDisplayTotal(progressCounts);
  const barMaxWidth = Math.max(1, effectiveWidth - 4);
  const progressSegments = allocateProgressBarSegments(
    progressCounts,
    barMaxWidth
  );
  const elapsedKey = `${missionState}:${snapshot.updatedAt ?? ''}:${snapshot.activeTime?.measuredAtMs ?? ''}`;

  const isCompactPreview =
    tier === ToolPreviewTier.XS || tier === ToolPreviewTier.SM;
  if (isCompactPreview) {
    const latestActivity =
      workerActivityEntries.length > 0
        ? workerActivityEntries[workerActivityEntries.length - 1]?.summary
        : undefined;
    const workerSummaryParts = [
      workerSessionId ? `#${workerSessionId.slice(0, 8)}` : undefined,
      workerToolCount > 0
        ? `${workerToolCount} ${getI18n().t('common:toolDisplay.startMission.tools')}`
        : undefined,
    ].filter((part): part is string => Boolean(part));
    const compactWorkerDetails =
      latestActivity ??
      (workerSummaryParts.length > 0
        ? workerSummaryParts.join(' · ')
        : undefined);

    if (tier === ToolPreviewTier.XS) {
      return (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={effectiveBorderColor}
          paddingX={1}
        >
          <MissionProgressStatusRow
            missionStatePresentation={missionStatePresentation}
            missionState={missionState}
            completedFeatures={completedFeatures}
            displayTotal={displayTotal}
            pendingInjectedCount={pendingInjectedCount}
            activeTime={snapshot.activeTime}
            elapsedKey={elapsedKey}
            width={innerWidth}
          />
          {compactWorkerDetails && (
            <Text color={MC_COLORS.tertiary} dimColor wrap="truncate-end">
              {truncateDescription(
                compactWorkerDetails,
                Math.max(10, innerWidth)
              )}
            </Text>
          )}
        </Box>
      );
    }

    const compactFeature = snapshot.featureWindow.focus ?? displayedFeatures[0];
    const compactFeatureStatus = compactFeature
      ? getFeatureStatusPresentation(compactFeature.status)
      : null;
    const moreLabel =
      hiddenCount > 0
        ? getI18n().t('common:toolDisplay.startMission.moreFeatures', {
            count: hiddenCount,
          })
        : undefined;
    const compactDetails = footerMessage ?? compactWorkerDetails;

    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={effectiveBorderColor}
        paddingX={1}
      >
        <MissionProgressStatusRow
          missionStatePresentation={missionStatePresentation}
          missionState={missionState}
          completedFeatures={completedFeatures}
          displayTotal={displayTotal}
          pendingInjectedCount={pendingInjectedCount}
          activeTime={snapshot.activeTime}
          elapsedKey={elapsedKey}
        />

        {tier === ToolPreviewTier.SM && (
          <MissionProgressBar progressSegments={progressSegments} />
        )}

        {compactFeature && (
          <Text wrap="truncate-end">
            <Text color={compactFeatureStatus?.iconColor}>
              {compactFeatureStatus?.icon}{' '}
            </Text>
            <Text
              color={compactFeatureStatus?.textColor ?? MC_COLORS.secondary}
              bold={compactFeatureStatus?.isActive}
            >
              {truncateDescription(
                compactFeature.id,
                Math.max(10, innerWidth - 4)
              )}
            </Text>
            {moreLabel && (
              <Text color={MC_COLORS.tertiary}> · {moreLabel}</Text>
            )}
          </Text>
        )}

        {compactDetails && (
          <Text
            color={
              footerMessage
                ? (footerColor ?? MC_COLORS.secondary)
                : MC_COLORS.tertiary
            }
            dimColor={!footerMessage}
            wrap="truncate-end"
          >
            {truncateDescription(compactDetails, Math.max(10, innerWidth))}
          </Text>
        )}
      </Box>
    );
  }

  const hasWorkerSection =
    Boolean(workerSessionId) || workerActivityEntries.length > 0;
  const workerSectionSpacing = hasWorkerSection ? 1 : 0;
  const footerSectionSpacing = footerMessage ? 1 : 0;

  const baseUsedLines =
    2 +
    2 + // marginTop gaps (status->progress bar, progress bar->features)
    displayedFeatures.length +
    (hiddenCount > 0 ? 1 : 0) +
    (workerSessionId ? 1 : 0) +
    (footerMessage ? 1 : 0) +
    workerSectionSpacing +
    footerSectionSpacing;
  let remainingOptionalLines = Math.max(0, maxLines - baseUsedLines);
  const shouldShowPrimaryDescription =
    tier === ToolPreviewTier.LG &&
    remainingOptionalLines > 0 &&
    displayedFeatures.some(
      (feature) => feature.isPrimary && Boolean(feature.description)
    );

  if (shouldShowPrimaryDescription) {
    remainingOptionalLines -= 1;
  }

  const visibleActivityLines = Math.min(
    workerActivityEntries.length,
    MAX_ACTIVITY_LINES_BY_TIER[tier],
    remainingOptionalLines
  );
  remainingOptionalLines -= visibleActivityLines;
  const recentActivity = workerActivityEntries.slice(-visibleActivityLines);
  const shouldShowMissionControlHint = remainingOptionalLines >= 2;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={effectiveBorderColor}
      paddingX={1}
    >
      {/* Status bar with state indicator and elapsed time */}
      <MissionProgressStatusRow
        missionStatePresentation={missionStatePresentation}
        missionState={missionState}
        completedFeatures={completedFeatures}
        displayTotal={displayTotal}
        pendingInjectedCount={pendingInjectedCount}
        activeTime={snapshot.activeTime}
        elapsedKey={elapsedKey}
      />

      {/* Progress bar */}
      <MissionProgressBar progressSegments={progressSegments} marginTop={1} />

      {/* Features list with status icons */}
      {displayedFeatures.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {displayedFeatures.map((feature) => (
            <MissionFeatureRow
              key={feature.id}
              feature={feature}
              innerWidth={innerWidth}
              descriptionMaxLength={descriptionMaxLength}
              showDescription={
                feature.isPrimary && shouldShowPrimaryDescription
              }
            />
          ))}
        </Box>
      )}

      {/* Truncation indicator */}
      {hiddenCount > 0 && (
        <Text color={MC_COLORS.tertiary} wrap="truncate-end">
          {'   '}
          {getI18n().t('common:toolDisplay.startMission.moreFeatures', {
            count: hiddenCount,
          })}
        </Text>
      )}

      {/* Active worker info */}
      {workerSessionId && (
        <Box marginTop={1}>
          <Text color={MC_COLORS.worker}>#{workerSessionId.slice(0, 8)}</Text>
          {workerToolCount > 0 && (
            <Text color={MC_COLORS.tertiary}>
              {' · '}
              {workerToolCount}{' '}
              {getI18n().t('common:toolDisplay.startMission.tools')}
            </Text>
          )}
        </Box>
      )}

      {/* Worker activity (last few updates) */}
      {recentActivity.length > 0 && (
        <Box flexDirection="column" marginTop={workerSessionId ? 0 : 1}>
          {recentActivity.map((activity, activityIndex) => (
            <Text
              key={`activity-${activityIndex}`}
              color={MC_COLORS.tertiary}
              dimColor
              wrap="truncate"
            >
              {'  '}
              {truncateDescription(activity.summary, activityMaxLength)}
            </Text>
          ))}
        </Box>
      )}

      {/* Footer message (for errors/cancellation) */}
      {footerMessage && (
        <Box marginTop={1}>
          <Text color={footerColor ?? MC_COLORS.secondary} wrap="truncate-end">
            {footerMessage}
          </Text>
        </Box>
      )}

      {/* Mission Control hint */}
      {shouldShowMissionControlHint && (
        <Box marginTop={1}>
          <Text color={MC_COLORS.tertiary} wrap="truncate-end">
            <Text color={MC_COLORS.primary}>
              {getI18n().t(
                'common:toolDisplay.startMission.missionControlShortcut'
              )}
            </Text>
            {getI18n().t('common:toolDisplay.startMission.enterMissionControl')}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function PendingMissionCard() {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={MC_COLORS.border}
      paddingX={1}
    >
      <Box>
        <Text color={MC_COLORS.tertiary}>◐ </Text>
        <Text color={MC_COLORS.tertiary}>
          {getI18n().t('common:toolDisplay.startMission.preparingStart')}
        </Text>
      </Box>
    </Box>
  );
}

function PausedFallbackCard() {
  const state = getMissionStatePresentation(MissionState.Paused);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={MC_COLORS.secondary}
      paddingX={1}
    >
      <Box>
        <Text color={state.color}>{state.icon} </Text>
        <Text color={state.color}>{state.label}</Text>
      </Box>
    </Box>
  );
}

function ErrorFallbackCard({
  message,
  contentWidth,
}: {
  message: string;
  contentWidth?: number;
}) {
  const lines = message.split('\n');
  const firstLineIndex = lines.findIndex((line) => line.trim().length > 0);
  const firstLine =
    (firstLineIndex >= 0 ? lines[firstLineIndex]?.trim() : undefined) ??
    getI18n().t('common:toolDisplay.startMission.summaryFailed');
  const detailLines = lines
    .slice(firstLineIndex + 1)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  const innerWidth = Math.min(96, Math.max(30, (contentWidth ?? 80) - 4));

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={MC_COLORS.fail}
      paddingX={1}
    >
      <Box>
        <Text color={MC_COLORS.fail}>✗ </Text>
        <Text color={MC_COLORS.fail} wrap="truncate-end">
          {truncateDescription(firstLine, innerWidth - 2)}
        </Text>
      </Box>
      {detailLines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {detailLines.map((line, index) => (
            <Text
              key={`error-line-${index}`}
              color={MC_COLORS.fail}
              wrap="truncate-end"
            >
              {truncateDescription(line, innerWidth)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function UsageLimitFallbackCard() {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={MC_COLORS.fail}
      paddingX={1}
    >
      <Box>
        <Text color={MC_COLORS.fail}>✗ </Text>
        <Text color={MC_COLORS.fail}>
          {getI18n().t('common:toolDisplay.startMission.usageLimitReached')}
        </Text>
      </Box>
      <Text color={MC_COLORS.tertiary} wrap="wrap">
        {getI18n().t(
          'common:toolDisplay.startMission.usageLimitReachedDescription'
        )}
      </Text>
    </Box>
  );
}

function stripSystemTags(message: string): string {
  return message
    .replace(/^<system>\s*/i, '')
    .replace(/\s*<\/system>$/i, '')
    .trim();
}

function getHistoricalResultState(resultData: StartMissionRunResult): {
  label: string;
  icon: string;
  color: string;
  borderColor: string;
  detail?: string;
} {
  const systemMessage = stripSystemTags(resultData.systemMessage ?? '');
  const normalized = systemMessage.toLowerCase();

  if (resultData.pauseReason === MissionPauseReason.UnrecoverableUsage402) {
    return {
      label: getI18n().t('common:toolDisplay.startMission.usageLimitReached'),
      icon: '✗',
      color: MC_COLORS.fail,
      borderColor: MC_COLORS.fail,
      detail: getI18n().t(
        'common:toolDisplay.startMission.usageLimitReachedDescription'
      ),
    };
  }

  if (resultData.pauseReason === MissionPauseReason.FeatureRetryLimitExceeded) {
    return {
      label: getI18n().t('common:toolDisplay.startMission.retryLimitReached'),
      icon: '✗',
      color: MC_COLORS.fail,
      borderColor: MC_COLORS.fail,
      detail: getI18n().t(
        'common:toolDisplay.startMission.retryLimitReachedDescription'
      ),
    };
  }

  if (
    normalized.includes('paused') ||
    normalized.includes('interrupted') ||
    normalized.includes('cancelled')
  ) {
    const state = getMissionStatePresentation(MissionState.Paused);
    return {
      label: state.label,
      icon: state.icon,
      color: state.color,
      borderColor: MC_COLORS.secondary,
      detail: systemMessage || undefined,
    };
  }

  if (
    normalized.includes('all features completed') ||
    normalized.includes('completed successfully')
  ) {
    const state = getMissionStatePresentation(MissionState.Completed);
    return {
      label: state.label,
      icon: state.icon,
      color: state.color,
      borderColor: MC_COLORS.done,
      detail: systemMessage || undefined,
    };
  }

  if (
    resultData.latestWorkerHandoff ||
    (resultData.workerHandoffs?.length ?? 0) > 0 ||
    normalized.includes('returned control')
  ) {
    const state = getMissionStatePresentation(MissionState.OrchestratorTurn);
    return {
      label: state.label,
      icon: state.icon,
      color: state.color,
      borderColor: MC_COLORS.border,
      detail: systemMessage || undefined,
    };
  }

  return {
    label: getI18n().t('common:toolDisplay.startMission.finished'),
    icon: '○',
    color: MC_COLORS.tertiary,
    borderColor: MC_COLORS.border,
    detail: systemMessage || undefined,
  };
}

function HistoricalResultCard({
  resultData,
  contentWidth,
}: {
  resultData: StartMissionRunResult;
  contentWidth?: number;
}) {
  const state = getHistoricalResultState(resultData);
  const handoff = resultData.latestWorkerHandoff;
  const handoffCount = resultData.workerHandoffs?.length ?? (handoff ? 1 : 0);
  const completed = resultData.completedFeatures?.length ?? 0;
  const total = resultData.totalFeatures ?? 0;
  const innerWidth = Math.max(30, (contentWidth ?? 80) - 4);
  const detailMaxLength = Math.max(20, innerWidth);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={state.borderColor}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Box>
          <Text color={state.color}>{state.icon} </Text>
          <Text color={state.color}>{state.label}</Text>
        </Box>
        {total > 0 && (
          <Text color={state.color}>
            {completed}/{total}
          </Text>
        )}
      </Box>

      {handoff && (
        <Box marginTop={1}>
          <Text color={MC_COLORS.tertiary}>
            {getI18n().t('common:toolDisplay.startMission.lastHandoff')}{' '}
          </Text>
          <Text
            color={
              handoff.resultState === 'pass' ? MC_COLORS.done : MC_COLORS.fail
            }
          >
            {handoff.featureId}
          </Text>
          <Text color={MC_COLORS.tertiary}> · {handoff.resultState}</Text>
          {handoffCount > 1 && (
            <Text color={MC_COLORS.tertiary}> · +{handoffCount - 1}</Text>
          )}
        </Box>
      )}

      {!handoff && handoffCount > 0 && (
        <Text color={MC_COLORS.tertiary} wrap="truncate-end">
          {getI18n().t('common:toolDisplay.startMission.workerHandoffCount', {
            count: handoffCount,
          })}
        </Text>
      )}

      {state.detail && (
        <Text color={MC_COLORS.tertiary} wrap="truncate-end">
          {truncateDescription(state.detail, detailMaxLength)}
        </Text>
      )}
    </Box>
  );
}

function ResultFallbackCard({ resultText }: { resultText: string }) {
  const lines = resultText.split('\n').filter((line) => line.trim());
  const firstLine =
    lines[0] ?? getI18n().t('common:toolDisplay.startMission.missionCompleted');

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={MC_COLORS.border}
      paddingX={1}
    >
      <Text color={MC_COLORS.secondary}>{firstLine}</Text>
    </Box>
  );
}

function StartMissionRunResultView({
  result,
  isError,
  contentWidth,
  progressUpdates,
}: ToolComponentProps) {
  const resultText = getTextContent(result);
  const resultData = resultText ? parseResultData(resultText) : null;
  const progressSnapshot = getDisplayProgressSnapshot(
    progressUpdates,
    resultData
  );
  const workerActivity = useStartMissionRunWorkerActivity(
    progressSnapshot?.currentWorkerId ?? null
  );

  if (!resultText) {
    return progressSnapshot ? (
      <ProgressPanel
        snapshot={progressSnapshot}
        workerActivity={workerActivity}
        contentWidth={contentWidth}
      />
    ) : (
      <PendingMissionCard />
    );
  }

  if (isError) {
    const isCancelled = isUserCancellationMessage(resultText);

    if (isCancelled && progressSnapshot) {
      return (
        <ProgressPanel
          snapshot={progressSnapshot}
          workerActivity={workerActivity}
          borderColor={MC_COLORS.secondary}
          contentWidth={contentWidth}
          overrideState={MissionState.Paused}
        />
      );
    }

    if (isCancelled) {
      return <PausedFallbackCard />;
    }

    return (
      <ErrorFallbackCard message={resultText} contentWidth={contentWidth} />
    );
  }

  if (resultData?.pauseReason === MissionPauseReason.UnrecoverableUsage402) {
    const usageLimitLabel = getI18n().t(
      'common:toolDisplay.startMission.usageLimitReached'
    );
    const usageLimitDetail = getI18n().t(
      'common:toolDisplay.startMission.usageLimitReachedDescription'
    );

    if (progressSnapshot) {
      return (
        <ProgressPanel
          snapshot={progressSnapshot}
          workerActivity={workerActivity}
          borderColor={MC_COLORS.fail}
          footerMessage={`${usageLimitLabel} — ${usageLimitDetail}`}
          footerColor={MC_COLORS.fail}
          contentWidth={contentWidth}
          overrideState={MissionState.Paused}
        />
      );
    }

    return <UsageLimitFallbackCard />;
  }

  if (
    resultData?.pauseReason === MissionPauseReason.FeatureRetryLimitExceeded
  ) {
    const retryLimitLabel = getI18n().t(
      'common:toolDisplay.startMission.retryLimitReached'
    );
    const retryLimitDetail = getI18n().t(
      'common:toolDisplay.startMission.retryLimitReachedDescription'
    );

    if (progressSnapshot) {
      return (
        <ProgressPanel
          snapshot={progressSnapshot}
          workerActivity={workerActivity}
          borderColor={MC_COLORS.fail}
          footerMessage={`${retryLimitLabel}: ${retryLimitDetail}`}
          footerColor={MC_COLORS.fail}
          contentWidth={contentWidth}
          overrideState={MissionState.Paused}
        />
      );
    }

    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={MC_COLORS.fail}
        paddingX={1}
      >
        <Box>
          <Text color={MC_COLORS.fail}>✗ </Text>
          <Text color={MC_COLORS.fail}>{retryLimitLabel}</Text>
        </Box>
        <Text color={MC_COLORS.tertiary} wrap="wrap">
          {retryLimitDetail}
        </Text>
      </Box>
    );
  }

  if (resultData && progressSnapshot) {
    return (
      <ProgressPanel
        snapshot={progressSnapshot}
        workerActivity={workerActivity}
        contentWidth={contentWidth}
      />
    );
  }

  if (resultData) {
    return (
      <HistoricalResultCard
        resultData={resultData}
        contentWidth={contentWidth}
      />
    );
  }

  return <ResultFallbackCard resultText={resultText} />;
}

function StartMissionRunDetailedView({
  result,
  isError,
  contentWidth,
  progressUpdates,
}: ToolComponentProps) {
  const resultText = getTextContent(result);
  const resultData = resultText ? parseResultData(resultText) : null;
  const snapshot = getDisplayProgressSnapshot(progressUpdates, resultData);
  const workerActivity = useStartMissionRunWorkerActivity(
    snapshot?.currentWorkerId ?? null
  );
  const features = snapshot
    ? getDisplayedFeatures(snapshot.featureWindow, ToolPreviewTier.LG)
    : [];
  const focusFeature = snapshot?.featureWindow.focus;
  const workerSessionId = snapshot?.currentWorkerId ?? null;
  const workerActivityEntries = workerActivity?.recentActivity ?? [];

  if (!snapshot && resultData) {
    return (
      <HistoricalResultCard
        resultData={resultData}
        contentWidth={contentWidth}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={MC_COLORS.secondary} bold>
        {getI18n().t('common:toolDisplay.startMission.progressLabel')}
      </Text>

      {snapshot && (
        <Box flexDirection="column" marginLeft={2} marginBottom={1}>
          <Text color={MC_COLORS.tertiary}>
            {getI18n().t('common:toolDisplay.startMission.stateLabel')}{' '}
            {snapshot.state ?? 'unknown'}
          </Text>
          <Text color={MC_COLORS.tertiary}>
            {getI18n().t('common:toolDisplay.startMission.progressCount')}{' '}
            {snapshot.counts.completed}/{snapshot.counts.total}{' '}
            {getI18n().t('common:toolDisplay.startMission.featuresCompleted')}
          </Text>
          {focusFeature && (
            <Text color={MC_COLORS.tertiary}>
              {getI18n().t('common:toolDisplay.startMission.currentFeature')}{' '}
              {focusFeature.id}
            </Text>
          )}
          {workerSessionId && (
            <Text color={MC_COLORS.secondary}>
              {getI18n().t('common:toolDisplay.startMission.workerLabel')}{' '}
              {workerSessionId.slice(0, 8)}...
              {workerActivity?.toolCount
                ? ` (${workerActivity.toolCount} ${getI18n().t('common:toolDisplay.startMission.tools')})`
                : ''}
            </Text>
          )}
        </Box>
      )}

      {features.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={MC_COLORS.secondary} bold>
            {getI18n().t('common:toolDisplay.startMission.featuresLabel')}
          </Text>
          {features.map((feature) => (
            <MissionFeatureRow
              key={feature.id}
              feature={feature}
              marginLeft={2}
              detailed
            />
          ))}
        </Box>
      )}

      {workerActivityEntries.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={MC_COLORS.secondary} bold>
            {getI18n().t('common:toolDisplay.startMission.workerActivity')}
          </Text>
          {workerActivityEntries.map((activity, activityIndex) => (
            <Box key={`activity-${activityIndex}`} marginLeft={2}>
              <Text color={MC_COLORS.secondary}>{activity.summary}</Text>
            </Box>
          ))}
        </Box>
      )}

      {resultText && (
        <Box flexDirection="column">
          <Text color={MC_COLORS.secondary} bold>
            {getI18n().t('common:toolDisplay.startMission.resultLabel')}
          </Text>
          <Box marginLeft={2}>
            <Text color={isError ? COLORS.error : MC_COLORS.primary}>
              {resultText}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

// eslint-disable-next-line industry/constants-file-organization
export const StartMissionRunTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    const message = input.message as string | undefined;
    if (!message) return '';
    return message;
  },

  renderResult(props: ToolComponentProps) {
    return <StartMissionRunResultView {...props} />;
  },

  renderDetailedView(props: ToolComponentProps) {
    return <StartMissionRunDetailedView {...props} />;
  },

  getSummaryLine(
    _input: Record<string, unknown>,
    result: string,
    isError: boolean
  ): string {
    if (isError) {
      return getI18n().t('common:toolDisplay.startMission.summaryFailed');
    }

    if (!result) {
      return getI18n().t('common:toolDisplay.startMission.summaryRunning');
    }

    if (result.includes('All features completed')) {
      return getI18n().t('common:toolDisplay.startMission.summaryCompleted');
    }

    if (result.includes('returning control')) {
      return getI18n().t('common:toolDisplay.startMission.summaryReturning');
    }

    return getI18n().t('common:toolDisplay.startMission.summaryFinished');
  },
};
