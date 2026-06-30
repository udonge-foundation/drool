/**
 * Mission Control overlay component
 * Full-screen overlay with view-stack navigation for missions
 *
 * Frame structure: manual border drawing with ┌─┐, │, └─┘ characters.
 * Header is single-line with ├─┤ dividers between sections.
 *
 * Viewport management:
 * - Computes available content viewport (accounting for header + frame)
 * - Passes viewport dimensions to subviews to prevent overflow
 * - Ensures all views render within terminal bounds
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

import { Box, Text } from 'ink';
import {
  Children,
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  MissionPauseReason,
  MissionState,
  ProgressLogEntryType,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logException } from '@industry/logging';

import {
  MC_COLORS,
  MISSION_CONTROL_HEADER_HEIGHT,
  MISSION_CONTROL_FOOTER_HEIGHT,
} from '@/components/mission-control/constants';
import {
  MissionControlView,
  MissionModelTarget,
} from '@/components/mission-control/enums';
import { FrameContentRow } from '@/components/mission-control/FrameContentRow';
import { HLine } from '@/components/mission-control/HLine';
import { MissionControlHeader } from '@/components/mission-control/MissionControlHeader';
import type {
  HandoffViewerContext,
  MissionControlOverlayProps,
  MissionControlOverlayRef,
  MissionModelSelectorContext,
  PauseResumeResult,
  SessionViewerContext,
  ViewportDimensions,
} from '@/components/mission-control/types';
import { useMissionSnapshot } from '@/components/mission-control/useMissionSnapshot';
import {
  formatMissionElapsedTime,
  getMissionActiveElapsedMs,
  getMissionElapsedTimerNowMs,
  isMissionStateTimingActive,
  subscribeMissionElapsedTimer,
} from '@/components/mission-control/utils/missionElapsedTime';
import { buildWorkerSessions } from '@/components/mission-control/utils/workerSessions';
import { FeatureDetailView } from '@/components/mission-control/views/FeatureDetailView';
import { FeaturesView } from '@/components/mission-control/views/FeaturesView';
import { HandoffViewerView } from '@/components/mission-control/views/HandoffViewerView';
import { MainView } from '@/components/mission-control/views/MainView';
import { MissionModelSelectorView } from '@/components/mission-control/views/MissionModelSelectorView';
import { MissionModelsView } from '@/components/mission-control/views/MissionModelsView';
import { SessionViewerView } from '@/components/mission-control/views/SessionViewerView';
import { WorkersView } from '@/components/mission-control/views/WorkersView';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMissionRateLimitUsage } from '@/hooks/useMissionRateLimitUsage';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import { pauseMissionRunner } from '@/services/mission/missionRunnerOperations';
import { getSessionService } from '@/services/SessionService';
import { getSystemOpenCommand } from '@/utils/getSystemOpenCommand';

const noopMissionElapsedTimerUnsubscribe = () => undefined;

function subscribeInactiveMissionElapsedTimer(): () => void {
  return noopMissionElapsedTimerUnsubscribe;
}

interface ViewStackEntry {
  view: MissionControlView;
  context?: unknown;
  /** Saved selection index so it can be restored when returning to this view via Esc */
  savedSelectedIndex?: number;
}

function isContextRecord(context: unknown): context is Record<string, unknown> {
  return typeof context === 'object' && context !== null;
}

function getFeatureIdFromContext(context: unknown): string | undefined {
  if (typeof context === 'string') {
    return context;
  }

  if (!isContextRecord(context)) {
    return undefined;
  }

  if (typeof context.featureId === 'string') {
    return context.featureId;
  }

  return typeof context.id === 'string' ? context.id : undefined;
}

/**
 * Renders a framed error/loading state with the MC frame structure.
 * Used for loading, error, not-found, and invalid states.
 */
