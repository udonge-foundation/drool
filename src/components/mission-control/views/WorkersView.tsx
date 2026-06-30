/**
 * Mission Control workers list view
 * Displays workers with status filtering (All/Active/Completed/Failed)
 * and navigation to worker session transcript viewer
 *
 * Layout requirements:
 * - Each row must be exactly one terminal line (no wrapping)
 * - Column headers must align exactly with row columns
 * - Column headers stay visible while list scrolls (sticky via windowing)
 * - Dividers fit within viewport width
 */

import { Box, Text } from 'ink';
import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { MC_COLORS } from '@/components/mission-control/constants';
import { MissionControlView } from '@/components/mission-control/enums';
import type {
  MissionData,
  SessionViewerContext,
  ViewportDimensions,
  WorkerSessionDisplay,
} from '@/components/mission-control/types';
import { shouldProcessMissionControlScroll } from '@/components/mission-control/utils/scrollInputGuard';
import { truncateWithEllipsis } from '@/components/mission-control/utils/text';
import {
  buildWorkerSessions,
  orderWorkerSessionsForDisplay,
} from '@/components/mission-control/utils/workerSessions';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { canViewTokenUsage } from '@/utils/tokenUsageVisibility';

/**
 * Column widths for Workers list - used by both header and rows
 * These must stay in sync to maintain alignment
 */
const COLUMN_WIDTHS = {
  /** Selection indicator + status icon ("> ●" or "  ○") + space */
  selectorAndIcon: 4,
  /** Worker number (#) */
  workerNumber: 4,
  /** Session ID (first 8 chars) */
  sessionId: 12,
  /** Start time column (HH:MM) */
  start: 8,
  /** Duration column */
  duration: 11,
  /** Status column */
  status: 10,
  /** Industry Standard Credits column */
  industryCredits: 9,
} as const;

/** Fixed columns total width (all columns except Feature) */
const BASE_FIXED_COLUMNS_WIDTH =
  COLUMN_WIDTHS.selectorAndIcon +
  COLUMN_WIDTHS.workerNumber +
  COLUMN_WIDTHS.sessionId +
  COLUMN_WIDTHS.start +
  COLUMN_WIDTHS.duration +
  COLUMN_WIDTHS.status;

/** Minimum feature column width before the credits column is hidden */
const MIN_FEATURE_WIDTH_WITH_TOKENS = 20;

/** Available filter options for workers */
type WorkerFilter = 'all' | 'active' | 'completed' | 'failed';

const FILTER_OPTIONS: WorkerFilter[] = ['all', 'active', 'completed', 'failed'];

const FILTER_LABEL_KEYS: Record<WorkerFilter, string> = {
  all: 'common:workersView.filterAll',
  active: 'common:workersView.filterActive',
  completed: 'common:workersView.filterCompleted',
  failed: 'common:workersView.filterFailed',
};

const STATUS_LABEL_KEYS: Record<WorkerSessionDisplay['status'], string> = {
  running: 'common:workersView.statusRunning',
  paused: 'common:workersView.statusPaused',
  success: 'common:workersView.statusSuccess',
  partial: 'common:workersView.statusPartial',
  failed: 'common:workersView.statusFailed',
};

interface WorkersViewProps {
  data: MissionData;
  onNavigate: (
    view: MissionControlView,
    context?: unknown,
    currentSelectedIndex?: number
  ) => void;
  /** Viewport dimensions for content area (excludes header and padding) */
  viewport: ViewportDimensions;
  /** Restore selection index when returning from a subview */
  initialSelectedIndex?: number;
}

/** Status icon and color for worker */
function getWorkerStatusIndicator(status: WorkerSessionDisplay['status']): {
  icon: string;
  color: string;
} {
  switch (status) {
    case 'running':
      return { icon: '●', color: MC_COLORS.active };
    case 'paused':
      return { icon: 'P', color: MC_COLORS.tertiary };
    case 'success':
      return { icon: '✓', color: MC_COLORS.done };
    case 'partial':
      // Avoid double-width glyphs (e.g. "⚠") which can break column alignment.
      return { icon: '!', color: MC_COLORS.fail };
    case 'failed':
      return { icon: '✗', color: MC_COLORS.fail };
    default:
      return { icon: '○', color: MC_COLORS.tertiary };
  }
}

