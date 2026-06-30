import * as path from 'path';

import { Box, Text, render, useApp, useStdin, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import '@/commands'; // register slash commands for CLI

import { MissionReadinessGateState } from '@industry/common/agentReadiness/enums';
import { TodoDisplayMode } from '@industry/common/cli';
import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import {
  DroolEvent,
  QueuedUserMessageDisplayGroup,
  QueuedUserMessageKind,
  getQueuedUserMessageDisplayGroup,
  getQueuedUserMessageReviewPriority,
  isDaemonQueuedMessageKind,
  isReviewableQueuedMessageKind,
  type QueuedUserMessageState,
} from '@industry/daemon-client';
import {
  DecompSessionType,
  DroolWorkingState,
  McpStatus,
  MissionState,
  QueuePlacement,
  ResolveQueuedUserMessageAction,
  ToolConfirmationOutcome,
  ToolConfirmationType,
} from '@industry/drool-sdk-ext/protocol/drool';
import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import {
  IndustryDroolMessage,
  MessageContentBlockType,
  MessageRole as ProtocolMessageRole,
  MessageVisibility,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import {
  AutonomyLevel,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logException, logInfo, logWarn, Metrics } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';
import { MCP_OAUTH_FILE_DATA_FILE_NAME } from '@industry/runtime/auth';
import { resetFeatureFlagCache } from '@industry/runtime/feature-flags';
import {
  getMcpOAuthReconnectionBannerStatus,
  getMcpOAuthReconnectionBannerStatusSync,
} from '@industry/runtime/settings';
import { getNextAutonomyLevelInCycle } from '@industry/utils/autonomy';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { isAbortError } from '@industry/utils/function';
import {
  MISSION_ORCHESTRATOR_MIN_REASONING_EFFORTS,
  MISSION_ORCHESTRATOR_MODEL_WARNING,
  MISSION_ORCHESTRATOR_RECOMMENDED_MODELS,
} from '@industry/utils/llm';
import { getPermissionToolInputForDisplay } from '@industry/utils/session';
import { findGitRoot } from '@industry/utils/shell/node';

import type { ApprovedSpecNewSessionPayload } from '@/agent/types';
import { formatLoopScheduledMessage } from '@/commands/loop';
import { commandRegistry } from '@/commands/registry';
import { AnchoredTranscriptPanel } from '@/components/AnchoredTranscriptPanel';
import type { AskUserAnswerState } from '@/components/askUser/types';
import { AskUserConfirmation } from '@/components/AskUserConfirmation';
import { AskUserReadOnlyPreview } from '@/components/AskUserReadOnlyPreview';
import { AuthenticationCheck } from '@/components/AuthenticationCheck';
import { AutomationsModal } from '@/components/AutomationsModal';
import { BackgroundTasksPanel } from '@/components/BackgroundTasksPanel';
import { Banner } from '@/components/Banner';
import { BatchToolConfirmationMessage } from '@/components/BatchToolConfirmationMessage';
import { BgProcessManager } from '@/components/BgProcessManager';
import { BtwScrollView } from '@/components/btw/BtwScrollView';
import { ChatInput } from '@/components/chat/ChatInput';
import { ANSI } from '@/components/chat/constants';
import { COLORS } from '@/components/chat/themedColors';
import type { ChatInputApi } from '@/components/chat/types';
import { CommandsManager } from '@/components/CommandsManager';
import { CompactionConfirmation } from '@/components/CompactionConfirmation';
import { CopySelector } from '@/components/CopySelector';
import { CreateSkillFlow } from '@/components/CreateSkillFlow';
import { DiagnosticsOverlay } from '@/components/DiagnosticsOverlay';
import { DroolsOverlay } from '@/components/drools/DroolsOverlay';
import {
  CopyQuickItem,
  CopySelectionKind,
  FileRestoreChoice,
} from '@/components/enums';
import { FileRestoreChoiceMenu } from '@/components/FileRestoreChoiceMenu';
import { FileRestoreMenu } from '@/components/FileRestoreMenu';
import { FolderTrustPrompt } from '@/components/FolderTrustPrompt';
import { FooterStatusRow } from '@/components/FooterStatusRow';
import { HelpPopup } from '@/components/HelpPopup';
import { HooksOverlay } from '@/components/hooks/HooksOverlay';
import { IdeExtensionConfirmation } from '@/components/IdeExtensionConfirmation';
import { IdeInstanceSelector } from '@/components/IdeInstanceSelector';
import { InlineModelCyclePicker } from '@/components/InlineModelCyclePicker';
import { InvalidApiKeyExit } from '@/components/InvalidApiKeyExit';
import { LoginList } from '@/components/LoginList';
import { LoopModal } from '@/components/LoopModal';
import { McpManager } from '@/components/McpManager';
import { MessageList } from '@/components/MessageList';
import {
  MissionControlOverlay,
  type MissionControlOverlayRef,
} from '@/components/mission-control';
import { MissionModelTarget } from '@/components/mission-control/enums';
import { MissionOnboardingModal } from '@/components/MissionOnboardingModal';
import { MissionsList } from '@/components/MissionsList';
import { ModelSelector } from '@/components/ModelSelector';
import { OrganizationOnboardingRedirect } from '@/components/OrganizationOnboardingRedirect';
import { PendingMessagesList } from '@/components/PendingMessagesList';
import { PinnedTodoDisplay } from '@/components/PinnedTodoDisplay';
import { PluginOverlay } from '@/components/plugin/PluginOverlay';
import { ReasoningEffortSelector } from '@/components/ReasoningEffortSelector';
import { ReviewPresetType, ReviewStep } from '@/components/review/enums';
import { ReviewOverlay } from '@/components/review/ReviewOverlay';
import { RewindMenu } from '@/components/RewindMenu';
import { ApprovalDetailsScreen } from '@/components/screens/ApprovalDetailsScreen';
import { ChatScreen } from '@/components/screens/ChatScreen';
import { MissionControlScreen } from '@/components/screens/MissionControlScreen';
import { TranscriptScreen } from '@/components/screens/TranscriptScreen';
import { SessionList } from '@/components/SessionList';
import { SessionSpecModeModelConfigurator } from '@/components/SessionSpecModeModelConfigurator';
import { SettingsList } from '@/components/SettingsList';
import { SetupIncidentResponseFlow } from '@/components/SetupIncidentResponseFlow/SetupIncidentResponseFlow';
import { SkillsOverlay } from '@/components/skills/SkillsOverlay';
import { Spinner } from '@/components/Spinner';
import { SquadModeOverlay } from '@/components/squad/SquadModeOverlay';
import type { SquadModeOverlayRef } from '@/components/squad/types';
import { StaticDetailedTranscriptPanel } from '@/components/StaticDetailedTranscriptPanel';
import { resetHeaderShown } from '@/components/StaticMessageList';
import { StatusLine } from '@/components/StatusLine';
import { ThemeSelector } from '@/components/ThemeSelector';
import type {
  CopySelectorSelection,
  TimerPersistentState,
  RewindOption,
  SpecModeModelConfiguratorRef,
} from '@/components/types';
import { UsageLimitsPanel } from '@/components/UsageLimitsPanel';
import {
  filterMainChatMessages,
  useUiMessages,
} from '@/components/useUiMessages';
import { VSCodeExtensionPrompt } from '@/components/VSCodeExtensionPrompt';
import { KeypressLayer } from '@/contexts/enums';
import { useKeypressProvider } from '@/contexts/KeypressProvider';
import type { KeyEvent } from '@/contexts/types';
import { getRuntimeAuthConfig } from '@/environment';
import { useFeatureFlagValue } from '@/feature-flags/hooks';
import { EXEC_SYSTEM_PROMPT, SYSTEM_PROMPT } from '@/hooks/constants';
import {
  AgentStatusState,
  AuthStatus,
  HookEventName,
  IdeConnectionStatus,
  MessageRole,
  MessageType,
} from '@/hooks/enums';
import { createSkillSession } from '@/hooks/skill-creation/createSkillSession';
import { createSpecHandoffSession } from '@/hooks/spec-mode/createSpecImplementationSession';
import type {
  HistoryMessage,
  QueuedUserMessage,
  ToolExecution,
  UiMessageOptions,
} from '@/hooks/types';
import { useAgentSession } from '@/hooks/useAgentSession';
import { useAuthentication } from '@/hooks/useAuthentication';
import { useBashMode, formatBashCommandMessage } from '@/hooks/useBashMode';
import { useBlockingOverlay } from '@/hooks/useBlockingOverlay/useBlockingOverlay';
import { useBtwEntries } from '@/hooks/useBtwEntries';
import { useCliScreenController } from '@/hooks/useCliScreenController';
import { useDaemonAgent } from '@/hooks/useDaemonAgent';
import { useDaemonMcp } from '@/hooks/useDaemonMcp';
import { useDiagnosticsMenu } from '@/hooks/useDiagnosticsMenu';
import { useDroolsMenu } from '@/hooks/useDroolsMenu';
import { useHooksManager } from '@/hooks/useHooksManager';
import { useIdeContext } from '@/hooks/useIdeContext';
import { useMcpAuthNotices } from '@/hooks/useMcpAuthNotices';
import { useMissionDefaultModelSettings } from '@/hooks/useMissionDefaultModelSettings';
import { useMountEffect } from '@/hooks/useMountEffect';
import { usePendingAskUser } from '@/hooks/usePendingAskUser';
import { usePendingStoreDefaults } from '@/hooks/usePendingStoreDefaults';
import { usePluginMenu } from '@/hooks/usePluginMenu';
import { usePrIndicator } from '@/hooks/usePrIndicator';
import { useReviewManager } from '@/hooks/useReviewManager';
import { useSessionConversationEmpty } from '@/hooks/useSessionConversationEmpty';
import { useSessionMessages } from '@/hooks/useSessionMessages';
import { useSessionQueuedMessages } from '@/hooks/useSessionQueuedMessages';
import {
  useDefaultSessionSettings,
  useSessionSettings,
} from '@/hooks/useSessionSettings';
import { useSessionTodos } from '@/hooks/useSessionTodos';
import { useSessionTokenUsage } from '@/hooks/useSessionTokenUsage';
import { useSessionWorkingState } from '@/hooks/useSessionWorkingState';
import { useSkillsMenu } from '@/hooks/useSkillsMenu';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import { useTerminalResizing } from '@/hooks/useTerminalResizing';
import { useTerminalTabTitle } from '@/hooks/useTerminalTabTitle';
import { useVSCodeExtension } from '@/hooks/useVSCodeExtension';
import { getI18n } from '@/i18n';
import { invalidApiKeyMessage } from '@/i18n/authMessages';
import { matchKeyboardChord } from '@/keyboard/keyboardChords';
import { useAvailableModels } from '@/models/availability';
import {
  getModelDefaultReasoningEffort,
  getReasoningEffortDisplayName,
  getTuiModelConfig,
} from '@/models/config';
import { ProfiledRegion } from '@/profiling/ProfiledRegion';
import { ProfilerOverlay } from '@/profiling/ProfilerOverlay';
import {
  resolveAskUserAnswers,
  rejectAskUserAnswers,
} from '@/services/AskUserAnswerStore';
import { listLocalAutomations } from '@/services/automations/automationActions';
import { fetchBanners } from '@/services/BannerService';
import {
  disposeBtwManager,
  getBtwManager,
  type BtwManager,
} from '@/services/btw/BtwManager';
import {
  dismissChangelog,
  getChangelog,
  isChangelogDismissed,
  restoreChangelog,
} from '@/services/ChangelogService';
import { getConversationStateManager } from '@/services/ConversationStateManager';
import { isUserVisibleCron } from '@/services/crons/format';
import { createScheduledTaskLeaveWarningGate } from '@/services/crons/leaveWarning';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getEditorService } from '@/services/EditorService';
import {
  PrStatus,
  TokenLimitAction,
  VSCodeExtensionStatus,
} from '@/services/enums';
import { getFolderTrustService } from '@/services/FolderTrustService';
import { convertAutonomyModeToPermissionMode } from '@/services/hook-utils';
import { getHookService } from '@/services/HookService';
import { IdeContextManager } from '@/services/IdeContextManager';
import {
  assertMissionEntryAllowed,
  enterMissionMode,
} from '@/services/mission/enterMissionMode';
import { gracefulMissionExit } from '@/services/mission/gracefulMissionExit';
import { getMissionFileService } from '@/services/mission/MissionFileService';
import { resolveMissionSettingsSnapshot } from '@/services/mission/missionSettingsSnapshot';
import {
  getOrchestratorSystemPrompt,
  getWorkerSystemPrompt,
} from '@/services/mission/prompts';
import {
  getDecompSessionTypeFromTags,
  isMissionOrchestratorSession,
} from '@/services/mission/sessionTags';
import {
  MissionErrorType,
  type MissionMetadata,
} from '@/services/mission/types';
import { evaluateMissionReadinessForCwd } from '@/services/missionReadinessGate';
import { processTracker } from '@/services/ProcessTracker';
import { getSandboxService } from '@/services/SandboxService';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { getFileSnapshotService } from '@/services/snapshots/FileSnapshotService';
import {
  getSquadOrchestratorSystemPrompt,
  getSquadWorkerSystemPrompt,
} from '@/services/squad/prompts';
import { isSquadSession } from '@/services/squad/sessionTags';
import { ensureActiveSquadWakeupScheduler } from '@/services/squad/SquadWakeupScheduler';
import { getTerminalService } from '@/services/TerminalService';
import type { BannerContent, SessionMetadata } from '@/services/types';
import { SESSION_SELECTOR_MAX_OTHER_SESSIONS } from '@/session-selector/constants';
import { applyThemeSelection } from '@/theme/applyThemeChange';
import {
  BatchToolConfirmationDetails,
  ChatSubmitOptions,
  ImageAttachment,
  ToolExecution as UiToolExecution,
} from '@/types/types';
import { getAutonomyIndicatorColor } from '@/utils/autonomyIndicatorColor';
import { clearTerminal, getClearTerminalSequence } from '@/utils/clearTerminal';
import { copyToClipboard } from '@/utils/clipboard';
import {
  buildConversationTurns,
  countLines,
  findLastTextByRole,
  formatTurnRangeTranscript,
  getConversationHistoryForCopy,
} from '@/utils/conversationCopy';
import { displayWidth as getDisplayWidth } from '@/utils/displayWidth';
import { escapeUserMessageSystemTags } from '@/utils/escapeUserMessageSystemTags';
import { saveSpecFile } from '@/utils/industryPaths';
import { clearInkOutput, refreshInkStaticOutput } from '@/utils/inkRendering';
import {
  restoreInteractiveTerminalState,
  restoreShellTerminalState,
} from '@/utils/interactiveTerminalState';
import { interruptRunningDaemonSessionForExit } from '@/utils/interruptRunningDaemonSessionForExit';
import { isWindowsLike } from '@/utils/isWsl';
import { loadConversationHistory } from '@/utils/loadConversationHistory';
import {
  shouldArmLocalPausedAutoDrain,
  shouldAutoDrainLocalPausedMessage,
  shouldQueueBehindLocalPausedMessages,
  shouldRestoreLocalPausedQueuedHeadAfterInterrupt,
} from '@/utils/localPausedQueueRestore';
import {
  enterMissionControlInkIsolation,
  exitMissionControlInkIsolation,
} from '@/utils/missionControlInkIsolation';
import {
  calculateNextReasoningEffort,
  getDeprecatedModelNotice,
  getExpensiveModelNotice,
  isLastMessageText,
  resolveActiveModel,
} from '@/utils/modelUtils';
import { getEnabledQueuePlacement } from '@/utils/queuedMessagesFeatureFlag';
import {
  buildQueuedPromptContent,
  extractQueuedPromptContent,
} from '@/utils/queuedPromptContent';
import { loadRewindHistory } from '@/utils/rewindHistory';
import {
  shouldShowInvokingToolsStatus,
  shouldShowPendingSpecEditConfirmationStatus,
  shouldShowReviewingSpecChangesStatus,
} from '@/utils/shouldShowInvokingToolsStatus';
import { getCliRuntimeMetricLabels } from '@/utils/startupLatency';
import { getStatusBannerHint } from '@/utils/statusBannerHint';
import {
  renderTerminalLine,
  renderTwoSidedTerminalRow,
  textSegment,
} from '@/utils/terminalSegments';
import type { TerminalSegment } from '@/utils/terminalSegments/types';
import { TranscriptAnchorMode } from '@/utils/transcriptTurnNavigation/enums';
import {
  buildTurnAnchors,
  resolveNextAnchor,
  resolvePreviousAnchor,
} from '@/utils/transcriptTurnNavigation/transcriptTurnNavigation';
import { resolveTuiSpinnerStatusBanner } from '@/utils/tuiSpinner/status';
import type { ConversationTurn } from '@/utils/types';
import { generateUUID } from '@/utils/uuid';

import type { AutomationEntry, CronRecord } from '@industry/common/daemon';
import type { MissionModelSettings, Settings } from '@industry/common/settings';
import type { MissionReadinessGateResult } from '@industry/utils/agentReadiness';

const REWIND_PREVIEW_LENGTH = 90;

// Vertical space consumed by UI elements surrounding HelpPopup (status bar, input area, margins).
const HELP_POPUP_HEIGHT_OFFSET = 8;
// Minimum height passed to HelpPopup (matches WIDE_MINIMAL in HelpPopup.tsx).
const HELP_POPUP_MIN_HEIGHT = 20;
const LOCAL_DEFERRED_QUEUE_DRAIN_DELAY_MS = 100;
const MCP_OAUTH_RECONNECTION_BANNER_TITLE = 'MCP OAuth reconnection required';
const MCP_OAUTH_RECONNECTION_BANNER_BODY =
  'We re-architected MCP OAuth to increase stability. Please re-authenticate your MCP OAuth servers via /mcp.';

function getStartupMcpOAuthDataFilePath(): string {
  return path.join(
    getIndustryHome(),
    getIndustryDirName(),
    MCP_OAUTH_FILE_DATA_FILE_NAME
  );
}

function getStartupMcpConfigFilePaths(): string[] {
  const userIndustryDir = path.join(getIndustryHome(), getIndustryDirName());
  const projectRoot = findGitRoot(process.cwd()) ?? process.cwd();

  return [
    path.join(userIndustryDir, 'mcp.json'),
    path.join(projectRoot, '.industry', 'mcp.json'),
  ];
}

function shouldShowStartupMcpOAuthReconnectionBanner(): boolean {
  try {
    return (
      getMcpOAuthReconnectionBannerStatusSync({
        oauthDataFilePath: getStartupMcpOAuthDataFilePath(),
        mcpConfigFilePaths: getStartupMcpConfigFilePaths(),
      }).shouldShow && !getSettingsService().getReauthBannerShownTui()
    );
  } catch (error) {
    logWarn('[App] Failed to resolve initial MCP OAuth reconnection banner', {
      cause: error,
    });
    return false;
  }
}

function extractTextFromLLMMessage(message: IndustryDroolMessage): string {
  const { content } = message;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
        return '';
      })
      .filter((text) => text && text.trim().length > 0)
      .join('\n');
  }

  return '';
}

function stripSystemReminderBlocks(text: string): string {
  if (!text) {
    return text;
  }

  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
}

