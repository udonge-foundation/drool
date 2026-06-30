import { Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type CronRecord } from '@industry/common/daemon';
import { McpStatus } from '@industry/drool-sdk-ext/protocol/drool';
import {
  classifyUpdateError,
  UpdateErrorCategory,
  UpdaterState,
  UpdaterStateType,
} from '@industry/updater';

import { COLORS } from '@/components/chat/themedColors';
import type { TimerPersistentState } from '@/components/types';
import { AgentStatusState } from '@/hooks/enums';
import type { IdeContextState } from '@/hooks/types';
import { useDiagnosticsStatus } from '@/hooks/useDiagnosticsStatus';
import { getI18n } from '@/i18n/index';
import { formatNextLoopSummary } from '@/services/crons/format';
import { PrStatus } from '@/services/enums';
import { getSandboxService } from '@/services/SandboxService';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import type { PrState } from '@/services/types';
import {
  subscribeToNonBlockingUpdates,
  getNonBlockingUpdateState,
} from '@/services/update/UpdateService';
import { SYSTEM_PROMPT_TOKENS } from '@/utils/constants';
import { computeContextPercentage } from '@/utils/contextUsage';
import { detectManagedEnvironment } from '@/utils/detectManagedEnvironment';
import { ManagedEnvironmentConfidence } from '@/utils/enums';
import { formatDurationCompact } from '@/utils/format';
import { ghosttyProgressIsSupported } from '@/utils/ghosttyProgress';
import { ideDetector } from '@/utils/ide-detector';
import { isWindowsLike } from '@/utils/isWsl';
import { getTerminalInfo } from '@/utils/terminalInfo';
import {
  linkSegment,
  renderTwoSidedTerminalRow,
  textSegment,
} from '@/utils/terminalSegments';
import type { TerminalSegment } from '@/utils/terminalSegments/types';
import type { TerminalInfo } from '@/utils/types';

import type { MutableRefObject } from 'react';

const ACTIVE_AGENT_STATES = new Set<AgentStatusState>([
  AgentStatusState.Thinking,
  AgentStatusState.Streaming,
  AgentStatusState.Compressing,
  AgentStatusState.ExecutingTool,
]);

const GIT_BRANCH_ICON = '\uF418';
const isWindows = isWindowsLike();

let cachedTerminalInfo: TerminalInfo | null = null;

interface FooterStatusRowProps {
  width: number;
  showHelpHints: boolean;
  chatDraftEmpty: boolean;
  timerState: MutableRefObject<TimerPersistentState>;
  statusState: AgentStatusState;
  sessionId: string | null;
  lastTokenUsage?: number | null;
  scheduledTasks: CronRecord[];
  prState: PrState;
  sandboxEnabled: boolean;
  mcpVisible: boolean;
  mcpStatus: McpStatus;
  ideState: IdeContextState;
  getSelectedLineCount: () => number;
  hasSelection: () => boolean;
}

function selectUpdateErrorKey(
  error: Error,
  isManagedEnvironment: boolean
): string {
  const category = classifyUpdateError(error);

  switch (category) {
    case UpdateErrorCategory.FileLocked:
      return isManagedEnvironment
        ? 'update.errorFileLockedManaged'
        : 'update.errorFileLocked';
    case UpdateErrorCategory.PermissionDenied:
      return isManagedEnvironment
        ? 'update.errorPermissionManaged'
        : 'update.errorPermission';
    case UpdateErrorCategory.DiskFull:
      return 'update.errorDiskFull';
    case UpdateErrorCategory.Network:
      return 'update.errorNetwork';
    case UpdateErrorCategory.VerificationFailed:
      return 'update.errorVerification';
    case UpdateErrorCategory.Unknown:
    default:
      return 'update.error';
  }
}

function hasVisibleUpdateState(state: UpdaterState | null): boolean {
  if (!state) return false;
  if (state.type === UpdaterStateType.NoUpdate) return false;
  if (state.type === UpdaterStateType.Complete && state.skipped) return false;
  return true;
}

function formatContextPercentage(lastTokenUsage: number | null): string | null {
  if (lastTokenUsage === null || lastTokenUsage === 0) return null;

  const currentModel = getSessionService().getModel();
  const tokenLimit =
    getSettingsService().getCompactionTokenLimitForModel(currentModel);
  const { percentage } = computeContextPercentage({
    lastTokenUsage,
    tokenLimit,
    systemPromptTokens: SYSTEM_PROMPT_TOKENS,
  });

  if (percentage === 0) {
    return getI18n().t('common:assistantTimer.lessThanOnePercent');
  }

  return `${percentage}%`;
}