export function WorkersView({
  data,
  onNavigate,
  viewport,
  initialSelectedIndex,
}: WorkersViewProps) {
  const { t } = useTranslation('common');
  const { snapshot } = data;
  const { width, height } = viewport;
  const industryCreditColumnLabel = t('common:workersView.columnTokens');

  const showTokenColumns =
    canViewTokenUsage() &&
    width - BASE_FIXED_COLUMNS_WIDTH - COLUMN_WIDTHS.industryCredits >=
      MIN_FEATURE_WIDTH_WITH_TOKENS;
  const fixedColumnsWidth = showTokenColumns
    ? BASE_FIXED_COLUMNS_WIDTH + COLUMN_WIDTHS.industryCredits
    : BASE_FIXED_COLUMNS_WIDTH;

  // Build worker sessions list (most recent first for display)
  const allWorkerSessions = useMemo(
    () =>
      orderWorkerSessionsForDisplay(
        buildWorkerSessions(
          snapshot.workerSessionIds ?? [],
          snapshot.workerStates,
          snapshot.progressLog,
          snapshot.features,
          snapshot.tokenUsageBySessionId
        )
      ),
    [
      snapshot.workerSessionIds,
      snapshot.workerStates,
      snapshot.progressLog,
      snapshot.features,
      snapshot.tokenUsageBySessionId,
    ]
  );

  const staticDurationBySessionRef = useRef<Map<string, string>>(new Map());
  const allWorkerSessionsWithStaticDurations = useMemo(() => {
    const staticDurationBySession = staticDurationBySessionRef.current;

    return allWorkerSessions.map((session) => {
      const existingDuration = staticDurationBySession.get(session.sessionId);
      if (existingDuration !== undefined) {
        if (
          session.status !== 'running' &&
          session.duration !== existingDuration
        ) {
          staticDurationBySession.set(session.sessionId, session.duration);
          return session;
        }

        return { ...session, duration: existingDuration };
      }

      staticDurationBySession.set(session.sessionId, session.duration);
      return session;
    });
  }, [allWorkerSessions]);

  // Filter state
  const [currentFilter, setCurrentFilter] = useState<WorkerFilter>('all');

  // Filtered workers based on current filter
  const filteredWorkers = useMemo(() => {
    if (currentFilter === 'all') {
      return allWorkerSessionsWithStaticDurations;
    }
    return allWorkerSessionsWithStaticDurations.filter((w) => {
      switch (currentFilter) {
        case 'active':
          return w.status === 'running' || w.status === 'paused';
        case 'completed':
          return w.status === 'success' || w.status === 'partial';
        case 'failed':
          return w.status === 'failed';
        default:
          return true;
      }
    });
  }, [allWorkerSessionsWithStaticDurations, currentFilter]);

  // Count workers by status
  const statusCounts = useMemo(() => {
    const counts = {
      all: allWorkerSessions.length,
      active: 0,
      completed: 0,
      failed: 0,
    };
    for (const w of allWorkerSessionsWithStaticDurations) {
      if (w.status === 'running' || w.status === 'paused') counts.active++;
      else if (w.status === 'success' || w.status === 'partial')
        counts.completed++;
      else if (w.status === 'failed') counts.failed++;
    }
    return counts;
  }, [allWorkerSessionsWithStaticDurations]);

  // Window and selection state
  const maxVisibleWorkers = Math.max(3, Math.floor(height - 12));
  const clampedInitialIndex =
    initialSelectedIndex !== undefined
      ? Math.min(initialSelectedIndex, Math.max(0, filteredWorkers.length - 1))
      : 0;
  const [windowStart, setWindowStart] = useState(() => {
    // Position the window so the restored index is visible
    if (clampedInitialIndex >= maxVisibleWorkers) {
      return clampedInitialIndex - maxVisibleWorkers + 1;
    }
    return 0;
  });
  const [selectedIndex, setSelectedIndex] = useState(clampedInitialIndex);

  // Reset selection when filter changes (but not on initial mount,
  // which would clobber the restored initialSelectedIndex).
  const prevFilterRef = useRef(currentFilter);
  useEffect(() => {
    if (prevFilterRef.current !== currentFilter) {
      prevFilterRef.current = currentFilter;
      setSelectedIndex(0);
      setWindowStart(0);
    }
  }, [currentFilter]);

  // Visible workers slice
  const visibleWorkers = useMemo(
    () => filteredWorkers.slice(windowStart, windowStart + maxVisibleWorkers),
    [filteredWorkers, windowStart, maxVisibleWorkers]
  );

  // Update window when selection changes
  useEffect(() => {
    if (filteredWorkers.length === 0) return;

    // Scroll down if selection below visible area
    if (selectedIndex >= windowStart + maxVisibleWorkers) {
      setWindowStart(selectedIndex - maxVisibleWorkers + 1);
    }
    // Scroll up if selection above visible area
    else if (selectedIndex < windowStart) {
      setWindowStart(selectedIndex);
    }
  }, [selectedIndex, windowStart, maxVisibleWorkers, filteredWorkers.length]);

  // Cycle filter
  const cycleFilter = useCallback(() => {
    setCurrentFilter((prev) => {
      const currentIndex = FILTER_OPTIONS.indexOf(prev);
      const nextIndex = (currentIndex + 1) % FILTER_OPTIONS.length;
      return FILTER_OPTIONS[nextIndex];
    });
  }, []);

  // Handle select worker
  const handleSelect = useCallback(() => {
    if (filteredWorkers.length > 0 && filteredWorkers[selectedIndex]) {
      const worker = filteredWorkers[selectedIndex];
      const sessionViewerContext: SessionViewerContext = {
        sessionId: worker.sessionId,
        featureId: worker.featureId,
        activeDurationAnchorMs: worker.activeDurationAnchorMs,
      };
      onNavigate(
        MissionControlView.SessionViewer,
        sessionViewerContext,
        selectedIndex
      );
    }
  }, [filteredWorkers, selectedIndex, onNavigate]);

  // Handle keyboard input
  useKeypressHandler((input, key) => {
    if (filteredWorkers.length === 0) {
      if (input.toLowerCase() === 't') {
        cycleFilter();
      }
      return;
    }

    if (input === 'g') {
      setSelectedIndex(0);
      setWindowStart(0);
    } else if (input === 'G') {
      const lastIndex = filteredWorkers.length - 1;
      setSelectedIndex(lastIndex);
      setWindowStart(Math.max(0, lastIndex - maxVisibleWorkers + 1));
    } else if (key.upArrow) {
      if (!shouldProcessMissionControlScroll()) {
        return;
      }
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (input === 'k') {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      if (!shouldProcessMissionControlScroll()) {
        return;
      }
      setSelectedIndex((prev) =>
        Math.min(filteredWorkers.length - 1, prev + 1)
      );
    } else if (input === 'j') {
      setSelectedIndex((prev) =>
        Math.min(filteredWorkers.length - 1, prev + 1)
      );
    } else if (key.return) {
      handleSelect();
    } else if (input.toLowerCase() === 't') {
      cycleFilter();
    }
  });

  return (
    <Box flexDirection="column">
      {/* Header with title */}
      <Box marginBottom={1}>
        <Text bold color={MC_COLORS.emphasis}>
          {t('common:workersView.title')}
        </Text>
        <Text color={MC_COLORS.tertiary}> ({filteredWorkers.length})</Text>
      </Box>

      {/* Filter tabs */}
      <Box marginBottom={1}>
        {FILTER_OPTIONS.map((filter, index) => {
          const isActive = filter === currentFilter;
          return (
            <Box key={filter}>
              {index > 0 && <Text color={MC_COLORS.tertiary}> │ </Text>}
              <Text
                bold={isActive}
                color={isActive ? MC_COLORS.active : MC_COLORS.tertiary}
              >
                {t(FILTER_LABEL_KEYS[filter])}
              </Text>
              <Text color={MC_COLORS.tertiary}> ({statusCounts[filter]})</Text>
            </Box>
          );
        })}
      </Box>

      {/* Separator - fits viewport width */}
      <Text color={MC_COLORS.border}>{'─'.repeat(Math.min(width, 70))}</Text>

      {/* Workers list - column headers are STICKY (outside the windowed list) */}
      <Box flexDirection="column" marginTop={1}>
        {/* Column header row (sticky - stays visible while list scrolls)
            Uses fixed-width Box containers for perfect alignment with rows */}
        <Box>
          <Box width={COLUMN_WIDTHS.selectorAndIcon}>
            <Text color={MC_COLORS.tertiary}> </Text>
          </Box>
          <Box width={COLUMN_WIDTHS.workerNumber}>
            <Text color={MC_COLORS.tertiary}>#</Text>
          </Box>
          <Box width={COLUMN_WIDTHS.sessionId}>
            <Text color={MC_COLORS.tertiary}>
              {t('common:workersView.columnSession')}
            </Text>
          </Box>
          <Box width={COLUMN_WIDTHS.start}>
            <Text color={MC_COLORS.tertiary}>
              {t('common:workersView.columnStart')}
            </Text>
          </Box>
          <Box width={COLUMN_WIDTHS.duration}>
            <Text color={MC_COLORS.tertiary}>
              {t('common:workersView.columnDuration')}
            </Text>
          </Box>
          <Box width={COLUMN_WIDTHS.status}>
            <Text color={MC_COLORS.tertiary}>
              {t('common:workersView.columnStatus')}
            </Text>
          </Box>
          {showTokenColumns && (
            <Box width={COLUMN_WIDTHS.industryCredits}>
              <Text color={MC_COLORS.tertiary}>{industryCreditColumnLabel}</Text>
            </Box>
          )}
          <Text color={MC_COLORS.tertiary}>
            {t('common:workersView.columnFeature')}
          </Text>
        </Box>

        {/* Windowed worker rows */}
        {visibleWorkers.length > 0 ? (
          visibleWorkers.map((worker, index) => {
            const globalIndex = windowStart + index;
            const isSelected = globalIndex === selectedIndex;
            const statusIndicator = getWorkerStatusIndicator(worker.status);

            // Calculate remaining width for Feature column
            const featureWidth = Math.max(1, width - fixedColumnsWidth);

            // Build feature display string (ID only, no description)
            const fullFeatureText = worker.featureId ?? '-';

            // Truncate feature text to a single line, then pad to fill
            // the column so the highlight background extends uniformly
            const truncatedFeature = truncateWithEllipsis(
              fullFeatureText,
              featureWidth
            ).padEnd(featureWidth);

            // Selected row uses inverted highlight (full-width background)
            const rowBg = isSelected ? MC_COLORS.hlBg : undefined;
            const rowFg = isSelected ? MC_COLORS.hlFg : undefined;

            return (
              <Box key={worker.sessionId}>
                {/* Selector + status icon column */}
                <Box width={COLUMN_WIDTHS.selectorAndIcon}>
                  <Text
                    color={rowFg ?? statusIndicator.color}
                    backgroundColor={rowBg}
                  >
                    {`  ${statusIndicator.icon} `}
                  </Text>
                </Box>
                {/* Worker number column */}
                <Box width={COLUMN_WIDTHS.workerNumber}>
                  <Text
                    color={
                      rowFg ??
                      (isSelected ? MC_COLORS.emphasis : MC_COLORS.worker)
                    }
                    backgroundColor={rowBg}
                    wrap="truncate-end"
                  >
                    {String(worker.workerNumber).padEnd(
                      COLUMN_WIDTHS.workerNumber
                    )}
                  </Text>
                </Box>
                {/* Session ID column */}
                <Box width={COLUMN_WIDTHS.sessionId}>
                  <Text
                    color={
                      rowFg ??
                      (isSelected ? MC_COLORS.emphasis : MC_COLORS.worker)
                    }
                    backgroundColor={rowBg}
                    wrap="truncate-end"
                  >
                    {worker.shortId.padEnd(COLUMN_WIDTHS.sessionId)}
                  </Text>
                </Box>
                {/* Start time column */}
                <Box width={COLUMN_WIDTHS.start}>
                  <Text
                    color={
                      rowFg ?? (isSelected ? MC_COLORS.emphasis : MC_COLORS.ts)
                    }
                    backgroundColor={rowBg}
                    wrap="truncate-end"
                  >
                    {worker.startTime.padEnd(COLUMN_WIDTHS.start)}
                  </Text>
                </Box>
                {/* Duration column */}
                <Box width={COLUMN_WIDTHS.duration}>
                  <Text
                    color={
                      rowFg ?? (isSelected ? MC_COLORS.emphasis : MC_COLORS.ts)
                    }
                    backgroundColor={rowBg}
                    wrap="truncate-end"
                  >
                    {worker.duration.padEnd(COLUMN_WIDTHS.duration)}
                  </Text>
                </Box>
                {/* Status column */}
                <Box width={COLUMN_WIDTHS.status}>
                  <Text
                    color={rowFg ?? statusIndicator.color}
                    backgroundColor={rowBg}
                    wrap="truncate-end"
                  >
                    {t(STATUS_LABEL_KEYS[worker.status]).padEnd(
                      COLUMN_WIDTHS.status
                    )}
                  </Text>
                </Box>
                {showTokenColumns && (
                  <Box width={COLUMN_WIDTHS.industryCredits}>
                    <Text
                      color={
                        rowFg ??
                        (isSelected ? MC_COLORS.emphasis : MC_COLORS.dataValue)
                      }
                      backgroundColor={rowBg}
                      wrap="truncate-end"
                    >
                      {worker.industryCreditDisplay.padEnd(
                        COLUMN_WIDTHS.industryCredits
                      )}
                    </Text>
                  </Box>
                )}
                {/* Feature column (last — padEnd fills to featureWidth for uniform highlight) */}
                <Box width={featureWidth}>
                  <Text
                    color={
                      rowFg ?? (isSelected ? MC_COLORS.emphasis : MC_COLORS.ref)
                    }
                    backgroundColor={rowBg}
                    wrap="truncate-end"
                  >
                    {truncatedFeature}
                  </Text>
                </Box>
              </Box>
            );
          })
        ) : (
          <Text color={MC_COLORS.tertiary}>
            {t('common:workersView.noMatch')}
          </Text>
        )}

        {/* Pagination indicator */}
        {filteredWorkers.length > maxVisibleWorkers && (
          <Text color={MC_COLORS.tertiary}>
            {t('common:workersView.showingRange', {
              start: windowStart + 1,
              end: Math.min(
                windowStart + maxVisibleWorkers,
                filteredWorkers.length
              ),
              total: filteredWorkers.length,
            })}
          </Text>
        )}
      </Box>
    </Box>
  );
}