function FramedState({
  frameWidth,
  frameHeight,
  title,
  children,
}: {
  frameWidth: number;
  frameHeight: number;
  title?: string;
  children: ReactNode;
}) {
  const contentWidth = frameWidth - 2;
  const renderedChildCount = Children.toArray(children).filter(
    (child) =>
      child !== null && child !== undefined && typeof child !== 'boolean'
  ).length;
  const fillerRows = Math.max(0, frameHeight - (4 + renderedChildCount));

  return (
    <Box width={frameWidth} height={frameHeight} flexDirection="column">
      <HLine width={frameWidth} left="┌" right="┐" />
      <Box height={1}>
        <Text color={MC_COLORS.border}>│</Text>
        <Box width={contentWidth} height={1} overflow="hidden">
          <Text color={MC_COLORS.active}> 🔱 {title ?? 'Mission Control'}</Text>
        </Box>
        <Text color={MC_COLORS.border}>│</Text>
      </Box>
      <HLine width={frameWidth} />
      {children}
      {Array.from({ length: fillerRows }, (_value, index) => (
        <FrameContentRow key={`frame-filler-${index}`} width={contentWidth} />
      ))}
      <HLine width={frameWidth} left="└" right="┘" />
    </Box>
  );
}

/**
 * Renders a single content row inside the frame (with │ side borders).
 */
function FrameRow({
  contentWidth,
  children,
}: {
  contentWidth: number;
  children?: ReactNode;
}) {
  return <FrameContentRow width={contentWidth}>{children}</FrameContentRow>;
}

function supportsPauseResumeShortcuts(
  currentView: MissionControlView
): boolean {
  const isSecondaryPage =
    currentView === MissionControlView.Features ||
    currentView === MissionControlView.Workers ||
    currentView === MissionControlView.MissionModels;

  return (
    !isSecondaryPage &&
    currentView !== MissionControlView.SessionViewer &&
    currentView !== MissionControlView.HandoffViewer &&
    currentView !== MissionControlView.FeatureDetail
  );
}

/**
 * Footer keyboard hints — rendered in a fixed-width clipped row so Ink cannot reflow it.
 * Shortcuts that don't fit are simply clipped.
 */