function useAssistantTimerLabel({
  statusState,
  sessionId,
  lastTokenUsage,
  timerState,
}: Pick<
  FooterStatusRowProps,
  'statusState' | 'sessionId' | 'lastTokenUsage' | 'timerState'
>): string | null {
  const { t } = useTranslation('common');
  const ps = timerState.current;
  const [assistantActiveTimeMs, setAssistantActiveTimeMs] = useState(() => {
    if (ps.sessionId !== null && ps.sessionId !== sessionId) {
      ps.activeStart = null;
      ps.accumulatedTimeMs = null;
    }
    ps.sessionId = sessionId;
    return ps.accumulatedTimeMs ?? getSessionService().getAssistantActiveTime();
  });
  const [, forceTick] = useState(0);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastSessionIdRef = useRef<string | null>(sessionId);
  const assistantActiveTimeMsRef = useRef(assistantActiveTimeMs);
  assistantActiveTimeMsRef.current = assistantActiveTimeMs;

  useEffect(() => {
    const sessionService = getSessionService();
    if (sessionId !== lastSessionIdRef.current) {
      lastSessionIdRef.current = sessionId;
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      ps.activeStart = null;
      ps.accumulatedTimeMs = null;
      ps.sessionId = sessionId;
      setAssistantActiveTimeMs(sessionService.getAssistantActiveTime());
    }
  }, [ps, sessionId]);

  useEffect(() => {
    const isActive = ACTIVE_AGENT_STATES.has(statusState);

    if (isActive) {
      if (ps.activeStart === null) ps.activeStart = Date.now();
      if (!timerIntervalRef.current) {
        timerIntervalRef.current = setInterval(() => {
          forceTick((prev) => prev + 1);
        }, 1000);
      }
    } else if (ps.activeStart !== null) {
      const elapsed = Date.now() - ps.activeStart;
      ps.activeStart = null;
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      setAssistantActiveTimeMs((prev) => prev + elapsed);
    }
  }, [ps, sessionId, statusState]);

  useEffect(
    () => () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      const base = assistantActiveTimeMsRef.current;
      const inFlight = ps.activeStart ? Date.now() - ps.activeStart : 0;
      ps.accumulatedTimeMs = base + inFlight;
      if (ps.activeStart !== null) ps.activeStart = Date.now();
    },
    [ps]
  );

  const displayAssistantTimeMs = Math.max(
    0,
    assistantActiveTimeMs + (ps.activeStart ? Date.now() - ps.activeStart : 0)
  );
  const assistantTimeLabel = formatDurationCompact(displayAssistantTimeMs);
  const showTimer = assistantTimeLabel !== '0s';
  const showTokenUsage =
    getSettingsService().getShowTokenUsageIndicator() &&
    lastTokenUsage !== null &&
    lastTokenUsage !== undefined &&
    lastTokenUsage > 0;
  const contextPercentage = showTokenUsage
    ? formatContextPercentage(lastTokenUsage ?? null)
    : null;

  if (!showTimer && !contextPercentage) return null;

  const parts: string[] = [];
  if (showTimer) parts.push(`⏱ ${assistantTimeLabel}`);
  if (contextPercentage) {
    parts.push(`${t('assistantTimer.contextLabel')}${contextPercentage}`);
  }

  return `[${parts.join(', ')}]`;
}

