/**
 * Mission Control feature detail view
 * Shows full feature details including description, preconditions, expectedBehavior,
 * and associated worker sessions list
 *
 * Viewport management:
 * - Receives viewport dimensions from parent overlay
 * - Truncates long text with ellipsis to prevent wrapping
 * - Uses internal scrolling for overflow content
 * - Space-bar toggles show-more/show-less for long lists
 */

import { Box, Text } from 'ink';
import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import {
  FeatureStatus,
  type MissionFeature,
} from '@industry/drool-sdk-ext/protocol/drool';

import { MC_COLORS } from '@/components/mission-control/constants';
import { MissionControlView } from '@/components/mission-control/enums';
import type { ViewportDimensions } from '@/components/mission-control/types';
import { parseNumberedDescription } from '@/components/mission-control/utils/description';
import { shouldProcessMissionControlScroll } from '@/components/mission-control/utils/scrollInputGuard';
import {
  truncateWithEllipsis,
  wrapText,
} from '@/components/mission-control/utils/text';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

interface FeatureDetailViewProps {
  feature: MissionFeature;
  onNavigate: (
    view: MissionControlView,
    context?: unknown,
    currentSelectedIndex?: number
  ) => void;
  /** Viewport dimensions for content area (excludes header and padding) */
  viewport: ViewportDimensions;
  /** Restore worker list selection index when returning from a subview */
  initialSelectedWorkerIndex?: number;
}

/** Number of items to show in collapsed state for lists.
 * If showing N items would hide only 1, show N+1 instead (avoid "+1 more" waste). */
const COLLAPSED_LIST_ITEMS = 3;

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