function createRewindPreview(text: string): string {
  const withoutReminders = stripSystemReminderBlocks(text);
  const normalized = withoutReminders.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return '';
  }
  if (normalized.length <= REWIND_PREVIEW_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, REWIND_PREVIEW_LENGTH - 1)}…`;
}

/**
 * Format a model display string with optional reasoning effort.
 * @param modelId The model ID to format
 * @param reasoningEffort Optional reasoning effort level to include
 * @returns Formatted string like "Sonnet 4.5" or "Sonnet 4.5 with High reasoning"
 */
function formatModelDisplay(
  modelId: string,
  reasoningEffort?: ReasoningEffort | null
): string {
  const config = getTuiModelConfig(modelId);
  const modelName = config.shortDisplayName || config.displayName;

  if (reasoningEffort && reasoningEffort !== ReasoningEffort.None) {
    const reasoningName = getReasoningEffortDisplayName(reasoningEffort);
    return `${modelName} with ${reasoningName} reasoning`;
  }

  return modelName;
}

function formatCompactModelLabel(
  modelId: string,
  reasoningEffort?: ReasoningEffort | null
): string {
  const cfg = getTuiModelConfig(modelId);
  const baseName = cfg.shortDisplayName || cfg.displayName || String(modelId);
  const supportedEfforts = cfg.supportedReasoningEfforts || [];

  let formattedReasoning = '';
  if (
    reasoningEffort &&
    reasoningEffort !== ReasoningEffort.None &&
    supportedEfforts.includes(reasoningEffort)
  ) {
    const reasoningDisplay = getReasoningEffortDisplayName(reasoningEffort);
    if (
      reasoningDisplay !== 'Reasoning disabled' &&
      reasoningDisplay !== 'Dynamic'
    ) {
      formattedReasoning = ` (${reasoningDisplay})`;
    }
  }

  return `${baseName}${formattedReasoning}`;
}

function areSessionListsEquivalent(
  current: SessionMetadata[],
  next: SessionMetadata[]
): boolean {
  if (current.length !== next.length) {
    return false;
  }

  return current.every((session, index) => {
    const nextSession = next[index];
    if (!nextSession) {
      return false;
    }

    return (
      session.id === nextSession.id &&
      session.title === nextSession.title &&
      session.sessionTitle === nextSession.sessionTitle &&
      session.owner === nextSession.owner &&
      session.messageCount === nextSession.messageCount &&
      session.modifiedTime.getTime() === nextSession.modifiedTime.getTime() &&
      session.createdTime.getTime() === nextSession.createdTime.getTime() &&
      session.isFavorite === nextSession.isFavorite &&
      session.cwd === nextSession.cwd &&
      session.isCurrentProject === nextSession.isCurrentProject &&
      session.isExec === nextSession.isExec &&
      session.decompSessionType === nextSession.decompSessionType &&
      session.decompMissionId === nextSession.decompMissionId
    );
  });
}

type AlternateScreenOwner = 'missionControl' | 'squadMode' | null;

interface StickyProposalPermissionState {
  sessionId: string | null | undefined;
  toolIds: Set<string>;
  toolInputsById: Map<string, Record<string, unknown>>;
}

function shouldKeepPermissionToolStaticAfterResolution(
  confirmationType: ToolConfirmationType
): boolean {
  return (
    confirmationType === ToolConfirmationType.ExitSpecMode ||
    confirmationType === ToolConfirmationType.ProposeMission
  );
}

function resetStickyProposalPermissionState(
  state: StickyProposalPermissionState,
  sessionId: string | null | undefined
): void {
  state.sessionId = sessionId;
  state.toolIds = new Set();
  state.toolInputsById = new Map();
}

function updateStickyProposalPermissionState(
  state: StickyProposalPermissionState,
  sessionId: string | null | undefined,
  pendingConfirmation: BatchToolConfirmationDetails | null
): void {
  if (state.sessionId !== sessionId) {
    resetStickyProposalPermissionState(state, sessionId);
  }

  if (!pendingConfirmation) {
    return;
  }

  for (const tool of pendingConfirmation.tools) {
    if (!shouldKeepPermissionToolStaticAfterResolution(tool.confirmationType)) {
      continue;
    }

    state.toolIds.add(tool.toolUseId);
    state.toolInputsById.set(
      tool.toolUseId,
      getPermissionToolInputForDisplay(tool)
    );
  }
}

interface AppContentProps {
  initialPrompt?: string;
  resumeSessionId?: string;
  originalCwd?: string;
  daemonStartupFailed?: boolean;
  setAlternateScreenOwner: (owner: AlternateScreenOwner) => void;
}

type InkStdoutContext = ReturnType<typeof useStdout> & {
  invalidateOutput?: (resetStaticOutput?: boolean) => void;
};

function AppContent({
  initialPrompt,
  resumeSessionId,
  originalCwd,
  daemonStartupFailed,
  setAlternateScreenOwner,
}: AppContentProps) {
  // Get Ink's exit function for graceful unmount
  const { exit: appExit } = useApp();
  const { stdin, setRawMode } = useStdin();
  const isQueuedMessagesEnabled = useFeatureFlagValue(
    IndustryFeatureFlags.CliQueuedMessages
  );

  // Persistent timer state -- survives footer unmount/remount
  // (e.g. Ctrl+O transcript toggle) without writing to SessionService.
  const timerStateRef = useRef<TimerPersistentState>({
    activeStart: null,
    sessionId: null,
    accumulatedTimeMs: null,
  });

  // TUI suspension state - hides TUI when external editor is open
  const [isTUISuspended, setIsTUISuspended] = useState(false);

  // Banner content fetched from S3
  const [bannerContent, setBannerContent] = useState<BannerContent>({
    header: null,
    footer: null,
  });
  const [showMcpOAuthReconnectionBanner, setShowMcpOAuthReconnectionBanner] =
    useState(shouldShowStartupMcpOAuthReconnectionBanner);
  useEffect(() => {
    void fetchBanners().then(setBannerContent);
  }, []);
  useEffect(() => {
    let isMounted = true;
    const bannerShownThisLaunch = showMcpOAuthReconnectionBanner;
    if (
      bannerShownThisLaunch &&
      !getSettingsService().getReauthBannerShownTui()
    ) {
      getSettingsService().setReauthBannerShownTui(true);
    }
    void getMcpOAuthReconnectionBannerStatus({
      oauthDataFilePath: getStartupMcpOAuthDataFilePath(),
      mcpConfigFilePaths: getStartupMcpConfigFilePaths(),
    })
      .then((status) => {
        if (!isMounted) {
          return;
        }
        const shouldShow =
          status.shouldShow &&
          (bannerShownThisLaunch ||
            !getSettingsService().getReauthBannerShownTui());
        setShowMcpOAuthReconnectionBanner(shouldShow);
        if (shouldShow) {
          getSettingsService().setReauthBannerShownTui(true);
        }
      })
      .catch((error) => {
        logWarn('[App] Failed to resolve MCP OAuth reconnection banner', {
          cause: error,
        });
      });
    return () => {
      isMounted = false;
    };
  }, []);

  // Static refresh key for re-rendering messages
  const [staticKey, setStaticKey] = useState(0);
  const [, setSessionBindingTick] = useState(0);

  // Transcript static key (used when showing detailed transcript view)
  const [transcriptStaticKey, setTranscriptStaticKey] = useState(0);

  // Track first render to skip clearing terminal on mount
  const isFirstRenderRef = useRef(true);

  // Core conversation state management
  // Handles message history, tool calls, and conversation lifecycle

  // MCP (Model Context Protocol) server connection status
  // Status is derived from daemon notifications — the daemon owns the MCPService.
  const { status: mcpStatus, retry: _retryMcp } = useDaemonMcp();

  // Reflect session title updates from the daemon in the terminal tab title.
  useTerminalTabTitle();

  // PR and Sandbox status for footer indicator visibility
  const prState = usePrIndicator();
  const sandboxEnabled = getSandboxService().isEnabled();
  const mcpVisible =
    mcpStatus !== McpStatus.NoServers && mcpStatus !== McpStatus.NotInitialized;

  // IDE integration state (VS Code, Cursor, etc.)
  // Provides context about selected files and text for enhanced assistance
  const {
    state: ideState,
    getSelectedLineCount,
    hasSelection,
    ideClient,
    refreshClientFromManager,
    setConnectionStatus,
  } = useIdeContext();

  // UI state for help hints
  const [showHelpHints, setShowHelpHints] = useState(false);
  const [commandMenuVisible, setCommandMenuVisible] = useState(false);

  // Session settings are read after activeSessionId is available (below).
  // Declared here for scope visibility; assigned after useAgentSession().

  // Bash mode functionality for executing shell commands
  const { bashMode, toggleBashMode, executeBashCommand, cancelBashCommand } =
    useBashMode();

  const AUTONOMY_INDICATOR_COLOR = getAutonomyIndicatorColor();

  // UI overlay states - these control which modal/selector is currently shown
  // Session selection for switching between conversation histories
  const [sessionSelectorData, setSessionSelectorData] = useState<
    SessionMetadata[] | null
  >(null);
  const [sessionListMode, setSessionListMode] = useState<
    'browse' | 'rename' | 'archive-confirm'
  >('browse');
  const [rewindOptions, setRewindOptions] = useState<RewindOption[] | null>(
    null
  );
  const [isRewindProcessing, setIsRewindProcessing] = useState(false);
  const [fileRestoreData, setFileRestoreData] = useState<{
    snapshotInfo: {
      availableFiles: Array<{
        filePath: string;
        contentHash: string;
        size: number;
      }>;
      createdFiles: Array<{ filePath: string }>;
      evictedFiles: Array<{ filePath: string; reason: string }>;
    };
    pendingRewind: RewindOption;
    showFileSelection: boolean; // true = show file picker, false = show choice menu
  } | null>(null);

  // Settings management overlay
  const [settingsSelectorData, setSettingsSelectorData] =
    useState<Settings | null>(null);

  // /copy selector overlay data (captured when the user runs /copy so we don't
  // need to recompute turns on every render)
  const [copySelectorData, setCopySelectorData] = useState<{
    turns: ConversationTurn[];
    hasLastAssistant: boolean;
    hasLastUser: boolean;
    hasSessionId: boolean;
    sessionId: string | null;
  } | null>(null);

  // Theme selector overlay
  const [showThemeSelector, setShowThemeSelector] = useState(false);

  // Custom slash commands manager
  const [showCommandsManager, setShowCommandsManager] = useState(false);

  // Loop / local automations setup-control overlay (one shared slot)
  const [schedulingOverlay, setSchedulingOverlay] = useState<
    'none' | 'loops' | 'automations'
  >('none');

  // MCP manager overlay
  const [showMcpManager, setShowMcpManager] = useState(false);

  // Mid-session folder trust prompt (e.g. /cwd into an untrusted folder).
  // When set, the trust prompt renders as a full-screen takeover; resolving
  // or cancelling settles the pending requestFolderTrust() promise via the
  // stored resolver.
  const [cwdTrustPrompt, setCwdTrustPrompt] = useState<{
    targetPath: string;
    resolve: (trusted: boolean) => void;
  } | null>(null);

  // Background process manager overlay
  const [showBgProcessManager, setShowBgProcessManager] = useState(false);
  const [bgTasksPanelFocused, setBgTasksPanelFocused] = useState(false);

  const missionControlRef = useRef<MissionControlOverlayRef>(null);

  // Squad Mode overlay
  const [showSquadMode, setShowSquadMode] = useState(false);
  const showSquadModeRef = useRef(false);
  const squadModeRef = useRef<SquadModeOverlayRef>(null);
  const [pendingSquadModeExit, setPendingSquadModeExit] = useState(false);

  // Ink-safe stdout writer. We use this for alternate-screen transitions so Ink stays
  // in sync with the terminal when the screen buffer changes.
  const {
    stdout,
    write: writeToStdout,
    invalidateOutput,
  } = useStdout() as InkStdoutContext;
  const clearTerminalSeq = useMemo(() => getClearTerminalSequence(), []);
  const clearInkTerminal = useCallback(() => {
    clearInkOutput({
      clearTerminalSequence: clearTerminalSeq,
      writeToStdout,
      invalidateOutput,
    });
  }, [clearTerminalSeq, invalidateOutput, writeToStdout]);
  // Clear for transitions between rendering surfaces that cannot safely diff
  // against the previous frame (Static takeovers, dynamic-only transcript
  // scroll). Also drops Ink's accumulated Static bookkeeping so tall-frame
  // redraws don't replay the previous surface's output on top of the new one.
  const clearInkTerminalForSurfaceHandoff = useCallback(() => {
    clearInkOutput({
      clearTerminalSequence: clearTerminalSeq,
      writeToStdout,
      invalidateOutput,
      resetStaticOutput: true,
    });
  }, [clearTerminalSeq, invalidateOutput, writeToStdout]);
  const {
    approvalDetailsRequestKey,
    isApprovalDetailsScreen: showApprovalDetails,
    isMissionControlScreen: showMissionControl,
    isTranscriptScreen: showDetailedTranscript,
    isRestoredChatBuffer: showRestoredChatBuffer,
    missionControlScreenRef: showMissionControlRef,
    pendingMissionControlExit,
    openTranscript,
    closeTranscript,
    openApprovalDetails,
    closeApprovalDetails,
    openMissionControl,
    closeMissionControl,
    unfreezeRestoredChat,
  } = useCliScreenController({
    stdout,
    writeToStdout,
  });
  const handleInteractivePromptPending = useCallback(() => {
    if (showMissionControlRef.current) {
      closeMissionControl();
    }
  }, [closeMissionControl, showMissionControlRef]);
  const setShowDetailedTranscript = useCallback(
    (show: boolean) => {
      if (show) {
        openTranscript();
        return;
      }
      closeTranscript();
    },
    [closeTranscript, openTranscript]
  );

  const openSquadMode = useCallback(() => {
    setPendingSquadModeExit(false);
    getConversationStateManager().setUiUpdatesSuspended(true);
    showSquadModeRef.current = true;
    setShowSquadMode(true);
    stdout.write(ANSI.ENTER_ALTERNATE_SCREEN + clearTerminalSeq);
  }, [clearTerminalSeq, stdout]);

  const closeSquadMode = useCallback(() => {
    setPendingSquadModeExit(true);
    setShowSquadMode(false);
    getConversationStateManager().setUiUpdatesSuspended(false);
  }, []);

  useEffect(() => {
    if (!pendingSquadModeExit) {
      return;
    }
    if (showSquadMode) {
      return;
    }

    writeToStdout(ANSI.EXIT_ALTERNATE_SCREEN + clearTerminalSeq);
    showSquadModeRef.current = false;
    setPendingSquadModeExit(false);
  }, [pendingSquadModeExit, showSquadMode, clearTerminalSeq, writeToStdout]);

  useEffect(() => {
    if (showSquadMode || pendingSquadModeExit) {
      setAlternateScreenOwner('squadMode');
      return;
    }
    if (showMissionControl || pendingMissionControlExit) {
      setAlternateScreenOwner('missionControl');
      return;
    }
    setAlternateScreenOwner(null);
  }, [
    pendingMissionControlExit,
    pendingSquadModeExit,
    setAlternateScreenOwner,
    showMissionControl,
    showSquadMode,
  ]);

  useEffect(
    () => () => {
      setAlternateScreenOwner(null);
    },
    [setAlternateScreenOwner]
  );

  // Missions menu overlay (for /missions command)
  const [missionsMenuData, setMissionsMenuData] = useState<{
    missions: MissionMetadata[];
    currentMissionId: string | null;
  } | null>(null);
  const [isMissionResumeInProgress, setIsMissionResumeInProgress] =
    useState(false);

  // Model selection overlay
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [showInlineModelPicker, setShowInlineModelPicker] = useState(false);
  const [showMissionModelSelector, setShowMissionModelSelector] =
    useState(false);
  const [pendingMissionModelTarget, setPendingMissionModelTarget] =
    useState<MissionModelTarget | null>(null);
  const [pendingMissionModel, setPendingMissionModel] = useState<string | null>(
    null
  );
  const returnToMissionModelSelectorRef = useRef(false);
  const missionModelTabRef = useRef<'orchestrator' | 'worker' | 'validator'>(
    'orchestrator'
  );
  const [_showSpecModeOption, setShowSpecModeOption] = useState(false);
  // Spec mode model configurator overlay
  const [showSpecModeConfigurator, setShowSpecModeConfigurator] =
    useState(false);
  const specModeConfiguratorRef = useRef<SpecModeModelConfiguratorRef>(null);
  const compactionAbortRef = useRef<AbortController | null>(null);

  // Conversation compaction state - for summarizing long conversations
  const [showCompactConfirm, setShowCompactConfirm] = useState(false);
  const [isCompactProcessing, setIsCompactProcessing] = useState(false);
  const manualCompactionQueueSessionIdRef = useRef<string | null>(null);
  const [compressionInstructions, setCompressionInstructions] = useState<
    string | undefined
  >(undefined);

  // Create skill state - for creating skills from current session
  const [showCreateSkillFlow, setShowCreateSkillFlow] = useState(false);
  const [createSkillDraft, setCreateSkillDraft] = useState('');

  // Setup incident response wizard state (slash command /setup-incident-response)
  const [showSetupIncidentResponseFlow, setShowSetupIncidentResponseFlow] =
    useState(false);

  // Detailed transcript snapshot state (Ctrl+O)
  const [detailedTranscriptMessages, setDetailedTranscriptMessages] = useState<
    Array<HistoryMessage | UiToolExecution>
  >([]);

  // Chat-view transcript scroll state (Alt+Up/Down, Alt+PgUp/PgDn).
  // When active, the chat view replaces the live MessageList with a bounded
  // slice anchored at a specific user/assistant turn. The index is into the
  // current `uiMessages` array; -1 means "no anchor selected" (inactive).
  const [transcriptAnchorIndex, setTranscriptAnchorIndex] =
    useState<number>(-1);
  const [transcriptAnchorMode, setTranscriptAnchorMode] =
    useState<TranscriptAnchorMode>(TranscriptAnchorMode.Any);

  // Helper to reset compression state
  const resetCompressionState = useCallback(() => {
    setShowCompactConfirm(false);
    setCompressionInstructions(undefined);
  }, []);

  const clearManualCompactionProcessingState = useCallback(() => {
    manualCompactionQueueSessionIdRef.current = null;
    setIsCompactProcessing(false);
  }, []);

  // Helper to reset create skill state
  const resetCreateSkillState = useCallback(() => {
    setShowCreateSkillFlow(false);
    setCreateSkillDraft('');
  }, []);

  // Reasoning effort selector state (standalone)
  const [showReasoningEffortSelector, setShowReasoningEffortSelector] =
    useState(false);
  // Track pending model selection for reasoning effort flow
  const [pendingModelSelection, setPendingModelSelection] = useState<
    string | null
  >(null);
  // Track pending spec model selection for reasoning effort flow
  const [pendingSpecModelSelection, setPendingSpecModelSelection] = useState<
    string | null
  >(null);

  // Login selector state
  const [showLoginSelector, setShowLoginSelector] = useState(false);

  // IDE extension prompt state
  const [ideExtensionPromptState, setIdeExtensionPromptState] = useState<{
    show: boolean;
    isUpdate: boolean;
  }>({ show: false, isUpdate: false });

  // IDE instance selector state
  const [ideInstanceSelectorState, setIdeInstanceSelectorState] = useState<{
    show: boolean;
    initialConnectedInstance?: { ideName: string; workspace: string };
    onDisconnect?: () => Promise<void>;
  }>({ show: false });

  // Mission onboarding modal state
  const [showMissionOnboarding, setShowMissionOnboarding] = useState(false);
  // True when the onboarding modal is gating a NEW mission entry (vs. the
  // first-time onboarding shown for a resumed orchestrator session). Drives
  // whether confirming the modal should actually convert the session.
  const [pendingMissionEntry, setPendingMissionEntry] = useState(false);
  const [missionGateEvaluating, setMissionGateEvaluating] = useState(false);
  const [missionGate, setMissionGate] =
    useState<MissionReadinessGateResult | null>(null);

  // Diagnostics menu state
  const diagnosticsMenu = useDiagnosticsMenu();
  // Drools menu state (moved to hook)
  const droolsMenu = useDroolsMenu();
  // Skills menu state
  const skillsMenu = useSkillsMenu();
  // Plugin menu state (unified UI for plugins and marketplaces)
  const pluginMenu = usePluginMenu();
  // Hooks manager state
  const hooksManager = useHooksManager();
  // Review flow state
  const reviewManager = useReviewManager();
  // Pending AskUser requests (for parallel tool execution)
  const pendingAskUser = usePendingAskUser();
  const [askUserQuestionIndex, setAskUserQuestionIndex] = useState(0);
  const [askUserAnswerStates, setAskUserAnswerStates] = useState<
    Record<number, AskUserAnswerState>
  >({});

  // Reset AskUser state when the pending request changes
  const prevAskUserToolCallIdRef = useRef<string | null>(null);
  useEffect(() => {
    const currentId = pendingAskUser?.toolCallId ?? null;
    if (currentId !== prevAskUserToolCallIdRef.current) {
      prevAskUserToolCallIdRef.current = currentId;
      if (currentId !== null) {
        setAskUserQuestionIndex(0);
        setAskUserAnswerStates({});
      }
    }
  }, [pendingAskUser?.toolCallId]);

  // Chat input API ref (for interrupt behavior)
  const chatInputApiRef = useRef<ChatInputApi | null>(null);
  const chatDraftRef = useRef('');
  const chatCursorPositionRef = useRef(0);
  const [queuedReviewActive, setQueuedReviewActive] = useState(false);
  const [selectedQueuedMessageIndex, setSelectedQueuedMessageIndex] =
    useState(0);
  const queuedReviewResolvingRef = useRef(false);
  const restoredQueuedHeadTextRef = useRef<string | null>(null);

  const setChatInputValue = useCallback(
    (value: string, options?: { updateInput?: boolean }) => {
      chatDraftRef.current = value;
      if (options?.updateInput === false) {
        return;
      }
      chatInputApiRef.current?.setInput?.(value);
    },
    []
  );

  const setChatInputTextFromDaemon = useCallback(
    (
      value: string,
      options?: {
        fromQueuedDiscard?: boolean;
        requestId?: string;
        sessionId?: string;
      }
    ) => {
      if (options?.fromQueuedDiscard) {
        let textToRestore = value;
        let imagesToRestore: ImageAttachment[] | undefined;
        if (options.requestId && options.sessionId) {
          const manager = getTuiDaemonAdapter()
            .getSessionStateManager()
            .getSessionManager(options.sessionId);
          const queuedMessage = manager?.getQueuedMessage(options.requestId);
          if (queuedMessage) {
            const { text, images, files } = extractQueuedPromptContent(
              queuedMessage.content
            );
            if ((files?.length ?? 0) > 0) {
              restoredQueuedHeadTextRef.current = null;
              setQueuedReviewActive(true);
              return;
            }
            textToRestore = text;
            imagesToRestore = images;
            manager?.clearQueuedMessage(options.requestId);
          }
        }

        const restoredText = textToRestore.trim();
        restoredQueuedHeadTextRef.current = restoredText || null;
        setChatInputValue(textToRestore);
        if ((imagesToRestore?.length ?? 0) > 0) {
          chatInputApiRef.current?.setImages(imagesToRestore ?? []);
        }
        return;
      }
      setChatInputValue(value);
    },
    [setChatInputValue]
  );

  const initialPromptSubmittedRef = useRef(false);

  // Use unified agent session hook for session state management
  const {
    sessionId: activeSessionId,
    settings: _sessionSettings,
    workingState: _workingState,
    setWorkingState: _setWorkingState,
    switchModel,
    switchSpecModeModel,
    loadSession: loadSessionViaController,
    createSession: createSessionViaController,
  } = useAgentSession();

  // ── SSM-backed state hooks ──
  // Read messages, working state, and settings directly from the daemon's
  // SessionStateManager via useSyncExternalStore.
  //
  // effectiveSessionId falls back to the SessionService's pre-created
  // session ID so that ephemeral system messages (e.g. /rewind on an
  // empty session) can be rendered before the daemon session is created.
  const effectiveSessionId =
    activeSessionId ?? getSessionService().getCurrentSessionId();
  const sessionMessages = useSessionMessages(effectiveSessionId);
  const sessionStatus = useSessionWorkingState(effectiveSessionId);
  const [scheduledTasks, setScheduledTasks] = useState<CronRecord[]>([]);
  const [cronHistory, setCronHistory] = useState<CronRecord[]>([]);
  const [automations, setAutomations] = useState<AutomationEntry[]>([]);
  const [automationsLoading, setAutomationsLoading] = useState(false);
  const refreshAutomations = useCallback(() => {
    setAutomationsLoading(true);
    void listLocalAutomations()
      .then(setAutomations)
      .catch((error) => {
        logWarn('[App] Failed to refresh local automations', { cause: error });
      })
      .finally(() => setAutomationsLoading(false));
  }, []);
  const scheduledTaskLeaveWarningGateRef = useRef<
    ReturnType<typeof createScheduledTaskLeaveWarningGate> | undefined
  >(undefined);
  const getScheduledTaskLeaveWarning =
    scheduledTaskLeaveWarningGateRef.current ??
    (scheduledTaskLeaveWarningGateRef.current =
      createScheduledTaskLeaveWarningGate());
  const sessionScheduledTasks = useMemo(
    () =>
      scheduledTasks.filter(
        (task) =>
          task.scope.type === 'session' &&
          task.scope.sessionId === effectiveSessionId
      ),
    [scheduledTasks, effectiveSessionId]
  );
  const scheduledTaskCount = sessionScheduledTasks.length;
  const ssmQueuedMessages = useSessionQueuedMessages(effectiveSessionId);
  const sessionTodos = useSessionTodos(effectiveSessionId);
  const sessionTokenUsage = useSessionTokenUsage(effectiveSessionId);
  const isConversationEmpty = useSessionConversationEmpty(effectiveSessionId);
  const restoredChatSnapshotRef = useRef<{
    sessionId: string | null | undefined;
    messageCount: number;
    lastMessageId: string | undefined;
  } | null>(null);

  // Track the latest session info via a ref so the snapshot effect below can
  // run only on Mission Control entry without re-firing on every message
  // update while MC is open.
  const latestSessionInfoRef = useRef({
    sessionId: effectiveSessionId,
    messageCount: sessionMessages.length,
    lastMessageId: sessionMessages.at(-1)?.id,
  });
  latestSessionInfoRef.current = {
    sessionId: effectiveSessionId,
    messageCount: sessionMessages.length,
    lastMessageId: sessionMessages.at(-1)?.id,
  };

  // Capture the snapshot once on entry into Mission Control. The terminal's
  // main buffer reflects chat content as of this moment; new messages that
  // stream in while MC is open land in SSM but are never painted to the main
  // buffer (we're in the alt-screen). On close we compare this snapshot to
  // the current SSM state to decide whether to force a React re-render of
  // the chat history via unfreezeRestoredChat.
  useEffect(() => {
    if (!showMissionControl) {
      return;
    }
    restoredChatSnapshotRef.current = { ...latestSessionInfoRef.current };
  }, [showMissionControl]);

  useEffect(() => {
    if (!showRestoredChatBuffer) {
      return;
    }
    const snapshot = restoredChatSnapshotRef.current;
    if (
      !snapshot ||
      snapshot.sessionId !== effectiveSessionId ||
      snapshot.messageCount !== sessionMessages.length ||
      snapshot.lastMessageId !== sessionMessages.at(-1)?.id
    ) {
      unfreezeRestoredChat();
    }
  }, [
    effectiveSessionId,
    sessionMessages,
    showRestoredChatBuffer,
    unfreezeRestoredChat,
  ]);

  // Counter to force systemPromptOverride re-evaluation when session type changes
  // (e.g., when upgrading to Mission mode without changing sessionId)
  const [sessionTypeVersion, setSessionTypeVersion] = useState(0);

  const _systemPromptOverride = useMemo(() => {
    const sessionService = getSessionService();
    const sessionTags = sessionService.getCurrentSessionTags();
    const sessionType = getDecompSessionTypeFromTags(sessionTags);
    const squadSession = isSquadSession(sessionTags);
    if (sessionType === DecompSessionType.Orchestrator) {
      return `${SYSTEM_PROMPT}\n\n${
        squadSession
          ? getSquadOrchestratorSystemPrompt()
          : getOrchestratorSystemPrompt()
      }`;
    }
    if (sessionType === DecompSessionType.Worker) {
      const missionId = sessionService.getDecompMissionId();
      const missionFileService = missionId
        ? getMissionFileService(missionId)
        : null;
      const missionDir = missionFileService?.getMissionDir();
      const feature =
        missionFileService?.getInProgressFeatureSync() ?? undefined;

      return `${EXEC_SYSTEM_PROMPT}\n\n${
        squadSession
          ? getSquadWorkerSystemPrompt()
          : getWorkerSystemPrompt(missionDir, feature)
      }`;
    }
    return undefined;
  }, [activeSessionId, sessionTypeVersion]);

  // Populate the pending store with resolved defaults from SessionService
  // before useSessionSettings reads from it. This ensures the status bar
  // shows correct model/autonomy values on the very first render.
  usePendingStoreDefaults(effectiveSessionId);

  // ── /btw side-question support ──
  // A hidden, lazy-created fork of the main session that answers side
  // questions without polluting the main transcript. The manager is
  // per-main-session and torn down on session change / clear.
  const [btwManager, setBtwManager] = useState<BtwManager | null>(null);
  const [btwScrollViewOpen, setBtwScrollViewOpen] = useState(false);
  // Ref mirrors btwManager so the submit handler can be a stable reference
  // even when consumed by downstream useCallbacks (e.g. processAndRun) that
  // do not list it in their dependency arrays. Without this, processAndRun
  // captures the initial null manager and /btw silently no-ops.
  const btwManagerRef = useRef<BtwManager | null>(null);
  useEffect(() => {
    if (!effectiveSessionId) {
      setBtwManager(null);
      btwManagerRef.current = null;
      return;
    }
    const manager = getBtwManager(effectiveSessionId);
    setBtwManager(manager);
    btwManagerRef.current = manager;
    return () => {
      setBtwManager((prev) => (prev === manager ? null : prev));
      if (btwManagerRef.current === manager) {
        btwManagerRef.current = null;
      }
      void disposeBtwManager(effectiveSessionId);
    };
  }, [effectiveSessionId]);
  const { entries: btwEntries } = useBtwEntries(btwManager);
  // Close the scroll view whenever the active session changes.
  useEffect(() => {
    setBtwScrollViewOpen(false);
  }, [effectiveSessionId]);
  const handleSubmitBtwQuestion = useCallback(
    async (question: string): Promise<void> => {
      const mgr = btwManagerRef.current;
      if (!mgr) return;
      await mgr.submit(question);
    },
    []
  );
  const handleShowBtwScrollView = useCallback(() => {
    setBtwScrollViewOpen(true);
  }, []);
  const handleDismissBtwScrollView = useCallback(() => {
    setBtwScrollViewOpen(false);
  }, []);

  const isCurrentSquadSession = useMemo(
    () => isSquadSession(getSessionService().getCurrentSessionTags()),
    [activeSessionId, sessionTypeVersion]
  );

  const {
    interactionMode,
    autonomyLevel,
    model: mainModel,
    reasoningEffort: mainReasoningEffort,
    specModeModel,
    specReasoningEffort,
    compactionThresholdCheckEnabled,
  } = useSessionSettings(effectiveSessionId);
  const {
    autonomyLevel: defaultAutonomyLevel,
    model: defaultModel,
    specModeModel: defaultSpecModeModel,
  } = useDefaultSessionSettings();
  const { missionSettings } = useSessionSettings(effectiveSessionId);
  const sessionMissionSettings = getSessionService().getMissionSettings();
  const effectiveMissionSettings = resolveMissionSettingsSnapshot(
    getSettingsService().getMissionModelSettings(),
    sessionMissionSettings || missionSettings
      ? {
          ...(sessionMissionSettings ?? {}),
          ...(missionSettings ?? {}),
        }
      : undefined
  );

  const missionWorkerModel = effectiveMissionSettings.workerModel;
  const missionWorkerReasoningEffort =
    effectiveMissionSettings.workerReasoningEffort;
  const missionValidatorModel = effectiveMissionSettings.validationWorkerModel;
  const missionValidatorReasoningEffort =
    effectiveMissionSettings.validationWorkerReasoningEffort;
  const missionDefaults = useMissionDefaultModelSettings();
  const updateMissionSessionSettings = useCallback(
    async (updates: MissionModelSettings) => {
      if (!effectiveSessionId) {
        return;
      }

      await getTuiDaemonAdapter().updateSessionSettings({
        sessionId: effectiveSessionId,
        missionSettings: updates,
      });
    },
    [effectiveSessionId]
  );

  // Add an ephemeral system message to the SSM so it appears in
  // sessionMessages at the correct chronological position. All messages
  // are rendered from sessionMessages alone (a single append-only array)
  // to avoid index shifting that breaks Ink's <Static>.
  const addEmphemeralSystemMessage = useCallback(
    (content: string, options?: UiMessageOptions & { sessionId?: string }) => {
      const adapter = getTuiDaemonAdapter();
      const ssm = adapter.getSessionStateManager();
      const appendMessage = (sessionId: string): string | undefined => {
        // Ensure a session manager exists — it may not yet if the daemon
        // session hasn't been initialised (e.g. /rewind before the first message).
        if (!ssm.getSessionManager(sessionId)) {
          ssm.markSessionLoading(sessionId, 'local');
          ssm.initializeSession(sessionId, []);
        }
        const mgr = ssm.getSessionManager(sessionId);
        if (mgr) {
          const id = `system-${generateUUID()}`;
          mgr.getStore().addMessage({
            role: ProtocolMessageRole.System,
            content: [{ type: MessageContentBlockType.Text, text: content }],
            id,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            visibility: options?.visibility ?? MessageVisibility.UserOnly,
            ...(options?.messageType
              ? { messageType: options.messageType }
              : {}),
          } as IndustryDroolMessage & {
            messageType?: MessageType;
          });
          return id;
        }
      };

      const sessionId =
        options?.sessionId ?? getSessionService().getCurrentSessionId();
      if (sessionId) {
        return appendMessage(sessionId);
      }

      void getSessionService()
        .ensureCurrentSession()
        .then((createdSessionId) => {
          appendMessage(createdSessionId);
          setSessionBindingTick((tick) => tick + 1);
        })
        .catch((error) =>
          logException(
            error,
            '[App] Failed to create session for system message'
          )
        );
    },
    []
  );

  useMcpAuthNotices();

  const confirmScheduledTaskLeave = useCallback(
    (options: {
      actionKey: string;
      repeatInstruction: string;
      targetSessionId?: string;
      taskCount?: number;
    }): boolean => {
      const warning = getScheduledTaskLeaveWarning({
        currentSessionId: getSessionService().getCurrentSessionId(),
        taskCount: options.taskCount ?? scheduledTaskCount,
        actionKey: options.actionKey,
        repeatInstruction: options.repeatInstruction,
        targetSessionId: options.targetSessionId,
      });
      if (!warning) {
        return true;
      }

      addEmphemeralSystemMessage(warning, {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
      return false;
    },
    [
      addEmphemeralSystemMessage,
      getScheduledTaskLeaveWarning,
      scheduledTaskCount,
    ]
  );

  const holdSessionCrons = useCallback(
    async (reason: string, sessionId?: string | null): Promise<void> => {
      const targetSessionId =
        sessionId ?? getSessionService().getCurrentSessionId();
      if (!targetSessionId) {
        return;
      }
      await getTuiDaemonAdapter()
        .ensureConnectedAndGetController()
        .then((controller) =>
          controller.holdSessionCrons({
            sessionId: targetSessionId,
            reason,
          })
        )
        .catch((error) => {
          logWarn('[App] Failed to hold session crons', { cause: error });
        });
    },
    []
  );

  const maybeShowModelNotices = useCallback(
    (
      modelId: string,
      options?: {
        sessionId?: string;
        conversationHistory?: IndustryDroolMessage[];
      }
    ) => {
      const notices = [
        getDeprecatedModelNotice(modelId),
        getExpensiveModelNotice(modelId),
      ].filter((notice): notice is { message: string } => notice !== null);
      if (notices.length === 0) {
        return;
      }

      const sessionId =
        options?.sessionId ??
        effectiveSessionId ??
        getSessionService().getCurrentSessionId();
      const store = sessionId
        ? getTuiDaemonAdapter()
            .getSessionStateManager()
            .getSessionManager(sessionId)
            ?.getStore()
        : undefined;
      const conversationHistory =
        options?.conversationHistory ?? store?.getMessages() ?? [];

      for (const notice of notices) {
        if (isLastMessageText(conversationHistory, notice.message)) {
          continue;
        }

        addEmphemeralSystemMessage(notice.message, {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
          ...(sessionId ? { sessionId } : {}),
        });
      }
    },
    [addEmphemeralSystemMessage, effectiveSessionId]
  );

  const maybeShowLoadedSessionModelNotices = useCallback(
    (sessionId: string, conversationHistory: IndustryDroolMessage[]) => {
      const modelId = resolveActiveModel(getSessionService());
      maybeShowModelNotices(modelId, {
        sessionId,
        conversationHistory,
      });
    },
    [maybeShowModelNotices]
  );

  const showModelActivationNotices = useCallback(
    (
      modelId: string,
      options?: {
        messageKey?:
          | 'common:appMessages.switchingToModel'
          | 'common:appMessages.restoringOriginalModel';
        reasoningEffort?: ReasoningEffort | null;
        includeModelNotices?: boolean;
      }
    ) => {
      if (options?.messageKey) {
        const modelDisplay = formatModelDisplay(
          modelId,
          options.reasoningEffort
        );
        addEmphemeralSystemMessage(
          getI18n().t(options.messageKey, {
            model: modelDisplay,
          }),
          {
            visibility: MessageVisibility.UserOnly,
          }
        );
      }

      if (options?.includeModelNotices ?? true) {
        maybeShowModelNotices(modelId);
      }
    },
    [addEmphemeralSystemMessage, maybeShowModelNotices]
  );

  const switchModelWithNotice = useCallback(
    async (model: string, effort?: ReasoningEffort) => {
      const sessionService = getSessionService();
      const previousActiveModel = resolveActiveModel(sessionService);
      const result = await switchModel(model, effort);
      const nextActiveModel = resolveActiveModel(sessionService);
      if (result.success && nextActiveModel !== previousActiveModel) {
        showModelActivationNotices(nextActiveModel);
      }
      return result;
    },
    [switchModel, showModelActivationNotices]
  );

  const switchSpecModeModelWithNotice = useCallback(
    async (model: string, effort?: ReasoningEffort) => {
      const sessionService = getSessionService();
      const previousActiveModel = resolveActiveModel(sessionService);
      const result = await switchSpecModeModel(model, effort);
      const nextActiveModel = resolveActiveModel(sessionService);
      if (result.success && nextActiveModel !== previousActiveModel) {
        showModelActivationNotices(nextActiveModel);
      }
      return result;
    },
    [switchSpecModeModel, showModelActivationNotices]
  );

  // Re-evaluate systemPromptOverride when interaction mode changes (entering or exiting mission mode).
  useEffect(() => {
    setSessionTypeVersion((v) => v + 1);

    // Show first-time onboarding for sessions that enter Mission mode through a
    // path other than handleNewMission (e.g. resuming an orchestrator session).
    // New-mission entry is gated explicitly in handleNewMission, which sets
    // hasSeenMissionOnboarding before this effect runs, so it won't double-show.
    if (
      interactionMode === DroolInteractionMode.Mission &&
      !getSettingsService().getHasSeenMissionOnboarding()
    ) {
      setShowMissionOnboarding(true);
    }
  }, [interactionMode]);

  useEffect(() => {
    if (isCurrentSquadSession) {
      return;
    }

    void ensureActiveSquadWakeupScheduler();
    const intervalId = setInterval(() => {
      void ensureActiveSquadWakeupScheduler();
    }, 60_000);

    return () => clearInterval(intervalId);
  }, [isCurrentSquadSession]);

  // Get terminal dimensions
  const { width: terminalWidth, height: terminalHeight } =
    useTerminalDimensions();
  const previousTerminalWidthRef = useRef(terminalWidth);

  // Handle terminal resize to force Static component re-render in normal view only

  const redrawSession = useCallback(() => {
    // While Mission Control owns the alternate screen, skip redrawing
    // the base-chat session to avoid any leaked content.
    if (showMissionControlRef.current || showSquadModeRef.current) {
      return;
    }
    refreshInkStaticOutput({
      clearTerminalSequence: clearTerminalSeq,
      writeToStdout,
      invalidateOutput,
      resetStaticHeader: resetHeaderShown,
      bumpStaticKey: () => setStaticKey((prev) => prev + 1),
    });
  }, [clearTerminalSeq, invalidateOutput, writeToStdout]);
  const exitTranscriptScrollToLiveChat = useCallback(() => {
    if (transcriptAnchorIndex === -1) {
      return;
    }
    redrawSession();
    setTranscriptAnchorIndex(-1);
  }, [redrawSession, transcriptAnchorIndex]);
  const enterTranscriptScroll = useCallback(
    (index: number, mode: TranscriptAnchorMode) => {
      if (transcriptAnchorIndex === -1) {
        clearInkTerminalForSurfaceHandoff();
      }
      setTranscriptAnchorMode(mode);
      setTranscriptAnchorIndex(index);
    },
    [clearInkTerminalForSurfaceHandoff, transcriptAnchorIndex]
  );

  useEffect(() => {
    const previousTerminalWidth = previousTerminalWidthRef.current;
    previousTerminalWidthRef.current = terminalWidth;

    if (showRestoredChatBuffer) {
      if (previousTerminalWidth !== terminalWidth) {
        unfreezeRestoredChat();
      }
      return;
    }
    if (showMissionControl || showSquadMode) {
      // Mission Control owns the alternate screen; its own viewport
      // computation handles resize. Skip redraw to avoid writing base-chat
      // content to the alternate buffer.
      return;
    }
    if (showDetailedTranscript) {
      if (previousTerminalWidth !== terminalWidth) {
        setTranscriptStaticKey((prev) => prev + 1);
      }
      return;
    }
    if (!isFirstRenderRef.current) {
      // Skip clearing terminal on first render (preserves startup header)
      redrawSession();
    } else {
      isFirstRenderRef.current = false;
    }
  }, [
    terminalWidth,
    showMissionControl,
    showRestoredChatBuffer,
    showSquadMode,
    showDetailedTranscript,
    redrawSession,
    unfreezeRestoredChat,
  ]);

  const terminalSafeWidth = Math.max(1, terminalWidth);
  const contentBoxWidth = terminalSafeWidth;
  const inputBoxWidth = terminalSafeWidth;
  const contentWidth = Math.max(1, terminalSafeWidth - 6);

  // Group tool calls with their results
  const emptyHistoryMessages = useMemo<HistoryMessage[]>(() => [], []);
  const uiMessages = useUiMessages(
    showMissionControl || showRestoredChatBuffer
      ? emptyHistoryMessages
      : sessionMessages
  );
  const mainChatMessages = useMemo(
    () => filterMainChatMessages(uiMessages),
    [uiMessages]
  );
  const uiMessagesRef = useRef(uiMessages);
  uiMessagesRef.current = uiMessages;
  const isInvokingTools = useMemo(
    () => shouldShowInvokingToolsStatus(sessionStatus, uiMessages),
    [sessionStatus, uiMessages]
  );
  const isPendingSpecEditConfirmation = useMemo(
    () =>
      shouldShowPendingSpecEditConfirmationStatus(sessionStatus, uiMessages),
    [sessionStatus, uiMessages]
  );
  const isReviewingSpecChanges = useMemo(
    () => shouldShowReviewingSpecChangesStatus(sessionStatus, uiMessages),
    [sessionStatus, uiMessages]
  );

  // Derive tool executions from SSM-sourced uiMessages for BackgroundTasksPanel.
  // In daemon mode the local CSM is empty, so we build the map from the
  // ToolExecution items that useUiMessages already produces.
  const getDaemonToolExecutions = useCallback((): Map<
    string,
    ToolExecution
  > => {
    const map = new Map<string, ToolExecution>();
    for (const item of uiMessages) {
      if ('toolName' in item && 'toolInput' in item) {
        const te = item as UiToolExecution;
        map.set(te.id, {
          id: te.id,
          name: te.toolName,
          status: te.status,
          input: te.toolInput,
          result: te.result,
          startTime: te.startTime,
          endTime: te.endTime,
          progressUpdates: te.progressUpdates,
          lastUpdateAt: te.lastUpdateAt,
        });
      }
    }
    return map;
  }, [uiMessages]);

  // Ctrl+C handling
  const [ctrlCPressed, setCtrlCPressed] = useState(false);
  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingConfirmationRef = useRef<BatchToolConfirmationDetails | null>(
    null
  );
  const pendingAutonomyLevelRef = useRef<AutonomyLevel | null>(null);
  const latestAutonomyLevelRef = useRef<AutonomyLevel | null>(null);
  const stickyProposalPermissionStateRef =
    useRef<StickyProposalPermissionState>({
      sessionId: effectiveSessionId,
      toolIds: new Set(),
      toolInputsById: new Map(),
    });

  // Timeout ref for deferred UI expansion after session load
  const expandUiTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Subscribe to KeypressProvider to catch Kitty CSI-u Ctrl+C
  let keypressProvider: ReturnType<typeof useKeypressProvider> | null = null;
  try {
    keypressProvider = useKeypressProvider();
  } catch (error) {
    logWarn('[App] Keypress provider not available yet', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }

  useEffect(() => {
    if (!keypressProvider) return;
    const handler = (event: KeyEvent) => {
      if (!matchKeyboardChord(event, 'ctrl-c')) return;

      if (bashMode.isExecuting) {
        if (ctrlCTimerRef.current) {
          clearTimeout(ctrlCTimerRef.current);
          ctrlCTimerRef.current = null;
        }
        setCtrlCPressed(false);
        void cancelBashCommand();
        return;
      }

      // Close file/command suggestions dropdown
      chatInputApiRef.current?.closeSuggestions?.();

      // Clear input if it exists
      const currentInput = chatInputApiRef.current?.getInput?.() || '';
      if (currentInput.trim()) {
        chatInputApiRef.current?.setInput?.('');
      }

      // Mirror Ink Ctrl+C handling (always handle exit timer)
      if (ctrlCPressed) {
        if (ctrlCTimerRef.current) {
          clearTimeout(ctrlCTimerRef.current);
        }
        // Execute tool processes live in the daemon child session, so interrupt that session first.
        // Parent-side cleanup remains as a best-effort fallback for local resources.
        void Promise.all([
          holdSessionCrons('ctrl-c-exit', effectiveSessionId),
          interruptRunningDaemonSessionForExit({
            sessionId: effectiveSessionId,
            sessionStatus,
            interruptSession: (sessionId) =>
              getTuiDaemonAdapter().interruptSession(sessionId),
          }),
          processTracker.killAllProcesses().catch(() => {}),
          getTerminalService()
            .releaseAll()
            .catch(() => {}),
        ])
          .then(() => gracefulMissionExit())
          .catch(() => {})
          .finally(async () => {
            await restoreShellTerminalState({ setRawMode, stdout });
            appExit();
          });
      } else {
        setCtrlCPressed(true);
        const hasSpecConfirmation = pendingConfirmationRef.current?.tools.some(
          (t) => t.confirmationType === ToolConfirmationType.ExitSpecMode
        );
        if (!hasSpecConfirmation) {
          const scheduledTaskWarning =
            scheduledTaskCount > 0
              ? ` ${scheduledTaskCount === 1 ? 'A loop' : 'Loops'} will stop when this session closes.`
              : '';
          addEmphemeralSystemMessage(
            `${getI18n().t('common:process.ctrlCToExit').trim()}${scheduledTaskWarning}`,
            {
              visibility: MessageVisibility.UserOnly,
            }
          );
        }
        ctrlCTimerRef.current = setTimeout(() => {
          setCtrlCPressed(false);
          ctrlCTimerRef.current = null;
        }, 2000);
      }
    };
    keypressProvider.subscribe(handler, { layer: KeypressLayer.System });
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [
    keypressProvider,
    ctrlCPressed,
    bashMode.isExecuting,
    holdSessionCrons,
    cancelBashCommand,
    addEmphemeralSystemMessage,
    appExit,
    effectiveSessionId,
    scheduledTaskCount,
    setRawMode,
    sessionStatus,
    stdout,
  ]);

  // Ctrl+Z handling (suspend process like vim/neovim)
  useEffect(() => {
    if (!keypressProvider) return;
    // Only support suspend on Unix-like systems (not Windows)
    if (process.platform === 'win32') return;

    const handler = (event: KeyEvent) => {
      if (!matchKeyboardChord(event, 'ctrl-z')) return;

      // Suspend the process (like vim Ctrl+Z)
      // 1. If Mission Control is open (in alternate screen buffer), exit it before suspending
      if (showMissionControl || showSquadMode) {
        if (showMissionControl) {
          void exitMissionControlInkIsolation(stdout);
        }
        process.stdout.write(ANSI.EXIT_ALTERNATE_SCREEN);
      }
      // 2. Show cursor
      process.stdout.write(ANSI.SHOW_CURSOR);

      // 3. Disable raw mode
      setRawMode(false);

      // 4. Send SIGTSTP to suspend self
      try {
        process.kill(process.pid, 'SIGTSTP');
      } catch (error) {
        logWarn('[App] Failed to suspend process with SIGTSTP', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    };

    keypressProvider.subscribe(handler, { layer: KeypressLayer.System });
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [keypressProvider, setRawMode, showMissionControl, showSquadMode, stdout]);

  // Handle SIGCONT to resume after Ctrl+Z suspend
  useEffect(() => {
    if (process.platform === 'win32') return;

    const handleContinue = () => {
      restoreInteractiveTerminalState({ setRawMode });

      // If Mission Control was open when suspended, re-enter alternate screen buffer
      // and clear it. Skip redrawSession to avoid writing base-chat content.
      if (showMissionControl || showSquadMode) {
        if (showMissionControl) {
          void enterMissionControlInkIsolation(stdout);
        }
        stdout.write(ANSI.ENTER_ALTERNATE_SCREEN + clearTerminalSeq);
        return;
      }

      // Clear screen to remove any cursor artifacts from shell
      clearInkTerminal();

      // Redraw the screen
      setTimeout(() => {
        redrawSession();
      }, 50);
    };

    process.on('SIGCONT', handleContinue);
    return () => {
      process.removeListener('SIGCONT', handleContinue);
    };
  }, [
    setRawMode,
    showMissionControl,
    showSquadMode,
    stdout,
    clearTerminalSeq,
    redrawSession,
    clearInkTerminal,
  ]);

  const {
    runAgent,
    addUserMessage,
    stopAgentWithTimeout,
    isCancelling,
    pendingConfirmation,
    pendingPermissionCount,
    pendingPermissionTotal,
    mcpAuthPending,
    loadConversationHistory: loadSession,
    isAgentRunning,
    tokenLimitChoice,
    handleTokenLimitChoice,
    showTokenLimitChoice,
    subscribeToSession,
    updateSettings,
    initializeDaemonSession,
    ensureDaemonSession,
    forkDaemonSession,
  } = useDaemonAgent({
    addMessage: addEmphemeralSystemMessage,
    loadConversationHistory,
    onSessionLoaded: maybeShowLoadedSessionModelNotices,
    activeSessionId,
    setChatInputText: setChatInputTextFromDaemon,
    onInteractivePromptPending: handleInteractivePromptPending,
  });

  useEffect(() => {
    latestAutonomyLevelRef.current = autonomyLevel;
    if (pendingAutonomyLevelRef.current === autonomyLevel) {
      pendingAutonomyLevelRef.current = null;
    }
  }, [autonomyLevel]);

  pendingConfirmationRef.current = pendingConfirmation;
  const pendingApprovalDetailsKey =
    pendingConfirmation?.tools.map((tool) => tool.toolUseId).join('\u0000') ??
    null;
  const approvalDetailsConfirmation =
    pendingConfirmation &&
    approvalDetailsRequestKey === pendingApprovalDetailsKey
      ? pendingConfirmation
      : null;

  useEffect(() => {
    if (!showApprovalDetails) {
      return;
    }
    if (approvalDetailsRequestKey === pendingApprovalDetailsKey) {
      return;
    }
    closeApprovalDetails();
  }, [
    approvalDetailsRequestKey,
    closeApprovalDetails,
    pendingApprovalDetailsKey,
    showApprovalDetails,
  ]);
  updateStickyProposalPermissionState(
    stickyProposalPermissionStateRef.current,
    effectiveSessionId,
    pendingConfirmation
  );

  // After /cwd, refresh the daemon child so execution-boundary slash prompt
  // resolution uses the same cwd-local custom commands and skills as the TUI.
  const handleWorkingDirectoryChanged = useCallback(
    async (resolvedPath: string) => {
      const sessionId =
        effectiveSessionId ?? getSessionService().getCurrentSessionId();
      try {
        if (sessionId) {
          await getTuiDaemonAdapter().reloadSessionForCurrentCwd(sessionId);
        }
      } catch (error) {
        logWarn('[App] Failed to reload daemon session after cwd change', {
          sessionId: sessionId ?? undefined,
          cwd: resolvedPath,
          cause: error,
        });
        throw error;
      } finally {
        setTimeout(() => {
          redrawSession();
        }, 25);
      }
    },
    [effectiveSessionId, redrawSession]
  );

  const [permissionExecuteToolIds, setPermissionExecuteToolIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  const stickyProposalPermissionState =
    stickyProposalPermissionStateRef.current;
  const toolInputOverridesById = new Map(
    stickyProposalPermissionState.toolInputsById
  );
  const staticToolIds = new Set(stickyProposalPermissionState.toolIds);
  const pendingPermissionToolIds = pendingConfirmation
    ? new Set(pendingConfirmation.tools.map((tool) => tool.toolUseId))
    : undefined;

  if (pendingConfirmation) {
    for (const tool of pendingConfirmation.tools) {
      toolInputOverridesById.set(
        tool.toolUseId,
        getPermissionToolInputForDisplay(tool)
      );
    }
  }

  const permissionToolInputOverridesById =
    toolInputOverridesById.size > 0 ? toolInputOverridesById : undefined;
  const permissionStaticToolIds =
    staticToolIds.size > 0 ? staticToolIds : undefined;

  const pendingPermissionExecuteToolIds = useMemo(() => {
    if (!pendingConfirmation) {
      return undefined;
    }

    const executeToolIds = pendingConfirmation.tools
      .filter((tool) => tool.confirmationType === ToolConfirmationType.Execute)
      .map((tool) => tool.toolUseId);

    return executeToolIds.length > 0 ? new Set(executeToolIds) : undefined;
  }, [pendingConfirmation]);

  useEffect(() => {
    setPermissionExecuteToolIds(new Set());
  }, [activeSessionId]);

  useEffect(() => {
    if (!pendingPermissionExecuteToolIds) {
      return;
    }

    setPermissionExecuteToolIds((previous) => {
      let changed = false;
      const next = new Set(previous);
      for (const toolId of pendingPermissionExecuteToolIds) {
        if (!next.has(toolId)) {
          next.add(toolId);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [pendingPermissionExecuteToolIds]);

  // Subscribe to daemon notifications when session changes
  useEffect(() => {
    if (activeSessionId) {
      subscribeToSession(activeSessionId);
    }
  }, [activeSessionId, subscribeToSession]);

  const handleReviewFlow = useCallback(() => {
    void reviewManager.open((openingLine, fullMessage) => {
      // Add a system notification to indicate review is starting
      addEmphemeralSystemMessage(openingLine, {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });

      // Then run the agent with the full review message
      // This will create the user message with proper system reminders
      void runAgent({ message: fullMessage });
    });
  }, [reviewManager, addEmphemeralSystemMessage, runAgent]);

  // Handle mission resume from Mission Control
  // Kicks off the agent loop with an instruction to resume the mission
  const handleMissionResume = useCallback(() => {
    // Run the agent with a clear instruction to resume the mission
    // The orchestrator will understand to call start_mission_run
    void runAgent({
      message: getI18n().t('common:appMessages.resumeTheMission'),
    });
  }, [runAgent]);

  // Eagerly init the daemon session after /new or /clear so daemon RPCs
  // (e.g. listMcpServers from /mcp) work before the user's first message.
  const handleCreateSessionWithDaemon = useCallback(
    async (options?: {
      skipScheduledTaskLeaveWarning?: boolean;
      scheduledTaskLeaveWarning?: {
        actionKey: string;
        repeatInstruction: string;
        targetSessionId?: string;
      };
    }): Promise<string | null> => {
      if (
        !options?.skipScheduledTaskLeaveWarning &&
        !confirmScheduledTaskLeave(
          options?.scheduledTaskLeaveWarning ?? {
            actionKey: 'create-session',
            repeatInstruction: 'Repeat the action to start a new session.',
          }
        )
      ) {
        return null;
      }

      const currentSessionId = getSessionService().getCurrentSessionId();
      await holdSessionCrons('session-leave', currentSessionId);
      const newSessionId = await createSessionViaController();
      await initializeDaemonSession(newSessionId);
      return newSessionId;
    },
    [
      confirmScheduledTaskLeave,
      createSessionViaController,
      holdSessionCrons,
      initializeDaemonSession,
    ]
  );

  // Ref to always access the latest handleOpenRewindMenu, avoiding stale
  // closure issues in processAndRun which has incomplete dependency arrays.
  const handleOpenRewindMenuRef = useRef<() => Promise<boolean>>(
    async () => false
  );

  // Same pattern for the /copy selector so processAndRun can call it without
  // needing the handler to be defined earlier.
  const handleOpenCopySelectorRef = useRef<() => boolean>(() => false);

  // Show the mid-session folder trust prompt for a target directory and
  // resolve to whether the user trusted it. Used by /cwd to gate switching
  // into an untrusted folder before its project config can load.
  const requestFolderTrust = useCallback(
    (targetPath: string): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        setCwdTrustPrompt({ targetPath, resolve });
      }),
    []
  );

  const settleCwdTrustPrompt = useCallback(
    (trusted: boolean) => {
      // Clear the full-screen prompt before unmounting so its lines don't
      // linger behind the redrawn chat (and the subsequent cwd-change
      // notification). Mirrors the startup gate's onTrust handler.
      clearTerminal();
      cwdTrustPrompt?.resolve(trusted);
      setCwdTrustPrompt(null);
    },
    [cwdTrustPrompt]
  );

  // Helper to process and send a message (slash commands + runAgent)
  const processAndRun = useCallback(
    async (
      text: string,
      images?: ImageAttachment[],
      options?: ChatSubmitOptions
    ): Promise<boolean> => {
      const trimmedText = text.trim();
      const files = options?.files;
      const hasAttachments =
        (images?.length ?? 0) > 0 || (files?.length ?? 0) > 0;
      if (!trimmedText && !hasAttachments) return true;
      const queuePlacement = getEnabledQueuePlacement(options?.queuePlacement);
      const runAgentWithEscapedUserMessage = (message: string) =>
        runAgent({
          message: escapeUserMessageSystemTags(message),
          images,
          files,
          queuePlacement,
        });
      if (
        trimmedText.startsWith('/') &&
        commandRegistry.hasDeferredPromptResolver(trimmedText.slice(1))
      ) {
        return runAgent({
          message: trimmedText,
          images,
          files,
          queuePlacement,
        });
      }

      // Alias "quit" or "exit" to /quit command
      const lowerText = trimmedText.toLowerCase();
      if (lowerText === 'quit' || lowerText === 'exit') {
        const result = await commandRegistry.execute('quit', {
          addEphemeralSystemMessage: addEmphemeralSystemMessage,
          loadSession,
          showSessionSelector: setSessionSelectorData,
          showSettingsSelector: setSettingsSelectorData,
          showThemeSelector: () => {
            setShowThemeSelector(true);
          },
          showModelSelector: (showSpecOption = false) => {
            setShowSpecModeOption(showSpecOption);
            setShowModelSelector(true);
          },
          showMissionModelSelector: () => {
            setShowSpecModeOption(false);
            setShowMissionModelSelector(true);
          },
          showSpecModeConfigurator: () => setShowSpecModeConfigurator(true),
          showReasoningEffortSelector: () => {
            const currentModel = mainModel;
            if (!currentModel) {
              return;
            }
            const { supportedReasoningEfforts } =
              getTuiModelConfig(currentModel);
            if (supportedReasoningEfforts.length > 1) {
              setShowReasoningEffortSelector(true);
            }
          },
          showLoginSelector: () => setShowLoginSelector(true),
          showIdeExtensionPrompt: (extensionPromptOptions) =>
            setIdeExtensionPromptState({
              show: true,
              isUpdate: extensionPromptOptions?.isUpdate ?? false,
            }),
          showIdeInstanceSelector: (ideInstanceOptions) =>
            setIdeInstanceSelectorState({
              show: true,
              initialConnectedInstance:
                ideInstanceOptions?.initialConnectedInstance,
              onDisconnect: ideInstanceOptions?.onDisconnect,
            }),
          showDroolsMenu: droolsMenu.open,
          showSkillsMenu: skillsMenu.open,
          showHooksManager: hooksManager.open,
          showReviewFlow: handleReviewFlow,
          clearTerminal: clearInkTerminal,
          forceUIRefresh: redrawSession,
          onWorkingDirectoryChanged: handleWorkingDirectoryChanged,
          requestFolderTrust,
          showCommandsManager: () => setShowCommandsManager(true),
          showMcpManager: () => setShowMcpManager(true),
          showPluginMenu: pluginMenu.open,
          showDiagnosticsMenu: diagnosticsMenu.open,
          showBgProcessManager: () => setShowBgProcessManager(true),
          showMissionControl: openMissionControl,
          showSquadMode: openSquadMode,
          showMissionsPicker: (missions, context) =>
            setMissionsMenuData({ missions, ...context }),
          showCompactConfirmation: (instructions?: string) => {
            setCompressionInstructions(instructions);
            setShowCompactConfirm(true);
          },
          showCreateSkillFlow: (description: string) => {
            setCreateSkillDraft(description);
            setShowCreateSkillFlow(true);
          },
          showSetupIncidentResponseFlow: () =>
            setShowSetupIncidentResponseFlow(true),
          showRewindMenu: async () => handleOpenRewindMenuRef.current(),
          showCopySelector: () => handleOpenCopySelectorRef.current(),
          submitBugReport: async (userComment, clientLogs) => {
            const sid = getSessionService().getCurrentSessionId();
            if (!sid) throw new Error('No active session');
            return getTuiDaemonAdapter().submitBugReport(
              sid,
              userComment,
              clientLogs
            );
          },

          confirmScheduledTaskLeave,
          createSession: handleCreateSessionWithDaemon,
          // eslint-disable-next-line no-use-before-define
          forkSession: handleForkSession,
          submitBtwQuestion: handleSubmitBtwQuestion,
          showBtwScrollView: handleShowBtwScrollView,
          ideClient,
          appExit,
          showTokenLimitChoice,
          showLoopModal: () => setSchedulingOverlay('loops'),
          showAutomationsModal: () => {
            setSchedulingOverlay('automations');
            refreshAutomations();
          },
          updateSettings,
        });

        if (result.handled) {
          if (typeof result.insertText === 'string') {
            setChatInputValue(result.insertText);
            return true;
          }

          setChatInputValue('');

          // Handle model/reasoning override for this agent run
          const settingsService = getSettingsService();
          const currentModel = settingsService.getModel();
          const currentReasoningEffort = settingsService.getReasoningEffort();

          // Check if overrides are different from current settings
          const modelChanged =
            result.modelOverride && result.modelOverride !== currentModel;
          const reasoningChanged =
            result.reasoningEffortOverride &&
            result.reasoningEffortOverride !== currentReasoningEffort;
          const hasChanges = modelChanged || reasoningChanged;

          // Apply temporary overrides (if any)
          let savedModel: string | null = null;
          let savedReasoningEffort: ReasoningEffort | null = null;

          if (result.modelOverride || result.reasoningEffortOverride) {
            savedModel = currentModel;
            savedReasoningEffort = currentReasoningEffort;

            // Propagate the override to the daemon so the next message
            // actually uses the new model/reasoning settings.
            const overrideSessionId = getSessionService().getCurrentSessionId();
            if (overrideSessionId) {
              const adapter = getTuiDaemonAdapter();
              await adapter.updateSessionSettings({
                sessionId: overrideSessionId,
                ...(result.modelOverride && {
                  modelId: result.modelOverride,
                }),
                ...(result.reasoningEffortOverride && {
                  reasoningEffort: result.reasoningEffortOverride,
                }),
              });
            }

            // Show switching message only if something changed
            if (hasChanges) {
              const targetModel = result.modelOverride || currentModel;
              showModelActivationNotices(targetModel, {
                messageKey: 'common:appMessages.switchingToModel',
                reasoningEffort: result.reasoningEffortOverride,
                includeModelNotices: Boolean(modelChanged),
              });
            }
          }

          try {
            if (result.messageText) {
              return await runAgent({
                message: result.messageText,
                images,
                files,
                queuePlacement,
              });
            }
            if (result.shouldRunAgent) {
              return await runAgentWithEscapedUserMessage(trimmedText);
            }
            return true;
          } finally {
            // Restore original settings after agent run completes
            if (savedModel !== null) {
              const sessionService = getSessionService();
              sessionService.setModel(savedModel, savedReasoningEffort!);

              // Restore the daemon session settings back to the original
              const restoreSessionId =
                getSessionService().getCurrentSessionId();
              if (restoreSessionId) {
                const adapter = getTuiDaemonAdapter();
                await adapter.updateSessionSettings({
                  sessionId: restoreSessionId,
                  modelId: savedModel,
                  reasoningEffort: savedReasoningEffort!,
                });
              }

              // Show restore message only if something was changed
              if (hasChanges) {
                showModelActivationNotices(savedModel, {
                  messageKey: 'common:appMessages.restoringOriginalModel',
                  reasoningEffort: savedReasoningEffort,
                  includeModelNotices: Boolean(modelChanged),
                });
              }
            }
          }
        }
      }

      if (trimmedText.startsWith('/')) {
        const commandText = trimmedText.slice(1);
        const result = await commandRegistry.execute(commandText, {
          addEphemeralSystemMessage: addEmphemeralSystemMessage,
          loadSession,
          showSessionSelector: setSessionSelectorData,
          showSettingsSelector: setSettingsSelectorData,
          showThemeSelector: () => {
            setShowThemeSelector(true);
          },
          showModelSelector: (showSpecOption = false) => {
            setShowSpecModeOption(showSpecOption);
            setShowModelSelector(true);
          },
          showMissionModelSelector: () => {
            setShowSpecModeOption(false);
            setShowMissionModelSelector(true);
          },
          showSpecModeConfigurator: () => setShowSpecModeConfigurator(true),
          showReasoningEffortSelector: () => {
            const currentModel = mainModel;
            if (!currentModel) {
              return;
            }
            const { supportedReasoningEfforts } =
              getTuiModelConfig(currentModel);
            if (supportedReasoningEfforts.length > 1) {
              setShowReasoningEffortSelector(true);
            }
          },
          showLoginSelector: () => setShowLoginSelector(true),
          showIdeExtensionPrompt: (extensionPromptOptions) =>
            setIdeExtensionPromptState({
              show: true,
              isUpdate: extensionPromptOptions?.isUpdate ?? false,
            }),
          showIdeInstanceSelector: (ideInstanceOptions) =>
            setIdeInstanceSelectorState({
              show: true,
              initialConnectedInstance:
                ideInstanceOptions?.initialConnectedInstance,
              onDisconnect: ideInstanceOptions?.onDisconnect,
            }),
          showDroolsMenu: droolsMenu.open,
          showSkillsMenu: skillsMenu.open,
          showHooksManager: hooksManager.open,
          showReviewFlow: handleReviewFlow,
          clearTerminal: clearInkTerminal,
          forceUIRefresh: redrawSession,
          onWorkingDirectoryChanged: handleWorkingDirectoryChanged,
          requestFolderTrust,
          showCommandsManager: () => setShowCommandsManager(true),
          showMcpManager: () => setShowMcpManager(true),
          showPluginMenu: pluginMenu.open,
          showDiagnosticsMenu: diagnosticsMenu.open,
          showBgProcessManager: () => setShowBgProcessManager(true),
          showMissionControl: openMissionControl,
          showSquadMode: openSquadMode,
          showMissionsPicker: (missions, context) =>
            setMissionsMenuData({ missions, ...context }),
          showCompactConfirmation: (instructions?: string) => {
            setCompressionInstructions(instructions);
            setShowCompactConfirm(true);
          },
          showCreateSkillFlow: (description: string) => {
            setCreateSkillDraft(description);
            setShowCreateSkillFlow(true);
          },
          showSetupIncidentResponseFlow: () =>
            setShowSetupIncidentResponseFlow(true),
          showRewindMenu: async () => handleOpenRewindMenuRef.current(),
          showCopySelector: () => handleOpenCopySelectorRef.current(),
          submitBugReport: async (userComment, clientLogs) => {
            const sid = getSessionService().getCurrentSessionId();
            if (!sid) throw new Error('No active session');
            return getTuiDaemonAdapter().submitBugReport(
              sid,
              userComment,
              clientLogs
            );
          },
          confirmScheduledTaskLeave,
          createSession: handleCreateSessionWithDaemon,
          // eslint-disable-next-line no-use-before-define
          forkSession: handleForkSession,
          submitBtwQuestion: handleSubmitBtwQuestion,
          showBtwScrollView: handleShowBtwScrollView,
          ideClient,
          appExit,
          showTokenLimitChoice,
          showLoopModal: () => setSchedulingOverlay('loops'),
          showAutomationsModal: () => {
            setSchedulingOverlay('automations');
            refreshAutomations();
          },
          updateSettings,
        });

        if (result.handled) {
          if (typeof result.insertText === 'string') {
            setChatInputValue(result.insertText);
            return true;
          }

          setChatInputValue('');

          const settingsService = getSettingsService();
          const currentModel = settingsService.getModel();
          const currentReasoningEffort = settingsService.getReasoningEffort();

          const modelChanged =
            result.modelOverride && result.modelOverride !== currentModel;
          const reasoningChanged =
            result.reasoningEffortOverride &&
            result.reasoningEffortOverride !== currentReasoningEffort;
          const hasChanges = modelChanged || reasoningChanged;

          let savedModel: string | null = null;
          let savedReasoningEffort: ReasoningEffort | null = null;

          if (result.modelOverride || result.reasoningEffortOverride) {
            savedModel = currentModel;
            savedReasoningEffort = currentReasoningEffort;

            const sessionService = getSessionService();

            if (result.modelOverride) {
              sessionService.setModel(
                result.modelOverride,
                result.reasoningEffortOverride ?? savedReasoningEffort
              );
            } else if (result.reasoningEffortOverride) {
              sessionService.setReasoningEffort(result.reasoningEffortOverride);
            }

            if (hasChanges) {
              const targetModel = result.modelOverride || currentModel;
              showModelActivationNotices(targetModel, {
                messageKey: 'common:appMessages.switchingToModel',
                reasoningEffort: result.reasoningEffortOverride,
                includeModelNotices: Boolean(modelChanged),
              });
            }
          }

          // Sync enabledToolIds to daemon (e.g. /readiness-report enables store tool)
          const updatedToolIds = getSessionService().getEnabledToolIds();
          if (updatedToolIds.length > 0) {
            await updateSettings({ enabledToolIds: updatedToolIds });
          }

          try {
            if (result.messageText) {
              return await runAgent({
                message: result.messageText,
                images,
                files,
                queuePlacement,
              });
            }
            if (result.shouldRunAgent) {
              return await runAgentWithEscapedUserMessage(trimmedText);
            }
            return true;
          } finally {
            if (savedModel !== null) {
              const sessionService = getSessionService();
              sessionService.setModel(savedModel, savedReasoningEffort!);

              if (hasChanges) {
                showModelActivationNotices(savedModel, {
                  messageKey: 'common:appMessages.restoringOriginalModel',
                  reasoningEffort: savedReasoningEffort,
                  includeModelNotices: Boolean(modelChanged),
                });
              }
            }
          }
        }
      }

      // Execute UserPromptSubmit hooks before running agent
      try {
        const autonomyMode = getSessionService().getCurrentAutonomyMode();
        const permissionMode =
          convertAutonomyModeToPermissionMode(autonomyMode);
        const transcriptPath =
          getSessionService().getSessionTranscriptPath() || '';
        const hookResults = await getHookService().executeHooks({
          eventName: HookEventName.UserPromptSubmit,
          input: {
            session_id: getSessionService().getCurrentSessionId() || 'unknown',
            transcript_path: transcriptPath,
            cwd: process.cwd(),
            permission_mode: permissionMode,
            hook_event_name: HookEventName.UserPromptSubmit,
            prompt: trimmedText,
            has_images: images && images.length > 0,
            message_id: undefined,
          },
        });

        // Process hook results
        let hookContextToInject: string | undefined;
        let finalPrompt = trimmedText;

        for (const result of hookResults) {
          // Exit code 2: Block submission
          if (result.exitCode === 2) {
            const reason =
              result.stderr ||
              getI18n().t('common:appMessages.hookBlockedDefault');
            addEmphemeralSystemMessage(
              getI18n().t('common:appMessages.hookBlockedSubmission', {
                reason,
              }),
              {
                messageType: MessageType.SystemNotification,
                visibility: MessageVisibility.UserOnly,
              }
            );
            return false;
          }

          // Exit code 3: Abort
          if (result.exitCode === 3) {
            const reason =
              result.stderr ||
              getI18n().t('common:appMessages.hookAbortedDefault');
            addEmphemeralSystemMessage(
              getI18n().t('commands:slashMessages.hookAborted', { reason }),
              {
                messageType: MessageType.SystemNotification,
                visibility: MessageVisibility.UserOnly,
              }
            );
            return false;
          }

          // Process successful hook results (exit code 0)
          if (result.exitCode === 0) {
            // Check for modified prompt in hook output
            if (result.hookSpecificOutput?.updatedInput?.prompt) {
              const modifiedPrompt = String(
                result.hookSpecificOutput.updatedInput.prompt
              ).trim();
              if (modifiedPrompt && modifiedPrompt !== trimmedText) {
                logInfo('[App] Using modified prompt from hook', {
                  preview: trimmedText.substring(0, 100),
                  textPreview: modifiedPrompt.substring(0, 100),
                });
                finalPrompt = modifiedPrompt;
              }
            }

            // Collect additionalContext from JSON output (highest priority)
            if (
              result.hookSpecificOutput?.additionalContext &&
              !hookContextToInject
            ) {
              hookContextToInject = result.hookSpecificOutput.additionalContext;
              logInfo('[App] Injecting additionalContext from hook', {
                length: hookContextToInject.length,
              });
            }
            // Fallback: use raw stdout if no JSON additionalContext
            else if (result.stdout?.trim() && !hookContextToInject) {
              hookContextToInject = result.stdout.trim();
              logInfo('[App] Injecting stdout from hook', {
                length: hookContextToInject.length,
              });
            }
          }
        }

        // Run agent with hook context if available
        return await runAgent({
          message: escapeUserMessageSystemTags(finalPrompt),
          images,
          files,
          hookContext: hookContextToInject,
          queuePlacement,
        });
      } catch (error) {
        // Log error but don't block submission - hooks should never break the main flow
        logException(error, '[App] Error executing UserPromptSubmit hooks');
      }

      return await runAgentWithEscapedUserMessage(trimmedText);
    },
    [
      runAgent,
      addEmphemeralSystemMessage,
      showModelActivationNotices,
      loadSession,
      setSessionSelectorData,
      setSettingsSelectorData,
      setShowModelSelector,
      setShowReasoningEffortSelector,
      setShowLoginSelector,
      droolsMenu.open,
      setChatInputValue,
      appExit,
      confirmScheduledTaskLeave,
      handleReviewFlow,
      clearInkTerminal,
      mainModel,
      refreshAutomations,
    ]
  );

  const refreshScheduledTasks = useCallback(() => {
    void getTuiDaemonAdapter()
      .ensureConnectedAndGetController()
      .then((controller) => controller.listCrons({ includeInactive: true }))
      .then(({ crons }) => {
        setCronHistory(crons);
        setScheduledTasks(crons.filter(isUserVisibleCron));
      })
      .catch((error) => {
        logWarn('[App] Failed to refresh crons', { cause: error });
      });
  }, []);

  useMountEffect(() => {
    refreshScheduledTasks();
  });

  useMountEffect(() => {
    const unsubscribe = getTuiDaemonAdapter().onControllerEvent(
      DroolEvent.CronStateChanged,
      refreshScheduledTasks
    );
    return unsubscribe;
  });

  const getOrCreateSessionQueueManager = useCallback((sessionId: string) => {
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();
    if (!ssm.getSessionManager(sessionId)) {
      ssm.markSessionLoading(sessionId, 'local');
      ssm.initializeSession(sessionId, []);
    }

    return ssm.getSessionManager(sessionId);
  }, []);

  const queueLocalPrompt = useCallback(
    (
      kind: QueuedUserMessageKind,
      text: string,
      images?: ImageAttachment[],
      files?: ChatSubmitOptions['files'],
      sessionIdOverride?: string | null
    ) => {
      const sessionId = sessionIdOverride ?? effectiveSessionId;
      if (!sessionId) {
        return;
      }

      getOrCreateSessionQueueManager(sessionId)?.queueUserMessage(
        generateUUID(),
        buildQueuedPromptContent({ text, images, files }),
        kind
      );
    },
    [effectiveSessionId, getOrCreateSessionQueueManager]
  );

  const queueLocalDeferredMessage = useCallback(
    (
      text: string,
      images?: ImageAttachment[],
      files?: ChatSubmitOptions['files']
    ) => {
      queueLocalPrompt(
        QueuedUserMessageKind.LocalDeferredAfterEsc,
        text,
        images,
        files
      );
    },
    [queueLocalPrompt]
  );

  const queueLocalPausedMessage = useCallback(
    (
      text: string,
      images?: ImageAttachment[],
      files?: ChatSubmitOptions['files']
    ) => {
      queueLocalPrompt(
        QueuedUserMessageKind.LocalPausedAfterEsc,
        text,
        images,
        files
      );
    },
    [queueLocalPrompt]
  );

  const restoreLocalPausedQueuedHead = useCallback(
    (sessionId: string): boolean => {
      const manager = getOrCreateSessionQueueManager(sessionId);
      const queuedMessage = manager
        ?.getQueuedMessages()
        .find(
          (message) =>
            message.kind === QueuedUserMessageKind.LocalPausedAfterEsc
        );
      if (!manager || !queuedMessage) {
        return false;
      }

      const { text, images, files } = extractQueuedPromptContent(
        queuedMessage.content
      );
      if ((files?.length ?? 0) > 0) {
        setQueuedReviewActive(true);
        return false;
      }

      manager.clearQueuedMessage(queuedMessage.requestId);
      if (!text.trim() && (images?.length ?? 0) === 0) {
        return false;
      }

      restoredQueuedHeadTextRef.current = text.trim() || null;
      setChatInputValue(text);
      if ((images?.length ?? 0) > 0) {
        chatInputApiRef.current?.setImages(images ?? []);
      }
      setQueuedReviewActive(false);
      return true;
    },
    [getOrCreateSessionQueueManager, setChatInputValue]
  );

  const queueManualCompactionMessage = useCallback(
    (
      text: string,
      images?: ImageAttachment[],
      files?: ChatSubmitOptions['files']
    ) => {
      queueLocalPrompt(
        QueuedUserMessageKind.LocalDeferredDuringManualCompaction,
        text,
        images,
        files,
        manualCompactionQueueSessionIdRef.current
      );
    },
    [queueLocalPrompt]
  );

  const takeManualCompactionQueuedMessages = useCallback(
    (sessionId: string): QueuedUserMessageState[] => {
      const manager = getOrCreateSessionQueueManager(sessionId);
      return (
        manager?.dequeueQueuedMessages(
          QueuedUserMessageKind.LocalDeferredDuringManualCompaction
        ) ?? []
      );
    },
    [getOrCreateSessionQueueManager]
  );

  const restoreManualCompactionQueuedMessages = useCallback(
    (queuedMessages: QueuedUserMessageState[], restoreSessionId?: string) => {
      if (queuedMessages.length === 0) {
        return;
      }

      const sessionId =
        restoreSessionId ?? getSessionService().getCurrentSessionId();
      if (!sessionId) {
        return;
      }

      const manager = getOrCreateSessionQueueManager(sessionId);
      manager?.restoreQueuedMessagesToFront(
        queuedMessages.map((queuedMessage) => ({
          ...queuedMessage,
          kind: QueuedUserMessageKind.LocalDeferredDuringManualCompaction,
        }))
      );
    },
    [getOrCreateSessionQueueManager]
  );

  const drainManualCompactionQueuedMessages = useCallback(
    async (
      queuedMessages: QueuedUserMessageState[],
      restoreSessionId?: string
    ) => {
      for (const [index, queuedMessage] of queuedMessages.entries()) {
        const { text, images, files } = extractQueuedPromptContent(
          queuedMessage.content
        );
        if (
          !text.trim() &&
          (images?.length ?? 0) === 0 &&
          (files?.length ?? 0) === 0
        ) {
          continue;
        }

        try {
          const accepted = await processAndRun(text, images, { files });
          if (!accepted) {
            restoreManualCompactionQueuedMessages(
              queuedMessages.slice(index),
              restoreSessionId
            );
            return;
          }
        } catch (error) {
          logWarn('[App] Failed to drain manual compaction queued message', {
            cause: error,
          });
          restoreManualCompactionQueuedMessages(
            queuedMessages.slice(index),
            restoreSessionId
          );
          return;
        }
      }
    },
    [processAndRun, restoreManualCompactionQueuedMessages]
  );

  const drainManualCompactionQueueForSession = useCallback(
    async (sessionId: string) => {
      const queuedMessages = takeManualCompactionQueuedMessages(sessionId);
      await drainManualCompactionQueuedMessages(queuedMessages, sessionId);
    },
    [drainManualCompactionQueuedMessages, takeManualCompactionQueuedMessages]
  );

  const escInterruptRequestedRef = useRef(false);
  const localPausedAutoDrainArmedRef = useRef(false);
  const localPausedAutoDrainInFlightRef = useRef(false);
  const localPausedAutoDrainAwaitingTurnRef = useRef(false);
  const localPausedAutoDrainSawBusyRef = useRef(false);
  const specHandoffInProgressRef = useRef(false);

  const pendingQueuedMessages = ssmQueuedMessages;
  const { reviewableQueuedMessages, pullableQueuedMessages } = useMemo(() => {
    const reviewPriorityBuckets: [QueuedUserMessage[], QueuedUserMessage[]] = [
      [],
      [],
    ];
    const nextPullableQueuedMessages: QueuedUserMessage[] = [];

    for (const item of pendingQueuedMessages) {
      if (!isReviewableQueuedMessageKind(item.kind)) {
        continue;
      }

      const priority = getQueuedUserMessageReviewPriority(item.kind) ?? 0;
      reviewPriorityBuckets[priority <= 0 ? 0 : 1].push(item);

      if (
        getQueuedUserMessageDisplayGroup(item.kind) ===
        QueuedUserMessageDisplayGroup.Queued
      ) {
        nextPullableQueuedMessages.push(item);
      }
    }

    return {
      reviewableQueuedMessages: reviewPriorityBuckets.flat(),
      pullableQueuedMessages: nextPullableQueuedMessages,
    };
  }, [pendingQueuedMessages]);
  useEffect(() => {
    if (reviewableQueuedMessages.length === 0) {
      setQueuedReviewActive(false);
      setSelectedQueuedMessageIndex(0);
      return;
    }
    setSelectedQueuedMessageIndex((current) =>
      Math.min(current, reviewableQueuedMessages.length - 1)
    );
  }, [reviewableQueuedMessages.length]);

  const queuedReviewModeActive =
    queuedReviewActive && reviewableQueuedMessages.length > 0;
  const inputBlockedByOverlay = Boolean(
    pendingConfirmation ||
      pendingAskUser ||
      tokenLimitChoice ||
      sessionSelectorData ||
      settingsSelectorData ||
      showThemeSelector ||
      schedulingOverlay !== 'none' ||
      rewindOptions ||
      copySelectorData ||
      diagnosticsMenu.show ||
      droolsMenu.show ||
      skillsMenu.show ||
      pluginMenu.show ||
      hooksManager.show ||
      reviewManager.show ||
      showCommandsManager ||
      showMcpManager ||
      showApprovalDetails ||
      showDetailedTranscript ||
      showMissionControl ||
      showMissionOnboarding ||
      showSquadMode ||
      showBgProcessManager ||
      bgTasksPanelFocused ||
      showModelSelector ||
      showInlineModelPicker ||
      showMissionModelSelector ||
      pendingMissionModelTarget ||
      showSpecModeConfigurator ||
      (showCompactConfirm && !isCompactProcessing) ||
      showCreateSkillFlow ||
      showSetupIncidentResponseFlow ||
      showReasoningEffortSelector ||
      showLoginSelector ||
      missionsMenuData ||
      fileRestoreData ||
      ideExtensionPromptState.show ||
      ideInstanceSelectorState.show
  );
  const queuedReviewInputActive =
    isQueuedMessagesEnabled && queuedReviewModeActive && !inputBlockedByOverlay;
  useEffect(() => {
    if (queuedReviewActive && !queuedReviewInputActive) {
      setQueuedReviewActive(false);
    }
  }, [queuedReviewActive, queuedReviewInputActive]);
  const selectedQueuedReviewIndex =
    reviewableQueuedMessages.length === 0
      ? 0
      : Math.min(
          selectedQueuedMessageIndex,
          reviewableQueuedMessages.length - 1
        );
  const selectedQueuedReviewMessage =
    reviewableQueuedMessages[selectedQueuedReviewIndex] ?? null;

  const handleOpenQueuedMessageReview = useCallback(() => {
    if (reviewableQueuedMessages.length === 0) {
      return;
    }
    setSelectedQueuedMessageIndex(0);
    setQueuedReviewActive(true);
  }, [reviewableQueuedMessages.length]);

  const handlePullTopQueuedMessageIntoInput = useCallback(async () => {
    if (!effectiveSessionId || pullableQueuedMessages.length === 0) {
      return;
    }

    const item = pullableQueuedMessages[0];
    if (!item) {
      return;
    }

    const manager = getOrCreateSessionQueueManager(effectiveSessionId);
    const queuedMessage = manager?.getQueuedMessage(item.id);
    if (!manager || !queuedMessage) {
      return;
    }

    const { text, images, files } = extractQueuedPromptContent(
      queuedMessage.content
    );
    if ((files?.length ?? 0) > 0) {
      const reviewIndex = reviewableQueuedMessages.findIndex(
        (queuedItem) => queuedItem.id === item.id
      );
      setSelectedQueuedMessageIndex(Math.max(0, reviewIndex));
      setQueuedReviewActive(true);
      return;
    }

    try {
      if (!isDaemonQueuedMessageKind(item.kind)) {
        manager.clearQueuedMessage(item.id);
      } else {
        await getTuiDaemonAdapter().resolveQueuedUserMessage({
          sessionId: effectiveSessionId,
          requestId: item.id,
          action: ResolveQueuedUserMessageAction.Delete,
        });
      }
    } catch (error) {
      logWarn('[App] Failed to pull queued message into input', {
        cause: error,
      });
      addEmphemeralSystemMessage('Failed to pull queued message.', {
        visibility: MessageVisibility.UserOnly,
      });
      return;
    }

    const currentDraft = chatDraftRef.current;
    const nextDraft =
      currentDraft.trim().length > 0 && text.trim().length > 0
        ? `${currentDraft}\n\n${text}`
        : currentDraft || text;

    if (!nextDraft.trim() && (images?.length ?? 0) === 0) {
      return;
    }

    restoredQueuedHeadTextRef.current = nextDraft.trim() || null;
    setChatInputValue(nextDraft);
    if ((images?.length ?? 0) > 0) {
      chatInputApiRef.current?.setImages(images ?? []);
    }
    setQueuedReviewActive(false);
  }, [
    effectiveSessionId,
    pullableQueuedMessages,
    getOrCreateSessionQueueManager,
    reviewableQueuedMessages,
    setChatInputValue,
    addEmphemeralSystemMessage,
  ]);

  const handleResolveQueuedMessage = useCallback(
    async (
      item: (typeof reviewableQueuedMessages)[number],
      action: ResolveQueuedUserMessageAction,
      queuePlacement: QueuePlacement = QueuePlacement.EndOfTurn
    ): Promise<boolean> => {
      if (!effectiveSessionId) {
        return false;
      }

      try {
        if (!isDaemonQueuedMessageKind(item.kind)) {
          const manager = getOrCreateSessionQueueManager(effectiveSessionId);
          const queuedMessage = manager?.getQueuedMessage(item.id);
          if (!manager || !queuedMessage) {
            return true;
          }

          manager.clearQueuedMessage(item.id);
          if (action === ResolveQueuedUserMessageAction.Delete) {
            return true;
          }

          const { text, images, files } = extractQueuedPromptContent(
            queuedMessage.content
          );
          const accepted = await processAndRun(text, images, {
            files,
            queuePlacement,
          });
          if (!accepted) {
            manager.restoreQueuedMessageToFront(queuedMessage);
            return false;
          }

          setQueuedReviewActive(false);
          return true;
        }

        if (action === ResolveQueuedUserMessageAction.UpdateQueue) {
          await getTuiDaemonAdapter().resolveQueuedUserMessage({
            sessionId: effectiveSessionId,
            requestId: item.id,
            action,
            queuePlacement,
          });
        } else {
          await getTuiDaemonAdapter().resolveQueuedUserMessage({
            sessionId: effectiveSessionId,
            requestId: item.id,
            action,
          });
        }
        if (
          action === ResolveQueuedUserMessageAction.UpdateQueue &&
          queuePlacement === QueuePlacement.EndOfTurn
        ) {
          setQueuedReviewActive(false);
        }
        return true;
      } catch (error) {
        logWarn('[App] Failed to resolve queued message', {
          cause: error,
        });
        addEmphemeralSystemMessage('Failed to update queued message.', {
          visibility: MessageVisibility.UserOnly,
        });
        return false;
      }
    },
    [
      effectiveSessionId,
      addEmphemeralSystemMessage,
      getOrCreateSessionQueueManager,
      processAndRun,
    ]
  );

  const handleSendNowSelectedQueuedMessage = useCallback(() => {
    if (!selectedQueuedReviewMessage || queuedReviewResolvingRef.current) {
      return;
    }

    queuedReviewResolvingRef.current = true;
    void handleResolveQueuedMessage(
      selectedQueuedReviewMessage,
      ResolveQueuedUserMessageAction.UpdateQueue,
      QueuePlacement.EndOfTurn
    ).finally(() => {
      queuedReviewResolvingRef.current = false;
    });
  }, [handleResolveQueuedMessage, selectedQueuedReviewMessage]);

  const handleDeleteSelectedQueuedMessage = useCallback(() => {
    if (!selectedQueuedReviewMessage || queuedReviewResolvingRef.current) {
      return;
    }

    queuedReviewResolvingRef.current = true;
    void handleResolveQueuedMessage(
      selectedQueuedReviewMessage,
      ResolveQueuedUserMessageAction.Delete
    )
      .then((success) => {
        if (!success) {
          return;
        }
        if (reviewableQueuedMessages.length <= 1) {
          setQueuedReviewActive(false);
          setSelectedQueuedMessageIndex(0);
          return;
        }
        setSelectedQueuedMessageIndex((current) =>
          Math.min(current, reviewableQueuedMessages.length - 2)
        );
      })
      .finally(() => {
        queuedReviewResolvingRef.current = false;
      });
  }, [
    handleResolveQueuedMessage,
    reviewableQueuedMessages.length,
    selectedQueuedReviewMessage,
  ]);

  const handleClearQueuedMessages = useCallback(async () => {
    if (
      !effectiveSessionId ||
      reviewableQueuedMessages.length === 0 ||
      queuedReviewResolvingRef.current
    ) {
      return;
    }

    queuedReviewResolvingRef.current = true;
    const manager = getOrCreateSessionQueueManager(effectiveSessionId);
    try {
      const localKindsToClear = new Set<QueuedUserMessageKind>();
      const daemonDeletePromises: Promise<void>[] = [];
      for (const item of reviewableQueuedMessages) {
        if (!isDaemonQueuedMessageKind(item.kind)) {
          localKindsToClear.add(item.kind);
          continue;
        }

        daemonDeletePromises.push(
          getTuiDaemonAdapter().resolveQueuedUserMessage({
            sessionId: effectiveSessionId,
            requestId: item.id,
            action: ResolveQueuedUserMessageAction.Delete,
          })
        );
      }

      if (localKindsToClear.size > 0) {
        manager?.clearQueuedMessages(Array.from(localKindsToClear));
      }

      const results = await Promise.allSettled(daemonDeletePromises);
      const rejection = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected'
      );
      if (rejection) {
        throw rejection.reason instanceof Error
          ? rejection.reason
          : new Error(String(rejection.reason));
      }

      setQueuedReviewActive(false);
      setSelectedQueuedMessageIndex(0);
    } catch (error) {
      logWarn('[App] Failed to clear queued messages', {
        cause: error,
      });
      addEmphemeralSystemMessage('Failed to clear queued messages.', {
        visibility: MessageVisibility.UserOnly,
      });
    } finally {
      queuedReviewResolvingRef.current = false;
    }
  }, [
    effectiveSessionId,
    reviewableQueuedMessages,
    getOrCreateSessionQueueManager,
    addEmphemeralSystemMessage,
  ]);

  useEffect(() => {
    if (!keypressProvider) return;

    const handler = (event: KeyEvent) => {
      if (!queuedReviewInputActive) {
        return;
      }

      if (
        matchKeyboardChord(event, 'ctrl-r') ||
        matchKeyboardChord(event, 'escape')
      ) {
        setQueuedReviewActive(false);
        return;
      }

      if (event.key.upArrow) {
        setSelectedQueuedMessageIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (event.key.downArrow) {
        setSelectedQueuedMessageIndex((current) =>
          Math.min(reviewableQueuedMessages.length - 1, current + 1)
        );
        return;
      }

      if (matchKeyboardChord(event, 'ctrl-d')) {
        handleDeleteSelectedQueuedMessage();
        return;
      }

      if (event.key.return) {
        handleSendNowSelectedQueuedMessage();
      }
    };

    keypressProvider.subscribe(handler);
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [
    handleDeleteSelectedQueuedMessage,
    handleSendNowSelectedQueuedMessage,
    keypressProvider,
    queuedReviewInputActive,
    reviewableQueuedMessages.length,
  ]);

  useEffect(() => {
    if (!keypressProvider) return;

    const handler = (event: KeyEvent) => {
      if (
        !matchKeyboardChord(event, 'ctrl-x') ||
        !isQueuedMessagesEnabled ||
        reviewableQueuedMessages.length === 0 ||
        inputBlockedByOverlay ||
        commandMenuVisible ||
        btwScrollViewOpen
      ) {
        return;
      }

      void handleClearQueuedMessages();
    };

    keypressProvider.subscribe(handler);
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [
    commandMenuVisible,
    btwScrollViewOpen,
    handleClearQueuedMessages,
    inputBlockedByOverlay,
    isQueuedMessagesEnabled,
    keypressProvider,
    reviewableQueuedMessages.length,
  ]);

  const hasLocalDeferredQueuedMessages = useMemo(
    () =>
      ssmQueuedMessages.some(
        (item) => item.kind === QueuedUserMessageKind.LocalDeferredAfterEsc
      ),
    [ssmQueuedMessages]
  );

  const hasLocalPausedAfterEscQueuedMessages = useMemo(
    () =>
      ssmQueuedMessages.some(
        (item) => item.kind === QueuedUserMessageKind.LocalPausedAfterEsc
      ),
    [ssmQueuedMessages]
  );
  const shouldBlockForLocalPausedAfterEscQueuedMessages =
    isQueuedMessagesEnabled && hasLocalPausedAfterEscQueuedMessages;

  useEffect(() => {
    if (
      isQueuedMessagesEnabled ||
      !effectiveSessionId ||
      !hasLocalPausedAfterEscQueuedMessages
    ) {
      return;
    }

    const manager = getTuiDaemonAdapter()
      .getSessionStateManager()
      .getSessionManager(effectiveSessionId);
    manager?.clearQueuedMessages(QueuedUserMessageKind.LocalPausedAfterEsc);
    setQueuedReviewActive(false);
  }, [
    effectiveSessionId,
    hasLocalPausedAfterEscQueuedMessages,
    isQueuedMessagesEnabled,
  ]);

  useEffect(() => {
    if (localPausedAutoDrainAwaitingTurnRef.current) {
      if (sessionStatus !== AgentStatusState.Idle) {
        localPausedAutoDrainSawBusyRef.current = true;
      } else if (localPausedAutoDrainSawBusyRef.current && !isCancelling) {
        localPausedAutoDrainAwaitingTurnRef.current = false;
        localPausedAutoDrainSawBusyRef.current = false;
      }
    }

    if (
      !hasLocalPausedAfterEscQueuedMessages &&
      !localPausedAutoDrainAwaitingTurnRef.current
    ) {
      localPausedAutoDrainArmedRef.current = false;
    }
  }, [
    hasLocalDeferredQueuedMessages,
    hasLocalPausedAfterEscQueuedMessages,
    isCancelling,
    sessionStatus,
  ]);

  const isDrainingLocalDeferredQueueRef = useRef(false);

  const drainNextLocalPausedMessage = useCallback(() => {
    if (
      !effectiveSessionId ||
      localPausedAutoDrainInFlightRef.current ||
      localPausedAutoDrainAwaitingTurnRef.current
    ) {
      return;
    }

    const manager = getOrCreateSessionQueueManager(effectiveSessionId);
    const queuedMessage =
      manager?.dequeueQueuedMessage(
        QueuedUserMessageKind.LocalPausedAfterEsc
      ) ?? null;
    if (!manager || !queuedMessage) {
      localPausedAutoDrainArmedRef.current = false;
      return;
    }

    const { text, images, files } = extractQueuedPromptContent(
      queuedMessage.content
    );
    if ((files?.length ?? 0) > 0) {
      manager.restoreQueuedMessageToFront(queuedMessage);
      localPausedAutoDrainArmedRef.current = false;
      setQueuedReviewActive(true);
      return;
    }

    if (!text.trim() && (images?.length ?? 0) === 0) {
      localPausedAutoDrainArmedRef.current = manager
        .getQueuedMessages()
        .some(
          (message) =>
            message.kind === QueuedUserMessageKind.LocalPausedAfterEsc
        );
      return;
    }

    localPausedAutoDrainInFlightRef.current = true;
    void processAndRun(text, images, {
      queuePlacement: QueuePlacement.EndOfLoop,
    })
      .then((accepted) => {
        if (!accepted) {
          manager.restoreQueuedMessageToFront(queuedMessage);
          localPausedAutoDrainArmedRef.current = false;
          return;
        }

        localPausedAutoDrainAwaitingTurnRef.current = true;
        localPausedAutoDrainSawBusyRef.current = false;
        localPausedAutoDrainArmedRef.current = manager
          .getQueuedMessages()
          .some(
            (message) =>
              message.kind === QueuedUserMessageKind.LocalPausedAfterEsc
          );
      })
      .catch((error) => {
        logWarn('[App] Failed to auto-drain paused queued message', {
          cause: error,
        });
        manager.restoreQueuedMessageToFront(queuedMessage);
        localPausedAutoDrainArmedRef.current = false;
      })
      .finally(() => {
        localPausedAutoDrainInFlightRef.current = false;
      });
  }, [effectiveSessionId, getOrCreateSessionQueueManager, processAndRun]);

  useEffect(() => {
    const trimmedInitialPrompt = initialPrompt?.trim();
    if (
      initialPromptSubmittedRef.current ||
      !trimmedInitialPrompt ||
      sessionStatus !== AgentStatusState.Idle
    ) {
      return;
    }

    initialPromptSubmittedRef.current = true;
    void processAndRun(trimmedInitialPrompt);
  }, [initialPrompt, processAndRun, sessionStatus]);

  // Submit one local-deferred queued prompt once the agent has actually settled.
  //
  // When the user presses Esc, the daemon discards its queue and emits
  // QUEUED_MESSAGES_DISCARDED, which the CLI uses to restore the discarded
  // text into the chat input. Anything the user types *during* that window
  // must NOT be sent through the normal daemon path: it would either (a)
  // land in the daemon queue and be wiped by the in-flight discard, or (b)
  // race the stopAgentWithTimeout(1000) guard in handleSubmit if interrupt
  // takes longer than a second. So handleSubmit parks it in SSM under
  // kind: LocalDeferredAfterEsc, and this effect restores the FIFO head into
  // kind: LocalDeferredAfterEsc, and this effect submits the FIFO head once
  // sessionStatus transitions to Idle AND the daemon interrupt
  useEffect(() => {
    if (
      shouldAutoDrainLocalPausedMessage({
        isAutoDrainArmed: localPausedAutoDrainArmedRef.current,
        isSessionIdle: sessionStatus === AgentStatusState.Idle,
        isCancelling,
        hasLocalDeferredMessages: hasLocalDeferredQueuedMessages,
        hasLocalPausedMessages: hasLocalPausedAfterEscQueuedMessages,
        hasDraftText: chatDraftRef.current.trim().length > 0,
        isQueuedReviewActive: queuedReviewActive,
        isDrainInFlight: localPausedAutoDrainInFlightRef.current,
        isAwaitingQueuedTurn: localPausedAutoDrainAwaitingTurnRef.current,
      })
    ) {
      const timer = setTimeout(
        drainNextLocalPausedMessage,
        LOCAL_DEFERRED_QUEUE_DRAIN_DELAY_MS
      );
      return () => clearTimeout(timer);
    }

    if (
      sessionStatus !== AgentStatusState.Idle ||
      isCancelling ||
      !effectiveSessionId ||
      !hasLocalDeferredQueuedMessages ||
      chatDraftRef.current.trim().length > 0 ||
      isDrainingLocalDeferredQueueRef.current
    ) {
      return;
    }

    const timer = setTimeout(() => {
      const adapter = getTuiDaemonAdapter();
      const mgr = adapter
        .getSessionStateManager()
        .getSessionManager(effectiveSessionId);
      const queuedMessage =
        mgr?.dequeueQueuedMessage(
          QueuedUserMessageKind.LocalDeferredAfterEsc
        ) ?? null;
      if (!mgr || !queuedMessage) {
        return;
      }

      const { text, images, files } = extractQueuedPromptContent(
        queuedMessage.content
      );
      if (
        !text.trim() &&
        (images?.length ?? 0) === 0 &&
        (files?.length ?? 0) === 0
      ) {
        return;
      }

      isDrainingLocalDeferredQueueRef.current = true;
      void processAndRun(text, images, {
        files,
      })
        .then((accepted) => {
          if (!accepted) {
            mgr.restoreQueuedMessageToFront(queuedMessage);
          }
        })
        .catch((error) => {
          logWarn('[App] Failed to drain local deferred queued message', {
            cause: error,
          });
          mgr.restoreQueuedMessageToFront(queuedMessage);
        })
        .finally(() => {
          isDrainingLocalDeferredQueueRef.current = false;
        });
    }, LOCAL_DEFERRED_QUEUE_DRAIN_DELAY_MS);

    return () => clearTimeout(timer);
  }, [
    drainNextLocalPausedMessage,
    effectiveSessionId,
    hasLocalDeferredQueuedMessages,
    hasLocalPausedAfterEscQueuedMessages,
    isCancelling,
    processAndRun,
    queuedReviewActive,
    sessionStatus,
    ssmQueuedMessages,
  ]);

  const handleInterrupt = useCallback(async () => {
    const shouldRestoreLocalPausedHead =
      isQueuedMessagesEnabled &&
      !!effectiveSessionId &&
      (() => {
        const queuedMessages =
          getOrCreateSessionQueueManager(
            effectiveSessionId
          )?.getQueuedMessages() ?? [];
        return shouldRestoreLocalPausedQueuedHeadAfterInterrupt(queuedMessages);
      })();

    try {
      if (sessionStatus !== AgentStatusState.Idle) {
        escInterruptRequestedRef.current = true;
      }
      // Use stopAgentWithTimeout which already handles duplicate prevention and timeout.
      // The daemon drains queued messages and emits QUEUED_MESSAGES_DISCARDED;
      // the listener below fills the chat input with the discarded text.
      await stopAgentWithTimeout(2000);
    } catch (error) {
      escInterruptRequestedRef.current = false;
      logWarn('[App] Error during interruption', { cause: error });
    } finally {
      if (shouldRestoreLocalPausedHead && effectiveSessionId) {
        restoreLocalPausedQueuedHead(effectiveSessionId);
      }
    }
  }, [
    effectiveSessionId,
    getOrCreateSessionQueueManager,
    isQueuedMessagesEnabled,
    restoreLocalPausedQueuedHead,
    sessionStatus,
    stopAgentWithTimeout,
  ]);

  const handleCancelTool = useCallback((toolId: string) => {
    void (async () => {
      await processTracker.killToolProcesses(toolId, 'SIGTERM');
      await getTerminalService().killByToolId(toolId);
      // Tool error state is set by the daemon via TOOL_RESULT notification
      // with isError: true when the tool execution is interrupted.
    })();
  }, []);

  const getStoreMessagesForRewind = useCallback(
    (sessionId: string): IndustryDroolMessage[] => {
      try {
        const adapter = getTuiDaemonAdapter();
        const ssm = adapter.getSessionStateManager();
        const mgr = ssm.getSessionManager(sessionId);
        return mgr?.getStore().getMessages() ?? [];
      } catch (error) {
        logWarn('[App] Failed to get session messages for rewind', {
          error,
        });
        return [];
      }
    },
    []
  );

  const getFullHistoryForRewind = useCallback(async (): Promise<
    IndustryDroolMessage[]
  > => {
    // Read session ID directly from SessionService to avoid stale closures.
    // This function is captured by processAndRun which has incomplete deps.
    const sessionService = getSessionService();
    return loadRewindHistory({
      sessionId: sessionService.getCurrentSessionId(),
      getStoreMessages: getStoreMessagesForRewind,
      getPersistedMessageEvents: (sessionId) =>
        sessionService.getAllMessageEvents(sessionId),
      onPersistedReadError: (error) => {
        logWarn('[App] Failed to load persisted session history for rewind', {
          error,
        });
      },
    });
  }, [getStoreMessagesForRewind]);

  // "Is anything else on screen" selector used by the transcript-scroll
  // handler only. The other gated shortcuts (Ctrl+O, Ctrl+T, rewind)
  // keep their own inline OR-chains because they each have product-specified
  // exclusions that don't match a single shared union (e.g. Ctrl+O is still
  // allowed while an AskUser form is pending so users can peek at the
  // transcript).
  const blockingOverlay = useBlockingOverlay({
    detailedTranscript: showDetailedTranscript,
    approvalDetails: showApprovalDetails,
    loginSelector: showLoginSelector,
    diagnosticsMenu: diagnosticsMenu.show,
    droolsMenu: droolsMenu.show,
    skillsMenu: skillsMenu.show,
    pluginMenu: pluginMenu.show,
    hooksManager: hooksManager.show,
    reviewManager: reviewManager.show,
    settingsSelector: !!settingsSelectorData,
    themeSelector: showThemeSelector,
    commandsManager: showCommandsManager,
    mcpManager: showMcpManager,
    bgProcessManager: showBgProcessManager,
    squadMode: showSquadMode,
    missionControl: showMissionControl,
    missionOnboarding: showMissionOnboarding,
    inlineModelPicker: showInlineModelPicker,
    modelSelector: showModelSelector,
    missionModelSelector: showMissionModelSelector,
    pendingMissionModelTarget: !!pendingMissionModelTarget,
    specModeConfigurator: showSpecModeConfigurator,
    compactConfirm: showCompactConfirm && !isCompactProcessing,
    createSkillFlow: showCreateSkillFlow,
    setupIncidentResponseFlow: showSetupIncidentResponseFlow,
    reasoningEffortSelector: showReasoningEffortSelector,
    sessionSelector: !!sessionSelectorData,
    missionsMenu: !!missionsMenuData,
    rewindOptions: !!rewindOptions,
    fileRestore: !!fileRestoreData,
    pendingConfirmation: !!pendingConfirmation,
    pendingAskUser: !!pendingAskUser,
    tokenLimitChoice: !!tokenLimitChoice,
  });

  useEffect(() => {
    if (!keypressProvider) return;

    const handler = (event: KeyEvent) => {
      if (!matchKeyboardChord(event, 'auto-compaction-toggle')) {
        return;
      }

      if (blockingOverlay.isActive || commandMenuVisible || btwScrollViewOpen) {
        return;
      }

      const nextEnabled = !compactionThresholdCheckEnabled;
      void (async () => {
        await updateSettings({ compactionThresholdCheckEnabled: nextEnabled });
      })();
    };

    keypressProvider.subscribe(handler);
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [
    compactionThresholdCheckEnabled,
    blockingOverlay,
    btwScrollViewOpen,
    commandMenuVisible,
    keypressProvider,
    updateSettings,
  ]);

  const handleOpenRewindMenu = useCallback(async (): Promise<boolean> => {
    // Read working state directly from SSM to avoid stale closure issues
    // (processAndRun may capture an old handleOpenRewindMenu reference).
    const currentSessionId = getSessionService().getCurrentSessionId();
    if (currentSessionId) {
      try {
        const adapter = getTuiDaemonAdapter();
        const ssm = adapter.getSessionStateManager();
        const mgr = ssm.getSessionManager(currentSessionId);
        if (mgr && mgr.getDroolWorkingState() !== DroolWorkingState.Idle) {
          return false;
        }
      } catch (error) {
        logWarn('[App] Failed to read session state for rewind gate', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    }

    if (
      pendingConfirmation ||
      sessionSelectorData ||
      settingsSelectorData ||
      showThemeSelector ||
      diagnosticsMenu.show ||
      droolsMenu.show ||
      skillsMenu.show ||
      pluginMenu.show ||
      hooksManager.show ||
      reviewManager.show ||
      showModelSelector ||
      showMissionModelSelector ||
      !!pendingMissionModelTarget ||
      schedulingOverlay !== 'none' ||
      (showCompactConfirm && !isCompactProcessing) ||
      showCreateSkillFlow ||
      showSetupIncidentResponseFlow ||
      showReasoningEffortSelector ||
      showLoginSelector ||
      showCommandsManager ||
      copySelectorData ||
      isRewindProcessing
    ) {
      return false;
    }

    const fullHistory = await getFullHistoryForRewind();
    const options = fullHistory
      .map((message, index) => {
        if (message.role !== 'user') {
          return null;
        }
        if (message.visibility === MessageVisibility.LLMOnly) {
          return null;
        }

        const messageText = extractTextFromLLMMessage(message);
        const preview = createRewindPreview(messageText);

        if (!preview) {
          return null;
        }

        return {
          messageId: message.id,
          preview,
          historyIndex: index,
        } satisfies RewindOption;
      })
      .filter((option): option is RewindOption => option !== null)
      .reverse(); // Show newest messages first

    if (options.length === 0) {
      addEmphemeralSystemMessage(
        getI18n().t('common:appMessages.noPreviousMessages'),
        {
          messageType: MessageType.Text,
          visibility: MessageVisibility.UserOnly,
        }
      );
      return false;
    }

    setRewindOptions(options);
    return true;
  }, [
    pendingConfirmation,
    sessionSelectorData,
    settingsSelectorData,
    showThemeSelector,
    droolsMenu.show,
    skillsMenu.show,
    showModelSelector,
    showMissionModelSelector,
    pendingMissionModelTarget,
    schedulingOverlay,
    showCompactConfirm,
    showCreateSkillFlow,
    showSetupIncidentResponseFlow,
    showReasoningEffortSelector,
    showLoginSelector,
    showCommandsManager,
    copySelectorData,
    isRewindProcessing,
    getFullHistoryForRewind,
    addEmphemeralSystemMessage,
  ]);
  handleOpenRewindMenuRef.current = handleOpenRewindMenu;

  const handleOpenCopySelector = useCallback((): boolean => {
    if (
      pendingConfirmation ||
      sessionSelectorData ||
      settingsSelectorData ||
      showThemeSelector ||
      diagnosticsMenu.show ||
      droolsMenu.show ||
      skillsMenu.show ||
      pluginMenu.show ||
      hooksManager.show ||
      reviewManager.show ||
      showModelSelector ||
      showMissionModelSelector ||
      !!pendingMissionModelTarget ||
      showCompactConfirm ||
      showCreateSkillFlow ||
      showSetupIncidentResponseFlow ||
      showReasoningEffortSelector ||
      showLoginSelector ||
      showCommandsManager ||
      rewindOptions ||
      fileRestoreData ||
      copySelectorData
    ) {
      return false;
    }

    const history = getConversationHistoryForCopy();
    const turns = buildConversationTurns(history);
    const hasLastAssistant =
      findLastTextByRole(history, MessageRole.Assistant) !== null;
    const hasLastUser = findLastTextByRole(history, MessageRole.User) !== null;
    const sessionId = getSessionService().getCurrentSessionId();

    if (!hasLastAssistant && !hasLastUser && !sessionId && turns.length === 0) {
      return false;
    }

    setCopySelectorData({
      turns,
      hasLastAssistant,
      hasLastUser,
      hasSessionId: !!sessionId,
      sessionId,
    });
    return true;
  }, [
    pendingConfirmation,
    sessionSelectorData,
    settingsSelectorData,
    showThemeSelector,
    diagnosticsMenu.show,
    droolsMenu.show,
    skillsMenu.show,
    pluginMenu.show,
    hooksManager.show,
    reviewManager.show,
    showModelSelector,
    showMissionModelSelector,
    pendingMissionModelTarget,
    showCompactConfirm,
    showCreateSkillFlow,
    showSetupIncidentResponseFlow,
    showReasoningEffortSelector,
    showLoginSelector,
    showCommandsManager,
    rewindOptions,
    fileRestoreData,
    copySelectorData,
    addEmphemeralSystemMessage,
  ]);
  handleOpenCopySelectorRef.current = handleOpenCopySelector;

  const handleCopySelectorSelect = useCallback(
    async (selection: CopySelectorSelection) => {
      const data = copySelectorData;
      setCopySelectorData(null);
      if (!data) return;

      let textToCopy: string | null = null;
      const history = getConversationHistoryForCopy();

      if (selection.kind === CopySelectionKind.Quick) {
        switch (selection.quickItem) {
          case CopyQuickItem.LastAssistant:
            textToCopy = findLastTextByRole(history, MessageRole.Assistant);
            break;
          case CopyQuickItem.LastUser:
            textToCopy = findLastTextByRole(history, MessageRole.User);
            break;
          case CopyQuickItem.SessionId:
            textToCopy = data.sessionId;
            break;
          case CopyQuickItem.FullTranscript: {
            const allTurns = data.turns;
            if (allTurns.length > 0) {
              textToCopy = formatTurnRangeTranscript(
                allTurns,
                allTurns[0].turnNumber,
                allTurns[allTurns.length - 1].turnNumber
              );
            }
            break;
          }
          default:
            break;
        }
      } else if (
        selection.kind === CopySelectionKind.Range &&
        selection.rangeStart != null &&
        selection.rangeEnd != null
      ) {
        textToCopy = formatTurnRangeTranscript(
          data.turns,
          selection.rangeStart,
          selection.rangeEnd
        );
      }

      if (!textToCopy) {
        addEmphemeralSystemMessage(
          getI18n().t('commands:slashMessages.copy.noContent'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return;
      }

      const copied = await copyToClipboard(textToCopy);
      if (!copied) {
        addEmphemeralSystemMessage(
          getI18n().t('commands:slashMessages.copy.clipboardFailed'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return;
      }

      const lineCount = countLines(textToCopy);
      addEmphemeralSystemMessage(
        getI18n().t('commands:slashMessages.copy.copied', {
          count: lineCount,
        }),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
    },
    [copySelectorData, addEmphemeralSystemMessage]
  );

  const isChatInputFocused =
    !inputBlockedByOverlay &&
    !bashMode.isExecuting &&
    !isCancelling &&
    !queuedReviewModeActive;

  const resumeSession = useCallback(
    async ({
      sessionId,
      isInitialResume = false,
      skipDaemonEnsure = false,
      skipScheduledTaskLeaveWarning = false,
      scheduledTaskLeaveActionKey = 'session-switch',
      scheduledTaskLeaveRepeatInstruction = 'Select this session again to switch.',
    }: {
      sessionId: string;
      isInitialResume?: boolean;
      skipDaemonEnsure?: boolean;
      skipScheduledTaskLeaveWarning?: boolean;
      scheduledTaskLeaveActionKey?: string;
      scheduledTaskLeaveRepeatInstruction?: string;
    }): Promise<boolean> => {
      if (
        !skipScheduledTaskLeaveWarning &&
        !confirmScheduledTaskLeave({
          actionKey: scheduledTaskLeaveActionKey,
          repeatInstruction: scheduledTaskLeaveRepeatInstruction,
          targetSessionId: sessionId,
        })
      ) {
        return false;
      }

      const currentSessionId = getSessionService().getCurrentSessionId();
      if (currentSessionId && currentSessionId !== sessionId) {
        await holdSessionCrons('session-leave', currentSessionId);
      }

      // Cancel any pending UI expansion from a previous session load
      if (expandUiTimeoutRef.current) {
        clearTimeout(expandUiTimeoutRef.current);
        expandUiTimeoutRef.current = null;
      }

      const cwdBeforeSwitch = process.cwd();

      // Load session via SessionController (updates React state, changes to session's directory automatically)
      const loadedSession = await loadSessionViaController({ sessionId });

      // Load into SessionService for full session data (messages, settings).
      // This also enforces the orchestrator→Mission invariant and provider lock.
      const session = await getSessionService().loadSession(sessionId);

      const effectiveCwd = loadedSession.cwd ?? session.cwd;
      const didChangeDirectory =
        effectiveCwd !== undefined && effectiveCwd !== cwdBeforeSwitch;
      loadSession(session);
      void getTuiDaemonAdapter()
        .ensureConnectedAndGetController()
        .then((controller) =>
          controller.resumeSessionCrons({ sessionId: session.id })
        )
        .then(refreshScheduledTasks)
        .catch((error) => {
          logWarn('[App] Failed to resume session crons', { cause: error });
        });

      if (session.wasTruncatedAtCompaction) {
        const adapter = getTuiDaemonAdapter();
        const ssm = adapter.getSessionStateManager();
        const mgr = ssm.getSessionManager(sessionId);
        if (mgr) {
          const id = generateUUID();
          // Use createdAt=0 so this sorts before all real messages
          mgr.addOptimisticMessage(id, {
            id: `system-${id}`,
            role: ProtocolMessageRole.System,
            content: [
              {
                type: MessageContentBlockType.Text,
                text: getI18n().t(
                  'common:appMessages.restoredSinceLastCompactionCheckpoint'
                ),
              },
            ],
            createdAt: 0,
            updatedAt: 0,
            visibility: MessageVisibility.UserOnly,
          });
        }
      }

      // Eagerly load the session in the daemon now that SSM state is populated.
      // loadSession() above defers the daemon spawn to avoid races during
      // initial render; trigger it here so the child process is ready for
      // operations like rewind that call daemon RPCs directly.
      // This is not awaited as it takes longer and we don't want to block
      // the UI
      if (!skipDaemonEnsure) {
        // Pending elicitation auto-resume is handled daemon-side on loadSession.
        void ensureDaemonSession().catch((error) => {
          logException(error, 'Error ensuring daemon session after resume');
          addEmphemeralSystemMessage(
            getI18n().t('common:appMessages.errorLoadingSession', {
              error: error instanceof Error ? error.message : String(error),
            })
          );
        });
      }

      if (!isInitialResume) {
        setTimeout(() => {
          redrawSession();
        }, 25);
      }

      // Progressively load older messages after initial fast render (doubling)
      const scheduleExpansion = (): void => {
        expandUiTimeoutRef.current = setTimeout(() => {
          const expansionSessionId = getSessionService().getCurrentSessionId();
          if (expansionSessionId !== sessionId) {
            expandUiTimeoutRef.current = null;
            return;
          }

          const adapter = getTuiDaemonAdapter();
          const mssm = adapter.getSessionStateManager();
          const mgr = mssm.getSessionManager(sessionId);
          if (!mgr) {
            scheduleExpansion();
            return;
          }

          const hasMore = mgr.expandUiMessages();
          if (hasMore) {
            scheduleExpansion();
          } else {
            expandUiTimeoutRef.current = null;
          }
        }, 100);
      };
      scheduleExpansion();

      if (didChangeDirectory) {
        addEmphemeralSystemMessage(
          getI18n().t('common:appMessages.restoredWorkingDir', {
            dir: effectiveCwd,
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
      }

      logInfo('[Session] Changed directory on session load', {
        sessionId,
        after: effectiveCwd,
      });
      return true;
    },
    [
      confirmScheduledTaskLeave,
      ensureDaemonSession,
      holdSessionCrons,
      loadSession,
      loadSessionViaController,
      addEmphemeralSystemMessage,
      refreshScheduledTasks,
      runAgent,
    ]
  );

  const handleForkSession = useCallback(async (): Promise<string | null> => {
    if (
      !confirmScheduledTaskLeave({
        actionKey: 'fork-session',
        repeatInstruction: 'Run /fork again to fork this session.',
      })
    ) {
      return null;
    }

    // Fork via daemon lifecycle: ensure → fork RPC → close old → load new
    const newSessionId = await forkDaemonSession();

    await resumeSession({
      sessionId: newSessionId,
      skipScheduledTaskLeaveWarning: true,
    });

    return newSessionId;
  }, [confirmScheduledTaskLeave, forkDaemonSession, resumeSession]);

  // Handle spec approval with new-session handoff directly from the confirmation UI.
  // Same pattern as compactToNewSession / createSkillSession: stop the agent,
  // save the spec, create a new session, and start the agent there.
  const handleSpecNewSessionHandoff = useCallback(
    (payload: ApprovedSpecNewSessionPayload) => {
      if (
        !confirmScheduledTaskLeave({
          actionKey: 'spec-new-session-handoff',
          repeatInstruction:
            'Approve the spec again to launch it in a new session.',
        })
      ) {
        return;
      }

      specHandoffInProgressRef.current = true;
      void (async () => {
        try {
          // 1. Stop the running agent (resolves pending confirmation by cancelling)
          await stopAgentWithTimeout(2000);

          // 2. Save spec file
          const filePath = await saveSpecFile(payload.plan, payload.title);

          // 3. Create new session via SessionController
          const { newSessionId, handoff } = await createSpecHandoffSession({
            ...payload,
            filePath,
          });

          // 4. Resume session (handles all session switching, SSM population, cwd changes)
          await resumeSession({
            sessionId: newSessionId,
            skipDaemonEnsure: true,
            skipScheduledTaskLeaveWarning: true,
          });

          // 5. Initialize daemon session (closes old, spawns new drool process)
          await initializeDaemonSession(newSessionId);

          // 6. Show opening line and run agent
          redrawSession();
          addEmphemeralSystemMessage(handoff.openingLine, {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          });
          specHandoffInProgressRef.current = false;
          void runAgent({ message: handoff.userMessage });
        } catch (error) {
          logException(error, 'Error launching approved spec in new session');
          addEmphemeralSystemMessage(
            error instanceof Error
              ? `Approved spec handoff failed: ${error.message}`
              : 'Approved spec handoff failed.',
            {
              messageType: MessageType.SystemNotification,
              visibility: MessageVisibility.UserOnly,
            }
          );
        } finally {
          specHandoffInProgressRef.current = false;
        }
      })();
    },
    [
      stopAgentWithTimeout,
      confirmScheduledTaskLeave,
      resumeSession,
      initializeDaemonSession,
      addEmphemeralSystemMessage,
      runAgent,
      redrawSession,
    ]
  );

  // Register editor suspend/resume callbacks and sync with keypress provider
  useEffect(() => {
    const editorService = getEditorService();

    editorService.registerCallbacks({
      onSuspend: async () => {
        // IMPORTANT: Turn off raw mode and pause stdin synchronously BEFORE state updates
        // This prevents vim from swallowing input characters
        setRawMode(false);
        if (!stdin.isPaused()) {
          stdin.pause();
        }
        setIsTUISuspended(true);
        await keypressProvider?.setEnabledAndWait?.(false);
      },
      onResume: async () => {
        await keypressProvider?.setEnabledAndWait?.(true);
        restoreInteractiveTerminalState({ setRawMode });
        stdin.resume();
        setIsTUISuspended(false);

        // Redraw session after a brief delay to ensure everything is rendered properly
        setTimeout(() => {
          redrawSession();
        }, 50);
      },
    });
  }, [keypressProvider, stdin, redrawSession, setRawMode]);

  // Handle resumeSessionId prop for CLI --resume flag
  const hasResumedSession = useRef(false);
  useEffect(() => {
    if (resumeSessionId && !hasResumedSession.current) {
      hasResumedSession.current = true;
      // Pass true to indicate this is initial resume - session already loaded by index.ts
      void resumeSession({ sessionId: resumeSessionId, isInitialResume: true });

      // If we changed directories before rendering (via index.ts), show notification
      if (originalCwd && originalCwd !== process.cwd()) {
        addEmphemeralSystemMessage(
          getI18n().t('common:appMessages.restoredWorkingDir', {
            dir: process.cwd(),
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
      }
    }
  }, [resumeSessionId, resumeSession, originalCwd, addEmphemeralSystemMessage]);

  // Eagerly initialize the daemon session on startup so it's ready before
  // the user sends their first message. Skip for resumed sessions —
  // resumeSession() sets pendingDaemonLoadSessionIdRef so the daemon session
  // is created lazily on first interaction. Without this guard, the eager
  // initializeTuiSession races with resumeSession's SSM population and
  // clears the historical messages via ssm.initializeSession().
  const hasEagerlyCreatedDaemonSession = useRef(false);
  useEffect(() => {
    if (hasEagerlyCreatedDaemonSession.current) return;
    if (daemonStartupFailed) return;
    if (!effectiveSessionId) return; // pre-created or resumed session not ready yet
    if (resumeSessionId) return; // defer to resumeSession useEffect — avoid race that wipes history

    hasEagerlyCreatedDaemonSession.current = true;
    void ensureDaemonSession();
  }, [
    daemonStartupFailed,
    effectiveSessionId,
    ensureDaemonSession,
    resumeSessionId,
  ]);

  // Execute the actual rewind after file restoration (or if skipped)
  const executeRewind = useCallback(
    async (
      option: RewindOption,
      filesToRestore: Array<{
        filePath: string;
        contentHash: string;
        size: number;
      }>,
      filesToDelete: Array<{ filePath: string }> = []
    ) => {
      setFileRestoreData(null);
      setIsRewindProcessing(true);

      try {
        // Build the fork title from conversation history
        const fullHistory = await getFullHistoryForRewind();
        const targetIndex = fullHistory.findIndex(
          (message) => message.id === option.messageId
        );

        if (targetIndex === -1) {
          throw new MetaError('Selected message not found in conversation.');
        }

        const historyToCopy = fullHistory.slice(0, targetIndex);
        const selectedMessage = fullHistory[targetIndex];
        const selectedMessageRaw = selectedMessage
          ? extractTextFromLLMMessage(selectedMessage)
          : '';
        const selectedMessageText = selectedMessageRaw.trim();

        const sessionService = getSessionService();
        const currentSessionId = sessionService.getCurrentSessionId();
        const originalTitle = currentSessionId
          ? sessionService.getSessionTitle(currentSessionId)
          : null;

        const firstUserMessage = historyToCopy.find(
          (message) => message.role === 'user'
        );
        const titleSource = firstUserMessage
          ? extractTextFromLLMMessage(firstUserMessage).trim()
          : selectedMessageText;

        const fallbackTitle =
          titleSource || getI18n().t('common:appMessages.newSession');
        const baseTitle =
          originalTitle && originalTitle.trim().length > 0
            ? originalTitle.trim()
            : fallbackTitle;
        const forkTitle = getI18n()
          .t('common:appMessages.forkPrefix', { title: baseTitle })
          .trim();
        if (
          !confirmScheduledTaskLeave({
            actionKey: 'rewind-session',
            repeatInstruction:
              'Run the rewind action again to continue in a new session.',
          })
        ) {
          return;
        }

        // Execute rewind via daemon RPC (file restore + session fork)
        const adapter = getTuiDaemonAdapter();
        const result = await adapter.executeRewind(currentSessionId!, {
          messageId: option.messageId,
          filesToRestore,
          filesToDelete,
          forkTitle,
        });

        if (result.failedRestoreCount > 0) {
          addEmphemeralSystemMessage(
            getI18n().t('common:appMessages.warningFilesNotRestored', {
              count: result.failedRestoreCount,
            }),
            {
              messageType: MessageType.Text,
              visibility: MessageVisibility.UserOnly,
            }
          );
        }

        if (result.failedDeleteCount > 0) {
          addEmphemeralSystemMessage(
            getI18n().t('common:appMessages.warningFilesNotDeleted', {
              count: result.failedDeleteCount,
            }),
            {
              messageType: MessageType.Text,
              visibility: MessageVisibility.UserOnly,
            }
          );
        }

        await resumeSession({
          sessionId: result.newSessionId,
          skipScheduledTaskLeaveWarning: true,
        });

        const cleanedInput =
          stripSystemReminderBlocks(selectedMessageRaw).trim();
        setChatInputValue(cleanedInput);

        const confirmationPreview = createRewindPreview(
          selectedMessageText || option.preview
        );

        const restoredMsg =
          result.restoredCount > 0
            ? ` (${result.restoredCount} file(s) restored)`
            : '';

        addEmphemeralSystemMessage(
          getI18n().t('common:appMessages.rewoundConversation', {
            preview: confirmationPreview,
            restoredMsg,
          }),
          {
            messageType: MessageType.Text,
            visibility: MessageVisibility.UserOnly,
          }
        );
      } catch (error) {
        logException(error, 'Failed to rewind conversation');
        addEmphemeralSystemMessage(getI18n().t('errors:rewindFailed'), {
          messageType: MessageType.Text,
          visibility: MessageVisibility.UserOnly,
        });
      } finally {
        setIsRewindProcessing(false);
      }
    },
    [
      getFullHistoryForRewind,
      confirmScheduledTaskLeave,
      resumeSession,
      setChatInputValue,
      addEmphemeralSystemMessage,
    ]
  );

  const handleRewindSelect = useCallback(
    async (option: RewindOption) => {
      setRewindOptions(null);

      // Check if file snapshots are available for this rewind point via daemon RPC
      try {
        const sessionService = getSessionService();
        const currentSessionId = sessionService.getCurrentSessionId();
        if (currentSessionId) {
          const adapter = getTuiDaemonAdapter();
          const snapshotInfo = await adapter.getRewindInfo(
            currentSessionId,
            option.messageId
          );

          logInfo('[Rewind] Snapshot info for boundary', {
            sessionId: currentSessionId,
            messageId: option.messageId,
            count: snapshotInfo.availableFiles.length,
            // eslint-disable-next-line industry/no-nested-log-metadata -- snapshot file-count breakdown consumed as a unit
            value: {
              created: snapshotInfo.createdFiles.length,
              evicted: snapshotInfo.evictedFiles.length,
            },
          });

          if (
            snapshotInfo.availableFiles.length > 0 ||
            snapshotInfo.createdFiles.length > 0 ||
            snapshotInfo.evictedFiles.length > 0
          ) {
            setFileRestoreData({
              snapshotInfo,
              pendingRewind: option,
              showFileSelection: false,
            });
            return;
          }
        }
      } catch (error) {
        logWarn('[Rewind] Snapshot service error', {
          errorMessage: error instanceof Error ? error.message : 'Unknown',
        });
      }

      // No snapshots available, proceed with rewind directly
      await executeRewind(option, []);
    },
    [executeRewind]
  );

  // Global ESC handling for Kitty CSI-u terminals (e.g., iTerm2, Ghostty)
  // Ensures ESC closes submenus even when Ink doesn't set key.escape
  useEffect(() => {
    if (!keypressProvider) return;
    const handler = (event: KeyEvent): boolean => {
      if (matchKeyboardChord(event, 'ctrl-e')) {
        if (showApprovalDetails) {
          redrawSession();
          closeApprovalDetails();
          return true;
        }

        if (pendingConfirmation && pendingApprovalDetailsKey) {
          clearInkTerminalForSurfaceHandoff();
          openApprovalDetails(pendingApprovalDetailsKey);
          return true;
        }

        return false;
      }

      if (!matchKeyboardChord(event, 'escape')) {
        return false;
      }

      // Ignore ESC while Mission Control is transitioning closed.
      // This avoids competing close/back state updates during teardown.
      if (pendingMissionControlExit) {
        return true;
      }

      if (specHandoffInProgressRef.current) {
        return true;
      }

      // Let BackgroundTasksPanel handle ESC internally.
      if (bgTasksPanelFocused) {
        return false;
      }
      if (btwScrollViewOpen) {
        setBtwScrollViewOpen(false);
        return true;
      }
      if (showApprovalDetails) {
        redrawSession();
        closeApprovalDetails();
        return true;
      }
      if (showDetailedTranscript) {
        redrawSession();
        setDetailedTranscriptMessages([]);
        setShowDetailedTranscript(false);
        return true;
      }
      if (showLoginSelector) {
        setShowLoginSelector(false);
        return true;
      }
      if (showMissionOnboarding) {
        setShowMissionOnboarding(false);
        setMissionGate(null);
        if (pendingMissionEntry) {
          setPendingMissionEntry(false);
        } else {
          getSessionService().setInteractionMode(DroolInteractionMode.Auto);
        }
        return true;
      }
      if (ideExtensionPromptState.show) {
        setIdeExtensionPromptState({ show: false, isUpdate: false });
        return true;
      }
      if (ideInstanceSelectorState.show) {
        setIdeInstanceSelectorState({ show: false });
        return true;
      }
      if (diagnosticsMenu.show) {
        diagnosticsMenu.close();
        return true;
      }
      if (droolsMenu.show) {
        droolsMenu.close();
        return true;
      }
      // SkillsMenu owns Escape so a detail pane can return to its list.
      if (skillsMenu.show) {
        return false;
      }
      if (pluginMenu.show && pluginMenu.flow === 'tabs') {
        pluginMenu.close();
        return true;
      }
      if (hooksManager.show && hooksManager.flow === 'menu') {
        hooksManager.close();
        return true;
      }
      if (reviewManager.show) {
        switch (reviewManager.step) {
          case ReviewStep.Preset:
          case ReviewStep.Results:
            reviewManager.close();
            break;
          case ReviewStep.BaseBranch:
          case ReviewStep.Commit:
          case ReviewStep.CustomInstructions:
            reviewManager.setStep(ReviewStep.Preset);
            break;
          case ReviewStep.Progress:
            if (reviewManager.preset?.id === ReviewPresetType.BaseBranch) {
              reviewManager.setStep(ReviewStep.BaseBranch);
            } else if (reviewManager.preset?.id === ReviewPresetType.Commit) {
              reviewManager.setStep(ReviewStep.Commit);
            } else if (reviewManager.preset?.id === ReviewPresetType.Custom) {
              reviewManager.setStep(ReviewStep.CustomInstructions);
            } else {
              reviewManager.setStep(ReviewStep.Preset);
            }
            break;
          default:
            break;
        }
        return true;
      }
      if (showThemeSelector) {
        setShowThemeSelector(false);
        return true;
      }
      if (showCommandsManager) {
        setShowCommandsManager(false);
        return true;
      }
      if (schedulingOverlay !== 'none') {
        return false;
      }
      if (showMcpManager) {
        setShowMcpManager(false);
        return true;
      }
      if (showBgProcessManager) {
        setShowBgProcessManager(false);
        return true;
      }
      if (showSquadMode) {
        const handled = squadModeRef.current?.handleEsc() ?? false;
        if (!handled) {
          closeSquadMode();
        }
        return true;
      }
      if (showMissionControl) {
        missionControlRef.current?.handleEsc();
        return true;
      }
      if (showSpecModeConfigurator) {
        specModeConfiguratorRef.current?.handleEsc();
        return true;
      }
      if (showInlineModelPicker) {
        setShowInlineModelPicker(false);
        return true;
      }
      if (showModelSelector) {
        return false;
      }
      if (showMissionModelSelector) {
        setShowMissionModelSelector(false);
        returnToMissionModelSelectorRef.current = false;
        return true;
      }
      if (pendingMissionModelTarget) {
        setPendingMissionModelTarget(null);
        setPendingMissionModel(null);
        returnToMissionModelSelectorRef.current = false;
        setShowMissionModelSelector(true);
        return true;
      }
      if (showCompactConfirm) {
        const controller = compactionAbortRef.current;
        if (controller) {
          try {
            controller.abort();
          } catch (error) {
            setIsCompactProcessing(false);
            resetCompressionState();
            logWarn('[App] Failed to abort compaction from ESC handler', {
              errorName: error instanceof Error ? error.name : typeof error,
            });
          }
        } else {
          resetCompressionState();
        }
        return true;
      }
      if (showReasoningEffortSelector) {
        if (pendingMissionModel && pendingMissionModelTarget) {
          setPendingMissionModelTarget(null);
          setPendingMissionModel(null);
          setShowMissionModelSelector(true);
        } else if (returnToMissionModelSelectorRef.current) {
          returnToMissionModelSelectorRef.current = false;
          setPendingModelSelection(null);
          setShowMissionModelSelector(true);
        } else {
          setShowModelSelector(true);
          setPendingModelSelection(null);
          setPendingSpecModelSelection(null);
        }
        setShowReasoningEffortSelector(false);
        return true;
      }
      if (sessionSelectorData) {
        if (sessionListMode !== 'browse') {
          return false;
        }
        setSessionSelectorData(null);
        return true;
      }
      if (missionsMenuData) {
        if (isMissionResumeInProgress) {
          return true;
        }
        setMissionsMenuData(null);
        return true;
      }
      if (rewindOptions) {
        setRewindOptions(null);
        return true;
      }
      if (fileRestoreData) {
        setFileRestoreData(null);
        return true;
      }
      if (pendingConfirmation) {
        const hasInternalEscHandling = pendingConfirmation.tools.some(
          (t) =>
            t.confirmationType === ToolConfirmationType.ProposeMission ||
            t.confirmationType === ToolConfirmationType.ExitSpecMode
        );
        if (hasInternalEscHandling) {
          return false;
        }
        void pendingConfirmation.onConfirm?.(
          ToolConfirmationOutcome.Cancel,
          []
        );
        return true;
      }
      if (pendingAskUser || tokenLimitChoice) {
        return false;
      }
      if (transcriptAnchorIndex !== -1) {
        exitTranscriptScrollToLiveChat();
        return true;
      }
      if (queuedReviewModeActive) {
        setQueuedReviewActive(false);
        return true;
      }
      if (isChatInputFocused) {
        return false;
      }

      return false;
    };
    keypressProvider.subscribe(handler, { layer: KeypressLayer.Navigation });
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [
    keypressProvider,
    bgTasksPanelFocused,
    showApprovalDetails,
    closeApprovalDetails,
    openApprovalDetails,
    pendingApprovalDetailsKey,
    showDetailedTranscript,
    setShowDetailedTranscript,
    showLoginSelector,
    ideExtensionPromptState.show,
    ideInstanceSelectorState.show,
    diagnosticsMenu.show,
    diagnosticsMenu.close,
    droolsMenu.show,
    droolsMenu.close,
    skillsMenu.show,
    pluginMenu.show,
    pluginMenu.close,
    pluginMenu.flow,
    hooksManager.show,
    hooksManager.close,
    hooksManager.flow,
    reviewManager.show,
    reviewManager.step,
    reviewManager.preset,
    reviewManager.close,
    reviewManager.setStep,
    showThemeSelector,
    showCommandsManager,
    schedulingOverlay,
    showMcpManager,
    showBgProcessManager,
    showMissionControl,
    showSquadMode,
    showMissionOnboarding,
    showInlineModelPicker,
    showModelSelector,
    showMissionModelSelector,
    pendingMissionModelTarget,
    showSpecModeConfigurator,
    showCompactConfirm,
    showCreateSkillFlow,
    showSetupIncidentResponseFlow,
    setIsCompactProcessing,
    setShowCompactConfirm,
    setPendingModelSelection,
    showReasoningEffortSelector,
    sessionSelectorData,
    sessionListMode,
    missionsMenuData,
    isMissionResumeInProgress,
    rewindOptions,
    fileRestoreData,
    pendingConfirmation,
    pendingAskUser,
    isChatInputFocused,
    pendingMissionControlExit,
    tokenLimitChoice,
    transcriptAnchorIndex,
    queuedReviewModeActive,
    bashMode.isExecuting,
    cancelBashCommand,
    sessionStatus,
    closeSquadMode,
    handleInterrupt,
    btwScrollViewOpen,
    redrawSession,
    clearInkTerminalForSurfaceHandoff,
    exitTranscriptScrollToLiveChat,
  ]);

  useEffect(() => {
    if (!keypressProvider) return;

    const handler = (event: KeyEvent): boolean => {
      if (!matchKeyboardChord(event, 'escape')) {
        return false;
      }

      const hasHigherPriorityEscOwner =
        blockingOverlay.isActive ||
        bgTasksPanelFocused ||
        btwScrollViewOpen ||
        schedulingOverlay !== 'none' ||
        pendingMissionControlExit ||
        specHandoffInProgressRef.current ||
        transcriptAnchorIndex !== -1;

      if (hasHigherPriorityEscOwner) {
        return false;
      }

      if (bashMode.isExecuting) {
        void cancelBashCommand();
        return true;
      }

      if (sessionStatus !== AgentStatusState.Idle) {
        void handleInterrupt();
        return true;
      }

      return false;
    };

    keypressProvider.subscribe(handler, { layer: KeypressLayer.AgentControl });
    return () => {
      keypressProvider.unsubscribe(handler);
    };
  }, [
    keypressProvider,
    blockingOverlay,
    bgTasksPanelFocused,
    btwScrollViewOpen,
    schedulingOverlay,
    pendingMissionControlExit,
    transcriptAnchorIndex,
    bashMode.isExecuting,
    cancelBashCommand,
    sessionStatus,
    handleInterrupt,
  ]);

  useEffect(() => {
    if (!keypressProvider) return;

    const handler = (event: KeyEvent) => {
      if (!matchKeyboardChord(event, 'ctrl-o')) {
        return;
      }

      // Block Ctrl+O when any overlay is active - each overlay handles Ctrl+O internally if needed
      const hasBlockingOverlay =
        !showDetailedTranscript &&
        (queuedReviewModeActive ||
          showApprovalDetails ||
          showLoginSelector ||
          diagnosticsMenu.show ||
          droolsMenu.show ||
          skillsMenu.show ||
          pluginMenu.show ||
          hooksManager.show ||
          !!settingsSelectorData ||
          showThemeSelector ||
          showCommandsManager ||
          schedulingOverlay !== 'none' ||
          showMissionControl ||
          showSquadMode ||
          showInlineModelPicker ||
          showModelSelector ||
          showMissionModelSelector ||
          !!pendingMissionModelTarget ||
          showCompactConfirm ||
          showCreateSkillFlow ||
          showSetupIncidentResponseFlow ||
          showReasoningEffortSelector ||
          !!sessionSelectorData ||
          !!pendingConfirmation ||
          !!tokenLimitChoice);

      if (hasBlockingOverlay) {
        return;
      }
      if (sessionMessages.length === 0) {
        return;
      }
      const togglingToDetailed = !showDetailedTranscript;
      if (togglingToDetailed) {
        clearInkTerminalForSurfaceHandoff();
        setDetailedTranscriptMessages(uiMessagesRef.current.slice(-50));
      } else {
        redrawSession();
        setDetailedTranscriptMessages([]);
      }
      setShowDetailedTranscript(togglingToDetailed);
    };

    keypressProvider.subscribe(handler, { layer: KeypressLayer.Navigation });
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [
    keypressProvider,
    showDetailedTranscript,
    showApprovalDetails,
    queuedReviewModeActive,
    showLoginSelector,
    droolsMenu.show,
    skillsMenu.show,
    settingsSelectorData,
    showThemeSelector,
    showCommandsManager,
    schedulingOverlay,
    showMissionControl,
    showSquadMode,
    showInlineModelPicker,
    showModelSelector,
    showMissionModelSelector,
    pendingMissionModelTarget,
    showCompactConfirm,
    showCreateSkillFlow,
    showSetupIncidentResponseFlow,
    showReasoningEffortSelector,
    sessionSelectorData,
    pendingConfirmation,
    tokenLimitChoice,
    setShowDetailedTranscript,
    sessionMessages.length,
    redrawSession,
    clearInkTerminalForSurfaceHandoff,
  ]);

  // Global transcript scroll handler - Alt+Up/Down navigate any turn,
  // Alt+PgUp/PgDn navigate user turns only. Anchors the chat view at the
  // selected turn while keeping the normal input area interactive.
  useEffect(() => {
    if (!keypressProvider) return;

    const handler = (event: KeyEvent) => {
      const isAltUp = matchKeyboardChord(event, 'transcript-scroll-up');
      const isAltDown = matchKeyboardChord(event, 'transcript-scroll-down');
      const isAltPgUp = matchKeyboardChord(event, 'transcript-page-scroll-up');
      const isAltPgDn = matchKeyboardChord(
        event,
        'transcript-page-scroll-down'
      );

      if (!isAltUp && !isAltDown && !isAltPgUp && !isAltPgDn) {
        return;
      }

      // Block transcript scrolling while any overlay or blocking UI is
      // active so Alt+Up/Down continues to work as the overlay expects.
      if (blockingOverlay.isActive) {
        return;
      }

      if (uiMessages.length === 0) {
        return;
      }

      const requestedMode: TranscriptAnchorMode =
        isAltPgUp || isAltPgDn
          ? TranscriptAnchorMode.UserOnly
          : TranscriptAnchorMode.Any;
      const anchors = buildTurnAnchors(uiMessages, { mode: requestedMode });
      if (anchors.length === 0) {
        return;
      }

      const current = transcriptAnchorIndex;

      if (isAltUp || isAltPgUp) {
        // Before the first anchor request, treat "no anchor" as "newest" so
        // the very first Alt+Up anchors at the most recent turn instead of
        // jumping to the oldest.
        const previous = resolvePreviousAnchor(anchors, current);
        if (!previous) {
          return;
        }
        enterTranscriptScroll(previous.index, requestedMode);
        return;
      }

      // Alt+Down / Alt+PgDn -> step forwards, or exit scroll mode when at end.
      if (current < 0) {
        // No anchor to move forward from; nothing to do.
        return;
      }

      const next = resolveNextAnchor(anchors, current);
      if (!next) {
        exitTranscriptScrollToLiveChat();
        return;
      }
      enterTranscriptScroll(next.index, requestedMode);
    };

    keypressProvider.subscribe(handler, { layer: KeypressLayer.Navigation });
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [
    keypressProvider,
    uiMessages,
    transcriptAnchorIndex,
    transcriptAnchorMode,
    blockingOverlay,
    exitTranscriptScrollToLiveChat,
    enterTranscriptScroll,
  ]);

  // Exit transcript scroll mode automatically when Ctrl+O detailed view or
  // Mission Control open so the chat view is not left in an inconsistent
  // state when the user returns.
  useEffect(() => {
    if (transcriptAnchorIndex === -1) return;
    if (showDetailedTranscript || showApprovalDetails || showMissionControl) {
      setTranscriptAnchorIndex(-1);
    }
  }, [
    transcriptAnchorIndex,
    showDetailedTranscript,
    showApprovalDetails,
    showMissionControl,
  ]);

  const isMissionMode = interactionMode === DroolInteractionMode.Mission;
  const isMissionActive =
    getSessionService().getDecompSessionType() ===
    DecompSessionType.Orchestrator;

  const handleModeToggle = useCallback(() => {
    // Mission mode cannot be toggled via keyboard - it's a one-way upgrade
    if (isMissionMode || interactionMode === null) {
      return;
    }

    const nextMode =
      interactionMode === DroolInteractionMode.Auto
        ? DroolInteractionMode.Spec
        : DroolInteractionMode.Auto;

    if (nextMode === DroolInteractionMode.Spec) {
      const specSettings: Parameters<typeof updateSettings>[0] = {
        interactionMode: nextMode,
      };
      if (specModeModel !== undefined) {
        specSettings.specModeModelId = specModeModel;
        if (specReasoningEffort !== null) {
          specSettings.specModeReasoningEffort = specReasoningEffort;
        }
      }
      void updateSettings(specSettings);
    } else {
      void updateSettings({ interactionMode: nextMode });
    }
  }, [
    interactionMode,
    isMissionMode,
    specModeModel,
    specReasoningEffort,
    updateSettings,
  ]);

  // Global Ctrl+T handler - toggle Mission Control in orchestrator sessions
  useEffect(() => {
    if (!keypressProvider) return;

    const handler = (event: KeyEvent) => {
      if (!matchKeyboardChord(event, 'ctrl-t')) {
        return;
      }

      if (pendingMissionControlExit) {
        return;
      }

      if (showSquadMode) {
        return;
      }

      // If Mission Control is already open, close it directly (from any subview)
      if (showMissionControl) {
        closeMissionControl();
        return;
      }

      // Block the Mission Control shortcut when other overlays are active (not Mission Control)
      const hasBlockingOverlay =
        showDetailedTranscript ||
        queuedReviewModeActive ||
        showApprovalDetails ||
        showLoginSelector ||
        diagnosticsMenu.show ||
        droolsMenu.show ||
        skillsMenu.show ||
        pluginMenu.show ||
        hooksManager.show ||
        reviewManager.show ||
        !!settingsSelectorData ||
        showCommandsManager ||
        schedulingOverlay !== 'none' ||
        showMcpManager ||
        showBgProcessManager ||
        showModelSelector ||
        showMissionModelSelector ||
        !!pendingMissionModelTarget ||
        showSpecModeConfigurator ||
        showCompactConfirm ||
        showCreateSkillFlow ||
        showSetupIncidentResponseFlow ||
        showReasoningEffortSelector ||
        !!sessionSelectorData ||
        !!missionsMenuData ||
        !!rewindOptions ||
        !!fileRestoreData ||
        !!pendingConfirmation ||
        !!pendingAskUser;

      if (hasBlockingOverlay) {
        return;
      }

      // Check if current session is an orchestrator session
      const sessionService = getSessionService();

      if (
        !isMissionOrchestratorSession(sessionService.getCurrentSessionTags())
      ) {
        if (isWindowsLike() && isChatInputFocused && !isMissionMode) {
          handleModeToggle();
          return;
        }

        if (sessionStatus !== AgentStatusState.Idle) {
          return;
        }

        // Show guidance message (same as /mission command)
        addEmphemeralSystemMessage(
          getI18n().t('common:appMessages.missionRequiresOrchestrator'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return;
      }

      // Open Mission Control (clear terminal for true full-screen experience)
      openMissionControl();
    };

    keypressProvider.subscribe(handler, { layer: KeypressLayer.Navigation });
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [
    keypressProvider,
    showMissionControl,
    showSquadMode,
    showDetailedTranscript,
    queuedReviewModeActive,
    showApprovalDetails,
    showLoginSelector,
    diagnosticsMenu.show,
    droolsMenu.show,
    skillsMenu.show,
    pluginMenu.show,
    hooksManager.show,
    reviewManager.show,
    settingsSelectorData,
    showCommandsManager,
    schedulingOverlay,
    showMcpManager,
    showBgProcessManager,
    showModelSelector,
    showMissionModelSelector,
    pendingMissionModelTarget,
    showSpecModeConfigurator,
    showCompactConfirm,
    showCreateSkillFlow,
    showSetupIncidentResponseFlow,
    showReasoningEffortSelector,
    sessionSelectorData,
    missionsMenuData,
    rewindOptions,
    fileRestoreData,
    pendingConfirmation,
    pendingAskUser,
    pendingMissionControlExit,
    sessionStatus,
    isChatInputFocused,
    isMissionMode,
    handleModeToggle,
    addEmphemeralSystemMessage,
    openMissionControl,
    closeMissionControl,
  ]);

  // Ctrl+Y handling to open /btw scroll view
  useEffect(() => {
    if (!keypressProvider) return;

    const handler = (event: KeyEvent) => {
      if (!matchKeyboardChord(event, 'ctrl-y')) return;

      if (btwScrollViewOpen) {
        setBtwScrollViewOpen(false);
        return;
      }

      const hasBlockingOverlay =
        showDetailedTranscript ||
        queuedReviewModeActive ||
        showApprovalDetails ||
        showLoginSelector ||
        diagnosticsMenu.show ||
        droolsMenu.show ||
        skillsMenu.show ||
        pluginMenu.show ||
        hooksManager.show ||
        reviewManager.show ||
        !!settingsSelectorData ||
        showThemeSelector ||
        showCommandsManager ||
        showSquadMode ||
        showMcpManager ||
        showBgProcessManager ||
        showInlineModelPicker ||
        showModelSelector ||
        showMissionModelSelector ||
        !!pendingMissionModelTarget ||
        showSpecModeConfigurator ||
        showCompactConfirm ||
        showCreateSkillFlow ||
        showSetupIncidentResponseFlow ||
        showReasoningEffortSelector ||
        !!sessionSelectorData ||
        !!rewindOptions ||
        !!fileRestoreData ||
        !!pendingConfirmation ||
        !!pendingAskUser ||
        !!tokenLimitChoice;

      if (hasBlockingOverlay) return;

      setBtwScrollViewOpen(true);
    };

    keypressProvider.subscribe(handler, { layer: KeypressLayer.Navigation });
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [
    keypressProvider,
    btwScrollViewOpen,
    showDetailedTranscript,
    queuedReviewModeActive,
    showApprovalDetails,
    showLoginSelector,
    diagnosticsMenu.show,
    droolsMenu.show,
    skillsMenu.show,
    pluginMenu.show,
    hooksManager.show,
    reviewManager.show,
    settingsSelectorData,
    showThemeSelector,
    showCommandsManager,
    showSquadMode,
    showMcpManager,
    showBgProcessManager,
    showInlineModelPicker,
    showModelSelector,
    showMissionModelSelector,
    pendingMissionModelTarget,
    showSpecModeConfigurator,
    showCompactConfirm,
    showCreateSkillFlow,
    showSetupIncidentResponseFlow,
    showReasoningEffortSelector,
    sessionSelectorData,
    rewindOptions,
    fileRestoreData,
    pendingConfirmation,
    pendingAskUser,
    tokenLimitChoice,
  ]);

  // Ctrl+J handling to dismiss changelog
  useEffect(() => {
    if (!keypressProvider) return;

    const handler = (event: KeyEvent) => {
      if (!matchKeyboardChord(event, 'ctrl-j')) return;

      if (getChangelog()) {
        dismissChangelog();
      } else if (isChangelogDismissed()) {
        if (!restoreChangelog()) return;
      } else {
        return;
      }

      redrawSession();
    };

    keypressProvider.subscribe(handler, { layer: KeypressLayer.System });
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [keypressProvider, redrawSession]);

  // Nudge: suggest /terminal-setup if needed for this terminal
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import('@/utils/terminalSetup');
        if (!mod?.shouldNudgeTerminalSetup) return;
        const res = await mod.shouldNudgeTerminalSetup({
          includeCtrlEnter: isQueuedMessagesEnabled,
        });
        if (!cancelled && res.shouldNudge) {
          const nameMap: Record<string, string> = {
            vscode: 'VS Code',
            cursor: 'Cursor',
            windsurf: 'Windsurf',
            'windows-terminal': 'Windows Terminal',
            tmux: 'tmux',
          };
          const term = res.terminal
            ? (nameMap[res.terminal] ??
              getI18n().t('common:appMessages.yourTerminal'))
            : getI18n().t('common:appMessages.yourTerminal');
          const hint =
            isQueuedMessagesEnabled &&
            (res.terminal === 'windows-terminal' ||
              res.terminal === 'vscode' ||
              res.terminal === 'cursor' ||
              res.terminal === 'windsurf')
              ? 'Shift+Enter/Ctrl+Enter'
              : 'Shift+Enter';
          addEmphemeralSystemMessage(
            getI18n().t('common:appMessages.terminalSetupTip', { hint, term }),
            {
              messageType: MessageType.Text,
              visibility: MessageVisibility.UserOnly,
              transient: true,
            }
          );
        }
      } catch (error) {
        logWarn('[App] Failed to show initial startup message', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addEmphemeralSystemMessage, isQueuedMessagesEnabled]);

  const handleSessionSelect = useCallback(
    async (sessionId: string) => {
      try {
        const didResume = await resumeSession({ sessionId });
        if (!didResume) {
          return;
        }
      } catch (error) {
        logException(error, 'Failed to load session from session selector');
        addEmphemeralSystemMessage(
          getI18n().t('commands:slashMessages.errorLoadingSession'),
          {
            messageType: MessageType.Text,
          }
        );
      }
      setSessionSelectorData(null);
    },
    [resumeSession, addEmphemeralSystemMessage]
  );

  const handleAutomationSessionSelect = useCallback(
    async (sessionId: string): Promise<boolean> => {
      try {
        const didResume = await resumeSession({ sessionId });
        if (!didResume) {
          return false;
        }
      } catch (error) {
        logException(error, 'Failed to load automation run session');
        return false;
      }
      setSchedulingOverlay('none');
      return true;
    },
    [resumeSession]
  );

  const refreshSessionSelectorData = useCallback(async () => {
    const sessionService = getSessionService();
    await sessionService.syncPinnedSessions();
    const sessions = await sessionService.getAllNonEmptySessions({
      currentCwd: process.cwd(),
      fetchOutsideCWD: true,
      maxOtherSessions: SESSION_SELECTOR_MAX_OTHER_SESSIONS,
    });

    setSessionSelectorData((current) => {
      if (current === null) {
        return current;
      }

      return areSessionListsEquivalent(current, sessions) ? current : sessions;
    });
  }, []);

  const handleSessionRename = useCallback(
    async (sessionId: string, newTitle: string) => {
      try {
        const adapter = getTuiDaemonAdapter();
        await adapter.renameSession(sessionId, newTitle);
        await refreshSessionSelectorData();
      } catch (error) {
        logException(error, 'Failed to rename session');
        addEmphemeralSystemMessage(
          getI18n().t('commands:slashMessages.errorRenamingSession'),
          {
            messageType: MessageType.Text,
          }
        );
      }
    },
    [addEmphemeralSystemMessage, refreshSessionSelectorData]
  );

  const handleSessionArchive = useCallback(
    async (sessionId: string) => {
      try {
        const sessionService = getSessionService();
        await sessionService.archiveSession(sessionId);
        await refreshSessionSelectorData();
      } catch (error) {
        logException(error, 'Failed to archive session');
        addEmphemeralSystemMessage(
          getI18n().t('commands:slashMessages.errorArchivingSession'),
          {
            messageType: MessageType.Text,
          }
        );
      }
    },
    [addEmphemeralSystemMessage, refreshSessionSelectorData]
  );

  const isSessionSelectorOpen = sessionSelectorData !== null;

  useEffect(() => {
    if (!isSessionSelectorOpen || sessionListMode !== 'browse') {
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      try {
        await refreshSessionSelectorData();
      } catch (error) {
        if (!cancelled) {
          logWarn('[App] Failed to refresh session selector data', {
            cause: error,
          });
        }
      }
    };

    void refresh();

    return () => {
      cancelled = true;
    };
  }, [isSessionSelectorOpen, refreshSessionSelectorData, sessionListMode]);

  const handleMissionSelect = useCallback(
    async (mission: MissionMetadata) => {
      if (isMissionResumeInProgress) return;

      // Check if mission has an error before attempting to resume
      if (mission.hasError) {
        let errorMessage = getI18n().t('common:missionResume.cannotResume');

        switch (mission.errorType) {
          case MissionErrorType.InvalidJson:
            errorMessage += getI18n().t('common:missionResume.invalidJson');
            break;
          case MissionErrorType.PermissionDenied:
            errorMessage += getI18n().t(
              'common:missionResume.permissionDenied'
            );
            break;
          case MissionErrorType.MissingTranscript:
            errorMessage += getI18n().t(
              'common:missionResume.missingTranscript'
            );
            break;
          case MissionErrorType.ReadError:
          default:
            errorMessage += getI18n().t('common:missionResume.readError');
        }

        // Include the error path if available
        if (mission.errorPath) {
          errorMessage += getI18n().t('common:missionResume.path', {
            path: mission.errorPath,
          });
        }

        // Include the specific error message if available
        if (mission.errorMessage) {
          errorMessage += getI18n().t('common:missionResume.details', {
            details: mission.errorMessage,
          });
        }

        addEmphemeralSystemMessage(errorMessage, {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        });

        // Close the picker and return to chat
        setMissionsMenuData(null);
        return;
      }

      setIsMissionResumeInProgress(true);

      try {
        // Keep the MissionsList visible while loading the session. It acts as
        // a shield that prevents the heavy chat UI tree (ChatInput +
        // MessageList) from rendering during the session state changes. This
        // avoids yoga WASM "Out of bounds memory access" crashes caused by
        // rapid mount/unmount of the complex chat component tree.
        getConversationStateManager().setUiUpdatesSuspended(true);

        // Load the session while the picker is still visible
        const didResume = await resumeSession({
          sessionId: mission.baseSessionId,
          scheduledTaskLeaveActionKey: 'mission-resume',
          scheduledTaskLeaveRepeatInstruction:
            'Select this mission again to resume it.',
        });
        if (!didResume) {
          getConversationStateManager().setUiUpdatesSuspended(false);
          return;
        }

        // Upgrade to orchestrator if needed (this ensures proper session type)
        const sessionService = getSessionService();
        if (
          !isMissionOrchestratorSession(sessionService.getCurrentSessionTags())
        ) {
          await sessionService.upgradeToOrchestratorSession();
          setSessionTypeVersion((v) => v + 1);
        }

        if (mission.state === MissionState.Planning) {
          getConversationStateManager().setUiUpdatesSuspended(false);
          setMissionsMenuData(null);
        } else {
          setMissionsMenuData(null);
          openMissionControl();
        }
      } catch (error) {
        getConversationStateManager().setUiUpdatesSuspended(false);
        setMissionsMenuData(null);
        logException(error, 'Failed to load mission');
        addEmphemeralSystemMessage(
          getI18n().t('commands:slashMessages.errorLoadingMission'),
          {
            messageType: MessageType.Text,
          }
        );
      } finally {
        setIsMissionResumeInProgress(false);
      }
    },
    [
      isMissionResumeInProgress,
      resumeSession,
      addEmphemeralSystemMessage,
      openMissionControl,
    ]
  );

  // Performs the actual conversion of the session into a mission. This must
  // only run after the readiness gate has been cleared, so the session is never
  // upgraded to an orchestrator until the user explicitly proceeds.
  const performEnterMission = useCallback(async () => {
    try {
      const result = await enterMissionMode();
      setMissionsMenuData(null);

      // Propagate the resolved settings (including tags) explicitly to the
      // daemon so it knows this is an orchestrator session and injects the
      // mission system prompt.
      await updateSettings({
        interactionMode: DroolInteractionMode.Mission,
        modelId: result.modelId,
        reasoningEffort: result.reasoningEffort,
        tags: result.tags,
      });

      addEmphemeralSystemMessage(
        result.wasNew
          ? getI18n().t('commands:slashMessages.enteredMission')
          : getI18n().t('commands:slashMessages.alreadyInMission'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
    } catch (error) {
      setMissionsMenuData(null);
      logException(error, 'Failed to enter mission mode');
      const errorMessage =
        error instanceof Error && error.message
          ? error.message
          : getI18n().t('commands:slashMessages.errorCreatingSession');
      addEmphemeralSystemMessage(errorMessage, {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
    }
  }, [addEmphemeralSystemMessage, updateSettings]);

  const handleNewMission = useCallback(async () => {
    // Evaluate the readiness gate BEFORE converting the session into a mission.
    // The modal is shown first so that cancelling leaves the session untouched.
    setMissionsMenuData(null);
    setMissionGateEvaluating(true);

    // Enforce mission access policy and overage limits before showing the gate,
    // so a restricted user sees the restriction error rather than the gate.
    try {
      await assertMissionEntryAllowed();
    } catch (error) {
      setMissionGateEvaluating(false);
      logException(error, 'Mission entry not allowed');
      const errorMessage =
        error instanceof Error && error.message
          ? error.message
          : getI18n().t('commands:slashMessages.errorCreatingSession');
      addEmphemeralSystemMessage(errorMessage, {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
      return;
    }

    const firstTime = !getSettingsService().getHasSeenMissionOnboarding();
    let gate: MissionReadinessGateResult | null = null;
    try {
      gate = await evaluateMissionReadinessForCwd();
    } catch (error) {
      logException(error, 'Failed to evaluate mission readiness gate');
    } finally {
      setMissionGateEvaluating(false);
    }
    setMissionGate(gate);

    if (firstTime || (gate && gate.state !== MissionReadinessGateState.Ok)) {
      setPendingMissionEntry(true);
      setShowMissionOnboarding(true);
      return;
    }

    await performEnterMission();
  }, [performEnterMission, addEmphemeralSystemMessage]);

  const handleExitMission = useCallback(async () => {
    try {
      await gracefulMissionExit();

      const sessionService = getSessionService();
      await sessionService.downgradeFromOrchestratorSession();
      sessionService.setInteractionMode(DroolInteractionMode.Auto);
      setMissionsMenuData(null);

      await updateSettings({
        interactionMode: DroolInteractionMode.Auto,
        tags: sessionService.getCurrentSessionTags() ?? [],
      });

      addEmphemeralSystemMessage(
        getI18n().t('commands:slashMessages.exitedMission'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
    } catch (error) {
      setMissionsMenuData(null);
      logException(error, 'Failed to exit mission mode');
      addEmphemeralSystemMessage(
        getI18n().t('commands:slashMessages.errorExitingMission'),
        {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        }
      );
    }
  }, [addEmphemeralSystemMessage, updateSettings]);

  const handleMissionRename = useCallback(
    async (missionId: string, newTitle: string) => {
      try {
        const missionFileService = getMissionFileService(missionId);
        const existingContent = await missionFileService.readMissionMd();
        if (existingContent) {
          // Replace the first heading with the new title
          const updated = existingContent.replace(
            /^#\s+.+$/m,
            () => `# ${newTitle}`
          );
          const fs = await import('fs/promises');
          const paths = missionFileService.getFilePaths();
          await fs.default.writeFile(paths.missionMd, updated);
        }
        // Refresh the missions list
        setMissionsMenuData((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            missions: prev.missions.map((m) =>
              m.baseSessionId === missionId ? { ...m, title: newTitle } : m
            ),
          };
        });
      } catch (error) {
        logException(error, 'Failed to rename mission');
        addEmphemeralSystemMessage(
          getI18n().t('commands:slashMessages.errorCreatingSession'),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
      }
    },
    [addEmphemeralSystemMessage]
  );

  const handleBashSubmit = useCallback(
    async (command: string) => {
      try {
        // Show that command is running
        addEmphemeralSystemMessage(
          getI18n().t('commands:slashMessages.running', { command }),
          {
            messageType: MessageType.Text,
          }
        );

        // Execute the bash command
        const result = await executeBashCommand(command);

        // Add the command output as a user message without starting the agent loop
        const formattedMessage = formatBashCommandMessage(result);
        await addUserMessage(formattedMessage);
      } catch (error) {
        logException(error, 'Failed to execute bash command');
        addEmphemeralSystemMessage(
          getI18n().t('commands:slashMessages.errorExecutingCommand', {
            error: String(error),
          }),
          {
            messageType: MessageType.Text,
          }
        );
      }
    },
    [executeBashCommand, addEmphemeralSystemMessage, addUserMessage]
  );

  const handleReasoningCycle = useCallback(() => {
    const isSpecMode = interactionMode === DroolInteractionMode.Spec;
    const hasExplicitSpecModel = specModeModel !== undefined;

    const currentModel =
      isSpecMode && hasExplicitSpecModel ? specModeModel : mainModel;
    if (!currentModel) {
      return;
    }
    const { supportedReasoningEfforts } = getTuiModelConfig(currentModel);

    if (supportedReasoningEfforts.length <= 1) {
      return;
    }

    if (isSpecMode && hasExplicitSpecModel) {
      if (specReasoningEffort === null) {
        return;
      }
      const nextEffort = calculateNextReasoningEffort(
        currentModel,
        specReasoningEffort
      );
      void updateSettings({ specModeReasoningEffort: nextEffort });
    } else {
      if (mainReasoningEffort === null) {
        return;
      }
      const nextEffort = calculateNextReasoningEffort(
        currentModel,
        mainReasoningEffort
      );
      void updateSettings({ reasoningEffort: nextEffort });
    }
  }, [
    interactionMode,
    mainModel,
    mainReasoningEffort,
    specModeModel,
    specReasoningEffort,
    updateSettings,
  ]);

  // Get available models for cycling
  const availableModels = useAvailableModels();
  const modelFavoritesKey = getSettingsService().getModelFavorites().join('\0');
  const modelCycleCandidates = useMemo(
    () => getSettingsService().getModelCycleCandidates(availableModels),
    [availableModels, modelFavoritesKey]
  );
  const allModelsBlocked =
    !getSettingsService().hasAnyAvailableModel(availableModels);
  // Under airgap the built-in catalog is hidden by design, so "blocked by
  // your settings" would mislead; point the operator at BYOK setup instead.
  const allModelsBlockedMessageKey = getRuntimeAuthConfig().airgapEnabled
    ? ('common:appMessages.allModelsBlockedAirgap' as const)
    : ('common:appMessages.allModelsBlocked' as const);

  const handleAutonomyLevelCycle = useCallback(() => {
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();
    const sessionStore = effectiveSessionId
      ? ssm.getSessionManager(effectiveSessionId)?.getStore()
      : null;
    const currentAutonomyLevel =
      pendingAutonomyLevelRef.current ??
      latestAutonomyLevelRef.current ??
      sessionStore?.getAutonomyLevel() ??
      ssm.getDefaultSettingsStore().getAutonomyLevel() ??
      autonomyLevel;
    if (currentAutonomyLevel === null) {
      return;
    }
    const maxLevel = getSettingsService().getMaxAutonomyLevel();
    const nextLevel = getNextAutonomyLevelInCycle(
      currentAutonomyLevel,
      maxLevel
    );
    pendingAutonomyLevelRef.current = nextLevel;
    latestAutonomyLevelRef.current = nextLevel;
    void updateSettings({ autonomyLevel: nextLevel });
  }, [updateSettings, autonomyLevel, effectiveSessionId]);

  // Refs for values used inside handleSubmit that should not cause it to
  // be recreated (isCancelling changes frequently, the others are stable
  // but were missing from the dependency array).
  const sessionStatusRef = useRef(sessionStatus);
  sessionStatusRef.current = sessionStatus;
  const isCancellingRef = useRef(isCancelling);
  isCancellingRef.current = isCancelling;
  const stopAgentWithTimeoutRef = useRef(stopAgentWithTimeout);
  stopAgentWithTimeoutRef.current = stopAgentWithTimeout;

  const handleSubmit = useCallback(
    async (
      text: string,
      images?: ImageAttachment[],
      options?: ChatSubmitOptions
    ) => {
      const trimmedText = text.trim();
      if (!trimmedText) return;

      // Exit transcript scroll mode on submit so the newly sent message and
      // any incoming response render in the live chat view.
      exitTranscriptScrollToLiveChat();

      const lowerTrimmed = trimmedText.toLowerCase();
      const isModelSetupCommand =
        lowerTrimmed === '/model' || lowerTrimmed.startsWith('/model ');
      const isProviderSetupCommand =
        lowerTrimmed === '/provider' || lowerTrimmed.startsWith('/provider ');

      if (allModelsBlocked && !isProviderSetupCommand && !isModelSetupCommand) {
        addEmphemeralSystemMessage(getI18n().t(allModelsBlockedMessageKey), {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        });
        return;
      }

      const firstNonWhitespaceChar = trimmedText[0];
      const isSlashCommand = firstNonWhitespaceChar === '/';
      const isDeferredSlashPrompt =
        isSlashCommand &&
        commandRegistry.hasDeferredPromptResolver(trimmedText.slice(1));
      const blocksRunningSessionQueue =
        isSlashCommand && !isDeferredSlashPrompt;
      // /btw is a special case: it intentionally runs on a hidden fork
      // session, so it is safe (and required) to allow mid-run.
      const isBtwSlashCommand =
        isSlashCommand &&
        (lowerTrimmed === '/btw' || lowerTrimmed.startsWith('/btw '));
      const submittedText = trimmedText;
      const restoredQueuedHeadText = restoredQueuedHeadTextRef.current;
      const isRestoredQueuedHeadSubmission =
        !blocksRunningSessionQueue &&
        restoredQueuedHeadText !== null &&
        submittedText === restoredQueuedHeadText;
      const shouldArmAutoDrain = shouldArmLocalPausedAutoDrain({
        isRestoredQueuedHeadSubmission,
        hasLocalPausedMessages: hasLocalPausedAfterEscQueuedMessages,
      });

      if (isRestoredQueuedHeadSubmission) {
        restoredQueuedHeadTextRef.current = null;
        escInterruptRequestedRef.current = false;
      }

      if (isCompactProcessing) {
        if (!blocksRunningSessionQueue) {
          queueManualCompactionMessage(submittedText, images, options?.files);
        }
        return;
      }

      const agentRunning = isAgentRunning();
      const submittedQueuePlacement = getEnabledQueuePlacement(
        options?.queuePlacement
      );
      if (
        shouldQueueBehindLocalPausedMessages({
          hasLocalPausedMessages:
            shouldBlockForLocalPausedAfterEscQueuedMessages,
          isSlashCommand: blocksRunningSessionQueue,
          isRestoredQueuedHeadSubmission,
          isAgentRunning: agentRunning,
          isCancelling: isCancellingRef.current,
          queuePlacement: submittedQueuePlacement,
        })
      ) {
        queueLocalPausedMessage(submittedText, images, options?.files);
        return;
      }

      // Queueable prompts must be parked locally whenever an Esc interrupt is
      // still settling, so we never race the daemon's
      // QUEUED_MESSAGES_DISCARDED drain. Three signals cover this:
      //   1. Existing LocalDeferredAfterEsc items (FIFO preservation).
      //   2. Esc was synchronously requested, but React has not necessarily
      //      rendered `isCancelling` yet.
      //   3. `isCancelling` is still true — the daemon interrupt is in
      //      flight even though sessionStatus may already say Idle. Without
      //      this, a follow-up prompt would be sent as a new turn AND
      //      restored into the chat input from the discard notification,
      //      producing the duplicate-user-message bug (FAC-19025).
      // The Esc flag is deliberately consumed here (and on restored-head
      // submissions) instead of being reset when the session reports Idle:
      // a time-based reset re-opens the FAC-19025 window between
      // stopAgentWithTimeout resolving and QUEUED_MESSAGES_DISCARDED
      // arriving. Accepted cost: the first prompt after an Esc interrupt
      // drains through the local deferred queue (~100 ms).
      const shouldDeferUntilInterruptSettles =
        !blocksRunningSessionQueue &&
        !isRestoredQueuedHeadSubmission &&
        (hasLocalDeferredQueuedMessages ||
          escInterruptRequestedRef.current ||
          isCancellingRef.current);

      if (shouldDeferUntilInterruptSettles) {
        escInterruptRequestedRef.current = false;
        queueLocalDeferredMessage(submittedText, images, options?.files);
        return;
      }

      // Wait for any ongoing cancellation to complete. /btw bypasses this:
      // it targets a different session, so an in-flight cancel on the main
      // session should not block it.
      if (isCancellingRef.current && !isBtwSlashCommand) {
        try {
          await stopAgentWithTimeoutRef.current(1000);
        } catch (error) {
          logWarn('[App] Cancellation timeout while waiting for submission', {
            cause: error,
          });
        }
      }

      // Non-deferred slash commands are not allowed mid-run; the user can
      // only invoke them when the agent is idle. /btw is the single exception
      // because it runs against a hidden fork session rather than the main one.
      if (agentRunning && blocksRunningSessionQueue && !isBtwSlashCommand)
        return;

      // processAndRun → runAgent → DaemonSessionController.addUserMessage
      // already gates on DroolWorkingState: it streams immediately when the
      // drool is idle and queues the message in SSM when the drool is busy.
      // Enter uses the steering queue drained between tool calls; Ctrl+Enter
      // uses the end-of-loop queue when queued messages are enabled.
      const accepted = await processAndRun(submittedText, images, options);
      if (accepted && shouldArmAutoDrain) {
        localPausedAutoDrainArmedRef.current = true;
      }
      if (!accepted && !blocksRunningSessionQueue) {
        if (shouldArmAutoDrain) {
          localPausedAutoDrainArmedRef.current = false;
        }
        addEmphemeralSystemMessage(
          'Failed to send message. Please try again.',
          { visibility: MessageVisibility.UserOnly }
        );
      }
    },
    [
      processAndRun,
      isAgentRunning,
      allModelsBlocked,
      allModelsBlockedMessageKey,
      addEmphemeralSystemMessage,
      hasLocalDeferredQueuedMessages,
      shouldBlockForLocalPausedAfterEscQueuedMessages,
      queueLocalDeferredMessage,
      queueLocalPausedMessage,
      hasLocalPausedAfterEscQueuedMessages,
      isCompactProcessing,
      queueManualCompactionMessage,
      exitTranscriptScrollToLiveChat,
    ]
  );

  const finalizeModelSwitch = useCallback(
    async (model: string, effort?: ReasoningEffort) => {
      // Use async switchModel from SessionController
      // This handles compaction automatically when switching providers
      const result = await switchModelWithNotice(model, effort);

      if (!result.success) {
        logWarn('[App] Model switch failed', {
          cause: result.error || 'Unknown error',
        });
        return;
      }

      // Propagate model switch to daemon
      void updateSettings({ modelId: model, reasoningEffort: effort });

      // In orchestrator sessions, warn when switching away from GPT-5.2 + High
      const sessionService = getSessionService();
      if (
        isMissionOrchestratorSession(sessionService.getCurrentSessionTags())
      ) {
        // Determine the effective reasoning effort
        // If effort was explicitly passed, use it; otherwise get from model config
        const effectiveEffort =
          effort ?? getTuiModelConfig(model).defaultReasoningEffort;
        const isRecommendedConfig =
          MISSION_ORCHESTRATOR_RECOMMENDED_MODELS.includes(model) &&
          MISSION_ORCHESTRATOR_MIN_REASONING_EFFORTS.includes(effectiveEffort);

        if (!isRecommendedConfig) {
          addEmphemeralSystemMessage(MISSION_ORCHESTRATOR_MODEL_WARNING, {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          });
        }
      }

      setPendingModelSelection(null);
      setShowModelSelector(false);
      setShowReasoningEffortSelector(false);
      redrawSession();
    },
    [
      switchModelWithNotice,
      setShowModelSelector,
      setShowReasoningEffortSelector,
      addEmphemeralSystemMessage,
      updateSettings,
    ]
  );

  const finalizeSpecModeModelSwitch = useCallback(
    async (model: string, effort?: ReasoningEffort) => {
      const result = await switchSpecModeModelWithNotice(model, effort);

      if (!result.success) {
        logWarn('[App] Spec mode model switch failed (finalize)', {
          cause: result.error || 'Unknown error',
        });
        return;
      }

      void updateSettings({
        specModeModelId: model,
        specModeReasoningEffort: effort,
        ...(interactionMode !== null && { interactionMode }),
      });
      setPendingSpecModelSelection(null);
      setShowModelSelector(false);
      setShowReasoningEffortSelector(false);
      redrawSession();
    },
    [
      interactionMode,
      switchSpecModeModelWithNotice,
      setShowModelSelector,
      setShowReasoningEffortSelector,
      updateSettings,
    ]
  );

  const handleModelCycle = useCallback(() => {
    const currentCycleModel =
      interactionMode === DroolInteractionMode.Spec &&
      specModeModel !== undefined
        ? specModeModel || mainModel
        : mainModel;
    const cycleModels = modelCycleCandidates.modelIds;
    if (
      cycleModels.length === 0 ||
      (cycleModels.length === 1 && cycleModels[0] === currentCycleModel)
    ) {
      return;
    }
    setShowInlineModelPicker((prev) => !prev);
  }, [interactionMode, mainModel, modelCycleCandidates, specModeModel]);

  const handleInlineModelSelect = useCallback(
    async (modelId: string) => {
      setShowInlineModelPicker(false);
      const isSpecMode = interactionMode === DroolInteractionMode.Spec;

      if (isSpecMode && specModeModel !== undefined) {
        const currentSpecModel = specModeModel;
        if (modelId === currentSpecModel) return;
        const defaultEffort = getTuiModelConfig(modelId).defaultReasoningEffort;
        const result = await switchSpecModeModelWithNotice(
          modelId,
          defaultEffort
        );
        if (!result.success) return;
        void updateSettings({
          specModeModelId: modelId,
          specModeReasoningEffort: defaultEffort,
          ...(interactionMode !== null && { interactionMode }),
        });
        if (result.compactionPerformed) redrawSession();
      } else {
        const currentModel = mainModel;
        if (modelId === currentModel) return;
        const defaultEffort = getTuiModelConfig(modelId).defaultReasoningEffort;
        const result = await switchModelWithNotice(modelId, defaultEffort);
        if (!result.success) return;
        void updateSettings({
          modelId,
          reasoningEffort: defaultEffort,
        });
        if (result.compactionPerformed) redrawSession();
      }
    },
    [
      interactionMode,
      mainModel,
      specModeModel,
      switchModelWithNotice,
      switchSpecModeModelWithNotice,
      updateSettings,
    ]
  );

  // Determine current model label
  const modelLabelInfo = useMemo(() => {
    const isSpecMode = interactionMode === DroolInteractionMode.Spec;
    const hasExplicitSpecModel = specModeModel !== undefined;
    const modelId =
      isSpecMode && hasExplicitSpecModel
        ? specModeModel || mainModel
        : mainModel;
    if (!modelId) {
      return {
        modelText: '',
        explicitModelText: '',
        showSpecHint: false,
      };
    }
    const cfg = getTuiModelConfig(modelId);
    const baseName = cfg.shortDisplayName || String(modelId);
    const supportedEfforts = cfg.supportedReasoningEfforts || [];
    let explicitFormattedReasoning = '';
    let formattedReasoning = '';
    if (supportedEfforts.length > 0) {
      const reasoningEffort =
        isSpecMode && hasExplicitSpecModel
          ? specReasoningEffort
          : mainReasoningEffort;

      const isSupported =
        reasoningEffort !== null && supportedEfforts.includes(reasoningEffort);
      if (isSupported) {
        const reasoningDisplay = getReasoningEffortDisplayName(reasoningEffort);
        explicitFormattedReasoning = `(${reasoningDisplay})`;
        formattedReasoning =
          reasoningDisplay === 'Reasoning disabled' ||
          reasoningDisplay === 'Dynamic'
            ? ''
            : `(${reasoningDisplay})`;
      }
    }

    const modelText =
      baseName + (formattedReasoning ? ` ${formattedReasoning}` : '');
    const explicitModelText =
      baseName +
      (explicitFormattedReasoning ? ` ${explicitFormattedReasoning}` : '');

    // Check if we should show the spec mode hint
    const showSpecHint = isSpecMode && !hasExplicitSpecModel;

    return {
      modelText,
      explicitModelText,
      showSpecHint,
    };
  }, [
    interactionMode,
    autonomyLevel,
    mainModel,
    specModeModel,
    mainReasoningEffort,
    specReasoningEffort,
  ]);

  const missionModelLabelInfo =
    isMissionMode && mainModel && missionWorkerModel && missionValidatorModel
      ? (() => {
          const orchestratorModelText = formatCompactModelLabel(mainModel);
          const workerModelText = formatCompactModelLabel(missionWorkerModel);
          const validatorModelText = formatCompactModelLabel(
            missionValidatorModel
          );

          const t = getI18n().t.bind(getI18n());
          const labels = {
            orch: t('common:missionModelLabels.orchestratorLabel'),
            work: t('common:missionModelLabels.workerLabel'),
            val: t('common:missionModelLabels.validatorLabel'),
            orchShort: t('common:missionModelLabels.orchestratorLabelShort'),
            workShort: t('common:missionModelLabels.workerLabelShort'),
            valShort: t('common:missionModelLabels.validatorLabelShort'),
          };
          const models = {
            orch: orchestratorModelText,
            work: workerModelText,
            val: validatorModelText,
          };
          const fullLen = getDisplayWidth(
            `${labels.orch}${models.orch} · ${labels.work}${models.work} · ${labels.val}${models.val}`
          );

          return { labels, models, fullLen };
        })()
      : null;

  const statusBanner = resolveTuiSpinnerStatusBanner({
    isRewindProcessing,
    isCancelling,
    sessionStatus,
    isPendingSpecEditConfirmation,
    isInvokingTools,
    isReviewingSpecChanges,
  });

  const modelLabelSegments: TerminalSegment[] = missionModelLabelInfo
    ? (() => {
        const { labels, models, fullLen } = missionModelLabelInfo;
        const short = fullLen > inputBoxWidth - 4;
        return [
          textSegment(short ? labels.orchShort : labels.orch, {
            color: COLORS.text.muted,
          }),
          textSegment(models.orch, { color: COLORS.text.secondary }),
          textSegment(' · ', { color: COLORS.text.muted }),
          textSegment(short ? labels.workShort : labels.work, {
            color: COLORS.text.muted,
          }),
          textSegment(models.work, { color: COLORS.text.secondary }),
          textSegment(' · ', { color: COLORS.text.muted }),
          textSegment(short ? labels.valShort : labels.val, {
            color: COLORS.text.muted,
          }),
          textSegment(models.val, { color: COLORS.text.secondary }),
        ];
      })()
    : [textSegment(modelLabelInfo.modelText, { color: COLORS.text.primary })];

  const statusBannerHint = getStatusBannerHint({
    isRewindProcessing,
    isInterruptPending:
      escInterruptRequestedRef.current &&
      sessionStatus !== AgentStatusState.Idle,
  });

  const headerLeftSegments: TerminalSegment[] = (() => {
    const withAutoCompactionOffHint = (
      segments: TerminalSegment[]
    ): TerminalSegment[] => {
      if (compactionThresholdCheckEnabled) {
        return segments;
      }

      const disabledSegment = textSegment(
        getI18n().t('common:statusBar.autoCompressionOff'),
        {
          color: AUTONOMY_INDICATOR_COLOR,
        }
      );

      if (segments.length === 0) {
        return [disabledSegment];
      }

      return [
        ...segments,
        textSegment(' · ', { color: COLORS.text.muted }),
        disabledSegment,
      ];
    };
    const splitAutonomyHint = (key: string) => {
      const [label, description] = getI18n()
        .t(key)
        .split(/\s[·-]\s/, 2);
      return { label, description };
    };
    const autonomySegments = (key: string): TerminalSegment[] => {
      const { label, description } = splitAutonomyHint(key);
      const labelSegment = textSegment(label, {
        color: AUTONOMY_INDICATOR_COLOR,
      });

      if (!compactionThresholdCheckEnabled || !description) {
        return [labelSegment];
      }

      return [
        labelSegment,
        textSegment(' · ', { color: COLORS.text.muted }),
        textSegment(description, {
          color: AUTONOMY_INDICATOR_COLOR,
        }),
      ];
    };

    if (isMissionMode) {
      return compactionThresholdCheckEnabled
        ? [textSegment(' ')]
        : withAutoCompactionOffHint([]);
    }
    if (bashMode.isActive) {
      return withAutoCompactionOffHint([
        textSegment(
          bashMode.isExecuting
            ? getI18n().t('common:statusBar.bashExecuting')
            : getI18n().t('common:statusBar.bashModeActive'),
          { color: bashMode.isExecuting ? COLORS.warning : COLORS.success }
        ),
      ]);
    }
    if (autonomyLevel === AutonomyLevel.Low) {
      return withAutoCompactionOffHint(
        autonomySegments('common:statusBar.autonomyLow')
      );
    }
    if (autonomyLevel === AutonomyLevel.Medium) {
      return withAutoCompactionOffHint(
        autonomySegments('common:statusBar.autonomyMedium')
      );
    }
    if (autonomyLevel === AutonomyLevel.High) {
      return withAutoCompactionOffHint(
        autonomySegments('common:statusBar.autonomyHigh')
      );
    }
    return withAutoCompactionOffHint([
      textSegment(getI18n().t('common:statusBar.autonomyOffLabel'), {
        color: COLORS.text.primary,
      }),
      ...(compactionThresholdCheckEnabled
        ? [
            textSegment(
              getI18n().t('common:statusBar.autonomyOffDescription'),
              {
                color: COLORS.text.muted,
              }
            ),
          ]
        : []),
    ]);
  })();

  // Anchor metadata for the chat-view transcript scroll panel.
  const transcriptAnchorRenderInfo = useMemo(() => {
    if (transcriptAnchorIndex === -1) return null;
    const anchors = buildTurnAnchors(uiMessages, {
      mode: transcriptAnchorMode,
    });
    const positionIndex = anchors.findIndex(
      (anchor) => anchor.index === transcriptAnchorIndex
    );
    return {
      totalAnchors: anchors.length,
      currentAnchorPosition: positionIndex >= 0 ? positionIndex + 1 : 0,
    };
  }, [uiMessages, transcriptAnchorIndex, transcriptAnchorMode]);

  // If editor is suspended, render nothing to give editor full control
  // This must be after all hooks to avoid React hooks violation
  if (isTUISuspended) {
    return null;
  }

  const messagePane = (
    <Box flexDirection="column" width="100%">
      {daemonStartupFailed && isConversationEmpty && (
        <Box width={inputBoxWidth} justifyContent="center" marginBottom={1}>
          <Banner
            variant="footer"
            title="⚠ Daemon startup failed"
            body="The background daemon could not be started. Session features may be limited. Check ~/.industry/logs/daemon-stderr.log for details."
            width={inputBoxWidth}
          />
        </Box>
      )}
      {showMcpOAuthReconnectionBanner && isConversationEmpty && (
        <Box width={inputBoxWidth} justifyContent="center" marginBottom={1}>
          <Banner
            variant="header"
            title={MCP_OAUTH_RECONNECTION_BANNER_TITLE}
            body={MCP_OAUTH_RECONNECTION_BANNER_BODY}
            width={inputBoxWidth}
          />
        </Box>
      )}
      {bannerContent.header && isConversationEmpty && (
        <Box width={inputBoxWidth} justifyContent="center" marginBottom={1}>
          <Banner
            variant="header"
            title={bannerContent.header.title}
            body={bannerContent.header.body}
            width={inputBoxWidth}
          />
        </Box>
      )}
      <Box width={contentBoxWidth} flexDirection="column">
        {showDetailedTranscript ? (
          <StaticDetailedTranscriptPanel
            messages={detailedTranscriptMessages}
            contentWidth={contentWidth}
            isConversationEmpty={isConversationEmpty}
            staticKey={transcriptStaticKey}
          />
        ) : transcriptAnchorIndex !== -1 && transcriptAnchorRenderInfo ? (
          <AnchoredTranscriptPanel
            messages={uiMessages}
            contentWidth={contentWidth}
            anchorIndex={transcriptAnchorIndex}
            totalAnchors={transcriptAnchorRenderInfo.totalAnchors}
            currentAnchorPosition={
              transcriptAnchorRenderInfo.currentAnchorPosition
            }
            mode={transcriptAnchorMode}
            showThinking={getSettingsService().getShowThinkingInMainView()}
          />
        ) : (
          <ProfiledRegion id="MessageList">
            <MessageList
              groupedMessages={mainChatMessages}
              contentWidth={contentWidth}
              headerWidth={inputBoxWidth}
              staticKey={staticKey}
              isConversationEmpty={isConversationEmpty}
              showThinking={getSettingsService().getShowThinkingInMainView()}
              isAgentRunning={isAgentRunning()}
              permissionToolIds={permissionExecuteToolIds}
              staticToolIds={permissionStaticToolIds}
              pendingPermissionToolIds={pendingPermissionToolIds}
              toolInputOverridesById={permissionToolInputOverridesById}
            />
          </ProfiledRegion>
        )}
      </Box>
    </Box>
  );

  const inputArea = showDetailedTranscript ? (
    <Box width={contentBoxWidth} flexDirection="column" paddingY={1}>
      {pendingAskUser && (
        <Box marginBottom={1}>
          <AskUserReadOnlyPreview
            questions={pendingAskUser.questions}
            questionIndex={askUserQuestionIndex}
            answerStates={askUserAnswerStates}
            width={contentBoxWidth}
          />
        </Box>
      )}
      <Box justifyContent="center">
        <Text color={COLORS.text.muted}>
          {getI18n().t('common:hints.pressCtrlOOrEscToReturn')}
        </Text>
      </Box>
    </Box>
  ) : showLoginSelector ? (
    <Box width={terminalWidth}>
      <LoginList
        onClose={() => setShowLoginSelector(false)}
        onSuccess={async (providerName) => {
          resetFeatureFlagCache();
          // Await org-managed settings reload so policies are applied
          // before resuming the session.
          try {
            await getSettingsService().reloadOrgSettings();
          } catch (error) {
            logException(
              error,
              'Failed to reload org settings after account switch'
            );
          }
          setShowLoginSelector(false);
          addEmphemeralSystemMessage(
            providerName
              ? `${providerName} login complete. Models refreshed. Select one with /model.`
              : getI18n().t('common:appMessages.authSuccess'),
            { messageType: MessageType.Text }
          );
        }}
      />
    </Box>
  ) : missionGateEvaluating ? (
    <Box width={terminalWidth} paddingLeft={1}>
      <Text color={COLORS.primary}>
        <Spinner />
      </Text>
      <Text color={COLORS.primary}>
        {' '}
        {getI18n().t('common:missionOnboarding.checkingReadiness')}
      </Text>
    </Box>
  ) : showMissionOnboarding ? (
    <Box width={terminalWidth}>
      <MissionOnboardingModal
        width={contentBoxWidth}
        showOnboarding={!getSettingsService().getHasSeenMissionOnboarding()}
        gateState={missionGate?.state ?? MissionReadinessGateState.Ok}
        level={missionGate?.level}
        onContinue={() => {
          getSettingsService().setHasSeenMissionOnboarding(true);
          setShowMissionOnboarding(false);
          // Only a pending NEW mission entry should convert the session here;
          // the resume path is already in Mission mode.
          if (pendingMissionEntry) {
            setPendingMissionEntry(false);
            void performEnterMission();
          }
        }}
        onCancel={() => {
          setShowMissionOnboarding(false);
          setMissionGate(null);
          if (pendingMissionEntry) {
            // New mission was never converted; nothing to undo.
            setPendingMissionEntry(false);
          } else {
            // Resumed session: leave Mission mode as before.
            getSessionService().setInteractionMode(DroolInteractionMode.Auto);
          }
        }}
        onRunReport={() => {
          setShowMissionOnboarding(false);
          setMissionGate(null);
          void processAndRun('/readiness-report');
        }}
        onFixReport={() => {
          setShowMissionOnboarding(false);
          setMissionGate(null);
          void processAndRun('/readiness-fix');
        }}
      />
    </Box>
  ) : ideExtensionPromptState.show ? (
    <Box width={terminalWidth}>
      <IdeExtensionConfirmation
        isUpdate={ideExtensionPromptState.isUpdate}
        onComplete={({ installed, connected }) => {
          setIdeExtensionPromptState({ show: false, isUpdate: false });
          // Show message if installed but not connected
          if (installed && !connected) {
            const action = ideExtensionPromptState.isUpdate
              ? 'updated'
              : 'installed';
            addEmphemeralSystemMessage(
              getI18n().t('common:appMessages.ideExtensionSuccess', {
                action,
              }),
              { messageType: MessageType.Text }
            );
          }
          // If connected, onConnected already showed the message
        }}
        onConnected={() => {
          refreshClientFromManager();
          const manager = IdeContextManager.getInstance();
          const instanceInfo = manager.getConnectedInstanceInfo();
          const ideName = instanceInfo?.ideName || 'IDE';
          addEmphemeralSystemMessage(
            getI18n().t('common:appMessages.ideConnected', {
              name: ideName,
            }),
            {
              messageType: MessageType.Text,
            }
          );
        }}
      />
    </Box>
  ) : ideInstanceSelectorState.show ? (
    <Box width={terminalWidth}>
      <IdeInstanceSelector
        onConnecting={() => setConnectionStatus(IdeConnectionStatus.Connecting)}
        onComplete={(connected, instanceName) => {
          const wasConnected =
            ideInstanceSelectorState.initialConnectedInstance;
          setIdeInstanceSelectorState({ show: false });
          if (connected) {
            refreshClientFromManager();
            if (instanceName) {
              addEmphemeralSystemMessage(
                getI18n().t('common:appMessages.ideConnected', {
                  name: instanceName,
                }),
                { messageType: MessageType.Text }
              );
            }
          } else {
            setConnectionStatus(IdeConnectionStatus.Disconnected);
            // Show disconnect message if user was connected and chose to disconnect
            if (wasConnected) {
              addEmphemeralSystemMessage(
                getI18n().t('common:appMessages.ideDisconnected', {
                  name: wasConnected.ideName,
                }),
                { messageType: MessageType.Text }
              );
            }
          }
        }}
        onDisconnect={ideInstanceSelectorState.onDisconnect}
        initialConnectedInstance={
          ideInstanceSelectorState.initialConnectedInstance
        }
      />
    </Box>
  ) : settingsSelectorData ? (
    <Box width={terminalWidth}>
      <SettingsList
        settings={settingsSelectorData}
        onThemeChanged={redrawSession}
        onClose={() => {
          setSettingsSelectorData(null);
        }}
      />
    </Box>
  ) : showThemeSelector ? (
    <Box width={terminalWidth}>
      <ThemeSelector
        onThemeSelect={(themeName) => {
          if (!applyThemeSelection(themeName)) return false;
          setShowThemeSelector(false);
          return true;
        }}
        onThemeChanged={redrawSession}
        onCancel={() => {
          setShowThemeSelector(false);
        }}
      />
    </Box>
  ) : showCommandsManager ? (
    <Box width={terminalWidth}>
      <CommandsManager onClose={() => setShowCommandsManager(false)} />
    </Box>
  ) : schedulingOverlay !== 'none' ? (
    <Box width={terminalWidth}>
      {schedulingOverlay === 'automations' ? (
        <AutomationsModal
          automations={automations}
          isLoading={automationsLoading}
          onCancel={() => setSchedulingOverlay('none')}
          onChanged={refreshAutomations}
          onOpenSession={handleAutomationSessionSelect}
        />
      ) : (
        <LoopModal
          scheduledTasks={scheduledTasks}
          cronHistory={cronHistory}
          currentSessionId={effectiveSessionId ?? null}
          currentSessionCwd={
            getSessionService().getCurrentSessionCwd() ?? process.cwd()
          }
          onCancel={() => setSchedulingOverlay('none')}
          onChanged={refreshScheduledTasks}
          onCreated={(cron) =>
            addEmphemeralSystemMessage(formatLoopScheduledMessage(cron), {
              messageType: MessageType.SystemNotification,
              visibility: MessageVisibility.UserOnly,
            })
          }
        />
      )}
    </Box>
  ) : showMcpManager && activeSessionId ? (
    <Box width={terminalWidth} key="mcp-manager">
      <McpManager
        sessionId={activeSessionId}
        mcpAuthPending={mcpAuthPending}
        onClose={() => setShowMcpManager(false)}
        addEphemeralSystemMessage={addEmphemeralSystemMessage}
      />
    </Box>
  ) : showBgProcessManager ? (
    <Box width={terminalWidth} key="bg-process-manager">
      <BgProcessManager onClose={() => setShowBgProcessManager(false)} />
    </Box>
  ) : showSquadMode && !pendingConfirmation ? (
    <SquadModeOverlay
      ref={squadModeRef}
      width={terminalWidth}
      onClose={closeSquadMode}
    />
  ) : showMissionControl && !pendingConfirmation ? (
    <MissionControlOverlay
      ref={missionControlRef}
      width={terminalWidth}
      onInterruptGeneration={() => stopAgentWithTimeout(2000)}
      onResume={handleMissionResume}
      onAutoExit={closeMissionControl}
    />
  ) : diagnosticsMenu.show ? (
    <Box width={terminalWidth}>
      <DiagnosticsOverlay onClose={diagnosticsMenu.close} />
    </Box>
  ) : droolsMenu.show ? (
    <DroolsOverlay width={terminalWidth} controller={droolsMenu} />
  ) : skillsMenu.show ? (
    <SkillsOverlay width={terminalWidth} controller={skillsMenu} />
  ) : pluginMenu.show ? (
    <PluginOverlay width={terminalWidth} controller={pluginMenu} />
  ) : hooksManager.show ? (
    <HooksOverlay width={terminalWidth} controller={hooksManager} />
  ) : reviewManager.show ? (
    <ReviewOverlay width={terminalWidth} controller={reviewManager} />
  ) : showMissionModelSelector ? (
    <Box width={terminalWidth}>
      <ModelSelector
        currentModel={mainModel ?? ''}
        currentReasoningEffort={mainReasoningEffort ?? ReasoningEffort.None}
        missionMode
        initialTab={missionModelTabRef.current}
        missionWorkerModel={missionWorkerModel}
        missionWorkerReasoningEffort={missionWorkerReasoningEffort}
        missionValidatorModel={missionValidatorModel}
        missionValidatorReasoningEffort={missionValidatorReasoningEffort}
        defaultMissionOrchestratorModelId={missionDefaults.orchestrator}
        defaultMissionWorkerModelId={missionDefaults.workerModel}
        defaultMissionValidatorModelId={missionDefaults.validationWorkerModel}
        onMissionSelect={async (target, model) => {
          missionModelTabRef.current = target;
          if (target === 'orchestrator') {
            const { supportedReasoningEfforts } = getTuiModelConfig(model);
            if (supportedReasoningEfforts.length > 1) {
              setPendingModelSelection(model);
              setShowMissionModelSelector(false);
              setShowReasoningEffortSelector(true);
              returnToMissionModelSelectorRef.current = true;
            } else {
              setShowMissionModelSelector(false);
              await finalizeModelSwitch(model);
              setShowMissionModelSelector(true);
            }
          } else {
            const missionTarget =
              target === 'validator'
                ? MissionModelTarget.Validation
                : MissionModelTarget.Worker;
            const { supportedReasoningEfforts } = getTuiModelConfig(model);
            if (supportedReasoningEfforts.length > 1) {
              setPendingMissionModelTarget(missionTarget);
              setPendingMissionModel(model);
              setShowMissionModelSelector(false);
              setShowReasoningEffortSelector(true);
            } else {
              const effort =
                supportedReasoningEfforts[0] ?? ReasoningEffort.None;
              if (missionTarget === MissionModelTarget.Validation) {
                await updateMissionSessionSettings({
                  validationWorkerModel: model,
                  validationWorkerReasoningEffort: effort,
                });
              } else {
                await updateMissionSessionSettings({
                  workerModel: model,
                  workerReasoningEffort: effort,
                });
              }
              // Stay in selector so user can configure other tabs
            }
          }
        }}
        onSelect={async (model) => {
          // Fallback onSelect for mission mode — treat as orchestrator
          const { supportedReasoningEfforts } = getTuiModelConfig(model);
          if (supportedReasoningEfforts.length > 1) {
            setPendingModelSelection(model);
            setShowMissionModelSelector(false);
            setShowReasoningEffortSelector(true);
            returnToMissionModelSelectorRef.current = true;
          } else {
            setShowMissionModelSelector(false);
            await finalizeModelSwitch(model);
            setShowMissionModelSelector(true);
          }
        }}
        onSetMissionDefault={async (target, modelId) => {
          const settingsService = getSettingsService();
          const effort = getTuiModelConfig(modelId).defaultReasoningEffort;
          if (target === 'orchestrator') {
            settingsService.setMissionOrchestratorModel(modelId);
            settingsService.setMissionOrchestratorReasoningEffort(effort);
          } else if (target === 'worker') {
            settingsService.setMissionWorkerModel(modelId);
            settingsService.setMissionWorkerReasoningEffort(effort);
          } else {
            settingsService.setMissionValidationWorkerModel(modelId);
            settingsService.setMissionValidationWorkerReasoningEffort(effort);
          }
          addEmphemeralSystemMessage(
            `Saved ${getTuiModelConfig(modelId).shortDisplayName} as the default ${target} model.`,
            { messageType: MessageType.Text }
          );
        }}
        onCancel={() => {
          setShowMissionModelSelector(false);
          returnToMissionModelSelectorRef.current = false;
        }}
      />
    </Box>
  ) : showSpecModeConfigurator ? (
    <Box width={terminalWidth}>
      <SessionSpecModeModelConfigurator
        ref={specModeConfiguratorRef}
        currentMainModel={mainModel ?? ''}
        currentSpecModel={specModeModel ?? null}
        currentMainReasoningEffort={mainReasoningEffort ?? ReasoningEffort.None}
        currentSpecReasoningEffort={specReasoningEffort ?? ReasoningEffort.None}
        onClose={() => {
          setShowSpecModeConfigurator(false);
          setShowSpecModeOption(false);
        }}
        onBack={() => {
          setShowSpecModeConfigurator(false);
          setShowModelSelector(true);
        }}
        onSpecModelSet={async (model, effort) => {
          const [result] = await Promise.all([
            switchSpecModeModel(model, effort),
            updateSettings({
              specModeModelId: model,
              specModeReasoningEffort: effort,
            }),
          ]);
          if (!result.success) {
            logWarn('[App] Spec mode model switch failed (config)', {
              cause: result.error || 'Unknown error',
            });
            return;
          }
          redrawSession();
        }}
        onSpecModelCleared={async () => {
          await updateSettings({
            specModeModelId: null,
            specModeReasoningEffort: null,
          });
          redrawSession();
        }}
      />
    </Box>
  ) : showModelSelector ? (
    <Box width={terminalWidth}>
      <ModelSelector
        currentModel={mainModel ?? ''}
        currentReasoningEffort={mainReasoningEffort ?? ReasoningEffort.None}
        mainReasoningEffort={mainReasoningEffort}
        specModeModel={specModeModel ?? null}
        specModeReasoningEffort={specReasoningEffort}
        isOrchestratorModelSelector={isMissionMode}
        initialTab={
          interactionMode === DroolInteractionMode.Spec ? 'spec' : 'main'
        }
        title={getI18n().t('common:appMessages.selectModelForSession')}
        onSetAsDefault={async (modelId: string) => {
          const effort = getModelDefaultReasoningEffort(modelId);
          const modelName = getTuiModelConfig(modelId).shortDisplayName;
          const effortName = getReasoningEffortDisplayName(effort);

          try {
            await getTuiDaemonAdapter().updateDefaultSettings({
              modelId,
              reasoningEffort: effort,
            });
            addEmphemeralSystemMessage(
              getI18n().t('common:appMessages.defaultModelSet', {
                model: modelName,
                effort: effortName,
              }),
              {
                messageType: MessageType.SystemNotification,
                visibility: MessageVisibility.UserOnly,
              }
            );
          } catch (error) {
            logWarn('[App] Failed to set default model', {
              cause: error,
            });
            addEmphemeralSystemMessage(
              getI18n().t('common:appMessages.defaultModelFailed'),
              {
                messageType: MessageType.SystemNotification,
                visibility: MessageVisibility.UserOnly,
              }
            );
          }
        }}
        onSetSpecAsDefault={async (modelId: string) => {
          const effort = getModelDefaultReasoningEffort(modelId);
          const modelName = getTuiModelConfig(modelId).shortDisplayName;
          const effortName = getReasoningEffortDisplayName(effort);

          try {
            await getTuiDaemonAdapter().updateDefaultSettings({
              specModeModelId: modelId,
              specModeReasoningEffort: effort,
            });
            addEmphemeralSystemMessage(
              getI18n().t('common:appMessages.defaultModelSet', {
                model: `${modelName} (spec)`,
                effort: effortName,
              }),
              {
                messageType: MessageType.SystemNotification,
                visibility: MessageVisibility.UserOnly,
              }
            );
          } catch (error) {
            logWarn('[App] Failed to set default spec model', {
              cause: error,
            });
            addEmphemeralSystemMessage(
              getI18n().t('common:appMessages.defaultModelFailed'),
              {
                messageType: MessageType.SystemNotification,
                visibility: MessageVisibility.UserOnly,
              }
            );
          }
        }}
        defaultDescription={(() => {
          const model = mainModel;
          const effort = mainReasoningEffort;
          if (!model || !effort) {
            return undefined;
          }
          const modelName = getTuiModelConfig(model).shortDisplayName;
          const effortName = getReasoningEffortDisplayName(effort);
          return `${modelName} (${effortName})`;
        })()}
        defaultModelId={defaultModel}
        defaultSpecModeModelId={defaultSpecModeModel}
        hasSpecModel={specModeModel !== undefined}
        onSpecSelect={async (model) => {
          const { supportedReasoningEfforts } = getTuiModelConfig(model);
          if (supportedReasoningEfforts.length > 1) {
            setPendingSpecModelSelection(model);
            setShowModelSelector(false);
            setShowReasoningEffortSelector(true);
          } else {
            setShowModelSelector(false);
            await finalizeSpecModeModelSwitch(model);
          }
        }}
        onClearSpecModel={() => {
          void updateSettings({
            specModeModelId: null,
            specModeReasoningEffort: null,
          });
          setShowModelSelector(false);
          setShowSpecModeOption(false);
        }}
        onSpecModeConfig={() => {
          setShowModelSelector(false);
          setShowSpecModeConfigurator(true);
        }}
        onSelect={async (model) => {
          const { supportedReasoningEfforts } = getTuiModelConfig(model);
          if (supportedReasoningEfforts.length > 1) {
            setPendingModelSelection(model);
            setShowModelSelector(false);
            setShowReasoningEffortSelector(true);
          } else {
            setShowModelSelector(false);
            await finalizeModelSwitch(model);
          }
        }}
        onCancel={() => {
          setShowModelSelector(false);
          setShowSpecModeOption(false);
          chatInputApiRef.current?.closeSuggestions?.();
          chatInputApiRef.current?.setInput?.('');
        }}
      />
    </Box>
  ) : showCompactConfirm && !isCompactProcessing ? (
    <Box width={terminalWidth}>
      <CompactionConfirmation
        currentSessionId={activeSessionId || undefined}
        isProcessing={isCompactProcessing}
        instructions={compressionInstructions}
        onCancel={() => resetCompressionState()}
        onAbort={() => {
          try {
            compactionAbortRef.current?.abort();
          } catch (error) {
            setIsCompactProcessing(false);
            resetCompressionState();
            logWarn('[App] Failed to abort compaction from confirmation', {
              errorName: error instanceof Error ? error.name : typeof error,
            });
            clearManualCompactionProcessingState();
          }
        }}
        onConfirm={async () => {
          setChatInputValue('');
          let currentSessionId: string | null = null;
          try {
            setIsCompactProcessing(true);

            currentSessionId = getSessionService().getCurrentSessionId();
            if (!currentSessionId) {
              addEmphemeralSystemMessage(
                getI18n().t('common:appMessages.noActiveSessionToCompact'),
                {
                  messageType: MessageType.SystemNotification,
                  visibility: MessageVisibility.UserOnly,
                }
              );
              resetCompressionState();
              return;
            }
            if (
              !confirmScheduledTaskLeave({
                actionKey: 'compact-session',
                repeatInstruction:
                  'Confirm compaction again to continue in a new session.',
              })
            ) {
              resetCompressionState();
              return;
            }
            manualCompactionQueueSessionIdRef.current = currentSessionId;

            const adapter = getTuiDaemonAdapter();
            const compactionResult = await adapter.compactSession(
              currentSessionId,
              compressionInstructions
            );

            if (!compactionResult?.newSessionId) {
              throw new Error(
                'Compaction completed but no new session was returned'
              );
            }

            resetCompressionState();

            await resumeSession({
              sessionId: compactionResult.newSessionId,
              skipDaemonEnsure: true,
              skipScheduledTaskLeaveWarning: true,
            });

            await initializeDaemonSession(compactionResult.newSessionId);

            addEmphemeralSystemMessage(
              getI18n().t('common:appMessages.loadedSummary', {
                sessionId: currentSessionId,
              }),
              {
                messageType: MessageType.SystemNotification,
                visibility: MessageVisibility.UserOnly,
              }
            );

            await drainManualCompactionQueueForSession(currentSessionId);
          } catch (error) {
            if (!isAbortError(error)) {
              logException(error, 'Error running /compact flow');
              const detail =
                error instanceof Error ? error.message : String(error);
              addEmphemeralSystemMessage(
                getI18n().t('errors:agent.compactFailed', { detail }),
                {
                  messageType: MessageType.SystemNotification,
                  visibility: MessageVisibility.UserOnly,
                }
              );
            }
            resetCompressionState();
            if (currentSessionId) {
              await drainManualCompactionQueueForSession(currentSessionId);
            }
          } finally {
            clearManualCompactionProcessingState();
          }
        }}
      />
    </Box>
  ) : showCreateSkillFlow ? (
    <Box width={terminalWidth}>
      <CreateSkillFlow
        initialValue={createSkillDraft}
        onCancel={() => {
          Metrics.addToCounter(Metric.SKILL_CREATE_COMMAND_CANCELLED_COUNT, 1);
          resetCreateSkillState();
        }}
        onStart={async (description) => {
          Metrics.addToCounter(Metric.SKILL_CREATE_COMMAND_CONFIRMED_COUNT, 1);
          try {
            if (
              !confirmScheduledTaskLeave({
                actionKey: 'create-skill-session',
                repeatInstruction:
                  'Start skill creation again to continue in a new session.',
              })
            ) {
              return;
            }

            await holdSessionCrons('create-skill-session');

            const { newSession, newSessionId, skillCreatorMessage } =
              await createSkillSession({
                description,
              });

            // Load the new session via SessionController (updates activeSessionId)
            await loadSessionViaController({ sessionId: newSessionId });
            loadSession(newSession);

            // Reset state
            resetCreateSkillState();

            // Trigger UI refresh and agent run
            setTimeout(() => {
              redrawSession();
              // Show user-visible opening line as system notification
              addEmphemeralSystemMessage(skillCreatorMessage.openingLine, {
                messageType: MessageType.SystemNotification,
                visibility: MessageVisibility.UserOnly,
              });
              // Run the agent with instructions and separate reference blocks
              void runAgent({
                message: skillCreatorMessage.instructionsMessage,
                additionalContentBlocks: skillCreatorMessage.referenceBlocks,
              });
            }, 50);
          } catch (error) {
            logException(error, 'Error creating skill session');
            addEmphemeralSystemMessage(
              error instanceof Error
                ? error.message
                : getI18n().t('errors:skillSessionFailed'),
              {
                messageType: MessageType.SystemNotification,
                visibility: MessageVisibility.UserOnly,
              }
            );
            resetCreateSkillState();
          }
        }}
      />
    </Box>
  ) : showSetupIncidentResponseFlow ? (
    <Box width={terminalWidth}>
      <SetupIncidentResponseFlow
        onClose={() => setShowSetupIncidentResponseFlow(false)}
      />
    </Box>
  ) : showReasoningEffortSelector ? (
    <Box width={terminalWidth}>
      <ReasoningEffortSelector
        currentEffort={
          (pendingMissionModel && pendingMissionModelTarget
            ? pendingMissionModelTarget === MissionModelTarget.Worker
              ? missionWorkerReasoningEffort
              : missionValidatorReasoningEffort
            : pendingSpecModelSelection
              ? specReasoningEffort
              : pendingModelSelection
                ? mainReasoningEffort
                : interactionMode === DroolInteractionMode.Spec &&
                    specModeModel !== undefined
                  ? specReasoningEffort
                  : mainReasoningEffort) ?? ReasoningEffort.None
        }
        supportedEfforts={(() => {
          const modelToUse =
            pendingMissionModel ??
            pendingSpecModelSelection ??
            pendingModelSelection ??
            (interactionMode === DroolInteractionMode.Spec &&
            specModeModel !== undefined
              ? specModeModel
              : mainModel);
          if (!modelToUse) {
            return [];
          }
          return getTuiModelConfig(modelToUse).supportedReasoningEfforts;
        })()}
        onSelect={async (effort) => {
          if (pendingMissionModel && pendingMissionModelTarget) {
            if (pendingMissionModelTarget === MissionModelTarget.Validation) {
              await updateMissionSessionSettings({
                validationWorkerModel: pendingMissionModel,
                validationWorkerReasoningEffort: effort,
              });
            } else {
              await updateMissionSessionSettings({
                workerModel: pendingMissionModel,
                workerReasoningEffort: effort,
              });
            }
            setPendingMissionModelTarget(null);
            setPendingMissionModel(null);
            setShowReasoningEffortSelector(false);
            setShowMissionModelSelector(true);
          } else if (pendingSpecModelSelection) {
            await finalizeSpecModeModelSwitch(
              pendingSpecModelSelection,
              effort
            );
          } else if (pendingModelSelection) {
            await finalizeModelSwitch(pendingModelSelection, effort);
            if (returnToMissionModelSelectorRef.current) {
              returnToMissionModelSelectorRef.current = false;
              setShowMissionModelSelector(true);
            }
          } else {
            // Just update reasoning effort for current model
            if (
              interactionMode === DroolInteractionMode.Spec &&
              specModeModel !== undefined
            ) {
              void updateSettings({ specModeReasoningEffort: effort });
            } else {
              void updateSettings({ reasoningEffort: effort });
            }
            setShowReasoningEffortSelector(false);
          }
        }}
        onCancel={() => {
          if (pendingMissionModel && pendingMissionModelTarget) {
            setPendingMissionModelTarget(null);
            setPendingMissionModel(null);
            setShowMissionModelSelector(true);
            setShowReasoningEffortSelector(false);
          } else if (returnToMissionModelSelectorRef.current) {
            returnToMissionModelSelectorRef.current = false;
            setPendingModelSelection(null);
            setShowMissionModelSelector(true);
            setShowReasoningEffortSelector(false);
          } else {
            setShowModelSelector(true);
            setPendingModelSelection(null);
            setPendingSpecModelSelection(null);
            setShowReasoningEffortSelector(false);
          }
        }}
      />
    </Box>
  ) : rewindOptions ? (
    <Box width={terminalWidth}>
      <RewindMenu
        options={rewindOptions}
        onSelect={handleRewindSelect}
        onCancel={() => setRewindOptions(null)}
      />
    </Box>
  ) : copySelectorData ? (
    <Box width={terminalWidth}>
      <CopySelector
        turns={copySelectorData.turns}
        hasLastAssistant={copySelectorData.hasLastAssistant}
        hasLastUser={copySelectorData.hasLastUser}
        hasSessionId={copySelectorData.hasSessionId}
        onSelect={(selection) => {
          void handleCopySelectorSelect(selection);
        }}
        onCancel={() => setCopySelectorData(null)}
      />
    </Box>
  ) : fileRestoreData && !fileRestoreData.showFileSelection ? (
    <Box width={terminalWidth}>
      <FileRestoreChoiceMenu
        restoreCount={fileRestoreData.snapshotInfo.availableFiles.length}
        deleteCount={fileRestoreData.snapshotInfo.createdFiles.length}
        evictedCount={fileRestoreData.snapshotInfo.evictedFiles.length}
        onSelect={(choice: FileRestoreChoice) => {
          if (choice === FileRestoreChoice.All) {
            // Restore all files immediately
            void executeRewind(
              fileRestoreData.pendingRewind,
              fileRestoreData.snapshotInfo.availableFiles,
              fileRestoreData.snapshotInfo.createdFiles
            );
          } else if (choice === FileRestoreChoice.Select) {
            // Show file selection menu
            setFileRestoreData({
              ...fileRestoreData,
              showFileSelection: true,
            });
          } else {
            // Don't restore files, just rewind
            void executeRewind(fileRestoreData.pendingRewind, [], []);
          }
        }}
        onCancel={() => setFileRestoreData(null)}
      />
    </Box>
  ) : fileRestoreData?.showFileSelection ? (
    <Box width={terminalWidth}>
      <FileRestoreMenu
        availableFiles={fileRestoreData.snapshotInfo.availableFiles.map(
          (f) => ({ ...f, capturedAt: 0 })
        )}
        evictedFiles={fileRestoreData.snapshotInfo.evictedFiles}
        createdFiles={fileRestoreData.snapshotInfo.createdFiles.map((f) => ({
          ...f,
          createdAt: 0,
        }))}
        onConfirm={(selection) => {
          void executeRewind(
            fileRestoreData.pendingRewind,
            selection.filesToRestore,
            selection.filesToDelete
          );
        }}
        onSkip={() => {
          void executeRewind(fileRestoreData.pendingRewind, [], []);
        }}
        onCancel={() => {
          setFileRestoreData(null);
        }}
      />
    </Box>
  ) : sessionSelectorData ? (
    <Box width={terminalWidth}>
      <SessionList
        sessions={sessionSelectorData}
        currentSessionId={
          activeSessionId ||
          getSessionService().getCurrentSessionId() ||
          undefined
        }
        onSelect={handleSessionSelect}
        onCancel={() => {
          setSessionSelectorData(null);
          setSessionListMode('browse');
        }}
        onArchive={handleSessionArchive}
        onRename={handleSessionRename}
        onModeChange={setSessionListMode}
      />
    </Box>
  ) : missionsMenuData ? (
    <Box width={terminalWidth}>
      <MissionsList
        missions={missionsMenuData.missions}
        currentMissionId={missionsMenuData.currentMissionId}
        onSelect={handleMissionSelect}
        onNewMission={handleNewMission}
        onExitMission={handleExitMission}
        onRename={handleMissionRename}
        onCancel={() => {
          setMissionsMenuData(null);
        }}
      />
    </Box>
  ) : pendingConfirmation ? (
    <Box width={terminalWidth}>
      <BatchToolConfirmationMessage
        key={pendingApprovalDetailsKey ?? undefined}
        confirmationDetails={pendingConfirmation}
        ctrlCPressed={ctrlCPressed}
        isFocused
        width={terminalWidth}
        ideClient={ideClient}
        lastTokenUsage={sessionTokenUsage}
        onSpecNewSessionHandoff={handleSpecNewSessionHandoff}
        onReasoningCycle={handleReasoningCycle}
        defaultAutonomyLevel={defaultAutonomyLevel ?? undefined}
        pendingPermissionCount={pendingPermissionCount}
        pendingPermissionTotal={pendingPermissionTotal}
      />
    </Box>
  ) : pendingAskUser ? (
    <Box width={terminalWidth} marginLeft={3}>
      <AskUserConfirmation
        questions={pendingAskUser.questions}
        onComplete={(answers) => {
          resolveAskUserAnswers(pendingAskUser.toolCallId, answers);
        }}
        onCancel={() => {
          rejectAskUserAnswers(pendingAskUser.toolCallId);
        }}
        isFocused
        width={terminalWidth}
        questionIndex={askUserQuestionIndex}
        onQuestionIndexChange={setAskUserQuestionIndex}
        answerStates={askUserAnswerStates}
        onAnswerStatesChange={setAskUserAnswerStates}
      />
    </Box>
  ) : tokenLimitChoice ? (
    <Box width={terminalWidth}>
      <UsageLimitsPanel
        limitsData={tokenLimitChoice.limitsData}
        extraUsageBalanceCents={tokenLimitChoice.extraUsageBalanceCents}
        currentPreference={tokenLimitChoice.overagePreference}
        extraUsageAllowed={tokenLimitChoice.extraUsageAllowed}
        isCurrentModelCore={tokenLimitChoice.isCurrentModelCore}
        onSelect={(action) => {
          void handleTokenLimitChoice(
            action === 'droolCore'
              ? TokenLimitAction.DroolCore
              : TokenLimitAction.OpenBilling
          );
        }}
        onCancel={() => {
          void handleTokenLimitChoice(TokenLimitAction.Cancel);
        }}
      />
    </Box>
  ) : (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column">
        {showHelpHints && !bashMode.isExecuting && (
          <Box width={contentBoxWidth} marginBottom={1}>
            <HelpPopup
              interactionMode={interactionMode ?? undefined}
              autonomyLevel={autonomyLevel ?? undefined}
              width={contentBoxWidth}
              height={Math.max(
                terminalHeight - HELP_POPUP_HEIGHT_OFFSET,
                HELP_POPUP_MIN_HEIGHT
              )}
            />
          </Box>
        )}

        {/* Pinned Todo Display - above status line */}
        {sessionTodos &&
          getSettingsService().getTodoDisplayMode() ===
            TodoDisplayMode.Pinned && (
            <PinnedTodoDisplay todos={sessionTodos} width={contentBoxWidth} />
          )}

        {showCompactConfirm && isCompactProcessing && (
          <Box width={contentBoxWidth} marginTop={1}>
            <CompactionConfirmation
              currentSessionId={activeSessionId || undefined}
              isProcessing
              instructions={compressionInstructions}
              variant="status"
              width={Math.min(contentBoxWidth, 78)}
            />
          </Box>
        )}

        {/* Pending queued user messages from SSM */}
        {pendingQueuedMessages.length > 0 && (
          <PendingMessagesList
            items={pendingQueuedMessages}
            width={Math.floor(terminalWidth * 0.9)}
            reviewActive={queuedReviewModeActive}
            reviewEnabled={isQueuedMessagesEnabled}
            selectedItemId={selectedQueuedReviewMessage?.id}
          />
        )}

        {/* Agent Status Indicator — pinned above chat input */}
        {statusBanner ? (
          <Box
            marginTop={1}
            marginBottom={1}
            paddingLeft={1}
            width={contentBoxWidth}
          >
            <Text>
              <Text color={COLORS.primary}>
                <Spinner
                  preset={statusBanner.preset}
                  intervalMs={statusBanner.intervalMs}
                />
              </Text>
              {renderTerminalLine(
                [
                  textSegment(statusBanner.text, {
                    color: COLORS.primary,
                  }),
                  textSegment(` ${statusBannerHint}`, {
                    color: COLORS.text.muted,
                    dim: true,
                  }),
                ],
                Math.max(1, contentBoxWidth - 2)
              )}
            </Text>
          </Box>
        ) : (
          <Box marginTop={1} />
        )}

        {/* Header row above input: autonomy indicator (left) + model name (right) */}
        {/* Spec mode indicator is shown in the chat input prompt itself */}
        <Box marginTop={0} marginBottom={0}>
          {showInlineModelPicker ? (
            <Box justifyContent="flex-end" width={inputBoxWidth}>
              <InlineModelCyclePicker
                availableModels={modelCycleCandidates.modelIds}
                currentModel={
                  (interactionMode === DroolInteractionMode.Spec &&
                  specModeModel !== undefined
                    ? specModeModel || mainModel
                    : mainModel) ?? ''
                }
                onSelect={handleInlineModelSelect}
                onCancel={() => setShowInlineModelPicker(false)}
              />
            </Box>
          ) : (
            <Text>
              {renderTwoSidedTerminalRow({
                left: [textSegment(' '), ...headerLeftSegments],
                right: [...modelLabelSegments, textSegment(' ')],
                width: inputBoxWidth,
              })}
            </Text>
          )}
        </Box>

        {allModelsBlocked && (
          <Box marginLeft={1} marginBottom={0}>
            <Text color={COLORS.error}>
              {getI18n().t(allModelsBlockedMessageKey)}
            </Text>
          </Box>
        )}

        <ProfilerOverlay />

        <ProfiledRegion id="ChatInput">
          {btwScrollViewOpen ? (
            <BtwScrollView
              entries={btwEntries}
              width={inputBoxWidth}
              onDismiss={handleDismissBtwScrollView}
              onRemoveEntry={(id) => btwManager?.removeEntry(id)}
              onSubmitQuestion={handleSubmitBtwQuestion}
            />
          ) : (
            <ChatInput
              key={staticKey}
              currentModel={mainModel ?? ''}
              onSubmit={handleSubmit}
              onRewindShortcut={handleOpenRewindMenu}
              initialValue={chatDraftRef.current}
              initialCursorPosition={chatCursorPositionRef.current}
              onInputChange={(value) => {
                unfreezeRestoredChat();
                setChatInputValue(value, { updateInput: false });
              }}
              onCursorPositionChange={(position) => {
                chatCursorPositionRef.current = position;
              }}
              width={inputBoxWidth}
              isFocused={isChatInputFocused}
              showHelpHints={showHelpHints}
              setShowHelpHints={setShowHelpHints}
              isBashMode={bashMode.isActive}
              isFirstMessage={sessionMessages.length === 0}
              isBashExecuting={bashMode.isExecuting}
              isSessionRunning={
                sessionStatus !== AgentStatusState.Idle &&
                !bashMode.isActive &&
                !bashMode.isExecuting &&
                !isCancelling
              }
              enableQueuedMessages={isQueuedMessagesEnabled}
              onBashSubmit={handleBashSubmit}
              onModeToggle={isMissionMode ? undefined : handleModeToggle}
              onAutonomyLevelCycle={handleAutonomyLevelCycle}
              onModelCycle={handleModelCycle}
              onReasoningCycle={handleReasoningCycle}
              onToggleBashMode={toggleBashMode}
              inputApiRef={chatInputApiRef}
              onWarning={(warning) => {
                addEmphemeralSystemMessage(warning, {
                  messageType: MessageType.Text,
                  visibility: MessageVisibility.UserOnly,
                  transient: true,
                });
              }}
              interactionMode={interactionMode ?? undefined}
              isMissionActive={isMissionActive}
              onDownArrowAtBottom={() => setBgTasksPanelFocused(true)}
              onQueuedMessagesReviewShortcut={
                isQueuedMessagesEnabled
                  ? handleOpenQueuedMessageReview
                  : undefined
              }
              onPullQueuedMessageShortcut={
                isQueuedMessagesEnabled
                  ? handlePullTopQueuedMessageIntoInput
                  : undefined
              }
              onCommandMenuVisibilityChange={setCommandMenuVisible}
            />
          )}
        </ProfiledRegion>
      </Box>
      <BackgroundTasksPanel
        getToolExecutions={getDaemonToolExecutions}
        isFocused={bgTasksPanelFocused}
        onFocusReturn={() => setBgTasksPanelFocused(false)}
        onCancelTool={handleCancelTool}
        onProcessKilled={(label, pid) => {
          const pidInfo = pid ? `PID ${pid} - ` : '';
          addEmphemeralSystemMessage(
            getI18n().t('common:appMessages.bgProcessStopped', {
              pidInfo,
              label,
            }),
            { visibility: MessageVisibility.UserOnly }
          );
        }}
        width={inputBoxWidth}
      />
      {bannerContent.footer && (
        <Banner
          variant="footer"
          title={bannerContent.footer.title}
          body={bannerContent.footer.body}
          width={inputBoxWidth}
        />
      )}
      {!commandMenuVisible && (
        <FooterStatusRow
          width={inputBoxWidth}
          showHelpHints={showHelpHints}
          chatDraftEmpty={chatDraftRef.current === ''}
          timerState={timerStateRef}
          statusState={sessionStatus}
          sessionId={activeSessionId}
          lastTokenUsage={sessionTokenUsage}
          scheduledTasks={sessionScheduledTasks}
          prState={terminalWidth >= 60 ? prState : { status: PrStatus.Idle }}
          sandboxEnabled={sandboxEnabled}
          mcpVisible={mcpVisible}
          mcpStatus={mcpStatus}
          ideState={ideState}
          getSelectedLineCount={getSelectedLineCount}
          hasSelection={hasSelection}
        />
      )}
      {/* Status line - separate row below footer, hidden when command menu is open */}
      {!commandMenuVisible && (
        <StatusLine
          sessionId={activeSessionId}
          modelId={mainModel ?? ''}
          reasoningEffort={mainReasoningEffort ?? ''}
          width={contentBoxWidth}
          lastTokenUsage={sessionTokenUsage}
          prState={prState}
        />
      )}
    </Box>
  );

  // Mid-session folder trust prompt (CLI-897): /cwd into an untrusted folder
  // must be confirmed before the chdir + daemon child respawn load the
  // target folder's project hooks/MCP servers. Takes precedence so no other
  // overlay or input can run while the decision is pending.
  if (cwdTrustPrompt) {
    return (
      <FolderTrustPrompt
        width={terminalWidth}
        folderPath={getFolderTrustService().getTrustRootForPath(
          cwdTrustPrompt.targetPath
        )}
        trustTargetPath={cwdTrustPrompt.targetPath}
        declineBehavior="cancel"
        onTrust={() => settleCwdTrustPrompt(true)}
        onCancel={() => settleCwdTrustPrompt(false)}
      />
    );
  }

  if (showMissionControl) {
    return <MissionControlScreen content={inputArea} />;
  }

  if (showApprovalDetails && approvalDetailsConfirmation) {
    return (
      <ApprovalDetailsScreen
        confirmationDetails={approvalDetailsConfirmation}
        width={contentBoxWidth}
      />
    );
  }

  if (showDetailedTranscript) {
    return <TranscriptScreen transcript={messagePane} footer={inputArea} />;
  }

  if (showRestoredChatBuffer) {
    return <ChatScreen messages={null} inputArea={inputArea} />;
  }

  return <ChatScreen messages={messagePane} inputArea={inputArea} />;
}

