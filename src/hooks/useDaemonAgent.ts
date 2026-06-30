/**
 * useDaemonAgent — React hook that delegates agent logic to the daemon via TuiDaemonAdapter.
 *
 * Message rendering and working state are handled by useSyncExternalStore hooks
 * (useSessionMessages and useSessionWorkingState) that read directly from the
 * daemon's SessionStateManager. This hook handles session creation, message
 * sending, permission/AskUser/disconnect flows, and error display.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';

import { DaemonSpecificNotificationType } from '@industry/common/daemon';
import {
  DroolWorkingState,
  QueuePlacement,
  SessionNotificationType,
  ToolConfirmationOutcome,
  type ToolConfirmationInfo,
} from '@industry/drool-sdk-ext/protocol/drool';
import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import {
  DocumentSource,
  IndustryDroolMessage,
  MessageContentBlockType,
  MessageRole as ProtocolMessageRole,
  MessageVisibility,
  TextBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import {
  AutonomyLevel,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logException, logInfo, logWarn } from '@industry/logging';
import { clearMcpAuthPendingForServer } from '@industry/utils/mcp';
import { buildUserMessageContentBlocks } from '@industry/utils/messages';
import {
  buildSubagentSessionTitle,
  getPermissionToolInputForDisplay,
  resolveSubagentSessionTitle as resolveSubagentSessionTitleShared,
} from '@industry/utils/session';

import type { TokenLimitChoice } from '@/core/types';
import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { convertAttachmentsToPlaceholderBase64Images } from '@/exec/imageAttachments';
import { MessageType } from '@/hooks/enums';
import { usePermissionQueue } from '@/hooks/permissionQueue';
import { useMountEffect } from '@/hooks/useMountEffect';
import { getI18n } from '@/i18n';
import {
  registerDaemonAskUserRequest,
  getPendingAskUserRequests,
  rejectAskUserAnswers,
} from '@/services/AskUserAnswerStore';
import { backgroundProcessTracker } from '@/services/BackgroundProcessTracker';
import {
  getCurrentSessionSettingsSnapshot,
  getSettingsSnapshotFromStore,
} from '@/services/daemon/session-settings/store';
import { getSessionCreationErrorMessage } from '@/services/daemon/sessionCreationErrorMessage';
import {
  getTuiDaemonAdapter,
  type TuiDaemonAdapter,
} from '@/services/daemon/TuiDaemonAdapter';
import { TokenLimitAction } from '@/services/enums';
import type { McpAuthRequiredInfo } from '@/services/mcp/types';
import { getSessionService } from '@/services/SessionService';
import {
  fetchTokenLimits,
  handleTokenLimitAction,
} from '@/services/TokenLimitService';
import type { DroolSession } from '@/services/types';
import type {
  ImageAttachment,
  BatchToolConfirmationDetails,
} from '@/types/types';
import { getEnabledQueuePlacement } from '@/utils/queuedMessagesFeatureFlag';
import {
  getTaskInvocationByChildSessionId,
  getUnfinishedTaskInvocationsForParent,
} from '@/utils/taskInvocationStore';

import type { DaemonSessionNotificationParams } from '@industry/common/daemon';
import type { MissionModelSettings } from '@industry/common/settings';
import type {
  PendingAskUserRequest as DaemonPendingAskUserRequest,
  PendingPermission,
} from '@industry/daemon-client';
import type { SessionTag } from '@industry/drool-sdk-ext/protocol/session';

/**
 * Resolves the relayed subagent permission title from live session state,
 * falling back to durable Task invocation metadata.
 */
function resolveSubagentSessionTitle(
  permission: PendingPermission,
  mainSessionId: string | null
): string | undefined {
  const titleForSession = (sessionId: string): string | undefined => {
    const liveTitle = getTuiDaemonAdapter()
      .getSessionStateManager()
      .getSessionManager(sessionId)
      ?.getStore()
      .getTitle();
    if (liveTitle) return liveTitle;

    const invocation = getTaskInvocationByChildSessionId(sessionId);
    if (!invocation?.subagentType) return undefined;
    return buildSubagentSessionTitle({
      subagentType: invocation.subagentType,
      taskTitle: invocation.description,
    });
  };

  return resolveSubagentSessionTitleShared({
    permissionSessionId: permission.sessionId,
    associatedSessionIds: permission.associatedSessionIds,
    mainSessionId,
    getTitleForSession: titleForSession,
    getActiveForegroundChildSessionId: (parentSessionId) => {
      const activeForeground = getUnfinishedTaskInvocationsForParent(
        parentSessionId
      )
        .filter((invocation) => !invocation.runInBackground)
        .sort((a, b) => a.updatedAt - b.updatedAt);
      return activeForeground[activeForeground.length - 1]?.childSessionId;
    },
  });
}

interface UseDaemonAgentProps {
  addMessage: (
    content: string,
    options?: {
      messageType?: MessageType;
      visibility?: MessageVisibility;
      images?: ImageAttachment[];
    }
  ) => void;
  loadConversationHistory: (messages: IndustryDroolMessage[]) => void;
  onSessionLoaded?: (
    sessionId: string,
    messages: IndustryDroolMessage[]
  ) => void;
  onInteractivePromptPending: () => void;
  activeSessionId: string | null;
  setChatInputText?: (
    text: string,
    options?: {
      fromQueuedDiscard?: boolean;
      requestId?: string;
      sessionId?: string;
    }
  ) => void;
}

type SessionSettingsUpdate = {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  interactionMode?: DroolInteractionMode;
  autonomyLevel?: AutonomyLevel;
  specModeModelId?: string | null;
  specModeReasoningEffort?: ReasoningEffort | null;
  missionSettings?: MissionModelSettings;
  tags?: SessionTag[];
  enabledToolIds?: string[];
  compactionThresholdCheckEnabled?: boolean;
};

