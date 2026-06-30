/**
 * Mission Control features list view
 * Displays features with status filtering and navigation to feature details
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

import { FeatureStatus } from '@industry/drool-sdk-ext/protocol/drool';

import { MC_COLORS } from '@/components/mission-control/constants';
import { MissionControlView } from '@/components/mission-control/enums';
import type {
  MissionData,
  ViewportDimensions,
} from '@/components/mission-control/types';
import { shouldProcessMissionControlScroll } from '@/components/mission-control/utils/scrollInputGuard';
import { truncateWithEllipsis } from '@/components/mission-control/utils/text';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

/**
 * Column widths for Features list - used by both header and rows
 * These must stay in sync to maintain alignment
 */
const COLUMN_WIDTHS = {
  /** Selection indicator + status icon ("> ●" or "  ○") */
  selectorAndIcon: 4,
  /** Status text (e.g., "In Progress") */
  status: 13,
  /** Minimum width for the milestone/ID column */
  milestoneIdMin: 1,
} as const;

/** Fixed columns total width (selector + status) */
const FIXED_COLUMNS_WIDTH =
  COLUMN_WIDTHS.selectorAndIcon + COLUMN_WIDTHS.status;

/** Available filter options for features */
type FeatureFilter =
  | 'all'
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

const FILTER_OPTIONS: FeatureFilter[] = [
  'all',
  'pending',
  'in_progress',
  'completed',
  'cancelled',
];

const FILTER_LABEL_KEYS: Record<FeatureFilter, string> = {
  all: 'common:featuresView.filterAll',
  pending: 'common:featuresView.filterPending',
  in_progress: 'common:featuresView.filterInProgress',
  completed: 'common:featuresView.filterCompleted',
  cancelled: 'common:featuresView.filterCancelled',
};