interface AppProps {
  initialPrompt?: string;
  resumeSessionId?: string;
  originalCwd?: string;
  daemonStartupFailed?: boolean;
}

export function App({
  initialPrompt,
  resumeSessionId,
  originalCwd,
  daemonStartupFailed,
}: AppProps) {
  const [alternateScreenOwner, setAlternateScreenOwner] =
    useState<AlternateScreenOwner>(null);
  const { width: terminalWidth } = useTerminalDimensions();
  const { write: writeToStdout, invalidateOutput } =
    useStdout() as InkStdoutContext;
  const clearTerminalSeq = useMemo(() => getClearTerminalSequence(), []);
  const clearInkTerminal = useCallback(() => {
    clearInkOutput({
      clearTerminalSequence: clearTerminalSeq,
      writeToStdout,
      invalidateOutput,
    });
  }, [clearTerminalSeq, invalidateOutput, writeToStdout]);
  useTerminalResizing({
    clearOnResize: alternateScreenOwner === null,
    clearTerminal: clearInkTerminal,
  });
  const [authStatus, refreshStatus, authErrorMessage] = useAuthentication();
  const { status: vsCodeExtensionStatus, setStatus: setVSCodeExtensionStatus } =
    useVSCodeExtension();
  const [showVSCodePrompt, setShowVSCodePrompt] = useState(false);
  // Folder trust gate (CLI-897): computed once on mount; flips to resolved
  // when the user accepts the prompt (declining exits the process).
  const [folderTrustResolved, setFolderTrustResolved] = useState(
    () => !getFolderTrustService().needsTrustPrompt()
  );
  const hasPrecreatedSessionRef = useRef(false);
  // Incremented to force re-render when the pre-created session is ready,
  // so effectiveSessionId picks up the new session ID.
  const [, setPrecreatedTick] = useState(0);
  const reportedFirstVisibleRef = useRef(false);

  useMountEffect(() => {
    if (reportedFirstVisibleRef.current) return;
    reportedFirstVisibleRef.current = true;
    Metrics.addToCounter(
      Metric.CLI_TUI_FIRST_VISIBLE_LATENCY,
      process.uptime() * 1000,
      getCliRuntimeMetricLabels()
    );
  });

  useEffect(() => {
    if (
      authStatus !== AuthStatus.Authenticated ||
      // Defer session pre-creation (and its SessionStart hooks) until the
      // folder trust prompt has been resolved.
      !folderTrustResolved ||
      hasPrecreatedSessionRef.current
    ) {
      return;
    }

    hasPrecreatedSessionRef.current = true;

    const sessionService = getSessionService();

    // Initialize snapshot service for file restoration on rewind
    const initializeSnapshots = async (sessionId: string) => {
      try {
        const snapshotService = getFileSnapshotService();
        if (!snapshotService.isInitialized()) {
          await snapshotService.initialize();
        }
        await snapshotService.startSession(sessionId);
      } catch (error) {
        logWarn(
          '[Session] Failed to initialize file snapshot service on initial session',
          { sessionId, cause: error }
        );
      }
    };

    const existingSessionId = sessionService.getCurrentSessionId();
    if (existingSessionId) {
      void initializeSnapshots(existingSessionId);
      return;
    }

    void sessionService
      .ensureCurrentSession()
      .then((sessionId) => {
        logInfo('[App] Pre-created new session', { sessionId });

        // Initialize SSM so ephemeral system messages can be rendered
        // before the daemon session is created (e.g. /rewind on empty session).
        const adapter = getTuiDaemonAdapter();
        const ssm = adapter.getSessionStateManager();
        if (!ssm.getSessionManager(sessionId)) {
          ssm.markSessionLoading(sessionId, 'local');
          ssm.initializeSession(sessionId, []);
        }

        // Force re-render so effectiveSessionId picks up this session.
        setPrecreatedTick((n) => n + 1);

        void initializeSnapshots(sessionId);
      })
      .catch((error) =>
        logException(error, '[App] Failed to pre-create session')
      );
  }, [authStatus, folderTrustResolved]);

  // While checking stored credentials / env vars, show startup progress.
  if (authStatus === AuthStatus.Checking) {
    return (
      <Text color={COLORS.text.muted}>
        {getI18n().t('common:login.checking')}
      </Text>
    );
  }

  const width = Math.max(1, terminalWidth);

  const onFinishAuthStep = async () => {
    // Clear stale default flags so hooks refetch with valid auth
    resetFeatureFlagCache();
    // Await org-managed settings reload so policies are applied before
    // transitioning to authenticated state.
    try {
      await getSettingsService().reloadOrgSettings();
    } catch (error) {
      logException(error, 'Failed to reload org settings after authentication');
    }
    // Clear any leftover authentication UI before rendering the main app
    clearInkTerminal();
    void refreshStatus();
  };

  // A configured-but-invalid INDUSTRY_API_KEY must not fall back to interactive
  // login (strict precedence, CLI-135): surface the error and exit non-zero.
  if (authStatus === AuthStatus.InvalidApiKey) {
    return (
      <InvalidApiKeyExit message={authErrorMessage ?? invalidApiKeyMessage()} />
    );
  }

  // If the user needs to authenticate, render AuthenticationCheck UI
  if (authStatus === AuthStatus.NeedsAuth) {
    return (
      <AuthenticationCheck
        width={width}
        message={authErrorMessage}
        onAuthenticated={onFinishAuthStep}
      />
    );
  }

  // If the user doesn't have an org, redirect them to web onboarding
  if (authStatus === AuthStatus.AuthenticatedWithoutOrg) {
    return (
      <OrganizationOnboardingRedirect
        width={width}
        onCheckComplete={refreshStatus}
      />
    );
  }

  // Folder trust prompt (CLI-897): must resolve before session pre-creation,
  // the drool child spawn, and statusLine execution (all gated behind
  // AppContent or the pre-create effect above). Declining exits the process.
  if (authStatus === AuthStatus.Authenticated && !folderTrustResolved) {
    return (
      <FolderTrustPrompt
        width={width}
        folderPath={getFolderTrustService().getTrustRoot()}
        onTrust={() => {
          // Clear any leftover prompt UI before rendering the main app
          clearTerminal();
          setFolderTrustResolved(true);
        }}
      />
    );
  }

  // After authentication, check if we should show VSCode extension prompt
  if (
    authStatus === AuthStatus.Authenticated &&
    vsCodeExtensionStatus === VSCodeExtensionStatus.CHECKING
  ) {
    return (
      <Text color={COLORS.text.muted}>
        {getI18n().t('common:onboarding.checking')}
      </Text>
    );
  }

  if (
    authStatus === AuthStatus.Authenticated &&
    vsCodeExtensionStatus === VSCodeExtensionStatus.SHOULD_PROMPT &&
    !showVSCodePrompt
  ) {
    // Show the VSCode extension prompt once
    setShowVSCodePrompt(true);
  }

  if (showVSCodePrompt) {
    return (
      <VSCodeExtensionPrompt
        width={width}
        onComplete={() => {
          // Clear any leftover prompt UI before rendering the main app
          clearInkTerminal();
          setShowVSCodePrompt(false);
        }}
        onStatusUpdate={setVSCodeExtensionStatus}
      />
    );
  }

  return (
    <AppContent
      initialPrompt={initialPrompt}
      resumeSessionId={resumeSessionId}
      originalCwd={originalCwd}
      daemonStartupFailed={daemonStartupFailed}
      setAlternateScreenOwner={setAlternateScreenOwner}
    />
  );
}