function MissionControlFooter({
  currentView,
  missionState,
  hasMissionDir,
  contentWidth,
}: {
  currentView: MissionControlView;
  missionState: MissionState;
  hasMissionDir: boolean;
  contentWidth: number;
}) {
  const isSecondaryPage =
    currentView === MissionControlView.Features ||
    currentView === MissionControlView.Workers ||
    currentView === MissionControlView.MissionModels;

  const supportsPauseResume = supportsPauseResumeShortcuts(currentView);

  const parts: { key: string; label: string }[] = [];

  // View-specific hints
  if (
    currentView === MissionControlView.Features ||
    currentView === MissionControlView.Workers
  ) {
    parts.push({ key: '↑↓', label: 'Select' });
    parts.push({ key: 'g', label: 'Top' });
    parts.push({ key: 'G', label: 'Bottom' });
    parts.push({ key: 'Enter', label: 'View' });
    parts.push({ key: 'T', label: 'Filter' });
  }
  if (currentView === MissionControlView.FeatureDetail) {
    parts.push({ key: '↑↓', label: 'Select' });
    parts.push({ key: 'Enter', label: 'View' });
    parts.push({ key: 'Space', label: 'Expand' });
  }
  if (currentView === MissionControlView.SessionViewer) {
    parts.push({ key: '↑↓', label: 'Scroll' });
    parts.push({ key: '[]', label: 'Density' });
    parts.push({ key: 'g', label: 'Top' });
    parts.push({ key: 'G', label: 'Bottom' });
    parts.push({ key: 's', label: 'Interrupt/Chat' });
    parts.push({ key: 'h', label: 'Handoff' });
  }
  if (currentView === MissionControlView.MissionModels) {
    parts.push({ key: '↑↓', label: 'Select' });
    parts.push({ key: 'Enter', label: 'Change' });
  }

  // Esc/Back for non-main views
  if (currentView !== MissionControlView.Main) {
    parts.push({ key: 'Esc', label: 'Back' });
  }

  // Global navigation – hide shortcut for current page; also hide on SessionViewer
  // and HandoffViewer where single-letter keys are reserved for scroll/message mode
  const hideGlobalNav =
    currentView === MissionControlView.SessionViewer ||
    currentView === MissionControlView.HandoffViewer ||
    currentView === MissionControlView.FeatureDetail ||
    currentView === MissionControlView.MissionModelSelector;
  if (currentView !== MissionControlView.Features && !hideGlobalNav) {
    parts.push({ key: 'F', label: 'Features' });
  }
  if (currentView !== MissionControlView.Workers && !hideGlobalNav) {
    parts.push({ key: 'W', label: 'Workers' });
  }
  if (currentView !== MissionControlView.MissionModels && !hideGlobalNav) {
    parts.push({ key: 'M', label: 'Models' });
  }

  // Pause/Resume – only on views where P/R handlers are active
  if (supportsPauseResume) {
    if (
      missionState === MissionState.Running ||
      missionState === MissionState.OrchestratorTurn
    ) {
      parts.push({ key: 'P', label: 'Pause' });
    }
    if (
      missionState === MissionState.Paused ||
      missionState === MissionState.OrchestratorTurn
    ) {
      parts.push({ key: 'R', label: 'Resume' });
    }
  }

  // D – open mission directory (Main view only, when missionDir is available)
  if (currentView === MissionControlView.Main && hasMissionDir) {
    parts.push({ key: 'D', label: 'Mission Dir' });
  }

  // Ctrl+T – only on non-secondary pages, excluding session/feature detail views
  if (
    !isSecondaryPage &&
    currentView !== MissionControlView.SessionViewer &&
    currentView !== MissionControlView.FeatureDetail
  ) {
    parts.push({ key: 'Ctrl+T', label: 'Back To Orchestrator' });
  }

  // Build a single plain string, pad to contentWidth, then truncate.
  // NOTE: This logic assumes ASCII shortcut keys/labels when slicing by string length.
  // Current Mission Control shortcuts are ASCII-only.
  const footerStr = ` ${parts.map((p) => `${p.key} ${p.label}`).join('    ')}`;
  const truncated = footerStr.padEnd(contentWidth).slice(0, contentWidth);

  // Re-render with colors by walking the truncated string
  // Build colored segments from the parts
  const segments: ReactNode[] = [];
  let pos = 1; // skip leading space
  segments.push(<Text key="lead"> </Text>);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const separator = i > 0 ? '    ' : '';
    const fullSegment = `${separator + part.key} ${part.label}`;

    if (pos >= truncated.length) break;

    const remaining = truncated.length - pos;
    const segStr = fullSegment.slice(0, remaining);

    // Split into: separator, key, space+label
    let segPos = 0;

    // Separator
    if (separator && segPos < segStr.length) {
      const sepLen = Math.min(separator.length, segStr.length - segPos);
      segments.push(
        <Text key={`sep-${i}`}>{segStr.slice(segPos, segPos + sepLen)}</Text>
      );
      segPos += sepLen;
    }

    // Key
    if (segPos < segStr.length) {
      const keyStart = segPos;
      const keyLen = Math.min(part.key.length, segStr.length - segPos);
      segments.push(
        <Text key={`key-${i}`} color={MC_COLORS.dataValue}>
          {segStr.slice(keyStart, keyStart + keyLen)}
        </Text>
      );
      segPos += keyLen;
    }

    // Space + label
    if (segPos < segStr.length) {
      const labelPart = segStr.slice(segPos);
      segments.push(
        <Text key={`lbl-${i}`} color={MC_COLORS.tertiary}>
          {labelPart}
        </Text>
      );
    }

    pos += fullSegment.length;
  }

  // Pad remaining space to fill contentWidth
  const remaining = Math.max(0, truncated.length - pos);
  if (remaining > 0) {
    segments.push(<Text key="pad">{' '.repeat(remaining)}</Text>);
  }

  return (
    <Box height={1}>
      <Text color={MC_COLORS.border}>│</Text>
      <Box width={contentWidth} height={1} overflow="hidden">
        {segments}
      </Box>
      <Text color={MC_COLORS.border}>│</Text>
    </Box>
  );
}

export const MissionControlOverlay = forwardRef<
  MissionControlOverlayRef,
  MissionControlOverlayProps