function useFooterPrimaryLabel({
  showHelpHints,
  chatDraftEmpty,
}: Pick<FooterStatusRowProps, 'showHelpHints' | 'chatDraftEmpty'>): {
  text: string;
  color: string;
  bold?: boolean;
} {
  const { t } = useTranslation('common');
  const { hasFailures, failures } = useDiagnosticsStatus();
  const [updateState, setUpdateState] = useState<UpdaterState | null>(
    getNonBlockingUpdateState()
  );

  useEffect(() => subscribeToNonBlockingUpdates(setUpdateState), []);

  if (hasFailures) {
    return {
      text: t('footer.configIssueCount', { count: failures.length }),
      color: COLORS.warning,
    };
  }

  if (chatDraftEmpty && hasVisibleUpdateState(updateState)) {
    const state = updateState!;
    switch (state.type) {
      case UpdaterStateType.Checking:
        return { text: t('update.checking'), color: COLORS.text.muted };
      case UpdaterStateType.UpdateAvailable:
        return {
          text: t('update.available', { version: state.version }),
          color: COLORS.text.muted,
        };
      case UpdaterStateType.Downloading:
        return { text: t('update.downloading'), color: COLORS.text.muted };
      case UpdaterStateType.Verifying:
        return { text: t('update.verifying'), color: COLORS.text.muted };
      case UpdaterStateType.Installing:
        return { text: t('update.installing'), color: COLORS.text.muted };
      case UpdaterStateType.Complete:
      case UpdaterStateType.PendingInstall:
        return {
          text: t('update.ready', { version: state.version }),
          color: COLORS.text.muted,
        };
      case UpdaterStateType.Error: {
        const isManagedEnv =
          detectManagedEnvironment().confidence ===
          ManagedEnvironmentConfidence.Likely;
        const category = classifyUpdateError(state.error);
        const errorKey = selectUpdateErrorKey(state.error, isManagedEnv);
        return {
          text: t(errorKey, { error: state.error.message }),
          color:
            category === UpdateErrorCategory.Unknown
              ? COLORS.text.muted
              : COLORS.warning,
        };
      }
      default:
        break;
    }
  }

  return {
    text: showHelpHints ? t('footer.hideHelp') : t('footer.showHelp'),
    color: COLORS.text.muted,
  };
}

function buildPrSegments(prState: PrState): TerminalSegment[] {
  if (
    prState.status !== PrStatus.Found ||
    !prState.prUrl ||
    !prState.prNumber
  ) {
    return [];
  }

  const label: TerminalSegment[] = [];
  if (getSettingsService().getNerdFont()) {
    label.push(
      textSegment(`${GIT_BRANCH_ICON} `, { color: COLORS.toolName, bold: true })
    );
  }
  label.push(
    textSegment(`+${prState.additions ?? 0}`, {
      color: COLORS.gitAdditions,
      bold: true,
    }),
    textSegment(' '),
    textSegment(`-${prState.deletions ?? 0}`, {
      color: COLORS.gitDeletions,
      bold: true,
    }),
    textSegment(' '),
    textSegment(`#${prState.prNumber}`, { color: COLORS.toolName, bold: true })
  );

  const link = linkSegment(prState.prUrl, label);
  return link ? [link] : label;
}

function buildMcpSegments(status: McpStatus): TerminalSegment[] {
  const t = getI18n().t.bind(getI18n());
  switch (status) {
    case McpStatus.Initializing:
      return [
        textSegment(t('common:mcpStatus.connecting'), {
          color: COLORS.warning,
          bold: true,
        }),
      ];
    case McpStatus.Ready:
      return [
        textSegment(t('common:mcpStatus.ready'), {
          color: COLORS.success,
          bold: true,
        }),
      ];
    case McpStatus.Failed:
      return [
        textSegment(t('common:mcpStatus.failed'), {
          color: COLORS.disconnected,
          bold: true,
        }),
      ];
    default:
      return [];
  }
}