type SettingsStore = {
  getModelId: () => string | null;
  setModelId: (modelId: string) => void;
  getReasoningEffort: () => string | null;
  setReasoningEffort: (reasoningEffort: string) => void;
  getInteractionMode: () => DroolInteractionMode | null;
  setInteractionMode: (interactionMode: DroolInteractionMode) => void;
  getAutonomyLevel: () => AutonomyLevel | null;
  setAutonomyLevel: (autonomyLevel: AutonomyLevel) => void;
  getSpecModeModelId: () => string | null;
  setSpecModeModelId: (specModeModelId: string | null) => void;
  getSpecModeReasoningEffort: () => string | null;
  setSpecModeReasoningEffort: (specModeReasoningEffort: string | null) => void;
  getMissionSettings: () => MissionModelSettings | null;
  setMissionSettings: (missionSettings: MissionModelSettings | null) => void;
  getCompactionThresholdCheckEnabled: () => boolean | null;
  setCompactionThresholdCheckEnabled: (enabled: boolean) => void;
  notify: () => void;
};

type SessionSettingsPatch = Omit<
  SessionSettingsUpdate,
  'tags' | 'enabledToolIds'
>;

function createSettingsPatch(
  settings: SessionSettingsUpdate
): SessionSettingsPatch {
  return {
    ...(settings.modelId !== undefined ? { modelId: settings.modelId } : {}),
    ...(settings.reasoningEffort !== undefined
      ? { reasoningEffort: settings.reasoningEffort }
      : {}),
    ...(settings.interactionMode !== undefined
      ? { interactionMode: settings.interactionMode }
      : {}),
    ...(settings.autonomyLevel !== undefined
      ? { autonomyLevel: settings.autonomyLevel }
      : {}),
    ...(settings.specModeModelId !== undefined
      ? { specModeModelId: settings.specModeModelId }
      : {}),
    ...(settings.specModeReasoningEffort !== undefined
      ? { specModeReasoningEffort: settings.specModeReasoningEffort }
      : {}),
    ...(settings.missionSettings !== undefined
      ? { missionSettings: settings.missionSettings }
      : {}),
    ...(settings.compactionThresholdCheckEnabled !== undefined
      ? {
          compactionThresholdCheckEnabled:
            settings.compactionThresholdCheckEnabled,
        }
      : {}),
  };
}

function applySettingsPatchToStore(
  store: SettingsStore,
  settings: SessionSettingsPatch
): void {
  let mutated = false;

  if (settings.modelId !== undefined) {
    store.setModelId(settings.modelId);
    mutated = true;
  }
  if (settings.reasoningEffort !== undefined) {
    store.setReasoningEffort(settings.reasoningEffort);
    mutated = true;
  }
  if (settings.interactionMode !== undefined) {
    store.setInteractionMode(settings.interactionMode);
    mutated = true;
  }
  if (settings.autonomyLevel !== undefined) {
    store.setAutonomyLevel(settings.autonomyLevel);
    mutated = true;
  }
  if (settings.specModeModelId !== undefined) {
    store.setSpecModeModelId(settings.specModeModelId);
    mutated = true;
  }
  if (settings.specModeReasoningEffort !== undefined) {
    store.setSpecModeReasoningEffort(settings.specModeReasoningEffort);
    mutated = true;
  }
  if (settings.missionSettings !== undefined) {
    store.setMissionSettings({
      ...(store.getMissionSettings() ?? {}),
      ...settings.missionSettings,
    });
    mutated = true;
  }
  if (settings.compactionThresholdCheckEnabled !== undefined) {
    store.setCompactionThresholdCheckEnabled(
      settings.compactionThresholdCheckEnabled
    );
    mutated = true;
  }

  if (mutated) {
    store.notify();
  }
}

function hasSettingsPatch(settings: SessionSettingsPatch): boolean {
  return Object.keys(settings).length > 0;
}

/**
 * React hook that delegates all agent logic to the daemon via TuiDaemonAdapter.
 *
 * Message rendering and working state are handled by useSyncExternalStore hooks
 * (useSessionMessages and useSessionWorkingState) that read directly from the
 * SessionStateManager. This hook handles:
 * - Session creation and message sending
 * - Permission, AskUser, and disconnect flows
 * - ERROR notifications (adding system messages)
 * - Settings propagation to daemon
 */
