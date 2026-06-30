/**
 * Mission Control main dashboard view — v22 reskin
 *
 * Manual border drawing with │ side borders, ┬/┴ column junctions,
 * gradient progress bar, blockquote descriptions, and inverted highlights.
 *
 * Layout:
 *
 * │ ● RUNNING ██████████████████░░░░░░░░░ 16/22                          │
 * ├────────────────────────────────────────┬──────────────────────────────┤
 * │ Active Feature  feature-name          │ Features              16/22 │
 * │                                        │                             │
 * │  skill skill-name                      │ ✓  completed-feature        │
 * │  milestone ms-name                     │ ●  active-feature (inv)     │
 * │                                        │ ○  pending-feature          │
 * │  Preconditions                         ├─────────────────────────────┤
 * │    · item text                         │ Progress Log      1-N of M │
 * │                                        │                             │
 * │  Expected Behavior                     │ 8h ago   Worker #abc [feat] │
 * │    · item text                         │                             │
 * │    · +N more                           │                             │
 * │                                        │                             │
 * │  ▌ Description text as blockquote      │                             │
 * ├────────────────────────────────────────┴──────────────────────────────┤
 * │ Active Worker  #18  feature-name                       Time 8m 36s  │
 * │                                                                      │
 * │ Execute  command here                                                │
 * │   ✓ result text                                                      │
 */

import { Box, Text } from 'ink';
import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  FeatureSuccessState,
  FeatureStatus,
  MissionState,
  ProgressLogEntryType,
  type ProgressLogEntry,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  formatMissionLogAge,
  getMissionProgressLogEntryFeatureId,
} from '@industry/utils/mission';

import { MC_COLORS } from '@/components/mission-control/constants';
import { FrameContentRow } from '@/components/mission-control/FrameContentRow';
import { HLine } from '@/components/mission-control/HLine';
import type {
  MissionData,
  ViewportDimensions,
} from '@/components/mission-control/types';
import { buildFeatureDisplayList } from '@/components/mission-control/utils/buildFeatureDisplayList';
import { parseNumberedDescription } from '@/components/mission-control/utils/description';
import {
  allocateProgressBarSegments,
  getProgressDisplayTotal,
} from '@/components/mission-control/utils/progressBar';
import { shouldProcessMissionControlScroll } from '@/components/mission-control/utils/scrollInputGuard';
import {
  truncateWithEllipsis,
  wrapText,
} from '@/components/mission-control/utils/text';
import {
  buildWorkerSessions,
  findLatestActiveWorkerSession,
} from '@/components/mission-control/utils/workerSessions';
import { ActiveWorkerPreview } from '@/components/mission-control/views/ActiveWorkerPreview';
import { Spinner } from '@/components/Spinner';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useSessionSettings } from '@/hooks/useSessionSettings';
import { getMissionProgressCounts } from '@/services/mission/missionProgressCounts';
import { formatDurationCompact } from '@/utils/format';

interface MainViewProps {
  data: MissionData;
  viewport: ViewportDimensions;
  sessionId: string | null;
  isResuming?: boolean;
}

const COLLAPSED_LIST_ITEMS = 3;

// ── State helpers ────────────────────────────────────────────────────

function getStateIndicator(
  state: MissionState,
  isResuming = false
): {
  icon: string;
  color: string;
} {
  if (isResuming && state === MissionState.Paused) {
    return { icon: '◐', color: MC_COLORS.active };
  }

  switch (state) {
    case MissionState.Running:
      return { icon: '●', color: MC_COLORS.done };
    case MissionState.Paused:
      return { icon: '⏸', color: MC_COLORS.secondary };
    case MissionState.Completed:
      return { icon: '✓', color: MC_COLORS.done };
    case MissionState.OrchestratorTurn:
      return { icon: '◆', color: MC_COLORS.active };
    case MissionState.Initializing:
      return { icon: '◐', color: MC_COLORS.active };
    case MissionState.Planning:
    case MissionState.AwaitingInput:
    default:
      return { icon: '○', color: MC_COLORS.tertiary };
  }
}

function formatState(
  state: MissionState | undefined,
  isResuming = false
): string {
  if (isResuming && state === MissionState.Paused) {
    return 'RESUMING';
  }

  switch (state) {
    case MissionState.Running:
      return 'RUNNING';
    case MissionState.Paused:
      return 'PAUSED';
    case MissionState.Completed:
      return 'COMPLETED';
    case MissionState.OrchestratorTurn:
      return 'PLANNING';
    case MissionState.Initializing:
      return 'INITIALIZING';
    case MissionState.Planning:
      return 'PLANNING';
    case MissionState.AwaitingInput:
      return 'AWAITING INPUT';
    default:
      return state ?? 'UNKNOWN';
  }
}