export function FeatureDetailView({
  feature,
  onNavigate,
  viewport,
  initialSelectedWorkerIndex,
}: FeatureDetailViewProps) {
  const { t } = useTranslation('common');
  const { width, height } = viewport;
  const statusIndicator = getStatusIndicator(feature.status);

  // Worker sessions for this feature
  const workerSessions = feature.workerSessionIds ?? [];

  // Selection state for worker sessions (only active if there are sessions)
  const clampedInitialWorkerIndex =
    initialSelectedWorkerIndex !== undefined
      ? Math.min(
          initialSelectedWorkerIndex,
          Math.max(0, workerSessions.length - 1)
        )
      : 0;
  const [selectedWorkerIndex, setSelectedWorkerIndex] = useState(
    clampedInitialWorkerIndex
  );

  // Expanded state for description and lists
  const [isExpanded, setIsExpanded] = useState(false);

  // Calculate max visible workers based on terminal height
  const maxVisibleWorkers = Math.max(3, Math.floor((height - 25) / 2));
  const [workerWindowStart, setWorkerWindowStart] = useState(() => {
    // Position the window so the restored index is visible
    if (clampedInitialWorkerIndex >= maxVisibleWorkers) {
      return clampedInitialWorkerIndex - maxVisibleWorkers + 1;
    }
    return 0;
  });

  // Visible workers slice
  const visibleWorkers = useMemo(
    () =>
      workerSessions.slice(
        workerWindowStart,
        workerWindowStart + maxVisibleWorkers
      ),
    [workerSessions, workerWindowStart, maxVisibleWorkers]
  );

  // Update window when selection changes
  useEffect(() => {
    if (workerSessions.length === 0) return;

    // Scroll down if selection below visible area
    if (selectedWorkerIndex >= workerWindowStart + maxVisibleWorkers) {
      setWorkerWindowStart(selectedWorkerIndex - maxVisibleWorkers + 1);
    }
    // Scroll up if selection above visible area
    else if (selectedWorkerIndex < workerWindowStart) {
      setWorkerWindowStart(selectedWorkerIndex);
    }
  }, [
    selectedWorkerIndex,
    workerWindowStart,
    maxVisibleWorkers,
    workerSessions.length,
  ]);

  // Derive completed/current worker session IDs from workerSessionIds + feature status
  const lastWorkerSessionId =
    workerSessions.length > 0
      ? workerSessions[workerSessions.length - 1]
      : undefined;
  const completedWorkerSessionId =
    feature.status === FeatureStatus.Completed
      ? lastWorkerSessionId
      : undefined;
  const currentWorkerSessionId =
    feature.status === FeatureStatus.InProgress
      ? lastWorkerSessionId
      : undefined;

  // Handle select worker session
  const handleSelectWorker = useCallback(() => {
    if (workerSessions.length > 0 && workerSessions[selectedWorkerIndex]) {
      const sessionId = workerSessions[selectedWorkerIndex];
      onNavigate(
        MissionControlView.SessionViewer,
        {
          sessionId,
          featureId: feature.id,
        },
        selectedWorkerIndex
      );
    }
  }, [workerSessions, selectedWorkerIndex, onNavigate, feature.id]);

  // Determine if there's list content that can be expanded.
  // Description is always fully rendered in this view.
  // Avoid the "+1 more" waste: if hiding only 1 item, show it instead
  const preconditionsCollapsedItems =
    (feature.preconditions?.length ?? 0) === COLLAPSED_LIST_ITEMS + 1
      ? COLLAPSED_LIST_ITEMS + 1
      : COLLAPSED_LIST_ITEMS;
  const expectedBehaviorCollapsedItems =
    (feature.expectedBehavior?.length ?? 0) === COLLAPSED_LIST_ITEMS + 1
      ? COLLAPSED_LIST_ITEMS + 1
      : COLLAPSED_LIST_ITEMS;

  const hasLongPreconditions =
    (feature.preconditions?.length ?? 0) > preconditionsCollapsedItems;
  const hasLongExpectedBehavior =
    (feature.expectedBehavior?.length ?? 0) > expectedBehaviorCollapsedItems;

  // Show "space to expand" hint only on the first truncated section
  const firstTruncated = hasLongPreconditions
    ? 'preconditions'
    : hasLongExpectedBehavior
      ? 'expectedBehavior'
      : null;
  const hasExpandableContent = hasLongPreconditions || hasLongExpectedBehavior;

  // Handle keyboard input
  useKeypressHandler((input, key) => {
    // Handle Space-bar toggle for show-more/show-less
    if (input === ' ' && hasExpandableContent) {
      setIsExpanded((prev) => !prev);
      return;
    }

    if (workerSessions.length === 0) return;

    if (key.upArrow) {
      if (!shouldProcessMissionControlScroll()) {
        return;
      }
      setSelectedWorkerIndex((prev) => Math.max(0, prev - 1));
    } else if (input === 'k') {
      setSelectedWorkerIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      if (!shouldProcessMissionControlScroll()) {
        return;
      }
      setSelectedWorkerIndex((prev) =>
        Math.min(workerSessions.length - 1, prev + 1)
      );
    } else if (input === 'j') {
      setSelectedWorkerIndex((prev) =>
        Math.min(workerSessions.length - 1, prev + 1)
      );
    } else if (key.return) {
      handleSelectWorker();
    }
  });

  return (
    <Box flexDirection="column">
      {/* Feature ID and Status */}
      <Box marginBottom={1}>
        <Text bold color={MC_COLORS.emphasis}>
          {feature.id}
        </Text>
        <Text color={MC_COLORS.tertiary}>{' · '}</Text>
        <Text color={statusIndicator.color}>
          {statusIndicator.icon} {formatStatus(feature.status)}
        </Text>
        {feature.milestone && (
          <>
            <Text color={MC_COLORS.tertiary}>{' · '}</Text>
            <Text color={MC_COLORS.tertiary}>{feature.milestone}</Text>
          </>
        )}
      </Box>

      {/* Description - split on numbered patterns like (1), (2) */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={MC_COLORS.t4}>
          {t('common:featureDetail.descriptionTitle')}
        </Text>
        {(() => {
          const desc = feature.description ?? '';
          const numberedItems = parseNumberedDescription(desc);
          const wrapWidth = Math.max(10, width - 5);
          const elements: React.ReactNode[] = [];

          for (let i = 0; i < numberedItems.length; i++) {
            const item = numberedItems[i]!;
            if (item.number) {
              const lines = wrapText(item.text, wrapWidth);
              // Blank line before numbered items
              elements.push(<Text key={`desc-gap-${i}`}> </Text>);
              // First line with number
              elements.push(
                <Box key={`desc-${i}-0`}>
                  <Text color={MC_COLORS.tertiary}>{item.number}. </Text>
                  <Text color={MC_COLORS.t9}>{lines[0]}</Text>
                </Box>
              );
              // Continuation lines indented past number
              for (let j = 1; j < lines.length; j++) {
                elements.push(
                  <Box key={`desc-${i}-${j}`}>
                    <Text>{'   '}</Text>
                    <Text color={MC_COLORS.t9}>{lines[j]}</Text>
                  </Box>
                );
              }
            } else {
              // Intro text before first number
              const lines = wrapText(item.text, Math.max(10, width - 2));
              for (let j = 0; j < lines.length; j++) {
                elements.push(
                  <Text key={`desc-${i}-${j}`} color={MC_COLORS.t9}>
                    {lines[j]}
                  </Text>
                );
              }
            }
          }
          return elements;
        })()}
      </Box>

      {/* Preconditions - show all when expanded, collapsed otherwise */}
      {feature.preconditions && feature.preconditions.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={MC_COLORS.t4}>
            {t('common:featureDetail.preconditionsTitle')}
          </Text>
          {(isExpanded
            ? feature.preconditions
            : feature.preconditions.slice(0, preconditionsCollapsedItems)
          ).map((precond, index) => (
            <Box key={`precond-${index}`}>
              <Text color={MC_COLORS.tertiary}>· </Text>
              <Text color={MC_COLORS.t9} wrap="truncate-end">
                {truncateWithEllipsis(precond, Math.max(0, width - 4))}
              </Text>
            </Box>
          ))}
          {!isExpanded && hasLongPreconditions && (
            <Text color={MC_COLORS.tertiary}>
              {t('common:featureDetail.moreCount', {
                count:
                  feature.preconditions.length - preconditionsCollapsedItems,
              })}
              {firstTruncated === 'preconditions' ? '; space to expand' : ''}
            </Text>
          )}
        </Box>
      )}

      {/* Expected Behavior - show all when expanded, collapsed otherwise */}
      {feature.expectedBehavior && feature.expectedBehavior.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={MC_COLORS.t4}>
            {t('common:featureDetail.expectedBehaviorTitle')}
          </Text>
          {(isExpanded
            ? feature.expectedBehavior
            : feature.expectedBehavior.slice(0, expectedBehaviorCollapsedItems)
          ).map((behavior, index) => (
            <Box key={`behavior-${index}`}>
              <Text color={MC_COLORS.tertiary}>· </Text>
              <Text color={MC_COLORS.t9} wrap="truncate-end">
                {truncateWithEllipsis(behavior, Math.max(0, width - 4))}
              </Text>
            </Box>
          ))}
          {!isExpanded && hasLongExpectedBehavior && (
            <Text color={MC_COLORS.tertiary}>
              {t('common:featureDetail.moreCount', {
                count:
                  feature.expectedBehavior.length -
                  expectedBehaviorCollapsedItems,
              })}
              {firstTruncated === 'expectedBehavior' ? '; space to expand' : ''}
            </Text>
          )}
        </Box>
      )}

      {/* Worker Sessions */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={MC_COLORS.emphasis}>
          {t('common:featureDetail.workerSessionsTitle')}
        </Text>
        <Text color={MC_COLORS.border}>{'─'.repeat(Math.min(width, 50))}</Text>

        {workerSessions.length > 0 ? (
          <>
            {visibleWorkers.map((sessionId, index) => {
              const globalIndex = workerWindowStart + index;
              const isSelected = globalIndex === selectedWorkerIndex;
              const isCompleted = sessionId === completedWorkerSessionId;
              const isCurrent = sessionId === currentWorkerSessionId;
              const workerStatusWidth = isCurrent ? 10 : isCompleted ? 12 : 0;
              const sessionIdMaxWidth = Math.max(
                0,
                width - 4 - workerStatusWidth
              );

              return (
                <Box key={sessionId}>
                  <Text
                    color={isSelected ? MC_COLORS.active : MC_COLORS.tertiary}
                  >
                    {isSelected ? '> ' : '  '}
                  </Text>
                  <Text
                    color={isSelected ? MC_COLORS.active : MC_COLORS.tertiary}
                    wrap="truncate-end"
                  >
                    {truncateWithEllipsis(sessionId, sessionIdMaxWidth)}
                  </Text>
                  {isCurrent && (
                    <Text color={MC_COLORS.active}>
                      {' '}
                      {t('common:featureDetail.currentLabel')}
                    </Text>
                  )}
                  {isCompleted && (
                    <Text color={MC_COLORS.done}>
                      {' '}
                      {t('common:featureDetail.completedLabel')}
                    </Text>
                  )}
                </Box>
              );
            })}

            {/* Pagination indicator */}
            {workerSessions.length > maxVisibleWorkers && (
              <Text color={MC_COLORS.tertiary}>
                {t('common:featureDetail.showingRange', {
                  start: workerWindowStart + 1,
                  end: Math.min(
                    workerWindowStart + maxVisibleWorkers,
                    workerSessions.length
                  ),
                  total: workerSessions.length,
                })}
              </Text>
            )}
          </>
        ) : (
          <Text color={MC_COLORS.tertiary}>
            {t('common:featureDetail.noWorkerSessions')}
          </Text>
        )}
      </Box>

      {/* Keyboard hints removed - handled by overlay footer */}
    </Box>
  );
}