export function useDaemonAgent({
  addMessage,
  loadConversationHistory,
  onSessionLoaded,
  onInteractivePromptPending,
  activeSessionId,
  setChatInputText,
}: UseDaemonAgentProps) {
  // ── React state ──
  const [isCancelling, setIsCancelling] = useState(false);
  const {
    pendingConfirmation,
    pendingPermissionCount,
    pendingPermissionTotal,
    removePermissionFromQueue,
    clearPermissionQueue,
    clearResolvedPermission,
    enqueuePermission,
  } = usePermissionQueue();
  const [tokenLimitChoice, setTokenLimitChoice] =
    useState<TokenLimitChoice | null>(null);
  const [mcpAuthPending, setMcpAuthPending] =
    useState<McpAuthRequiredInfo | null>(null);

  // Track daemon-created session ID (set only after initializeTuiSession succeeds).
  // This is distinct from activeSessionId which may be a pre-created local session.
  const daemonSessionIdRef = useRef<string | null>(null);
  // Deduplicate concurrent ensureDaemonSession calls
  const ensureDaemonSessionPromiseRef = useRef<Promise<string | null> | null>(
    null
  );
  // Deferred load: when a session is resumed, we store its ID here so that
  // ensureDaemonSession can load it lazily (on first interaction) instead of
  // eagerly spawning a child process during the initial render.
  const pendingDaemonLoadSessionIdRef = useRef<string | null>(null);
  // Track the previous daemon session ID that should be closed *after* the
  // next session is successfully loaded/initialized. This avoids tearing down
  // the prior session eagerly if the subsequent load fails, and keeps the
  // SSM state around until the new session is ready to take over.
  const pendingCloseDaemonSessionIdRef = useRef<string | null>(null);
  // Sessions whose next AskUser prompt should suppress duplicate sound.
  const resumedSessionIdsRef = useRef<Set<string>>(new Set());
  // Track the session ID we're subscribed to for notification routing
  const subscribedSessionIdRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const adapterRef = useRef<TuiDaemonAdapter | null>(null);
  const cancellationPromiseRef = useRef<Promise<void> | null>(null);
  const pendingSettingsPatchRef = useRef<SessionSettingsPatch>({});

  // Reset daemon session ID when activeSessionId changes (e.g., /new, /sessions).
  // This ensures the next message creates a fresh daemon session instead of
  // sending to the old one.
  const initializedRef = useRef(false);
  const prevActiveSessionIdRef = useRef<string | null>(activeSessionId);

  useEffect(() => {
    const isFirstInit = !initializedRef.current;
    const previousActiveSessionId = prevActiveSessionIdRef.current;
    initializedRef.current = true;
    prevActiveSessionIdRef.current = activeSessionId;
    const isNewActiveSession =
      !isFirstInit &&
      activeSessionId !== null &&
      activeSessionId !== previousActiveSessionId &&
      daemonSessionIdRef.current !== activeSessionId;

    if (isNewActiveSession) {
      setMcpAuthPending(null);
      const prevDaemonSessionId = daemonSessionIdRef.current;
      daemonSessionIdRef.current = null;
      // Only clear pendingDaemonLoadSessionIdRef if it refers to the previous
      // session — preserve it when it was set for the newly selected session
      // (deferred resume load path).
      if (
        pendingDaemonLoadSessionIdRef.current &&
        pendingDaemonLoadSessionIdRef.current !== activeSessionId
      ) {
        pendingDaemonLoadSessionIdRef.current = null;
      }

      // Defer closing the previous daemon session until the next session has
      // been successfully loaded/initialized. This ensures we don't tear down
      // the previous child drool process (and its SSM state) until the new
      // session is ready to take over. See closePendingPreviousSession().
      if (prevDaemonSessionId) {
        pendingCloseDaemonSessionIdRef.current = prevDaemonSessionId;
      }
    }
  }, [activeSessionId]);

  // Keep callback refs current without triggering re-subscriptions
  const callbacksRef = useRef({
    addMessage,
    loadConversationHistory,
    onSessionLoaded,
    onInteractivePromptPending,
    setChatInputText,
  });
  callbacksRef.current = {
    addMessage,
    loadConversationHistory,
    onSessionLoaded,
    onInteractivePromptPending,
    setChatInputText,
  };

  /**
   * Close the previously-active daemon session stashed in
   * pendingCloseDaemonSessionIdRef, if any. Called after the next session
   * has been successfully loaded/initialized so its child drool process
   * (and SSM state) is torn down only once its replacement is ready.
   */
  const closePendingPreviousSession = useCallback(
    (newSessionId: string | null): void => {
      const prev = pendingCloseDaemonSessionIdRef.current;
      if (!prev) return;
      pendingCloseDaemonSessionIdRef.current = null;
      if (prev === newSessionId) return;
      const adapter = getTuiDaemonAdapter();
      void adapter.closeSession(prev).catch((err) => {
        logWarn(
          '[useDaemonAgent] Failed to close previous daemon session after load',
          { cause: err, sessionId: prev }
        );
      });
    },
    [clearResolvedPermission]
  );

  // ── Notification handler ──
  // Most notification types are now handled by SSM + useSyncExternalStore hooks
  // (useSessionMessages for messages, useSessionWorkingState for status).
  // This handler only processes notifications that require React state changes:
  // ERROR (system message display) and PERMISSION_RESOLVED (clear UI state).
  const handleNotification = useCallback(
    (notification: DaemonSessionNotificationParams['notification']) => {
      const cb = callbacksRef.current;

      switch (notification.type) {
        // ── SSM handles these — no React state mutation needed ──
        case SessionNotificationType.ASSISTANT_TEXT_DELTA:
        case SessionNotificationType.THINKING_TEXT_DELTA:
        case SessionNotificationType.CREATE_MESSAGE:
        case SessionNotificationType.TOOL_PROGRESS_UPDATE:
        case SessionNotificationType.DROOL_WORKING_STATE_CHANGED:
        case SessionNotificationType.SESSION_COMPACTED:
          // Handled by SessionStateManager → SessionStore → useSyncExternalStore
          break;

        case SessionNotificationType.TOOL_RESULT: {
          // SSM handles rendering. Additionally, register fire-and-forget
          // background processes in the TUI's tracker so BackgroundTasksPanel
          // can display and kill them.
          try {
            const adapter = getTuiDaemonAdapter();
            const ssm = adapter.getSessionStateManager();
            const sessionId = daemonSessionIdRef.current;
            if (sessionId) {
              const mgr = ssm.getSessionManager(sessionId);
              if (mgr) {
                const msgs = mgr.getDisplayMessages();
                // Find the tool_use block matching this result
                for (const msg of msgs) {
                  if (msg.role !== 'assistant' || !Array.isArray(msg.content))
                    continue;
                  for (const block of msg.content) {
                    if (
                      block.type === MessageContentBlockType.ToolUse &&
                      block.id === notification.toolUseId &&
                      block.name === 'Execute'
                    ) {
                      const input = block.input;
                      if (input?.fireAndForget === true) {
                        const resultText =
                          typeof notification.content === 'string'
                            ? notification.content
                            : '';
                        const pidMatch = resultText.match(/PID:\s*(\d+)/);
                        const outputMatch = resultText.match(/Output:\s*(\S+)/);
                        if (pidMatch) {
                          const pid = parseInt(pidMatch[1], 10);
                          const command =
                            (input.command as string) || 'background process';
                          backgroundProcessTracker.registerProcess(
                            pid,
                            command,
                            process.cwd(),
                            sessionId,
                            outputMatch?.[1]
                          );
                        }
                      }
                    }
                  }
                }
              }
            }
          } catch {
            // Non-critical — don't block notification handling
          }
          break;
        }

        // ── Still need React state updates ──
        case SessionNotificationType.ERROR:
          // Ignore since the emitter of the error already logs
          break;

        case SessionNotificationType.PERMISSION_RESOLVED:
          // Permission was resolved server-side (auto-cancel, another client,
          // batch clear). Drop the matching queued entry; if no requestId is
          // provided, fall back to clearing the whole queue.
          clearResolvedPermission(notification.requestId);
          break;

        case SessionNotificationType.MCP_AUTH_REQUIRED:
          setMcpAuthPending({
            serverName: notification.serverName,
            authUrl: notification.authUrl,
            message: notification.message,
            state: notification.state,
          });
          break;

        case SessionNotificationType.MCP_AUTH_COMPLETED:
          setMcpAuthPending(
            (prev) =>
              clearMcpAuthPendingForServer(prev, notification.serverName) ??
              null
          );
          break;

        case DaemonSpecificNotificationType.SESSION_INACTIVITY:
        case DaemonSpecificNotificationType.SESSION_PROCESS_EXITED: {
          const sessionId = subscribedSessionIdRef.current;
          if (sessionId) {
            if (daemonSessionIdRef.current === sessionId) {
              daemonSessionIdRef.current = null;
            }
            pendingDaemonLoadSessionIdRef.current = sessionId;
            ensureDaemonSessionPromiseRef.current = null;
            resumedSessionIdsRef.current.add(sessionId);
          }
          break;
        }

        case SessionNotificationType.SETTINGS_UPDATED:
          try {
            getSessionService().syncSettingsFromDaemon(notification.settings);
          } catch (err) {
            logWarn(
              '[useDaemonAgent] Failed to sync daemon settings into SessionService',
              { cause: err }
            );
          }
          break;

        // ── Informational — handled by other hooks ──
        case SessionNotificationType.SESSION_TITLE_UPDATED:
        case SessionNotificationType.MCP_STATUS_CHANGED:
        case SessionNotificationType.SESSION_TOKEN_USAGE_CHANGED:
          // Handled by useAgentSession, useMcp, etc.
          break;

        case SessionNotificationType.QUEUED_MESSAGES_DISCARDED: {
          const setText = cb.setChatInputText;
          if (setText && (notification.text || notification.requestId)) {
            setText(notification.text, {
              fromQueuedDiscard: true,
              requestId: notification.requestId,
              sessionId: subscribedSessionIdRef.current ?? undefined,
            });
          }
          break;
        }

        default:
          // Mission notifications and others handled elsewhere
          break;
      }
    },
    []
  );

  // ── Permission request handler ──
  const handlePermissionRequest = useCallback(
    (permission: PendingPermission) => {
      logInfo('[useDaemonAgent] Permission request received', {
        requestId: permission.requestId,
        toolCount: permission.toolUses.length,
      });
      // Convert PendingPermission to BatchToolConfirmationDetails
      const tools: ToolConfirmationInfo[] = permission.toolUses.map((tu) => {
        const toolInfo: ToolConfirmationInfo = {
          toolUseId: tu.toolUse.id,
          toolName: tu.toolUse.name,
          toolInput: tu.toolUse.input,
          confirmationType: tu.confirmationType,
          details: tu.details,
        };

        return {
          ...toolInfo,
          toolInput: getPermissionToolInputForDisplay(toolInfo),
        };
      });

      // A relayed subagent permission carries the subagent's own session id,
      // which differs from the session this TUI is attached to. Surface the
      // subagent session's title so the user knows which agent is asking; the
      // main session renders no such label.
      const mainSessionId = subscribedSessionIdRef.current;
      const subagentSessionTitle = resolveSubagentSessionTitle(
        permission,
        mainSessionId
      );

      const confirmationDetails: BatchToolConfirmationDetails = {
        tools,
        ...(subagentSessionTitle !== undefined && { subagentSessionTitle }),
        onConfirm: async (
          outcome: ToolConfirmationOutcome,
          _approvedToolIds?: string[],
          comment?: string,
          editedSpecContent?: string
        ) => {
          try {
            const adapter = getTuiDaemonAdapter();
            await adapter.respondToPermission({
              permissionId: permission.requestId,
              selectedOption: outcome,
              sessionId: permission.sessionId,
              ...(comment !== undefined && { comment }),
              ...(editedSpecContent !== undefined && { editedSpecContent }),
            });
            removePermissionFromQueue(permission.requestId);
          } catch (permErr) {
            logWarn('[useDaemonAgent] Failed to respond to permission', {
              cause: permErr,
            });
          }
        },
      };

      const entry = {
        requestId: permission.requestId,
        sessionId: permission.sessionId,
        details: confirmationDetails,
      };

      callbacksRef.current.onInteractivePromptPending();
      enqueuePermission(entry);
    },
    [enqueuePermission, removePermissionFromQueue]
  );

  // ── AskUser request handler ──
  const handleAskUserRequest = useCallback(
    (request: DaemonPendingAskUserRequest) => {
      logInfo('[useDaemonAgent] AskUser request received', {
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        questionCount: request.questions.length,
      });

      const adapter = getTuiDaemonAdapter();
      const sessionId = request.sessionId;

      // Consume the one-shot duplicate-sound suppression flag.
      const isResumeReplay = resumedSessionIdsRef.current.delete(sessionId);

      // Register the request in AskUserAnswerStore so usePendingAskUser picks it up.
      // The resolve/reject callbacks route through the daemon adapter.
      callbacksRef.current.onInteractivePromptPending();
      registerDaemonAskUserRequest(
        request.toolCallId,
        request.questions,
        (answers) => {
          void adapter
            .respondToAskUser({
              requestId: request.requestId,
              sessionId,
              result: { answers },
            })
            .catch((askErr) => {
              logWarn('[useDaemonAgent] Failed to respond to AskUser', {
                cause: askErr,
              });
            });
        },
        () => {
          void adapter
            .respondToAskUser({
              requestId: request.requestId,
              sessionId,
              result: { cancelled: true, answers: [] },
            })
            .catch((cancelErr) => {
              logWarn('[useDaemonAgent] Failed to cancel AskUser', {
                cause: cancelErr,
              });
            });
        },
        request.requestId,
        { suppressSound: isResumeReplay }
      );
    },
    []
  );

  // ── Disconnect handler ──
  const handleDisconnect = useCallback(
    (code: number, reason: string) => {
      logWarn('[useDaemonAgent] Daemon disconnected', {
        code,
        reason,
      });
      callbacksRef.current.addMessage(
        getI18n().t('common:appMessages.daemonDisconnected', {
          defaultValue: `Daemon connection lost (code ${code}). The daemon may have crashed or been stopped.`,
        }),
        {
          messageType: MessageType.Text,
          visibility: MessageVisibility.UserOnly,
        }
      );
      // Clear any pending confirmations/AskUser since the daemon is gone
      clearPermissionQueue();

      // Reject any pending AskUser requests so they don't hang forever
      const pendingRequests = getPendingAskUserRequests();
      for (const request of pendingRequests) {
        rejectAskUserAnswers(
          request.toolCallId,
          new Error('Daemon disconnected')
        );
      }
    },
    [clearPermissionQueue]
  );

  // ── Subscribe to notifications when session ID changes ──
  const subscribeToSession = useCallback(
    (sessionId: string) => {
      // Clean up previous subscription
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }

      const adapter = getTuiDaemonAdapter();
      adapterRef.current = adapter;
      subscribedSessionIdRef.current = sessionId;

      // Subscribe to all event types for this session
      const unsubNotifications = adapter.subscribeToSessionNotifications(
        sessionId,
        handleNotification
      );
      const unsubPermissions = adapter.subscribeToPermissionRequests(
        sessionId,
        handlePermissionRequest
      );
      const unsubAskUser = adapter.subscribeToAskUserRequests(
        sessionId,
        handleAskUserRequest
      );
      const unsubDisconnect = adapter.onDisconnect(handleDisconnect);

      // Combine all unsubscribe functions
      unsubscribeRef.current = () => {
        unsubNotifications();
        unsubPermissions();
        unsubAskUser();
        unsubDisconnect();
      };

      logInfo('[useDaemonAgent] Subscribed to session notifications', {
        sessionId,
      });
    },
    [
      handleNotification,
      handlePermissionRequest,
      handleAskUserRequest,
      handleDisconnect,
    ]
  );

  // Cleanup on unmount
  useMountEffect(() => () => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
  });

  /**
   * Eagerly load an existing daemon session for the given session ID.
   * Used after compaction/session handoff to ensure the daemon has a CLI
   * process ready before the user sends a message.
   */
  const initializeDaemonSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const adapter = getTuiDaemonAdapter();
      pendingDaemonLoadSessionIdRef.current = null;
      try {
        // Defer closing the previous daemon session until the new one is
        // successfully initialized below. This prevents tearing down the
        // prior session (and its SSM state) if initialization fails.
        const prevSessionId = daemonSessionIdRef.current;
        if (prevSessionId && prevSessionId !== sessionId) {
          pendingCloseDaemonSessionIdRef.current = prevSessionId;
        }

        await adapter.loadSession(sessionId);
        daemonSessionIdRef.current = sessionId;

        pendingSettingsPatchRef.current = {};

        agentEventBus.emit(AgentEvent.SessionCreated, {
          sessionId,
        });

        subscribeToSession(sessionId);

        // Session was successfully initialized — tear down the previous
        // session's daemon process and clean up its SSM state.
        closePendingPreviousSession(sessionId);
      } catch (err) {
        logException(
          err,
          '[useDaemonAgent] Failed to initialize daemon session'
        );
      }
    },
    [subscribeToSession, closePendingPreviousSession]
  );

  /**
   * Ensure a daemon session exists, creating one if needed.
   * Returns the session ID or null if creation failed.
   */
  const ensureDaemonSession = useCallback(async (): Promise<string | null> => {
    if (daemonSessionIdRef.current) return daemonSessionIdRef.current;

    // Deduplicate concurrent calls (e.g., resume + fork racing)
    if (ensureDaemonSessionPromiseRef.current) {
      return ensureDaemonSessionPromiseRef.current;
    }

    // If a session was resumed but the daemon load was deferred, do it now.
    const pendingLoadId = pendingDaemonLoadSessionIdRef.current;
    if (pendingLoadId) {
      pendingDaemonLoadSessionIdRef.current = null;
      const loadPromise = (async (): Promise<string | null> => {
        let explicitPendingPatch: SessionSettingsPatch | null = null;
        try {
          const adapter = getTuiDaemonAdapter();
          explicitPendingPatch = pendingSettingsPatchRef.current;
          pendingSettingsPatchRef.current = {};
          await adapter.loadSession(pendingLoadId);
          daemonSessionIdRef.current = pendingLoadId;

          const pendingSettingsPatchAfterLoad = pendingSettingsPatchRef.current;
          pendingSettingsPatchRef.current = {};
          const settingsPatch = {
            ...explicitPendingPatch,
            ...pendingSettingsPatchAfterLoad,
          };
          if (hasSettingsPatch(settingsPatch)) {
            try {
              await adapter.updateSessionSettings({
                sessionId: pendingLoadId,
                ...settingsPatch,
              });
            } catch (settingsErr) {
              logWarn(
                '[useDaemonAgent] Failed to sync pending session settings',
                { cause: settingsErr }
              );
            }
          }

          // Session was successfully loaded — tear down the previous
          // session's daemon process and clean up its SSM state.
          closePendingPreviousSession(pendingLoadId);

          return pendingLoadId;
        } catch (e) {
          if (explicitPendingPatch) {
            pendingSettingsPatchRef.current = {
              ...explicitPendingPatch,
              ...pendingSettingsPatchRef.current,
            };
          }
          logWarn(
            '[useDaemonAgent] Failed to load session in daemon on deferred resume',
            { cause: e }
          );
          return null;
        }
      })();
      ensureDaemonSessionPromiseRef.current = loadPromise;
      try {
        return await loadPromise;
      } finally {
        ensureDaemonSessionPromiseRef.current = null;
      }
    }

    const promise = (async (): Promise<string | null> => {
      const adapter = getTuiDaemonAdapter();
      let settingsPatchConsumedForInitialize: SessionSettingsPatch | null =
        null;
      try {
        await adapter.ensureConnectedAndGetController();

        const svc = getSessionService();
        // Reuse the pre-created session ID from SessionService so the daemon
        // doesn't create a second session file on disk.
        const preCreatedSessionId = svc.getCurrentSessionId() ?? undefined;
        const defaultSettings = getSettingsSnapshotFromStore(
          adapter.getSessionStateManager().getDefaultSettingsStore()
        );
        const currentSettings =
          preCreatedSessionId !== undefined
            ? getCurrentSessionSettingsSnapshot()
            : defaultSettings;
        const settingsPatch = {
          ...(currentSettings.modelId !== undefined
            ? { modelId: currentSettings.modelId }
            : {}),
          ...(currentSettings.reasoningEffort !== undefined
            ? { reasoningEffort: currentSettings.reasoningEffort }
            : {}),
          ...(currentSettings.interactionMode !== undefined
            ? { interactionMode: currentSettings.interactionMode }
            : {}),
          ...(currentSettings.autonomyLevel !== undefined
            ? { autonomyLevel: currentSettings.autonomyLevel }
            : {}),
          ...(currentSettings.specModeModelId !== undefined
            ? { specModeModelId: currentSettings.specModeModelId }
            : {}),
          ...(currentSettings.specModeReasoningEffort !== undefined
            ? {
                specModeReasoningEffort:
                  currentSettings.specModeReasoningEffort,
              }
            : {}),
          ...(currentSettings.missionSettings
            ? { missionSettings: currentSettings.missionSettings }
            : {}),
          ...(currentSettings.compactionThresholdCheckEnabled !== undefined
            ? {
                compactionThresholdCheckEnabled:
                  currentSettings.compactionThresholdCheckEnabled,
              }
            : {}),
          ...pendingSettingsPatchRef.current,
        };
        settingsPatchConsumedForInitialize = pendingSettingsPatchRef.current;
        pendingSettingsPatchRef.current = {};

        const result = await adapter.initializeTuiSession({
          cwd: process.cwd(),
          sessionId: preCreatedSessionId,
          modelId: settingsPatch.modelId,
          reasoningEffort: settingsPatch.reasoningEffort,
          interactionMode: settingsPatch.interactionMode,
          autonomyLevel: settingsPatch.autonomyLevel,
          tags: svc.getCurrentSessionTags(),
          specModeModelId: settingsPatch.specModeModelId ?? undefined,
          specModeReasoningEffort:
            settingsPatch.specModeReasoningEffort ?? undefined,
          missionSettings: settingsPatch.missionSettings,
          compactionThresholdCheckEnabled:
            settingsPatch.compactionThresholdCheckEnabled,
        });
        const sessionId = result.sessionId;
        daemonSessionIdRef.current = sessionId;

        const pendingSettingsPatchAfterInitialize =
          pendingSettingsPatchRef.current;
        pendingSettingsPatchRef.current = {};
        settingsPatchConsumedForInitialize = null;

        if (hasSettingsPatch(pendingSettingsPatchAfterInitialize)) {
          const sessionStore = adapter
            .getSessionStateManager()
            .getSessionManager(sessionId)
            ?.getStore();
          if (sessionStore) {
            applySettingsPatchToStore(
              sessionStore,
              pendingSettingsPatchAfterInitialize
            );
          }
          try {
            await adapter.updateSessionSettings({
              sessionId,
              ...pendingSettingsPatchAfterInitialize,
            });
          } catch (settingsErr) {
            logWarn(
              '[useDaemonAgent] Failed to apply pending settings after session initialization',
              { cause: settingsErr }
            );
          }
        }

        // Bridge the daemon session to React state by emitting SessionCreated.
        // This updates useAgentSession.activeSessionId which triggers the
        // registerSession effect in app.tsx, ensuring the multi-session tab bar
        // knows about this session and focusedSessionId is set.
        agentEventBus.emit(AgentEvent.SessionCreated, {
          sessionId,
        });

        subscribeToSession(sessionId);

        // Session was successfully initialized — tear down the previous
        // session's daemon process and clean up its SSM state.
        closePendingPreviousSession(sessionId);

        return sessionId;
      } catch (createErr) {
        if (settingsPatchConsumedForInitialize) {
          pendingSettingsPatchRef.current = {
            ...settingsPatchConsumedForInitialize,
            ...pendingSettingsPatchRef.current,
          };
        }
        logException(createErr, '[useDaemonAgent] Failed to create session');

        addMessage(getSessionCreationErrorMessage(createErr), {
          messageType: MessageType.Text,
          visibility: MessageVisibility.UserOnly,
        });
        return null;
      }
    })();

    ensureDaemonSessionPromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      ensureDaemonSessionPromiseRef.current = null;
    }
  }, [subscribeToSession, addMessage, closePendingPreviousSession]);

  /**
   * Fork the current daemon session:
   *  1. Ensure the current session is initialized in the daemon
   *  2. Send fork_session RPC to the daemon (creates new session on disk)
   *  3. Close the old daemon session (kills old drool process)
   *  4. Load the new session in the daemon (spawns new drool process)
   *  5. Update internal state so the hook tracks the new session
   *
   * Returns the new session ID.
   */
  const forkDaemonSession = useCallback(async (): Promise<string> => {
    const adapter = getTuiDaemonAdapter();

    // 1. Ensure the current session has a daemon process initialized
    const currentSessionId = await ensureDaemonSession();
    if (!currentSessionId) {
      throw new Error('Cannot fork: no daemon session initialized');
    }

    // 2. Fork via daemon RPC
    const { newSessionId } = await adapter.forkSession(currentSessionId);

    // 3. Close the old daemon session
    await adapter.closeSession(currentSessionId);

    // 4. Update refs BEFORE loadSession so that any re-render triggered by
    //    the load (or the subsequent resumeSession) sees the new session ID
    //    and doesn't reset it or spawn a duplicate via ensureDaemonSession.
    daemonSessionIdRef.current = newSessionId;
    ensureDaemonSessionPromiseRef.current = null;

    // 5. Load the new session in the daemon (spawns new drool process)
    await adapter.loadSession(newSessionId);
    subscribeToSession(newSessionId);

    return newSessionId;
  }, [ensureDaemonSession, subscribeToSession]);

  // ── Public API (matches useAgent interface) ──
  const runAgent = useCallback(
    async (params: {
      message: string;
      images?: ImageAttachment[];
      additionalContentBlocks?: TextBlock[];
      files?: DocumentSource[];
      hookContext?: string;
      messageId?: string;
      requestId?: string;
      queuePlacement?: QueuePlacement;
      role?: ProtocolMessageRole;
      visibility?: MessageVisibility;
    }): Promise<boolean> => {
      const adapter = getTuiDaemonAdapter();
      // Use the known session ID synchronously when available so the
      // optimistic message is added in the same tick as the caller.
      // This is critical for flows that call redrawSession() + runAgent()
      // together (e.g. spec handoff) — awaiting an already-resolved async
      // function still defers to the next microtask, causing Ink's <Static>
      // to commit before the optimistic message is added.
      const currentSessionId =
        daemonSessionIdRef.current ?? (await ensureDaemonSession());
      if (!currentSessionId) return false;

      const fullMessage = params.message;

      // Generate a requestId that flows through the entire chain:
      // useDaemonAgent → TuiDaemonAdapter → DaemonSessionController → daemon
      // This lets us add an optimistic user message to the SSM immediately
      // and remove it when the daemon confirms via CREATE_MESSAGE.
      const requestId = params.requestId ?? uuidv4();

      // Add optimistic user message directly to the SSM so it appears in
      // sessionMessages immediately. This avoids prepending to the local
      // messages array which causes index shifting in Ink's <Static>.
      const ssm = adapter.getSessionStateManager();
      const mgr = ssm.getSessionManager(currentSessionId);

      // When the drool is busy, skip optimistic message handling here.
      // DaemonSessionController.addUserMessage() will queue the message in
      // SSM for display and the daemon will drain it mid-loop. We only add
      // an optimistic message + start streaming when drool is idle (new turn).
      const isDroolIdle =
        mgr?.getDroolWorkingState() === DroolWorkingState.Idle;
      const queuePlacement = getEnabledQueuePlacement(params.queuePlacement);
      const shouldOptimisticallySubmit =
        isDroolIdle && queuePlacement === QueuePlacement.EndOfTurn;

      if (shouldOptimisticallySubmit) {
        const optimisticContent = buildUserMessageContentBlocks({
          text: fullMessage,
          images: convertAttachmentsToPlaceholderBase64Images(params.images),
        });

        const optimisticMessage: IndustryDroolMessage = {
          id: `optimistic-${requestId}`,
          role: params.role ?? ProtocolMessageRole.User,
          content: optimisticContent,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...(params.visibility && { visibility: params.visibility }),
        };

        if (mgr) {
          mgr.addOptimisticMessage(requestId, optimisticMessage);
        }
      }

      // Send to daemon. Working state transitions are handled by SSM via
      // DROOL_WORKING_STATE_CHANGED notifications → useSessionWorkingState.
      // When drool is busy, the daemon queues the message and drains it
      // mid-loop (between tool calls), enabling queued message interruption.
      try {
        await adapter.sendTuiMessage({
          sessionId: currentSessionId,
          text: fullMessage,
          images: params.images,
          files: params.files,
          requestId,
          queuePlacement,
          ...(params.role && { role: params.role }),
          ...(params.visibility && { visibility: params.visibility }),
        });

        return true;
      } catch (sendError) {
        // Revert optimistic message on failure
        if (shouldOptimisticallySubmit && mgr) {
          mgr.removeOptimisticMessage(requestId);
        }
        logException(sendError, '[useDaemonAgent] Failed to send message');
        addMessage(
          getI18n().t('common:appMessages.messageSendFailed') ||
            'Failed to send message to daemon.',
          {
            messageType: MessageType.Text,
            visibility: MessageVisibility.UserOnly,
          }
        );
        return false;
      }
    },
    [addMessage, ensureDaemonSession]
  );

  const stopAgent = useCallback((): Promise<void> => {
    if (cancellationPromiseRef.current) {
      return cancellationPromiseRef.current;
    }

    const currentSessionId = daemonSessionIdRef.current;
    if (!currentSessionId) return Promise.resolve();

    const cancellationPromise = (async () => {
      setIsCancelling(true);
      try {
        const adapter = getTuiDaemonAdapter();
        await adapter.interruptSession(currentSessionId);

        addMessage(getI18n().t('common:appMessages.requestCancelledByUser'), {
          messageType: MessageType.Text,
          visibility: MessageVisibility.UserOnly,
        });
      } catch (stopError) {
        logWarn('[useDaemonAgent] Failed to interrupt session', {
          cause: stopError,
        });
      }
    })();

    cancellationPromiseRef.current = cancellationPromise;

    void cancellationPromise.finally(() => {
      if (cancellationPromiseRef.current === cancellationPromise) {
        cancellationPromiseRef.current = null;
        setIsCancelling(false);
      }
    });

    return cancellationPromise;
  }, [addMessage]);

  const stopAgentWithTimeout = useCallback(
    async (timeoutMs = 5000): Promise<void> => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const cancellation = stopAgent();

      // The timeout only stops this caller from awaiting indefinitely; it does
      // NOT declare the interrupt safe. The canonical cancellation promise and
      // `isCancelling` flag remain owned by `stopAgent`'s `.finally` and only
      // clear when `adapter.interruptSession()` has actually settled. Clearing
      // them here would let `app.tsx` treat a follow-up prompt as safe while the
      // daemon is still draining queued messages, which is the root cause of
      // the post-Esc duplicate-user-message bug.
      await Promise.race([
        cancellation.finally(() => {
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
        }),
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, timeoutMs);
        }),
      ]);
    },
    [stopAgent]
  );

  /**
   * Add a user message to the conversation without starting the agent loop.
   * Used by bash mode to persist command output as a user message.
   */
  const addUserMessage = useCallback(
    async (text: string): Promise<void> => {
      const sessionId = await ensureDaemonSession();
      if (!sessionId) return;

      const adapter = getTuiDaemonAdapter();
      await adapter.sendTuiMessage({
        sessionId,
        text,
        skipAgentLoop: true,
      });
    },
    [ensureDaemonSession]
  );

  const loadConversationHistoryFromSession = useCallback(
    (session: DroolSession) => {
      if (session.messages && session.messages.length > 0) {
        callbacksRef.current.loadConversationHistory(session.messages);
      }
      if (session.id) {
        subscribeToSession(session.id);

        // Populate the SSM with loaded messages so useSessionMessages can
        // render them. Without this, only user messages (from local state)
        // would be visible since the SSM store would be empty for resumed sessions.
        try {
          const adapter = getTuiDaemonAdapter();
          adapter.hydrateLocalSessionState({
            sessionId: session.id,
            messages: session.messages ?? [],
            uiRenderCutoffMessageId: session.uiRenderCutoffMessageId ?? null,
          });
          callbacksRef.current.onSessionLoaded?.(
            session.id,
            session.messages ?? []
          );
        } catch (e) {
          logWarn(
            '[useDaemonAgent] Failed to populate SSM with loaded session messages',
            { cause: e }
          );
        }

        // Stash the previous daemon session so ensureDaemonSession can tear
        // it down *after* the new session is successfully loaded below (via
        // the deferred load path). This keeps the previous session's child
        // process and SSM state alive until the replacement is ready.
        const prevSessionId = daemonSessionIdRef.current;
        if (prevSessionId && prevSessionId !== session.id) {
          pendingCloseDaemonSessionIdRef.current = prevSessionId;
          daemonSessionIdRef.current = null;
        }

        // Defer the daemon loadSession to the first interaction that actually
        // needs the child process (e.g., sendMessage, fork, compact). This
        // avoids spawning a child process during the initial resume render,
        // which can cause race conditions and CI flakiness.
        pendingDaemonLoadSessionIdRef.current = session.id;
      }
    },
    [subscribeToSession]
  );

  const isAgentRunning = useCallback((): boolean => {
    // Check if the focused session's working state is non-idle via SSM.
    // This is a best-effort check; callers in app.tsx should prefer
    // sessionStatus from useSessionWorkingState for rendering decisions.
    const currentSessionId = daemonSessionIdRef.current;
    if (!currentSessionId) return false;
    try {
      const adapter = getTuiDaemonAdapter();
      const ssm = adapter.getSessionStateManager();
      const mgr = ssm.getSessionManager(currentSessionId);
      if (!mgr) return false;
      return mgr.getDroolWorkingState() !== DroolWorkingState.Idle;
    } catch {
      return false;
    }
  }, []);

  const dismissTokenLimitChoice = useCallback(() => {
    setTokenLimitChoice(null);
  }, []);

  const showTokenLimitChoice = useCallback(async () => {
    const result = await fetchTokenLimits();
    if (result.type === 'choice') {
      setTokenLimitChoice(result.choice);
    } else {
      addMessage(result.message);
    }
  }, [addMessage]);

  // ── Settings propagation ──
  // The daemon/daemon-client SSM is the canonical source for CLI-visible
  // settings. Before a daemon session exists, keep a session-level patch in
  // SSM so the next initialize/load call can send it to the daemon.
  const updateSettings = useCallback(
    async (settings: SessionSettingsUpdate): Promise<void> => {
      const adapter = getTuiDaemonAdapter();
      let currentSessionId = daemonSessionIdRef.current;

      if (!currentSessionId && pendingDaemonLoadSessionIdRef.current) {
        currentSessionId = await ensureDaemonSession();
      }

      if (!currentSessionId) {
        const ssm = adapter.getSessionStateManager();
        const patch = createSettingsPatch(settings);
        pendingSettingsPatchRef.current = {
          ...pendingSettingsPatchRef.current,
          ...patch,
        };

        applySettingsPatchToStore(ssm.getPendingStore(), patch);

        const pendingSessionId =
          pendingDaemonLoadSessionIdRef.current ??
          getSessionService().getCurrentSessionId();
        const pendingSessionStore = pendingSessionId
          ? ssm.getSessionManager(pendingSessionId)?.getStore()
          : null;
        if (pendingSessionStore) {
          applySettingsPatchToStore(pendingSessionStore, patch);
        }
        return;
      }

      const patch = createSettingsPatch(settings);
      if (hasSettingsPatch(patch)) {
        const sessionStore = adapter
          .getSessionStateManager()
          .getSessionManager(currentSessionId)
          ?.getStore();
        if (sessionStore) {
          applySettingsPatchToStore(sessionStore, patch);
        }
      }

      try {
        await adapter.updateSessionSettings({
          sessionId: currentSessionId,
          ...settings,
        });
      } catch (settingsErr) {
        logWarn('[useDaemonAgent] Failed to update session settings', {
          cause: settingsErr,
        });
      }
    },
    [ensureDaemonSession]
  );

  const handleTokenLimitChoice = useCallback(
    async (action: TokenLimitAction) => {
      const recommendedModel = tokenLimitChoice?.recommendedCoreModel;
      setTokenLimitChoice(null);
      const message = await handleTokenLimitAction(action, {
        recommendedCoreModel: recommendedModel,
        onMessage: addMessage,
      });
      addMessage(message);
      if (action === TokenLimitAction.DroolCore && recommendedModel) {
        void updateSettings({ modelId: recommendedModel });
      }
    },
    [tokenLimitChoice, addMessage, updateSettings]
  );

  // Prepare a no-op prepareMessagesWithCaching placeholder
  const prepareMessagesWithCaching = useCallback(
    () => ({ messages: [], systemMessage: '' }),
    []
  );

  return {
    runAgent,
    addUserMessage,
    stopAgent,
    stopAgentWithTimeout,
    isCancelling,
    loadConversationHistory: loadConversationHistoryFromSession,
    pendingConfirmation,
    pendingPermissionCount,
    pendingPermissionTotal,
    mcpAuthPending,
    prepareMessagesWithCaching,
    isAgentRunning,
    tokenLimitChoice,
    handleTokenLimitChoice,
    dismissTokenLimitChoice,
    showTokenLimitChoice,
    // Expose session subscription for external callers (e.g., session resume)
    subscribeToSession,
    // Expose settings propagation for UI handlers
    updateSettings,
    // Eagerly initialize a daemon session (e.g., after compaction)
    initializeDaemonSession,
    // Eagerly ensure a daemon session exists (creates one if needed)
    ensureDaemonSession,
    // Fork current session via daemon lifecycle (fork → close old → load new)
    forkDaemonSession,
  };
}