function featureStatusIcon(status: FeatureStatus): {
  icon: string;
  color: string;
} {
  switch (status) {
    case FeatureStatus.Completed:
      return { icon: '✓', color: MC_COLORS.done };
    case FeatureStatus.InProgress:
      return { icon: '●', color: MC_COLORS.active };
    case FeatureStatus.Pending:
      return { icon: '○', color: MC_COLORS.tertiary };
    case FeatureStatus.Cancelled:
      return { icon: '✗', color: MC_COLORS.fail };
    default:
      return { icon: '○', color: MC_COLORS.tertiary };
  }
}

function workerCompletionIndicator(successState: FeatureSuccessState): {
  icon: string;
  color: string;
} {
  switch (successState) {
    case FeatureSuccessState.Success:
      return { icon: '✓', color: MC_COLORS.done };
    case FeatureSuccessState.Partial:
      return { icon: '!', color: MC_COLORS.secondary };
    case FeatureSuccessState.Failure:
      return { icon: '✗', color: MC_COLORS.fail };
    default:
      return { icon: '✓', color: MC_COLORS.done };
  }
}

// ── Progress log formatting ──────────────────────────────────────────

interface ColoredPart {
  text: string;
  color: string;
}

function formatProgressEntryParts(entry: ProgressLogEntry): ColoredPart[] {
  switch (entry.type) {
    case ProgressLogEntryType.MissionAccepted:
      return [
        { text: `Mission accepted: ${entry.title}`, color: MC_COLORS.tertiary },
      ];
    case ProgressLogEntryType.MissionPaused:
      return [{ text: 'Mission paused', color: MC_COLORS.tertiary }];
    case ProgressLogEntryType.MissionResumed:
      return [{ text: 'Mission resumed', color: MC_COLORS.tertiary }];
    case ProgressLogEntryType.MissionRunStarted:
      return [
        {
          text: entry.message
            ? `Run started: ${entry.message}`
            : 'Mission run started',
          color: MC_COLORS.tertiary,
        },
      ];
    case ProgressLogEntryType.WorkerStarted: {
      const startedFeatureId = getMissionProgressLogEntryFeatureId(entry);
      return [
        {
          text: `#${entry.workerSessionId.slice(0, 8)}`,
          color: MC_COLORS.worker,
        },
        { text: ' started', color: MC_COLORS.tertiary },
        ...(startedFeatureId
          ? [
              { text: ' ', color: MC_COLORS.tertiary },
              { text: `[${startedFeatureId}]`, color: MC_COLORS.ref },
            ]
          : []),
      ];
    }
    case ProgressLogEntryType.WorkerSelectedFeature: {
      const selectedFeatureId =
        getMissionProgressLogEntryFeatureId(entry) ?? entry.featureId;
      return [
        {
          text: `#${entry.workerSessionId.slice(0, 8)}`,
          color: MC_COLORS.worker,
        },
        { text: ' → ', color: MC_COLORS.tertiary },
        { text: `[${selectedFeatureId}]`, color: MC_COLORS.ref },
      ];
    }
    case ProgressLogEntryType.WorkerCompleted: {
      const completion = workerCompletionIndicator(entry.successState);
      const completedFeatureId =
        getMissionProgressLogEntryFeatureId(entry) ?? entry.featureId;
      return [
        {
          text: `#${entry.workerSessionId.slice(0, 8)}`,
          color: MC_COLORS.worker,
        },
        { text: ' completed ', color: MC_COLORS.tertiary },
        { text: `[${completedFeatureId}]`, color: MC_COLORS.ref },
        { text: ` ${completion.icon}`, color: completion.color },
      ];
    }
    case ProgressLogEntryType.WorkerFailed:
      return entry.workerSessionId
        ? [
            {
              text: `#${entry.workerSessionId.slice(0, 8)}`,
              color: MC_COLORS.worker,
            },
            { text: ` failed: ${entry.reason}`, color: MC_COLORS.fail },
          ]
        : [
            {
              text: `Failed: ${entry.reason}`,
              color: MC_COLORS.fail,
            },
          ];
    case ProgressLogEntryType.WorkerPaused: {
      const pausedFeatureId = getMissionProgressLogEntryFeatureId(entry);
      return [
        {
          text: `#${entry.workerSessionId.slice(0, 8)}`,
          color: MC_COLORS.worker,
        },
        { text: ' paused', color: MC_COLORS.tertiary },
        ...(pausedFeatureId
          ? [
              { text: ' ', color: MC_COLORS.tertiary },
              { text: `[${pausedFeatureId}]`, color: MC_COLORS.ref },
            ]
          : []),
      ];
    }
    case ProgressLogEntryType.HandoffItemsDismissed:
      return [{ text: 'Handoff items dismissed', color: MC_COLORS.tertiary }];
    case ProgressLogEntryType.MilestoneValidationTriggered:
      return [
        {
          text: `Milestone validation: ${entry.milestone}`,
          color: MC_COLORS.tertiary,
        },
      ];
    default:
      return [{ text: 'Unknown event', color: MC_COLORS.tertiary }];
  }
}