export function displayResumeCommandIfNeeded(): void {
  try {
    const sessionService = getSessionService();
    const sessionId = sessionService.getCurrentSessionId();

    if (!sessionId) {
      return;
    }

    // Only show resume command if session has messages
    const hasMessages = sessionService.sessionHasMessages(sessionId);

    if (hasMessages) {
      // Use process.stderr.write to ensure immediate output before exit
      // stderr is unbuffered and will display immediately
      process.stderr.write(
        getI18n().t('common:process.resumeSession', { sessionId })
      );
    }
  } catch (error) {
    logWarn('[App] Failed to restore terminal state before exit', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

export async function showFullScreenAnimation(): Promise<void> {
  const { FullScreenAnimation } = await import(
    '@/components/FullScreenAnimation'
  );

  return new Promise<void>((resolve) => {
    let resolved = false;
    let animationApp: ReturnType<typeof render> | null = null;

    const handleComplete = () => {
      if (!resolved) {
        resolved = true;
        if (animationApp) {
          animationApp.unmount();
          animationApp.clear();
        }
        // Clear screen completely before TUI renders
        clearTerminal();
        resolve();
      }
    };

    animationApp = render(<FullScreenAnimation onComplete={handleComplete} />, {
      exitOnCtrlC: false,
      patchConsole: false,
    });

    // Safety timeout - force continue after 10 seconds
    setTimeout(() => {
      handleComplete();
    }, 10000);
  });
}