interface FeaturesViewProps {
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

/** Get status indicator icon and color */
function getStatusIndicator(status: FeatureStatus): {
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

/** Format status for display */
function formatStatus(status: FeatureStatus): string {
  switch (status) {
    case FeatureStatus.Completed:
      return 'Completed';
    case FeatureStatus.InProgress:
      return 'In Progress';
    case FeatureStatus.Pending:
      return 'Pending';
    case FeatureStatus.Cancelled:
      return 'Cancelled';
    default:
      return status;
  }
}

export function FeaturesView({
  data,
  onNavigate,
  viewport,
  initialSelectedIndex,
}: FeaturesViewProps) {
  const { t } = useTranslation('common');
  const { snapshot } = data;
  const { width, height } = viewport;

  // Filter state
  const [currentFilter, setCurrentFilter] = useState<FeatureFilter>('all');

  // Filtered features based on current filter
  const filteredFeatures = useMemo(() => {
    if (currentFilter === 'all') {
      return snapshot.features;
    }
    return snapshot.features.filter((f) => {
      switch (currentFilter) {
        case 'pending':
          return f.status === FeatureStatus.Pending;
        case 'in_progress':
          return f.status === FeatureStatus.InProgress;
        case 'completed':
          return f.status === FeatureStatus.Completed;
        case 'cancelled':
          return f.status === FeatureStatus.Cancelled;
        default:
          return true;
      }
    });
  }, [snapshot.features, currentFilter]);

  // Window and selection state
  const maxVisibleFeatures = Math.max(5, height - 10);
  const clampedInitialIndex =
    initialSelectedIndex !== undefined
      ? Math.min(initialSelectedIndex, Math.max(0, filteredFeatures.length - 1))
      : 0;
  const [windowStart, setWindowStart] = useState(() => {
    // Position the window so the restored index is visible
    if (clampedInitialIndex >= maxVisibleFeatures) {
      return clampedInitialIndex - maxVisibleFeatures + 1;
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

  // Visible features slice
  const visibleFeatures = useMemo(
    () => filteredFeatures.slice(windowStart, windowStart + maxVisibleFeatures),
    [filteredFeatures, windowStart, maxVisibleFeatures]
  );

  // Update window when selection changes
  useEffect(() => {
    if (filteredFeatures.length === 0) return;

    // Scroll down if selection below visible area
    if (selectedIndex >= windowStart + maxVisibleFeatures) {
      setWindowStart(selectedIndex - maxVisibleFeatures + 1);
    }
    // Scroll up if selection above visible area
    else if (selectedIndex < windowStart) {
      setWindowStart(selectedIndex);
    }
  }, [selectedIndex, windowStart, maxVisibleFeatures, filteredFeatures.length]);

  // Cycle filter
  const cycleFilter = useCallback(() => {
    setCurrentFilter((prev) => {
      const currentIndex = FILTER_OPTIONS.indexOf(prev);
      const nextIndex = (currentIndex + 1) % FILTER_OPTIONS.length;
      return FILTER_OPTIONS[nextIndex];
    });
  }, []);

  // Handle select
  const handleSelect = useCallback(() => {
    if (filteredFeatures.length > 0 && filteredFeatures[selectedIndex]) {
      onNavigate(
        MissionControlView.FeatureDetail,
        filteredFeatures[selectedIndex],
        selectedIndex
      );
    }
  }, [filteredFeatures, selectedIndex, onNavigate]);

  // Handle keyboard input
  useKeypressHandler((input, key) => {
    if (filteredFeatures.length === 0) {
      if (input.toLowerCase() === 't') {
        cycleFilter();
      }
      return;
    }

    if (input === 'g') {
      setSelectedIndex(0);
      setWindowStart(0);
    } else if (input === 'G') {
      const lastIndex = filteredFeatures.length - 1;
      setSelectedIndex(lastIndex);
      setWindowStart(Math.max(0, lastIndex - maxVisibleFeatures + 1));
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
        Math.min(filteredFeatures.length - 1, prev + 1)
      );
    } else if (input === 'j') {
      setSelectedIndex((prev) =>
        Math.min(filteredFeatures.length - 1, prev + 1)
      );
    } else if (key.return) {
      handleSelect();
    } else if (input.toLowerCase() === 't') {
      cycleFilter();
    }
  });

  // Count features by status
  const statusCounts = useMemo(() => {
    const counts = {
      all: snapshot.features.length,
      pending: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const f of snapshot.features) {
      if (f.status === FeatureStatus.Pending) counts.pending++;
      else if (f.status === FeatureStatus.InProgress) counts.in_progress++;
      else if (f.status === FeatureStatus.Completed) counts.completed++;
      else if (f.status === FeatureStatus.Cancelled) counts.cancelled++;
    }
    return counts;
  }, [snapshot.features]);

  return (
    <Box flexDirection="column">
      {/* Header with title and filter tabs */}
      <Box marginBottom={1}>
        <Text bold color={MC_COLORS.emphasis}>
          {t('common:featuresView.title')}
        </Text>
        <Text color={MC_COLORS.tertiary}> ({filteredFeatures.length})</Text>
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

      {/* Features list - column headers are STICKY (outside the windowed list) */}
      <Box flexDirection="column" marginTop={1}>
        {/* Column header row (sticky - stays visible while list scrolls)
            Uses fixed-width Box containers for perfect alignment with rows */}
        <Box>
          <Box width={COLUMN_WIDTHS.selectorAndIcon}>
            <Text color={MC_COLORS.tertiary}> </Text>
          </Box>
          <Box width={COLUMN_WIDTHS.status}>
            <Text color={MC_COLORS.tertiary}>
              {t('common:featuresView.statusColumn')}
            </Text>
          </Box>
          <Text color={MC_COLORS.tertiary}>
            {t('common:featuresView.milestoneIdColumn')}
          </Text>
        </Box>

        {/* Windowed feature rows - each row is exactly one terminal line */}
        {visibleFeatures.length > 0 ? (
          visibleFeatures.map((feature, index) => {
            const globalIndex = windowStart + index;
            const isSelected = globalIndex === selectedIndex;
            const statusIndicator = getStatusIndicator(feature.status);

            // Build combined "milestone/id" display string
            const milestone = feature.milestone ?? '-';
            const milestoneIdFull = `${milestone}/${feature.id}`;

            // Calculate remaining width for the Milestone/ID column
            const milestoneIdWidth = Math.max(
              COLUMN_WIDTHS.milestoneIdMin,
              width - FIXED_COLUMNS_WIDTH
            );
            // Pad to fill the column so the highlight background extends uniformly
            const milestoneIdDisplay = truncateWithEllipsis(
              milestoneIdFull,
              milestoneIdWidth
            ).padEnd(milestoneIdWidth);

            // Selected row uses inverted highlight (full-width background)
            const rowBg = isSelected ? MC_COLORS.hlBg : undefined;
            const rowFg = isSelected ? MC_COLORS.hlFg : undefined;

            return (
              <Box key={feature.id}>
                {/* Selector + status icon column */}
                <Box width={COLUMN_WIDTHS.selectorAndIcon}>
                  <Text
                    color={rowFg ?? statusIndicator.color}
                    backgroundColor={rowBg}
                  >
                    {`  ${statusIndicator.icon} `}
                  </Text>
                </Box>
                {/* Status text column */}
                <Box width={COLUMN_WIDTHS.status}>
                  <Text
                    color={
                      rowFg ??
                      (isSelected ? MC_COLORS.emphasis : MC_COLORS.tertiary)
                    }
                    backgroundColor={rowBg}
                    wrap="truncate-end"
                  >
                    {formatStatus(feature.status).padEnd(COLUMN_WIDTHS.status)}
                  </Text>
                </Box>
                {/* Milestone/ID column (last — padEnd fills to milestoneIdWidth for uniform highlight) */}
                <Box width={milestoneIdWidth}>
                  <Text
                    color={
                      rowFg ??
                      (isSelected ? MC_COLORS.emphasis : MC_COLORS.tertiary)
                    }
                    backgroundColor={rowBg}
                    wrap="truncate-end"
                  >
                    {milestoneIdDisplay}
                  </Text>
                </Box>
              </Box>
            );
          })
        ) : (
          <Text color={MC_COLORS.tertiary}>
            {t('common:featuresView.noMatch')}
          </Text>
        )}

        {/* Pagination indicator */}
        {filteredFeatures.length > maxVisibleFeatures && (
          <Text color={MC_COLORS.tertiary}>
            {t('common:featuresView.showingRange', {
              start: windowStart + 1,
              end: Math.min(
                windowStart + maxVisibleFeatures,
                filteredFeatures.length
              ),
              total: filteredFeatures.length,
            })}
          </Text>
        )}
      </Box>
    </Box>
  );
}