function buildIdeSegments({
  ideState,
  getSelectedLineCount,
  hasSelection,
}: Pick<
  FooterStatusRowProps,
  'ideState' | 'getSelectedLineCount' | 'hasSelection'
>): TerminalSegment[] {
  const t = getI18n().t.bind(getI18n());
  const { activeFile, connectionStatus } = ideState;
  const isConnected = connectionStatus === 'connected';
  const isConnecting = connectionStatus === 'connecting';
  const isInSupportedIde = ideDetector.isRunningInSupportedIde();
  const ideInfo = isInSupportedIde ? ideDetector.detectIde() : null;

  if (isConnecting && isInSupportedIde && ideInfo) {
    return [
      textSegment(`${ideInfo.displayName} ◌`, { color: COLORS.text.info }),
    ];
  }

  if (isConnected && hasSelection()) {
    const selectedLines = getSelectedLineCount();
    return [
      textSegment(
        `${selectedLines} line${selectedLines === 1 ? '' : 's'} selected`,
        { color: COLORS.text.info }
      ),
    ];
  }

  const fileName =
    activeFile?.fileName.split(/[\\/]/).pop() || activeFile?.fileName || '';
  if (isConnected && activeFile && fileName !== undefined) {
    return [textSegment(fileName, { color: COLORS.text.info })];
  }

  if (isConnected && isInSupportedIde && ideInfo) {
    return [textSegment(ideInfo.displayName, { color: COLORS.text.info })];
  }

  if (isWindows && !(isInSupportedIde && ideInfo)) {
    return [];
  }

  if (!cachedTerminalInfo) cachedTerminalInfo = getTerminalInfo();
  const terminalInfo = cachedTerminalInfo;
  const isGhostty = ghosttyProgressIsSupported();
  const isTmux = Boolean(process.env.TMUX) || terminalInfo.name === 'tmux';
  let terminalIndicator = 'IDE ◌';
  let isKnownTerminal = false;

  if (isInSupportedIde && ideInfo) {
    terminalIndicator = t('common:footer.ideHint', {
      name: ideInfo.displayName,
    });
  } else if (isTmux) {
    terminalIndicator = 'TMUX ⧉';
    isKnownTerminal = true;
  } else if (isGhostty) {
    terminalIndicator = 'GHOSTTY ᗣ';
    isKnownTerminal = true;
  } else if (terminalInfo.name === 'iTerm.app') {
    terminalIndicator = 'iTERM2 ▲';
    isKnownTerminal = true;
  } else if (terminalInfo.name === 'WarpTerminal') {
    terminalIndicator = 'WARP ⚡';
    isKnownTerminal = true;
  } else if (terminalInfo.name === 'Apple_Terminal') {
    terminalIndicator = 'TERMINAL ■';
    isKnownTerminal = true;
  } else if (terminalInfo.name === 'powershell') {
    terminalIndicator = 'POWERSHELL ▶';
    isKnownTerminal = true;
  }

  return [
    textSegment(terminalIndicator, {
      color: isKnownTerminal
        ? COLORS.success
        : isConnected
          ? COLORS.text.info
          : COLORS.disconnected,
    }),
  ];
}

function appendWithSeparator(
  target: TerminalSegment[],
  segments: TerminalSegment[],
  separator: string = ' | '
): void {
  if (segments.length === 0) return;
  if (target.length > 0) {
    target.push(textSegment(separator, { color: COLORS.text.muted }));
  }
  target.push(...segments);
}

export function FooterStatusRow({
  width,
  showHelpHints,
  chatDraftEmpty,
  timerState,
  statusState,
  sessionId,
  lastTokenUsage,
  scheduledTasks,
  prState,
  sandboxEnabled,
  mcpVisible,
  mcpStatus,
  ideState,
  getSelectedLineCount,
  hasSelection,
}: FooterStatusRowProps) {
  const timerLabel = useAssistantTimerLabel({
    statusState,
    sessionId,
    lastTokenUsage,
    timerState,
  });
  const primary = useFooterPrimaryLabel({ showHelpHints, chatDraftEmpty });
  const left: TerminalSegment[] = [];
  const right: TerminalSegment[] = [];

  if (timerLabel) {
    appendWithSeparator(
      left,
      [textSegment(timerLabel, { color: COLORS.text.muted })],
      ' '
    );
  }

  appendWithSeparator(
    left,
    [textSegment(primary.text, { color: primary.color, bold: primary.bold })],
    ' '
  );

  const scheduledTaskSegmentText = formatNextLoopSummary(scheduledTasks);
  if (scheduledTaskSegmentText) {
    appendWithSeparator(left, [
      textSegment(scheduledTaskSegmentText, { color: COLORS.primary }),
    ]);
  }

  const statusSegments: TerminalSegment[] = [];
  appendWithSeparator(statusSegments, buildPrSegments(prState), ' ');
  if (sandboxEnabled && getSandboxService().isEnabled()) {
    appendWithSeparator(statusSegments, [
      textSegment(getI18n().t('common:sandbox.statusIndicator'), {
        color: COLORS.warning,
      }),
    ]);
  }
  if (mcpVisible)
    appendWithSeparator(statusSegments, buildMcpSegments(mcpStatus));
  appendWithSeparator(
    statusSegments,
    buildIdeSegments({ ideState, getSelectedLineCount, hasSelection })
  );

  if (isWindows) {
    appendWithSeparator(left, statusSegments);
  } else {
    right.push(...statusSegments);
  }

  return (
    <Text>
      {renderTwoSidedTerminalRow({
        left,
        right,
        width,
      })}
    </Text>
  );
}