>(function MissionControlOverlay(
  { width, onInterruptGeneration, onResume, onAutoExit },
  ref
) {
  const { t } = useTranslation('common');
  const { loading, error, data } = useMissionSnapshot();
  const { height: terminalHeight, width: terminalWidth } =
    useTerminalDimensions();
  const activeSessionId = getSessionService().getCurrentSessionId();
  const missionSessionId =
    getSessionService().getDecompMissionId() ?? activeSessionId;
  const settingsSessionId = activeSessionId ?? missionSessionId;
  // Frame width = full terminal width (or provided width)
  const frameWidth = Math.max(3, width ?? terminalWidth);
  const framedStateHeight = Math.max(4, terminalHeight);
  const contentWidth = frameWidth - 2; // Inside the │ borders

  // Track whether the Session Viewer ChatInput is open to suppress global Esc
  const isChatInputOpenRef = useRef(false);
  const [isResuming, setIsResuming] = useState(false);
  const handleMessageModeChange = useCallback((isOpen: boolean) => {
    isChatInputOpenRef.current = isOpen;
  }, []);

  // Compute available content viewport for subviews
  // This ensures subviews know exactly how much space they have
  const contentViewport = useMemo<ViewportDimensions>(() => {
    // Available width: frame width minus border chars (│ on each side)
    const availableWidth = Math.max(1, contentWidth);
    // Available height: terminal height minus header (top border + header + divider)
    // minus footer (divider + footer + bottom border) minus padding
    const availableHeight = Math.max(
      1,
      terminalHeight -
        MISSION_CONTROL_HEADER_HEIGHT -
        MISSION_CONTROL_FOOTER_HEIGHT
    );
    return { width: availableWidth, height: availableHeight };
  }, [contentWidth, terminalHeight]);

  const nestedViewContentViewport = useMemo<ViewportDimensions>(
    () => ({
      // Non-main views render with a left and right side border plus horizontal padding (paddingX={1})
      // so the usable content width is contentWidth - 2.
      width: Math.max(1, contentWidth - 2),
      height: contentViewport.height,
    }),
    [contentWidth, contentViewport.height]
  );

  // Handle pause action
  // This pauses the mission runner AND interrupts any in-flight orchestrator generation
  const handlePause = useCallback(async (): Promise<PauseResumeResult> => {
    const sessionService = getSessionService();
    const sessionId = sessionService.getCurrentSessionId();
    const activeMissionSessionId =
      sessionService.getDecompMissionId() ?? sessionId;

    if (!activeMissionSessionId) {
      return {
        success: false,
        message: 'No active session',
      };
    }

    try {
      // Interrupt any in-flight orchestrator LLM generation (equivalent of Esc)
      // This ensures generation stops immediately when user presses P
      if (onInterruptGeneration) {
        // Fire and forget - don't wait for it to complete
        void onInterruptGeneration().catch(() => undefined);
      }

      await pauseMissionRunner(activeMissionSessionId);
      setIsResuming(false);
      return {
        success: true,
        message: 'Mission paused',
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to pause: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }, [onInterruptGeneration]);

  // Handle resume action
  // Triggers the agent to resume the mission while staying in Mission Control
  const handleResume = useCallback(async (): Promise<PauseResumeResult> => {
    setIsResuming(true);

    // Trigger the agent to resume the mission (don't close Mission Control)
    onResume();

    return {
      success: true,
      message: 'Resuming mission...',
    };
  }, [onResume]);

  // View stack for navigation (Esc pops, navigation pushes)
  const [viewStack, setViewStack] = useState<ViewStackEntry[]>([
    { view: MissionControlView.Main },
  ]);

  const currentEntry = viewStack[viewStack.length - 1];
  const currentView = currentEntry?.view ?? MissionControlView.Main;
  const rateLimitUsage = useMissionRateLimitUsage(data?.snapshot.state);

  // Reset ChatInput-open tracking when leaving the session viewer
  useEffect(() => {
    if (currentView !== MissionControlView.SessionViewer) {
      isChatInputOpenRef.current = false;
    }
  }, [currentView]);

  useEffect(() => {
    if (data?.snapshot.state !== MissionState.Paused) {
      setIsResuming(false);
    }
  }, [data?.snapshot.state]);

  // Auto-exit Mission Control back to the orchestrator view when the mission
  // is auto-paused for a reason the user must act on (a feature exhausted its
  // retry budget, or a worker hit an unrecoverable usage 402). We capture the
  // latest pause entry on first snapshot as a baseline so a pre-existing
  // auto-pause (i.e. the user opened Mission Control after the abort already
  // happened) does NOT immediately kick them out; only a fresh auto-pause that
  // occurs while the overlay is open triggers the exit.
  const baselinePauseTimestampRef = useRef<string | null | undefined>(
    undefined
  );
  const autoExitTriggeredRef = useRef(false);
  useEffect(() => {
    const snapshot = data?.snapshot;
    if (!snapshot) {
      return;
    }

    const latestPause = [...snapshot.progressLog]
      .reverse()
      .find((entry) => entry.type === ProgressLogEntryType.MissionPaused);

    if (baselinePauseTimestampRef.current === undefined) {
      baselinePauseTimestampRef.current = latestPause?.timestamp ?? null;
    }

    if (autoExitTriggeredRef.current) {
      return;
    }

    const isAutoPause =
      latestPause?.type === ProgressLogEntryType.MissionPaused &&
      (latestPause.pauseReason ===
        MissionPauseReason.FeatureRetryLimitExceeded ||
        latestPause.pauseReason === MissionPauseReason.UnrecoverableUsage402);
    const isNewPause =
      latestPause?.timestamp !== baselinePauseTimestampRef.current;

    if (isAutoPause && isNewPause) {
      autoExitTriggeredRef.current = true;
      onAutoExit();
    }
  }, [data?.snapshot, onAutoExit]);

  // Navigation: push a new view onto the stack
  // Optionally saves the current view's selectedIndex so it can be restored on Esc-back.
  const navigateTo = useCallback(
    (
      view: MissionControlView,
      context?: unknown,
      currentSelectedIndex?: number
    ) => {
      setViewStack((stack) => {
        // If the caller provided its current selection index, persist it
        // on the current top-of-stack entry so we can restore it later.
        const updated =
          currentSelectedIndex !== undefined && stack.length > 0
            ? [
                ...stack.slice(0, -1),
                {
                  ...stack[stack.length - 1],
                  savedSelectedIndex: currentSelectedIndex,
                },
              ]
            : [...stack];
        return [...updated, { view, context }];
      });
    },
    []
  );

  // Go back: pop the current view from the stack
  // Returns true if we navigated back within the overlay, false if at root (no-op)
  const goBack = useCallback((): boolean => {
    if (viewStack.length <= 1) {
      // At root – do nothing. Use Ctrl+T to exit Mission Control.
      return true;
    }
    setViewStack((stack) => stack.slice(0, -1));
    return true; // Indicates we navigated back within the overlay
  }, [viewStack.length]);

  // Expose handleEsc method to parent via ref
  useImperativeHandle(
    ref,
    () => ({
      handleEsc: () => {
        if (isChatInputOpenRef.current) {
          return true;
        }
        return goBack();
      },
    }),
    [goBack]
  );

  // Tab / Shift+Tab cycling between top-level views
  const TOP_LEVEL_VIEWS = useMemo(
    () => [
      MissionControlView.Main,
      MissionControlView.Features,
      MissionControlView.Workers,
      MissionControlView.MissionModels,
    ],
    []
  );

  const isTopLevelView = TOP_LEVEL_VIEWS.includes(currentView);

  // Handle keyboard input for F/W/M navigation keys (not ESC - that's handled by parent via ref)
  // Active on any top-level view so users can press F/W/M from Features, Workers, or Models too.
  useKeypressHandler(
    (input, _key) => {
      if (data) {
        if (input.toLowerCase() === 'f') {
          setViewStack([
            { view: MissionControlView.Main },
            { view: MissionControlView.Features },
          ]);
        } else if (input.toLowerCase() === 'w') {
          setViewStack([
            { view: MissionControlView.Main },
            { view: MissionControlView.Workers },
          ]);
        } else if (input.toLowerCase() === 'm') {
          setViewStack([
            { view: MissionControlView.Main },
            { view: MissionControlView.MissionModels },
          ]);
        }
      }
    },
    { isActive: isTopLevelView }
  );

  useKeypressHandler(
    (_input, key) => {
      if (key.tab) {
        const currentIndex = TOP_LEVEL_VIEWS.indexOf(currentView);
        const nextIndex = key.shift
          ? (currentIndex - 1 + TOP_LEVEL_VIEWS.length) % TOP_LEVEL_VIEWS.length
          : (currentIndex + 1) % TOP_LEVEL_VIEWS.length;
        const nextView = TOP_LEVEL_VIEWS[nextIndex];
        if (nextView === MissionControlView.Main) {
          setViewStack([{ view: MissionControlView.Main }]);
        } else {
          setViewStack([{ view: MissionControlView.Main }, { view: nextView }]);
        }
      }
    },
    { isActive: isTopLevelView }
  );

  // Keep P/R activation aligned with footer hints.
  const isPauseResumeActive = supportsPauseResumeShortcuts(currentView);

  useKeypressHandler(
    (input, _key) => {
      if (!data) return;
      if (isChatInputOpenRef.current) return;
      if (
        input.toLowerCase() === 'p' &&
        (data.snapshot.state === MissionState.Running ||
          data.snapshot.state === MissionState.OrchestratorTurn)
      ) {
        void handlePause();
      } else if (
        input.toLowerCase() === 'r' &&
        (data.snapshot.state === MissionState.Paused ||
          data.snapshot.state === MissionState.OrchestratorTurn)
      ) {
        void handleResume();
      }
    },
    { isActive: isPauseResumeActive }
  );

  // D – open mission directory in the system file browser
  useKeypressHandler(
    (input) => {
      if (input.toLowerCase() === 'd' && data?.missionDir) {
        const child = spawn(getSystemOpenCommand(), [data.missionDir], {
          detached: true,
          stdio: 'ignore',
        });

        child.on('error', (spawnError) => {
          logException(spawnError, 'Failed to open mission directory', {
            path: data.missionDir,
          });
        });

        child.unref();
      }
    },
    { isActive: currentView === MissionControlView.Main }
  );

  const isMissionTimeActive = data
    ? isMissionStateTimingActive(data.snapshot.state)
    : false;
  const headerTimerNowMs = useSyncExternalStore(
    isMissionTimeActive
      ? subscribeMissionElapsedTimer
      : subscribeInactiveMissionElapsedTimer,
    getMissionElapsedTimerNowMs,
    getMissionElapsedTimerNowMs
  );

  // Compute mission elapsed time from cumulative active mission intervals
  const elapsedTime = useMemo(() => {
    if (!data) {
      return undefined;
    }

    const elapsedMs = getMissionActiveElapsedMs(
      data.snapshot,
      headerTimerNowMs
    );
    if (elapsedMs === null) {
      return undefined;
    }

    return formatMissionElapsedTime(elapsedMs);
  }, [data, headerTimerNowMs]);

  // Loading state
  if (loading) {
    return (
      <FramedState frameWidth={frameWidth} frameHeight={framedStateHeight}>
        <FrameRow contentWidth={contentWidth}>
          <Text color={MC_COLORS.tertiary}>
            {' '}
            {t('common:missionControl.loading')}
          </Text>
        </FrameRow>
      </FramedState>
    );
  }

  // Error state: mission not found (empty state - expected for new sessions)
  if (error?.type === 'not_found') {
    return (
      <FramedState frameWidth={frameWidth} frameHeight={framedStateHeight}>
        <FrameRow contentWidth={contentWidth}>
          <Text color={MC_COLORS.fail}>
            {' '}
            {t('common:missionControl.noMissionFound')}
          </Text>
        </FrameRow>
        <FrameRow contentWidth={contentWidth}>
          <Text color={MC_COLORS.tertiary}> {error.message}</Text>
        </FrameRow>
        <FrameRow contentWidth={contentWidth} />
        <FrameRow contentWidth={contentWidth}>
          <Text color={MC_COLORS.tertiary}>
            {' '}
            {t('common:missionControl.pressCtrlGToClose')}
          </Text>
        </FrameRow>
      </FramedState>
    );
  }

  // Error state: read error (permission denied or other)
  if (error) {
    return (
      <FramedState frameWidth={frameWidth} frameHeight={framedStateHeight}>
        <FrameRow contentWidth={contentWidth}>
          <Text color={MC_COLORS.fail}>
            {' '}
            {t('common:missionControl.errorLoadingMission')}
          </Text>
        </FrameRow>
        <FrameRow contentWidth={contentWidth}>
          <Text color={MC_COLORS.tertiary}> {error.message}</Text>
        </FrameRow>
        {error.path && (
          <FrameRow contentWidth={contentWidth}>
            <Text color={MC_COLORS.tertiary}>
              {' '}
              {t('common:missionControl.fileLabel', {
                path: path.basename(error.path),
              })}
            </Text>
          </FrameRow>
        )}
        {error.path && path.basename(error.path) !== error.path && (
          <FrameRow contentWidth={contentWidth}>
            <Text color={MC_COLORS.tertiary}>
              {' '}
              {t('common:missionControl.fileLabel', { path: error.path })}
            </Text>
          </FrameRow>
        )}
        <FrameRow contentWidth={contentWidth} />
        <FrameRow contentWidth={contentWidth}>
          <Text color={MC_COLORS.tertiary}>
            {' '}
            {t('common:missionControl.pressCtrlGToClose')}
          </Text>
        </FrameRow>
      </FramedState>
    );
  }

  // No data (should not happen after loading, but handle gracefully)
  if (!data) {
    return (
      <FramedState frameWidth={frameWidth} frameHeight={framedStateHeight}>
        <FrameRow contentWidth={contentWidth}>
          <Text color={MC_COLORS.tertiary}>
            {' '}
            {t('common:missionControl.noDataAvailable')}
          </Text>
        </FrameRow>
      </FramedState>
    );
  }

  // Render the current view
  const activeViewport =
    currentView === MissionControlView.Main
      ? contentViewport
      : nestedViewContentViewport;

  const renderView = () => {
    switch (currentView) {
      case MissionControlView.Main:
        return (
          <MainView
            data={data}
            viewport={activeViewport}
            sessionId={settingsSessionId}
            isResuming={isResuming}
          />
        );

      case MissionControlView.Features:
        return (
          <FeaturesView
            data={data}
            onNavigate={navigateTo}
            viewport={activeViewport}
            initialSelectedIndex={currentEntry?.savedSelectedIndex}
          />
        );

      case MissionControlView.FeatureDetail: {
        const featureId = getFeatureIdFromContext(currentEntry?.context);
        const feature = data.snapshot.features.find(
          (candidate) => candidate.id === featureId
        );
        if (!feature) {
          return (
            <Text color={MC_COLORS.tertiary}>
              {t('common:missionControl.featureNotFound')}
            </Text>
          );
        }
        return (
          <FeatureDetailView
            feature={feature}
            onNavigate={navigateTo}
            viewport={activeViewport}
            initialSelectedWorkerIndex={currentEntry?.savedSelectedIndex}
          />
        );
      }

      case MissionControlView.Workers:
        return (
          <WorkersView
            data={data}
            onNavigate={navigateTo}
            viewport={activeViewport}
            initialSelectedIndex={currentEntry?.savedSelectedIndex}
          />
        );

      case MissionControlView.MissionModels:
        return (
          <MissionModelsView
            onNavigate={navigateTo}
            viewport={activeViewport}
            sessionId={settingsSessionId}
          />
        );

      case MissionControlView.MissionModelSelector: {
        const context = currentEntry?.context as
          | MissionModelSelectorContext
          | undefined;
        const target = context?.target ?? MissionModelTarget.Worker;
        return (
          <MissionModelSelectorView
            target={target}
            sessionId={settingsSessionId}
            onDone={() => {
              goBack();
            }}
          />
        );
      }

      case MissionControlView.SessionViewer: {
        // Support both old format (string sessionId) and new format (SessionViewerContext)
        const context = currentEntry?.context;
        if (!context) {
          return (
            <Text color={MC_COLORS.tertiary}>
              {t('common:missionControl.sessionNotFound')}
            </Text>
          );
        }
        // Handle backward compatibility - if context is a string, convert to object
        const sessionContext =
          typeof context === 'string'
            ? ({ sessionId: context } satisfies SessionViewerContext)
            : (context as SessionViewerContext);
        if (!sessionContext.sessionId) {
          return (
            <Text color={MC_COLORS.tertiary}>
              {t('common:missionControl.sessionNotFound')}
            </Text>
          );
        }

        const currentWorker = buildWorkerSessions(
          data.snapshot.workerSessionIds ?? [],
          data.snapshot.workerStates,
          data.snapshot.progressLog,
          data.snapshot.features,
          data.snapshot.tokenUsageBySessionId
        ).find((worker) => worker.sessionId === sessionContext.sessionId);
        const currentStatus = currentWorker?.status ?? sessionContext.status;
        const currentDuration =
          currentWorker?.duration ?? sessionContext.duration;
        const currentFeatureId =
          currentWorker?.featureId ?? sessionContext.featureId;
        const currentActiveDurationAnchorMs =
          currentWorker?.activeDurationAnchorMs ??
          sessionContext.activeDurationAnchorMs;

        return (
          <SessionViewerView
            key={sessionContext.sessionId}
            sessionId={sessionContext.sessionId}
            featureId={currentFeatureId}
            status={currentStatus}
            duration={currentDuration}
            activeDurationAnchorMs={currentActiveDurationAnchorMs}
            workingDirectory={data.workingDirectory}
            tokenUsage={
              data.snapshot.tokenUsageBySessionId?.[sessionContext.sessionId]
            }
            missionDir={data.missionDir}
            viewport={activeViewport}
            onMessageModeChange={handleMessageModeChange}
            onNavigateToHandoff={() => {
              navigateTo(MissionControlView.HandoffViewer, {
                workerSessionId: sessionContext.sessionId,
                featureId: currentFeatureId,
              } as HandoffViewerContext);
            }}
          />
        );
      }

      case MissionControlView.HandoffViewer: {
        const context = currentEntry?.context as
          | HandoffViewerContext
          | undefined;
        if (!context?.workerSessionId) {
          return (
            <Text color={MC_COLORS.tertiary}>
              {t('common:missionControl.noWorkerSession')}
            </Text>
          );
        }
        return (
          <HandoffViewerView
            workerSessionId={context.workerSessionId}
            featureId={context.featureId}
            viewport={activeViewport}
          />
        );
      }

      default:
        return (
          <Text color={MC_COLORS.tertiary}>
            {t('common:missionControl.unknownView')}
          </Text>
        );
    }
  };

  return (
    <Box width={frameWidth} height={terminalHeight} flexDirection="column">
      {/* Top border */}
      <HLine width={frameWidth} left="┌" right="┐" />

      {/* Header row */}
      <Box height={1}>
        <Text color={MC_COLORS.border}>│</Text>
        <MissionControlHeader
          workingDirectory={data.workingDirectory}
          tokenUsage={data.snapshot.tokenUsage}
          rateLimitUsage={rateLimitUsage}
          width={contentWidth}
          elapsedTime={elapsedTime}
        />
        <Text color={MC_COLORS.border}>│</Text>
      </Box>

      {/* Header divider */}
      <HLine width={frameWidth} />

      {/* Content area */}
      {currentView === MissionControlView.Main ? (
        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          {renderView()}
        </Box>
      ) : (
        <Box
          flexGrow={1}
          height={activeViewport.height}
          flexDirection="column"
          overflow="hidden"
          borderStyle="single"
          borderColor={MC_COLORS.border}
          borderTop={false}
          borderBottom={false}
          paddingX={1}
        >
          {renderView()}
        </Box>
      )}

      {/* Footer divider */}
      <HLine width={frameWidth} />

      {/* Footer keyboard hints — context-aware, single unified row */}
      <MissionControlFooter
        currentView={currentView}
        missionState={data.snapshot.state}
        hasMissionDir={!!data.missionDir}
        contentWidth={contentWidth}
      />

      {/* Bottom border */}
      <HLine width={frameWidth} left="└" right="┘" />
    </Box>
  );
});