// ── Row wrappers ─────────────────────────────────────────────────────

/** Dual-panel content row: │ left │ right │ */
function DualRow({
  lw,
  rw,
  left,
  right,
}: {
  lw: number;
  rw: number;
  left?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <Box height={1}>
      <Text color={MC_COLORS.border}>│</Text>
      <Box width={lw} height={1} overflow="hidden">
        {left}
      </Box>
      <Text color={MC_COLORS.border}>│</Text>
      <Box width={rw} height={1} overflow="hidden">
        {right}
      </Box>
      <Text color={MC_COLORS.border}>│</Text>
    </Box>
  );
}

/** Right-side only divider: │ left ├───┤ */
function RightDividerRow({
  lw,
  rw,
  left,
}: {
  lw: number;
  rw: number;
  left?: ReactNode;
}) {
  return (
    <Box height={1}>
      <Text color={MC_COLORS.border}>│</Text>
      <Box width={lw} height={1} overflow="hidden">
        {left}
      </Box>
      <Text color={MC_COLORS.border}>├{'─'.repeat(rw)}┤</Text>
    </Box>
  );
}

// ── Component ────────────────────────────────────────────────────────

export function MainView({
  data,
  viewport,
  sessionId,
  isResuming = false,
}: MainViewProps) {
  const { t } = useTranslation('common');
  const { snapshot } = data;
  const { height, width: viewportWidth } = viewport;
  const { missionSettings } = useSessionSettings(sessionId);

  // ── Derived data ────────────────────────────────────────────────

  const stateIndicator = getStateIndicator(snapshot.state, isResuming);

  const activeFeature = useMemo(
    () =>
      snapshot.features.find((f) => f.status === FeatureStatus.InProgress) ??
      null,
    [snapshot.features]
  );

  const missionProgressCounts = useMemo(
    () =>
      getMissionProgressCounts({
        features: snapshot.features,
        missionSettings,
      }),
    [missionSettings, snapshot.features]
  );
  const completedCount = missionProgressCounts.completed;
  const cancelledCount = missionProgressCounts.cancelled;
  const pendingInjectedCount = missionProgressCounts.estimatedValidation;

  const filteredProgressLog = useMemo(
    () =>
      snapshot.progressLog
        .filter((e) => e.type !== ProgressLogEntryType.WorkerSelectedFeature)
        .reverse(),
    [snapshot.progressLog]
  );

  const workerSessions = useMemo(
    () =>
      buildWorkerSessions(
        snapshot.workerSessionIds ?? [],
        snapshot.workerStates,
        snapshot.progressLog,
        snapshot.features,
        snapshot.tokenUsageBySessionId
      ),
    [
      snapshot.features,
      snapshot.progressLog,
      snapshot.tokenUsageBySessionId,
      snapshot.workerSessionIds,
      snapshot.workerStates,
    ]
  );
  const activeWorker = useMemo(
    () => findLatestActiveWorkerSession(workerSessions),
    [workerSessions]
  );

  // ── Elapsed timer for active worker ─────────────────────────────

  const [timerTick, forceTimerTick] = useState(0);

  const activeWorkerDurationAnchorMs =
    activeWorker?.activeDurationAnchorMs ?? undefined;
  const isActiveWorkerLive = activeWorker?.status === 'running';

  useEffect(() => {
    if (!activeWorkerDurationAnchorMs || !isActiveWorkerLive) return;
    const timer = setInterval(() => forceTimerTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [activeWorkerDurationAnchorMs, isActiveWorkerLive]);

  const activeWorkerElapsed = useMemo(() => {
    if (!activeWorker) {
      return null;
    }

    if (isActiveWorkerLive && activeWorkerDurationAnchorMs) {
      const ms = Date.now() - activeWorkerDurationAnchorMs;
      return formatDurationCompact(Math.max(0, ms));
    }

    return activeWorker.duration;
  }, [
    activeWorker,
    activeWorkerDurationAnchorMs,
    isActiveWorkerLive,
    timerTick,
  ]);

  // ── Layout calculations ─────────────────────────────────────────

  // Total width including │ borders = viewport width + 2
  const totalWidth = viewportWidth + 2;
  const SPLIT = Math.floor(totalWidth * 0.55);
  const LW = SPLIT - 1; // left content width
  const RW = totalWidth - SPLIT - 2; // right content width
  const FW = totalWidth - 2; // full-width content width (= viewportWidth)

  // Height allocation:
  // Fixed rows: progress bar (1) + column split divider (1) + column merge divider (1) = 3
  const fixedRows = 3;
  const contentHeight = Math.max(6, height - fixedRows);

  // Active worker gets ~35% of content height if present
  const activeWorkerHeight = activeWorker
    ? Math.max(4, Math.floor(contentHeight * 0.35))
    : 0;
  const topHeight = contentHeight - activeWorkerHeight;

  // Right panel: features section + divider + progress log
  // Features section takes only what it needs (capped at 50%), progress log gets the rest
  const maxFeaturesRows = Math.max(3, Math.floor(topHeight * 0.5));
  const maxVisibleFeatures = Math.max(1, maxFeaturesRows - 2);
  const featureDisplay = useMemo(
    () => buildFeatureDisplayList(snapshot.features, maxVisibleFeatures),
    [snapshot.features, maxVisibleFeatures]
  );
  // Actual rows needed: 1 title + 1 empty + items + (1 if "+N more")
  const actualFeatureItemRows =
    featureDisplay.features.length +
    (featureDisplay.hiddenPendingCount > 0 ? 1 : 0);
  const rightFeaturesRows = Math.min(
    maxFeaturesRows,
    Math.max(3, 2 + actualFeatureItemRows)
  );
  // 1 row for the right-side divider
  const rightProgressLogRows = Math.max(2, topHeight - rightFeaturesRows - 1);

  const TIME_COL = 9;

  // ── Progress Log scrolling ──────────────────────────────────────

  const [progressScrollOffset, setProgressScrollOffset] = useState(0);
  // Progress log rows: 1 title + 1 empty + entries
  const maxProgressLogEntries = Math.max(1, rightProgressLogRows - 2);

  useEffect(() => {
    const maxOffset = Math.max(
      0,
      filteredProgressLog.length - maxProgressLogEntries
    );
    setProgressScrollOffset((prev) => Math.max(0, Math.min(prev, maxOffset)));
  }, [filteredProgressLog.length, maxProgressLogEntries]);

  const visibleProgressLog = useMemo(
    () =>
      filteredProgressLog.slice(
        progressScrollOffset,
        progressScrollOffset + maxProgressLogEntries
      ),
    [filteredProgressLog, maxProgressLogEntries, progressScrollOffset]
  );

  // ── Keyboard ────────────────────────────────────────────────────

  useKeypressHandler((_input, key) => {
    // Scroll navigation for the Progress Log
    const maxOffset = Math.max(
      0,
      filteredProgressLog.length - maxProgressLogEntries
    );
    if (key.upArrow) {
      if (!shouldProcessMissionControlScroll()) {
        return;
      }
      setProgressScrollOffset((prev) => Math.max(0, prev - 1));
    } else if (_input === 'k') {
      setProgressScrollOffset((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      if (!shouldProcessMissionControlScroll()) {
        return;
      }
      setProgressScrollOffset((prev) => Math.min(maxOffset, prev + 1));
    } else if (_input === 'j') {
      setProgressScrollOffset((prev) => Math.min(maxOffset, prev + 1));
    }
  });

  // ── Progress bar ────────────────────────────────────────────────

  const total = snapshot.features.length;
  const activeTotal = total - cancelledCount;
  const stateLabel = formatState(snapshot.state, isResuming);
  const progressCounts = useMemo(
    () => ({
      completed: completedCount,
      pending: Math.max(0, activeTotal - completedCount),
      estimated: pendingInjectedCount,
    }),
    [completedCount, activeTotal, pendingInjectedCount]
  );
  const displayTotal = getProgressDisplayTotal(progressCounts);

  const countStr = `${completedCount}/${displayTotal}`;
  const injectedSuffix =
    pendingInjectedCount > 0 ? ` [+${pendingInjectedCount}]` : '';
  const stateToBarGap = 2;
  // Layout: " ●  STATE  BAR N/M [+X] "
  // " ●  " = 4, "STATE" = stateLabel.length, stateToBarGap = 2, BAR,
  // " " = 1, countStr, injectedSuffix, " " = 1
  const fixedChars =
    4 +
    stateLabel.length +
    stateToBarGap +
    1 +
    countStr.length +
    injectedSuffix.length +
    1;
  const barWidth = Math.max(10, FW - fixedChars);
  const progressSegments = useMemo(
    () => allocateProgressBarSegments(progressCounts, barWidth),
    [progressCounts, barWidth]
  );

  const isPaused = snapshot.state === MissionState.Paused;
  const isPausedResuming = isPaused && isResuming;
  const filledBar = useMemo(
    () => '█'.repeat(progressSegments.filled),
    [progressSegments.filled]
  );
  const pendingBar = useMemo(
    () => '▒'.repeat(progressSegments.pending),
    [progressSegments.pending]
  );
  const estimateBar = useMemo(
    () => '░'.repeat(progressSegments.estimate),
    [progressSegments.estimate]
  );
  const stateColor = stateIndicator.color;
  const barColor = isPausedResuming ? MC_COLORS.secondary : stateColor;

  // ── Build left panel content ────────────────────────────────────

  const leftContent = useMemo(() => {
    const rows: (ReactNode | null)[] = [];

    if (!activeFeature) {
      // No active feature
      rows.push(
        <Text color={MC_COLORS.tertiary}>
          {' '}
          {snapshot.state === MissionState.Completed
            ? t('common:missionControl.allFeaturesCompleted')
            : t('common:missionControl.noActiveFeature')}
        </Text>
      );
      return rows;
    }

    // Title row: "Active Feature  feature-id"
    rows.push(
      <Fragment key="title">
        <Text> </Text>
        <Text color={MC_COLORS.emphasis}>
          {t('common:missionControl.activeFeature')}
        </Text>
        <Text>{'  '}</Text>
        <Text color={MC_COLORS.tertiary}>
          {truncateWithEllipsis(activeFeature.id, Math.max(0, LW - 18))}
        </Text>
      </Fragment>
    );

    // Empty row
    rows.push(null);

    // Skill
    if (activeFeature.skillName) {
      rows.push(
        <Fragment key="skill">
          <Text> </Text>
          <Text color={MC_COLORS.tertiary}>
            {t('common:missionControl.skillLabel')}
          </Text>
          <Text color={MC_COLORS.secondary}>
            {truncateWithEllipsis(activeFeature.skillName, Math.max(0, LW - 8))}
          </Text>
        </Fragment>
      );
    }

    // Milestone
    if (activeFeature.milestone) {
      rows.push(
        <Fragment key="ms">
          <Text> </Text>
          <Text color={MC_COLORS.tertiary}>
            {t('common:missionControl.milestoneLabel')}
          </Text>
          <Text color={MC_COLORS.secondary}>
            {truncateWithEllipsis(
              activeFeature.milestone,
              Math.max(0, LW - 12)
            )}
          </Text>
        </Fragment>
      );
    }

    // Preconditions
    if (activeFeature.preconditions && activeFeature.preconditions.length > 0) {
      rows.push(null);
      rows.push(
        <Text key="pre-hdr" color={MC_COLORS.t4}>
          {' '}
          {t('common:featureDetail.preconditionsTitle')}
        </Text>
      );
      const maxItems = COLLAPSED_LIST_ITEMS;
      for (
        let i = 0;
        i < Math.min(maxItems, activeFeature.preconditions.length);
        i++
      ) {
        rows.push(
          <Fragment key={`pre-${i}`}>
            <Text color={MC_COLORS.tertiary}>{'   · '}</Text>
            <Text color={MC_COLORS.t9}>
              {truncateWithEllipsis(
                activeFeature.preconditions[i]!,
                Math.max(0, LW - 6)
              )}
            </Text>
          </Fragment>
        );
      }
      if (activeFeature.preconditions.length > maxItems) {
        rows.push(
          <Text key="pre-more" color={MC_COLORS.t12}>
            {'   · '}
            {t('common:missionControl.moreCount', {
              count: activeFeature.preconditions.length - maxItems,
            })}
          </Text>
        );
      }
    }

    // Expected Behavior
    if (
      activeFeature.expectedBehavior &&
      activeFeature.expectedBehavior.length > 0
    ) {
      rows.push(null);
      rows.push(
        <Text key="eb-hdr" color={MC_COLORS.t4}>
          {' '}
          {t('common:featureDetail.expectedBehaviorTitle')}
        </Text>
      );
      const maxItems = COLLAPSED_LIST_ITEMS;
      for (
        let i = 0;
        i < Math.min(maxItems, activeFeature.expectedBehavior.length);
        i++
      ) {
        rows.push(
          <Fragment key={`eb-${i}`}>
            <Text color={MC_COLORS.tertiary}>{'   · '}</Text>
            <Text color={MC_COLORS.t9}>
              {truncateWithEllipsis(
                activeFeature.expectedBehavior[i]!,
                Math.max(0, LW - 6)
              )}
            </Text>
          </Fragment>
        );
      }
      if (activeFeature.expectedBehavior.length > maxItems) {
        rows.push(
          <Text key="eb-more" color={MC_COLORS.t12}>
            {'   · '}
            {t('common:missionControl.moreCount', {
              count: activeFeature.expectedBehavior.length - maxItems,
            })}
          </Text>
        );
      }
    }

    // Description
    if (activeFeature.description) {
      rows.push(null);
      rows.push(
        <Text key="desc-hdr" color={MC_COLORS.t4}>
          {' '}
          {t('common:featureDetail.descriptionTitle')}
        </Text>
      );
      // Split description into numbered items (e.g., "(1) Foo", "(2) Bar") or plain lines.
      const numberedItems = parseNumberedDescription(activeFeature.description);
      const indent = '   ';
      const numIndent = '      '; // continuation indent for numbered items
      for (let i = 0; i < numberedItems.length; i++) {
        const item = numberedItems[i]!;
        if (item.number) {
          // Blank line before each numbered item
          rows.push(null);
          const lines = wrapText(item.text, Math.max(1, LW - numIndent.length));
          // First line with number
          rows.push(
            <Fragment key={`desc-${i}-0`}>
              <Text>{indent}</Text>
              <Text color={MC_COLORS.tertiary}>{item.number}. </Text>
              <Text color={MC_COLORS.t9}>{lines[0]}</Text>
            </Fragment>
          );
          // Continuation lines aligned past the number
          for (let j = 1; j < lines.length; j++) {
            rows.push(
              <Fragment key={`desc-${i}-${j}`}>
                <Text>{numIndent}</Text>
                <Text color={MC_COLORS.t9}>{lines[j]}</Text>
              </Fragment>
            );
          }
        } else {
          // Intro text before the first number — wrap normally
          const lines = wrapText(item.text, Math.max(1, LW - indent.length));
          for (let j = 0; j < lines.length; j++) {
            rows.push(
              <Fragment key={`desc-${i}-${j}`}>
                <Text>{indent}</Text>
                <Text color={MC_COLORS.t9}>{lines[j]}</Text>
              </Fragment>
            );
          }
        }
      }
    }

    return rows;
  }, [activeFeature, snapshot.state, LW, t]);

  // ── Build right panel content ───────────────────────────────────

  // Right panel content types
  type RightRowItem =
    | { type: 'feature'; node: ReactNode }
    | { type: 'feature-active'; node: ReactNode }
    | { type: 'divider' }
    | { type: 'log-title'; node: ReactNode }
    | { type: 'log'; node: ReactNode }
    | { type: 'empty' }
    | { type: 'text'; node: ReactNode };

  const rightContent = useMemo(() => {
    const items: RightRowItem[] = [];
    const countStr2 = `${completedCount}/${activeTotal}`;
    const featuresLabel = ` ${t('common:missionControl.features')}`;

    // Title: "Features" + right-aligned count
    const titlePad = Math.max(
      0,
      RW - featuresLabel.length - countStr2.length - 1
    );
    items.push({
      type: 'text',
      node: (
        <>
          <Text color={MC_COLORS.emphasis}>{featuresLabel}</Text>
          <Text>{' '.repeat(titlePad)}</Text>
          <Text color={MC_COLORS.tertiary}>{countStr2}</Text>
        </>
      ),
    });

    // Empty row
    items.push({ type: 'empty' });

    // Feature items
    for (const f of featureDisplay.features) {
      const fi = featureStatusIcon(f.status);
      if (f.status === FeatureStatus.InProgress) {
        // Inverted highlight for active feature
        const displayName = truncateWithEllipsis(f.id, Math.max(0, RW - 4));
        const padLen = Math.max(0, RW - displayName.length - 4);
        items.push({
          type: 'feature-active',
          node: (
            <Text backgroundColor={MC_COLORS.hlBg} color={MC_COLORS.hlFg}>
              {' '}
              {fi.icon}
              {'  '}
              {displayName}
              {' '.repeat(padLen)}
            </Text>
          ),
        });
      } else {
        items.push({
          type: 'feature',
          node: (
            <>
              <Text color={fi.color}> {fi.icon}</Text>
              <Text color={MC_COLORS.tertiary}>
                {'  '}
                {truncateWithEllipsis(f.id, Math.max(0, RW - 5))}
              </Text>
            </>
          ),
        });
      }
    }

    if (featureDisplay.hiddenPendingCount > 0) {
      items.push({
        type: 'text',
        node: (
          <Text color={MC_COLORS.t12}>
            {' '}
            {t('common:missionControl.moreCount', {
              count: featureDisplay.hiddenPendingCount,
            })}
          </Text>
        ),
      });
    }

    // Right-side divider
    items.push({ type: 'divider' });

    // Progress Log title with pagination
    const progressLogLabel = ` ${t('common:missionControl.progressLog')}`;
    const paginationStr =
      filteredProgressLog.length > maxProgressLogEntries
        ? `${progressScrollOffset + 1}-${Math.min(progressScrollOffset + maxProgressLogEntries, filteredProgressLog.length)} of ${filteredProgressLog.length}`
        : '';
    const plTitlePad = Math.max(
      0,
      RW -
        progressLogLabel.length -
        (paginationStr ? paginationStr.length + 2 : 0)
    );
    items.push({
      type: 'log-title',
      node: (
        <>
          <Text color={MC_COLORS.emphasis}>{progressLogLabel}</Text>
          <Text>{' '.repeat(plTitlePad)}</Text>
          {paginationStr && (
            <Text color={MC_COLORS.tertiary}>
              {paginationStr}
              {'  '}
            </Text>
          )}
        </>
      ),
    });

    // Empty row
    items.push({ type: 'empty' });

    // Progress log entries
    if (filteredProgressLog.length > 0) {
      for (const entry of visibleProgressLog) {
        const parts = formatProgressEntryParts(entry);
        // Calculate remaining width for entry text after timestamp column
        const timestampWidth = TIME_COL - 1;
        const timestampGapWidth = 3;
        const entryTextWidth = Math.max(
          0,
          RW - timestampWidth - timestampGapWidth
        );
        const entryText = parts.map((p) => p.text).join('');
        const truncatedText = truncateWithEllipsis(entryText, entryTextWidth);
        // Re-apply colors to the truncated text
        let charPos = 0;
        const coloredParts: ColoredPart[] = [];
        for (const part of parts) {
          if (charPos >= truncatedText.length) break;
          const remaining = truncatedText.length - charPos;
          const partLen = Math.min(part.text.length, remaining);
          coloredParts.push({
            text: truncatedText.slice(charPos, charPos + partLen),
            color: part.color,
          });
          charPos += partLen;
        }
        items.push({
          type: 'log',
          node: (
            <>
              <Text color={MC_COLORS.ts}>
                {formatMissionLogAge(entry.timestamp, {
                  withAgoSuffix: true,
                }).padStart(TIME_COL - 1)}
              </Text>
              <Text>{'   '}</Text>
              {coloredParts.map((part, pi) => (
                <Text key={pi} color={part.color}>
                  {part.text}
                </Text>
              ))}
            </>
          ),
        });
      }
    } else {
      items.push({
        type: 'text',
        node: (
          <Text color={MC_COLORS.tertiary}>
            {' '}
            {t('common:missionControl.noProgressEntries')}
          </Text>
        ),
      });
    }

    return items;
  }, [
    featureDisplay,
    filteredProgressLog,
    visibleProgressLog,
    completedCount,
    activeTotal,
    maxProgressLogEntries,
    progressScrollOffset,
    RW,
    t,
  ]);

  // ── Active Worker title ─────────────────────────────────────────

  const activeWorkerTitle = useMemo(() => {
    if (!activeWorker) return null;

    const workerNum = `#${activeWorker.workerNumber}`;
    const featureName = activeWorker.featureId ?? '';
    const timeStr = activeWorkerElapsed ?? '-';
    const leftPrefix = ` ${t('common:missionControl.activeWorker')}  ${workerNum}  `;
    const rightSuffix = `${t('common:workersView.columnDuration')} ${timeStr}  `;
    const maxFeatureNameWidth = Math.max(
      0,
      FW - leftPrefix.length - rightSuffix.length
    );
    const activeFeatureDisplay = truncateWithEllipsis(
      featureName,
      maxFeatureNameWidth
    );
    const padLen = Math.max(
      0,
      maxFeatureNameWidth - activeFeatureDisplay.length
    );

    return (
      <>
        <Text> </Text>
        <Text color={MC_COLORS.emphasis}>
          {t('common:missionControl.activeWorker')}
        </Text>
        <Text>{'  '}</Text>
        <Text color={MC_COLORS.worker}>{workerNum}</Text>
        <Text>{'  '}</Text>
        <Text color={MC_COLORS.tertiary}>{activeFeatureDisplay}</Text>
        <Text>{' '.repeat(padLen)}</Text>
        <Text color={MC_COLORS.tertiary}>
          {t('common:workersView.columnDuration')}{' '}
        </Text>
        <Text color={MC_COLORS.dataValue}>{timeStr}</Text>
        <Text>{'  '}</Text>
      </>
    );
  }, [activeWorker, activeWorkerElapsed, FW, t]);

  // ── Render ──────────────────────────────────────────────────────

  // Build the dual-panel rows
  const dualPanelRows = useMemo(() => {
    const rows: ReactNode[] = [];

    for (let i = 0; i < topHeight; i++) {
      // Left panel content
      const leftNode = i < leftContent.length ? (leftContent[i] ?? null) : null;

      // Right panel content
      const rightItem = i < rightContent.length ? rightContent[i] : null;

      if (rightItem && rightItem.type === 'divider') {
        rows.push(
          <RightDividerRow key={`dual-${i}`} lw={LW} rw={RW} left={leftNode} />
        );
      } else {
        const rightNode = rightItem
          ? rightItem.type === 'empty'
            ? null
            : rightItem.node
          : null;
        rows.push(
          <DualRow
            key={`dual-${i}`}
            lw={LW}
            rw={RW}
            left={leftNode}
            right={rightNode}
          />
        );
      }
    }

    return rows;
  }, [topHeight, leftContent, rightContent, LW, RW]);

  // Build active worker rows
  const activeWorkerRows = useMemo(() => {
    if (!activeWorker) return null;

    const rows: ReactNode[] = [];

    // Title row
    rows.push(
      <FrameContentRow key="aw-title" width={FW}>
        {activeWorkerTitle}
      </FrameContentRow>
    );

    // Empty row
    rows.push(<FrameContentRow key="aw-empty" width={FW} />);

    // Content: ActiveWorkerPreview fills the remaining space
    // Height = activeWorkerHeight - 2 (title + empty)
    const previewHeight = Math.max(2, activeWorkerHeight - 2);

    const buildVerticalBorder = (key: string) => (
      <Box key={key} width={1} height={previewHeight} flexDirection="column">
        {Array.from({ length: previewHeight }, (_, index) => (
          <Text key={`${key}-${index}`} color={MC_COLORS.border}>
            │
          </Text>
        ))}
      </Box>
    );

    rows.push(
      <Box key="aw-content" height={previewHeight} flexDirection="row">
        {buildVerticalBorder('aw-left-border')}
        <Box
          width={FW}
          height={previewHeight}
          flexDirection="column"
          overflow="hidden"
        >
          <ActiveWorkerPreview
            sessionId={activeWorker.sessionId}
            workingDirectory={data.workingDirectory}
            maxWidth={FW}
            maxItems={Math.max(1, Math.floor(previewHeight / 2))}
            isLive={isActiveWorkerLive}
          />
        </Box>
        {buildVerticalBorder('aw-right-border')}
      </Box>
    );

    return rows;
  }, [
    activeWorker,
    activeWorkerTitle,
    activeWorkerHeight,
    FW,
    data.workingDirectory,
  ]);

  return (
    <Box flexDirection="column">
      {/* Progress bar row */}
      <FrameContentRow width={FW}>
        <Text color={stateColor}>
          {' '}
          {isPausedResuming ? <Spinner /> : stateIndicator.icon}
          {'  '}
        </Text>
        <Text color={stateColor}>{stateLabel}</Text>
        <Text>{' '.repeat(stateToBarGap)}</Text>
        <Text color={barColor}>{filledBar}</Text>
        {progressSegments.pending > 0 && (
          <Text color={MC_COLORS.secondary}>{pendingBar}</Text>
        )}
        <Text color={MC_COLORS.barEmpty}>{estimateBar}</Text>
        <Text> </Text>
        <Text color={barColor}>{countStr}</Text>
        {pendingInjectedCount > 0 && (
          <Text color={MC_COLORS.tertiary}> [+{pendingInjectedCount}]</Text>
        )}
        <Text> </Text>
      </FrameContentRow>

      {/* Column split divider: ├─┬─┤ */}
      <HLine width={totalWidth} mid="┬" midPos={SPLIT} />

      {/* Dual-panel rows */}
      {dualPanelRows}

      {/* Column merge divider: ├─┴─┤ */}
      <HLine width={totalWidth} mid="┴" midPos={SPLIT} />

      {/* Active worker section */}
      {activeWorkerRows}
    </Box>
  );
}
