import { COMPUTER_ID_REGEX } from '@industry/common/api/v0/computers';
import { LOCAL_MACHINE_ID } from '@industry/common/daemon';
import {
  convertLocallyPersistedMessageContentToDroolMessageContent,
  MachineConnectionType,
  SESSION_PLACEHOLDER_TITLE,
  SessionPrivacyLevel,
} from '@industry/common/session';
import { TokenUsage } from '@industry/common/session/settings';
import { SessionTitleAutoStage } from '@industry/common/session/summary';
import { type MissionModelSettings } from '@industry/common/settings';
import { DroolMode, DroolSubMode } from '@industry/common/shared';
import { InvalidSessionCwdError } from '@industry/drool-sdk';
import {
  DecompSessionType,
  DroolWorkingState,
  MissionState,
  type MissionSnapshot,
  type SandboxStatus,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  ModelProvider,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';
import {
  SessionSource,
  SessionTag,
} from '@industry/drool-sdk-ext/protocol/session';
import {
  IndustryDroolMessage,
  MessageContentBlockType,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import {
  AutonomyLevel,
  AutonomyMode,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logException, logInfo, logWarn } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';
import {
  getIndustrySessionAttributionAttributes,
  OtelTracing,
  SessionOrigin,
  SpanAttribute,
  SpanName,
} from '@industry/logging/tracing';
import { SettingsManager } from '@industry/runtime/settings';
import {
  deriveAutonomyMode,
  hasDecoupledInteractionSettings,
  resolveInteractionSettingsWithLegacyFallback,
} from '@industry/utils/autonomy';
import {
  getBaseVariant,
  predictSelectionSwitchEffects,
  resolveProviderForSelection,
} from '@industry/utils/llm';
import { expandTilde } from '@industry/utils/shell/node';

import {
  AgentEvent,
  agentEventBus,
  SessionTitleUpdateType,
} from '@/events/AgentEventBus';
import {
  getLatestSummaryMetaFromSession,
  isAnchoredAtLastMessage,
  serializeAndPersistForProviderSwitch,
} from '@/hooks/compaction/providerSwitchUtils';
import { getI18n } from '@/i18n';
import { isModelFeatureFlagEnabled } from '@/models/availability';
import { getTuiModelConfig } from '@/models/config';
import { getConversationStateManager } from '@/services/ConversationStateManager';
import { getDroolRuntimeService } from '@/services/DroolRuntimeService';
import { getMcpService } from '@/services/mcp/McpService';
import { getMissionFileService } from '@/services/mission/MissionFileService';
import {
  isMissionRunnerActive,
  killWorkerSession,
  reconcileMissionStateAfterSessionLoad,
} from '@/services/mission/missionRunnerOperations';
import {
  getDecompSessionTypeFromTags,
  upsertMissionSessionTag,
} from '@/services/mission/sessionTags';
import { getSessionService } from '@/services/SessionService';
import { generateAndUpdateSessionTitle } from '@/services/SessionTitleGenerator';
import { getSettingsService } from '@/services/SettingsService';
import type { DroolMessageEvent } from '@/services/types';
import { classifySessionKind } from '@/telemetry/system/initCliTracing';
import { cleanMessage } from '@/utils/cleanMessage';
import { loadMissionStateWithDetails } from '@/utils/loadMissionState';
import {
  reinitializeSandboxForCwd,
  resolveWorkingDirectoryPath,
} from '@/utils/sessionCwd';
import { recordStartupLatency } from '@/utils/startupLatency';

function cloneSessionMessages(
  messages: IndustryDroolMessage[]
): IndustryDroolMessage[] {
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block) =>
          block && typeof block === 'object' ? { ...block } : block
        )
      : message.content,
  }));
}

function shouldRecordJsonRpcInitMetrics(): boolean {
  const runtime = getDroolRuntimeService();
  return (
    runtime.getDroolMode() === DroolMode.InteractiveCLI &&
    runtime.getDroolSubMode() === DroolSubMode.JsonRpc
  );
}

/**
 * SessionSettings represents the current settings state for a session.
 * This is the single source of truth that both services and adapters reference.
 */
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export interface SessionSettings {
  modelId: string;
  reasoningEffort: ReasoningEffort;
  /** @deprecated Use interactionMode + autonomyLevel instead. */
  autonomyMode: AutonomyMode;
  interactionMode?: DroolInteractionMode;
  autonomyLevel?: AutonomyLevel;
  specModeModelId?: string | null;
  specModeReasoningEffort?: ReasoningEffort | null;
  missionSettings?: MissionModelSettings;
  enabledToolIds?: string[];
  disabledToolIds?: string[];
  sandbox?: SandboxStatus;
  compactionThresholdCheckEnabled?: boolean;
}

/**
 * Parameters for creating a new session
 */
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export interface CreateSessionParams {
  sessionId?: string;
  cwd?: string;
  workspaceId?: string;
  machineId?: string;
  skipRemoteCreation?: boolean;
  /** First user message for session title generation */
  firstUserMessage?: string;
  /** Initial settings to apply (overrides defaults) */
  initialSettings?: Partial<SessionSettings>;
  /** Decomposition session type (orchestrator or worker) */
  decompSessionType?: DecompSessionType;
  /** Decomposition mission ID (for linking workers to orchestrator) */
  decompMissionId?: string;
  /** Session location for delegations (e.g., "Linear Agent Delegation") */
  sessionLocation?: string;
  /** Session source metadata for delegations */
  sessionSource?: SessionSource;
  /** Explicit root session origin propagated from the parent process. */
  sessionOriginHint?: SessionOrigin;
  /** Session tags for categorization */
  tags?: SessionTag[];
  privacyLevel?: SessionPrivacyLevel | 'private' | 'organization';
  /** Parent session ID for linking child/subagent sessions to their parent */
  callingSessionId?: string;
  /** Parent tool use ID that spawned this subagent session */
  callingToolUseId?: string;
  /** Session title override (e.g., for Task tool subagents) */
  sessionTitle?: string;
  /** Additional tool IDs to enable for this session */
  enabledToolIds?: string[];
  /** Tool IDs explicitly disabled for this session */
  disabledToolIds?: string[];
}

/**
 * Parameters for loading an existing session
 */
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export interface LoadSessionParams {
  sessionId: string;
  loadAllMessages?: boolean;
  /** Client surface this load originates from (TUI, desktop, web, ...). */
  sessionOriginHint?: SessionOrigin;
}

/**
 * Result of loading a session
 */
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export interface LoadedSessionResult {
  sessionId: string;
  cwd?: string;
  hostId?: string;
  settings: SessionSettings;
  messages: IndustryDroolMessage[];
  title?: string;
  callingSessionId?: string;
  callingToolUseId?: string;
  decompSessionType?: DecompSessionType;
  decompMissionId?: string;
  missionSnapshot?: MissionSnapshot | null;
  tokenUsage?: TokenUsage;
  uiRenderCutoffMessageId?: string | null;
}

/**
 * Result of a model switch operation
 */
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export interface ModelSwitchResult {
  success: boolean;
  compactionPerformed: boolean;
  error?: string;
}

/**
 * Result of an MCP operation
 */
// eslint-disable-next-line industry/types-file-organization -- PLT-76: migrated from file-level disable
export interface McpOperationResult {
  success: boolean;
  error?: string;
}

/**
 * SessionController provides unified session lifecycle and settings management
 * for all execution modes (TUI, StreamingJSONRPC, ACP).
 *
 * It acts as the single source of truth for:
 * - Current session ID
 * - Session settings (model, reasoning effort, autonomy mode, spec mode)
 * - Working state (idle, streaming, waiting for confirmation, etc.)
 *
 * All modes should use SessionController instead of directly manipulating
 * ModeService, SettingsService, and SessionService for settings.
 */

// Router/unknown ids can't be statically narrowed, so the switch is treated
// as compaction-requiring.
function computeSwitchRequiresCompaction({
  currentModelId,
  newModelId,
}: {
  currentModelId: string;
  newModelId: string;
}): boolean {
  const { requiresCompaction, losingImageSupport } =
    predictSelectionSwitchEffects(currentModelId, newModelId);
  return requiresCompaction || losingImageSupport;
}

export class SessionController {
  private workingState: DroolWorkingState = DroolWorkingState.Idle;

  private static getCurrentModeState(): {
    autonomyMode: AutonomyMode;
    interactionMode: DroolInteractionMode;
    autonomyLevel: AutonomyLevel;
  } {
    const sessionSvc = getSessionService();
    const interactionMode = sessionSvc.getInteractionMode();
    const autonomyLevel = sessionSvc.getAutonomyLevel();
    const autonomyMode = deriveAutonomyMode(interactionMode, autonomyLevel);

    return {
      autonomyMode,
      interactionMode,
      autonomyLevel,
    };
  }

  /**
   * Kill a worker session. Updates mission state and interrupts both the worker
   * and the current orchestrator execution.
   * @param workerSessionId The worker session to kill
   * @param interruptCallback Callback to interrupt current orchestrator execution
   */
  async killWorkerSession(
    workerSessionId: string,
    interruptCallback: () => Promise<void>
  ): Promise<void> {
    const missionId =
      getSessionService().getDecompMissionId() ?? this.getSessionId();
    if (!missionId) {
      throw new Error('No active session');
    }

    // Update mission state and interrupt the worker
    await killWorkerSession({ missionId, workerSessionId });

    // Interrupt current execution (e.g., StartMissionRun tool waiting for worker)
    if (interruptCallback) {
      await interruptCallback();
    }
  }

  /**
   * Get the current session ID (delegates to SessionService)
   */
  getSessionId(): string | null {
    return getSessionService().getCurrentSessionId();
  }

  getSessionHostId(): string | undefined {
    return getSessionService().getCurrentSessionHostId();
  }

  /**
   * Get current settings.
   * Reads model/reasoning/spec from SessionService effective getters
   * (session -> transient -> global) and includes the latest mission settings
   * owned by SessionService when available.
   */
  getSettings(): Readonly<SessionSettings> {
    const sessionService = getSessionService();
    const modeState = SessionController.getCurrentModeState();

    // Protocol surfaces forward this to clients; must carry the
    // user's literal selection ("Auto Model"), not the routed concrete pick.
    return {
      modelId: sessionService.getDisplayModel(),
      reasoningEffort: sessionService.getDisplayReasoningEffort(),
      autonomyMode: modeState.autonomyMode,
      interactionMode: modeState.interactionMode,
      autonomyLevel: modeState.autonomyLevel,
      specModeModelId: sessionService.hasSpecModeModel()
        ? sessionService.getDisplaySpecModeModel()
        : undefined,
      specModeReasoningEffort: sessionService.hasSpecModeModel()
        ? sessionService.getDisplaySpecModeReasoningEffort()
        : undefined,
      missionSettings: sessionService.getMissionSettings(),
      enabledToolIds: sessionService.getEnabledToolIds(),
      disabledToolIds: sessionService.getDisabledToolIds(),
      compactionThresholdCheckEnabled:
        sessionService.getCompactionThresholdCheckEnabled(),
    };
  }

  /**
   * Get current working state
   */
  getWorkingState(): DroolWorkingState {
    return this.workingState;
  }

  /** Create a new session. Emits a `cli.create_session` span. */
  async createSession(params: CreateSessionParams = {}): Promise<string> {
    const origin = SessionController.deriveSessionOriginFromRuntime(
      params.sessionOriginHint
    );
    getSessionService().setCurrentSessionOrigin(origin ?? undefined);
    const sessionKind = classifySessionKind();
    return OtelTracing.trace(
      SpanName.CLI_CREATE_SESSION,
      async (span) => {
        const sessionId = await this._createSessionImpl(params);
        span.setAttributes({
          [SpanAttribute.SESSION_ID]: sessionId,
        });
        return sessionId;
      },
      {
        attributes: {
          // industry.client.surface lives on the resource, not per-span.
          ...getIndustrySessionAttributionAttributes({
            ...params,
            sessionOrigin: origin ?? undefined,
            sessionKind,
          }),
        },
      }
    );
  }

  /**
   * Returns the industry.session.origin value for the current CLI mode,
   * or null for spawned drool children (their parent is the authoritative
   * origin). Subagent children (detected by --calling-session-id) and
   * daemon-spawned workers don't own their provenance.
   */
  private static deriveSessionOriginFromRuntime(
    sessionOriginHint?: SessionOrigin
  ): SessionOrigin | null {
    if (sessionOriginHint) return sessionOriginHint;

    const runtime = getDroolRuntimeService();
    const mode = runtime.getDroolMode();
    const subMode = runtime.getDroolSubMode();
    if (mode === DroolMode.TerminalUI) return SessionOrigin.CliTui;
    if (mode === DroolMode.NonInteractiveCLI) {
      // Subagent/worker children don't own their origin -- the parent does.
      if (process.argv.includes('--calling-session-id')) return null;
      return SessionOrigin.CliExec;
    }
    if (mode === DroolMode.InteractiveCLI && subMode === DroolSubMode.ACP) {
      return SessionOrigin.CliAcp;
    }
    return null;
  }

  private async _createSessionImpl(
    params: CreateSessionParams = {}
  ): Promise<string> {
    const sessionService = getSessionService();

    // Ensure we're in the correct working directory and refresh settings.
    // SettingsManager may have been initialized during CLI bootstrap before
    // we knew the session cwd, so we must refresh to discover project skills/drools.
    const recordJsonRpcMetrics = shouldRecordJsonRpcInitMetrics();
    if (params.cwd) {
      const cwdSettingsRefreshStart = performance.now();
      let cwdSettingsRefreshOutcome = 'success';
      const requestedCwd = params.cwd;
      try {
        let resolvedCwd: string;
        try {
          resolvedCwd = resolveWorkingDirectoryPath(requestedCwd);
        } catch (resolveError) {
          throw new InvalidSessionCwdError(
            requestedCwd,
            resolveError instanceof Error
              ? resolveError.message
              : String(resolveError),
            { cause: resolveError }
          );
        }
        if (resolvedCwd !== process.cwd()) {
          try {
            process.chdir(resolvedCwd);
          } catch (chdirError) {
            throw new InvalidSessionCwdError(
              requestedCwd,
              `Failed to change working directory: ${
                chdirError instanceof Error
                  ? chdirError.message
                  : String(chdirError)
              }`,
              { cause: chdirError }
            );
          }
        }
        SettingsManager.getInstance().refresh();
        await reinitializeSandboxForCwd();
      } catch (error) {
        cwdSettingsRefreshOutcome = 'error';
        throw error;
      } finally {
        if (recordJsonRpcMetrics) {
          recordStartupLatency(
            Metric.CLI_JSONRPC_INIT_CWD_SETTINGS_REFRESH_LATENCY,
            cwdSettingsRefreshStart,
            { outcome: cwdSettingsRefreshOutcome }
          );
        }
      }
    }

    // Determine machine connection type based on machineId format
    // FIXME: this is hacky and we should do this further up the stack
    const isComputerSession =
      params.machineId && COMPUTER_ID_REGEX.test(params.machineId);
    const isLocalMachine =
      !params.machineId || params.machineId === LOCAL_MACHINE_ID;
    const machineConnectionType = isLocalMachine
      ? MachineConnectionType.TUI
      : isComputerSession
        ? MachineConnectionType.Computer
        : MachineConnectionType.Workspace;
    const normalizedMissionId =
      params.decompSessionType === DecompSessionType.Orchestrator
        ? (params.decompMissionId ?? params.sessionId)
        : params.decompMissionId;
    const normalizedTags =
      params.decompSessionType !== undefined &&
      normalizedMissionId !== undefined
        ? upsertMissionSessionTag(params.tags, {
            role: params.decompSessionType,
            missionId: normalizedMissionId,
          })
        : params.tags;

    // Convert controller-level SessionSettings to the format expected by
    // SessionService so they are baked into the initial synchronous write
    // (avoids race between async applySettings writes and a subsequent
    // synchronous loadSession read — see FAC-17999).
    // When only the legacy autonomyMode is provided (no decoupled fields),
    // derive interactionMode/autonomyLevel so they are included in the sync write.
    const serviceInitialSettings = params.initialSettings
      ? (() => {
          const s = params.initialSettings!;
          const resolved = resolveInteractionSettingsWithLegacyFallback({
            interactionMode: s.interactionMode,
            autonomyLevel: s.autonomyLevel,
            autonomyMode: s.autonomyMode,
          });
          return {
            model: s.modelId,
            reasoningEffort: s.reasoningEffort,
            interactionMode: resolved.interactionMode,
            autonomyLevel: resolved.autonomyLevel,
            specModeModel: s.specModeModelId,
            specModeReasoningEffort: s.specModeReasoningEffort,
            compactionThresholdCheckEnabled: s.compactionThresholdCheckEnabled,
          };
        })()
      : undefined;

    const sessionPersistStart = performance.now();
    let sessionPersistOutcome = 'success';
    let sessionId: string;
    try {
      sessionId = params.sessionId
        ? await sessionService.createSessionWithId({
            sessionId: params.sessionId,
            cwd: params.cwd,
            skipRemoteCreation: params.skipRemoteCreation ?? false,
            selectedWorkspaceId: params.workspaceId,
            workspaceSandboxId: isComputerSession
              ? undefined
              : params.machineId,
            computerId: isComputerSession ? params.machineId : undefined,
            machineConnectionType,
            sessionLocation: params.sessionLocation,
            sessionSource: params.sessionSource,
            tags: normalizedTags,
            ...(params.privacyLevel
              ? { privacyLevel: params.privacyLevel }
              : {}),
            callingSessionId: params.callingSessionId,
            callingToolUseId: params.callingToolUseId,
            sessionTitle: params.sessionTitle,
            enabledToolIds: params.enabledToolIds,
            disabledToolIds: params.disabledToolIds,
            initialSettings: serviceInitialSettings,
          })
        : await sessionService.createNewSession({
            firstUserMessage: params.firstUserMessage,
            callingSessionId: params.callingSessionId,
            callingToolUseId: params.callingToolUseId,
            cwd: params.cwd,
            tags: normalizedTags,
            sessionTitle: params.sessionTitle,
            enabledToolIds: params.enabledToolIds,
            disabledToolIds: params.disabledToolIds,
            initialSettings: serviceInitialSettings,
          });
    } catch (error) {
      sessionPersistOutcome = 'error';
      throw error;
    } finally {
      if (recordJsonRpcMetrics) {
        recordStartupLatency(
          Metric.CLI_JSONRPC_INIT_SESSION_PERSIST_LATENCY,
          sessionPersistStart,
          { outcome: sessionPersistOutcome }
        );
      }
    }

    // Apply remaining settings that aren't part of the initial sync write
    // (e.g., autonomyMode legacy field, sandbox status).
    if (params.initialSettings) {
      this.applySettings(params.initialSettings);
    }

    sessionService.setMissionSettings(
      (await getMissionFileService(
        normalizedMissionId ?? sessionId
      ).readModelSettings()) ?? undefined
    );

    logInfo('[SessionController] Session created', { sessionId });
    agentEventBus.emit(AgentEvent.SessionCreated, { sessionId });

    return sessionId;
  }

  /**
   * Load an existing session
   */
  async loadSession(params: LoadSessionParams): Promise<LoadedSessionResult> {
    const sessionService = getSessionService();
    sessionService.setCurrentSessionOrigin(
      SessionController.deriveSessionOriginFromRuntime(
        params.sessionOriginHint
      ) ?? undefined
    );
    const conversationStateManager = getConversationStateManager();
    const previouslyLoadedSessionId = sessionService.getCurrentSessionId();
    const liveMessages = conversationStateManager.getAllMessages();
    const isActiveSessionSnapshot =
      sessionService.getCurrentSessionId() === params.sessionId &&
      liveMessages.length > 0;

    let cwd: string | undefined;
    let messages: IndustryDroolMessage[];
    let title: string | undefined;
    let sessionTitle: string | undefined;
    let hostId: string | undefined;
    let callingSessionId: string | undefined;
    let callingToolUseId: string | undefined;
    let decompSessionType: DecompSessionType | undefined;
    let decompMissionId: string | undefined;
    let tokenUsage: TokenUsage | undefined;
    let uiRenderCutoffMessageId: string | null | undefined;

    if (isActiveSessionSnapshot) {
      cwd = process.cwd();
      messages = cloneSessionMessages(liveMessages);
      title = sessionService.getSessionTitle(params.sessionId) ?? undefined;
      sessionTitle =
        sessionService.getSessionTitleText(params.sessionId) ?? undefined;
      hostId = sessionService.getCurrentSessionHostId();
      callingSessionId = sessionService.getCallingSessionId(params.sessionId);
      callingToolUseId = sessionService.getCallingToolUseId(params.sessionId);
      decompSessionType =
        getDecompSessionTypeFromTags(sessionService.getCurrentSessionTags()) ??
        sessionService.getDecompSessionType();
      decompMissionId = sessionService.getDecompMissionId();
      tokenUsage = sessionService.getTokenUsage();
      uiRenderCutoffMessageId = conversationStateManager.getUiRenderCutoff();

      logInfo('[SessionController] Returning live active session snapshot', {
        sessionId: params.sessionId,
        messageCount: messages.length,
      });
    } else {
      if (
        sessionService.getCurrentSessionId() === params.sessionId &&
        liveMessages.length === 0
      ) {
        logWarn(
          '[SessionController] Current session has no live conversation history; loading from disk',
          {
            sessionId: params.sessionId,
          }
        );
      }

      const session =
        params.loadAllMessages === undefined
          ? await sessionService.loadSession(params.sessionId)
          : await sessionService.loadSession(params.sessionId, {
              loadAllMessages: params.loadAllMessages,
            });
      cwd = session.cwd;
      messages = session.messages;
      title = session.title;
      sessionTitle = session.sessionTitle;
      hostId = session.hostId;
      callingSessionId = session.callingSessionId;
      callingToolUseId = session.callingToolUseId;
      decompSessionType = session.decompSessionType;
      decompMissionId = session.decompMissionId;
      tokenUsage = session.tokenUsage;
      uiRenderCutoffMessageId = session.uiRenderCutoffMessageId;

      // If the session was using a fast variant whose feature flag is now
      // disabled, downgrade to the base model so the user doesn't resume
      // into a gated model they no longer have access to.
      const loadedModel = sessionService.getModel();
      const baseVariant = getBaseVariant(loadedModel);
      if (baseVariant && !(await isModelFeatureFlagEnabled(loadedModel))) {
        sessionService.setModel(baseVariant);
        logInfo(
          '[SessionController] Downgraded gated fast variant on session resume',
          {
            sessionId: params.sessionId,
            previousModelId: loadedModel,
            modelId: baseVariant,
          }
        );
      }
    }

    // Ensure we're in the correct working directory and refresh settings.
    // SettingsManager may have been initialized during CLI bootstrap before
    // we knew the session cwd, so we must refresh to discover project skills/drools.
    if (cwd) {
      try {
        const expandedCwd = expandTilde(cwd);
        if (expandedCwd !== process.cwd()) {
          process.chdir(expandedCwd);
          logInfo('[SessionController] Changed directory on session load', {
            sessionId: params.sessionId,
            after: expandedCwd,
          });
        }
        // Always refresh SettingsManager to re-discover paths from session cwd
        SettingsManager.getInstance().refresh();

        await reinitializeSandboxForCwd();
      } catch (error) {
        logException(
          error,
          '[SessionController] Failed to change directory on session load'
        );
      }
    }

    const missionSessionId =
      decompSessionType === DecompSessionType.Orchestrator
        ? (decompMissionId ?? params.sessionId)
        : decompMissionId;
    if (missionSessionId) {
      try {
        await getMissionFileService(
          missionSessionId
        ).ensureCanonicalArtifactLayout();
      } catch (error) {
        logException(
          error,
          '[SessionController] Failed to hydrate legacy mission artifacts'
        );
      }
    }

    // Load mission state for orchestrator sessions
    let missionSnapshot: MissionSnapshot | null = null;
    if (decompSessionType === DecompSessionType.Orchestrator) {
      const orchestratorMissionSessionId = missionSessionId ?? params.sessionId;
      const missionFileService = getMissionFileService(
        orchestratorMissionSessionId
      );
      let missionResult = await loadMissionStateWithDetails(
        orchestratorMissionSessionId,
        cwd
      );
      missionSnapshot = missionResult.success ? missionResult.data : null;

      const missionStateLooksActive =
        missionSnapshot?.state === MissionState.Running ||
        missionSnapshot?.state === MissionState.Initializing ||
        missionSnapshot?.state === MissionState.OrchestratorTurn;
      const shouldReconcileStaleMissionState =
        previouslyLoadedSessionId !== params.sessionId &&
        missionStateLooksActive &&
        !isMissionRunnerActive(orchestratorMissionSessionId);

      if (shouldReconcileStaleMissionState) {
        const reconciled = await reconcileMissionStateAfterSessionLoad(
          orchestratorMissionSessionId
        );

        if (reconciled) {
          missionResult = await loadMissionStateWithDetails(
            orchestratorMissionSessionId,
            cwd
          );
          missionSnapshot = missionResult.success ? missionResult.data : null;
        }
      }
      if (missionResult.success) {
        missionFileService.syncMissionMetadataToCloud();
      }
    }

    sessionService.setMissionSettings(
      (await getMissionFileService(
        decompMissionId ?? params.sessionId
      ).readModelSettings()) ?? undefined
    );

    const result: LoadedSessionResult = {
      sessionId: params.sessionId,
      cwd,
      hostId,
      settings: this.getSettings(),
      messages,
      title,
      callingSessionId,
      callingToolUseId,
      decompSessionType,
      decompMissionId,
      missionSnapshot,
      tokenUsage,
      uiRenderCutoffMessageId,
    };

    // Load conversation history into ConversationStateManager
    // This ensures context is available when resuming sessions (e.g., in ACP mode)
    if (!isActiveSessionSnapshot) {
      if (result.messages.length > 0) {
        conversationStateManager.loadConversationHistory(result.messages);
      }
      conversationStateManager.setUiRenderCutoff(
        uiRenderCutoffMessageId ?? null
      );
    }

    // Check if the current model's provider differs from the session's provider lock.
    // If so, serialize the conversation to avoid cross-provider thinking signature errors.
    // This handles the case where a user resumes a session after switching their default model.
    if (!isActiveSessionSnapshot && result.messages.length > 0) {
      try {
        const sessionProviderLock = sessionService.getLockedModelProvider();
        const currentModelId = sessionService.getModel();
        // Use getTuiModelConfig().modelProvider to match the provider source
        // used when the lock was set (ensureProviderLocks uses config.provider,
        // not apiModelProvider). getModelProvider() returns apiModelProvider
        // which differs for Industry models routed via other wire formats
        // (e.g. MiniMax M2.5 locks as INDUSTRY but getModelProvider returns ANTHROPIC).
        const currentProvider = getTuiModelConfig(currentModelId).modelProvider;

        if (
          sessionProviderLock &&
          currentProvider !== sessionProviderLock &&
          !isAnchoredAtLastMessage(
            await getLatestSummaryMetaFromSession(
              sessionService,
              params.sessionId
            ),
            result.messages.length
          )
        ) {
          logInfo(
            '[SessionController] Provider mismatch on session resume, serializing',
            {
              modelProvider: currentProvider,
              source: sessionProviderLock,
              messageCount: result.messages.length,
            }
          );
          await serializeAndPersistForProviderSwitch(sessionService, {
            sessionId: params.sessionId,
            messages: result.messages,
          });
          sessionService.updateLockedModelProvider(currentProvider);
        }
      } catch (error) {
        logException(
          error,
          '[SessionController] Failed to serialize on session resume provider mismatch'
        );
      }
    }

    SessionController.retryHistoricalSessionTitleOnLoad({
      sessionId: params.sessionId,
      title,
      sessionTitle,
      messages: result.messages,
    });

    logInfo('[SessionController] Session loaded', {
      sessionId: params.sessionId,
      messageCount: result.messages.length,
      hasState: !!missionSnapshot,
    });
    agentEventBus.emit(AgentEvent.SessionLoaded, result);

    return result;
  }

  /**
   * Set the model and optionally reasoning effort.
   * Updates session runtime only — does not modify global user defaults.
   */

  setModel(modelId: string, reasoningEffort?: ReasoningEffort): void {
    if (reasoningEffort !== undefined) {
      getSessionService().setModel(modelId, reasoningEffort);
    } else {
      getSessionService().setModel(modelId);
    }
  }

  /**
   * Set reasoning effort only
   */

  setReasoningEffort(reasoningEffort: ReasoningEffort): void {
    getSessionService().setReasoningEffort(reasoningEffort);
  }

  /**
   * Set autonomy mode
   * @deprecated Use setInteractionMode() and setAutonomyLevel() instead.
   */
  setAutonomyMode(mode: AutonomyMode): void {
    getSessionService().setAutonomyMode(mode);
  }

  /**
   * Set interaction mode (Auto/Spec) while preserving autonomy level.
   */
  setInteractionMode(mode: DroolInteractionMode): void {
    getSessionService().setInteractionMode(mode);
  }

  /**
   * Set autonomy level (Off/Low/Medium/High) while preserving interaction mode.
   */
  setAutonomyLevel(level: AutonomyLevel): void {
    getSessionService().setAutonomyLevel(level);
  }

  /**
   * Set session tags (used for mission mode, etc.)
   */
  setTags(tags: SessionTag[] | undefined): void {
    getSessionService().setTags(tags);
  }

  /**
   * Update enabled/disabled tool overrides and emit a settings change event.
   */
  setToolSelectionOverrides(params: {
    enabledToolIds?: string[];
    disabledToolIds?: string[];
  }): void {
    getSessionService().setToolSelectionOverrides(params);
    this.emitSettingsChanged({
      ...(params.enabledToolIds !== undefined && {
        enabledToolIds: params.enabledToolIds,
      }),
      ...(params.disabledToolIds !== undefined && {
        disabledToolIds: params.disabledToolIds,
      }),
    });
  }

  /**
   * Cycle through autonomy modes: Normal -> Spec -> Auto(Low) -> Auto(Medium) -> Auto(High) -> Normal
   * Used by TUI for keyboard shortcuts.
   */
  cycleAutonomyMode(): AutonomyMode {
    const newMode = getSessionService().getNextAutonomyMode();
    this.setAutonomyMode(newMode);
    return newMode;
  }

  /**
   * Set spec mode model and optionally reasoning effort
   */

  setSpecModeModel(modelId: string, reasoningEffort?: ReasoningEffort): void {
    getSessionService().setSpecModeModel(modelId, reasoningEffort);
    this.emitSettingsChanged({
      specModeModelId: modelId,
      ...(reasoningEffort !== undefined && {
        specModeReasoningEffort: reasoningEffort,
      }),
    });
  }

  /**
   * Clear spec mode model (use same as main)
   */
  clearSpecModeModel(): void {
    getSessionService().clearSpecModeModel();
    this.emitSettingsChanged({});
  }

  // ============================================================================
  // MISSION-SPECIFIC MODEL SETTINGS
  // ============================================================================

  /**
   * Set worker model for the current mission.
   * Updates mission-specific model-settings.json.
   */
  async setMissionWorkerModel(
    model: string,
    effort?: ReasoningEffort
  ): Promise<void> {
    await this.updateMissionSettings(
      effort !== undefined
        ? { workerModel: model, workerReasoningEffort: effort }
        : { workerModel: model }
    );
  }

  /**
   * Set validator model for the current mission.
   * Updates mission-specific model-settings.json.
   */
  async setMissionValidatorModel(
    model: string,
    effort?: ReasoningEffort
  ): Promise<void> {
    await this.updateMissionSettings(
      effort !== undefined
        ? {
            validationWorkerModel: model,
            validationWorkerReasoningEffort: effort,
          }
        : { validationWorkerModel: model }
    );
  }

  /**
   * Set worker reasoning effort for the current mission.
   * Updates mission-specific model-settings.json.
   */
  async setMissionWorkerReasoningEffort(
    effort: ReasoningEffort
  ): Promise<void> {
    await this.updateMissionSettings({
      workerReasoningEffort: effort,
    });
  }

  /**
   * Set validator reasoning effort for the current mission.
   * Updates mission-specific model-settings.json.
   */
  async setMissionValidatorReasoningEffort(
    effort: ReasoningEffort
  ): Promise<void> {
    await this.updateMissionSettings({
      validationWorkerReasoningEffort: effort,
    });
  }

  /**
   * Toggle skip scrutiny for missions (experimental).
   * Updates mission-specific model-settings.json.
   */
  async setMissionSkipScrutiny(skip: boolean): Promise<void> {
    await this.updateMissionSettings({ skipScrutiny: skip });
  }

  /**
   * Toggle skip user testing for missions (experimental).
   * Updates mission-specific model-settings.json.
   */
  async setMissionSkipUserTesting(skip: boolean): Promise<void> {
    await this.updateMissionSettings({ skipUserTesting: skip });
  }

  async updateMissionSettings(
    missionOverrides: MissionModelSettings
  ): Promise<void> {
    const sessionService = getSessionService();
    await sessionService.updateMissionSettings(
      sessionService.getDecompMissionId() ?? this.getSessionId(),
      missionOverrides
    );
  }

  /**
   * Apply multiple settings at once
   */
  applySettings(settings: Partial<SessionSettings>): void {
    if (settings.modelId !== undefined) {
      if (settings.reasoningEffort !== undefined) {
        this.setModel(settings.modelId, settings.reasoningEffort);
      } else {
        this.setModel(settings.modelId);
      }
    } else if (settings.reasoningEffort !== undefined) {
      this.setReasoningEffort(settings.reasoningEffort);
    }

    const hasDecoupledAutonomyFields = hasDecoupledInteractionSettings({
      interactionMode: settings.interactionMode,
      autonomyLevel: settings.autonomyLevel,
    });

    if (settings.interactionMode !== undefined) {
      this.setInteractionMode(settings.interactionMode);
    }

    if (settings.autonomyLevel !== undefined) {
      this.setAutonomyLevel(settings.autonomyLevel);
    } else if (
      !hasDecoupledAutonomyFields &&
      settings.autonomyMode !== undefined
    ) {
      this.setAutonomyMode(settings.autonomyMode);
    }

    if (settings.specModeModelId === null) {
      this.clearSpecModeModel();
    } else if (settings.specModeModelId !== undefined) {
      this.setSpecModeModel(
        settings.specModeModelId,
        settings.specModeReasoningEffort ?? undefined
      );
    }

    if (settings.compactionThresholdCheckEnabled !== undefined) {
      getSessionService().setCompactionThresholdCheckEnabled(
        settings.compactionThresholdCheckEnabled
      );
    }
  }

  // ============================================================================
  // MODEL SWITCHING WITH COMPACTION
  // ============================================================================

  /**
   * Switch model with automatic compaction if needed.
   * This handles provider switches that require conversation serialization.
   */
  async switchModel(
    modelId: string,
    reasoningEffort?: ReasoningEffort
  ): Promise<ModelSwitchResult> {
    const currentSettings = this.getSettings();
    const requiresCompaction = computeSwitchRequiresCompaction({
      currentModelId: currentSettings.modelId,
      newModelId: modelId,
    });

    let compactionPerformed = false;

    if (requiresCompaction) {
      try {
        compactionPerformed = await this.performCompactionForModelSwitch(
          resolveProviderForSelection(modelId)
        );
      } catch (error) {
        return {
          success: false,
          compactionPerformed: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to serialize conversation for model switch',
        };
      }
    }

    if (reasoningEffort !== undefined) {
      this.setModel(modelId, reasoningEffort);
    } else {
      this.setModel(modelId);
    }

    logInfo('[SessionController] Model switched', {
      modelId,
      compactionWasPerformed: compactionPerformed,
    });

    return { success: true, compactionPerformed };
  }

  /**
   * Switch spec mode model with automatic compaction if needed.
   * Same as switchModel but operates on the spec mode model slot.
   */
  async switchSpecModeModel(
    modelId: string,
    reasoningEffort?: ReasoningEffort
  ): Promise<ModelSwitchResult> {
    const sessionService = getSessionService();
    const currentSpecModel = sessionService.getSpecModeModel();
    const requiresCompaction = computeSwitchRequiresCompaction({
      currentModelId: currentSpecModel,
      newModelId: modelId,
    });

    let compactionPerformed = false;

    if (requiresCompaction) {
      try {
        compactionPerformed = await this.performCompactionForModelSwitch(
          resolveProviderForSelection(modelId)
        );
      } catch (error) {
        return {
          success: false,
          compactionPerformed: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to serialize conversation for spec mode model switch',
        };
      }
    }

    if (reasoningEffort !== undefined) {
      this.setSpecModeModel(modelId, reasoningEffort);
    } else {
      this.setSpecModeModel(modelId);
    }

    logInfo('[SessionController] Spec mode model switched', {
      modelId,
      compactionWasPerformed: compactionPerformed,
    });

    return { success: true, compactionPerformed };
  }

  /**
   * Perform compaction/serialization for provider switch if needed.
   * Returns true if compaction was performed.
   */
  private async performCompactionForModelSwitch(
    newProvider: ModelProvider
  ): Promise<boolean> {
    const sessionId = this.getSessionId();
    if (!sessionId) return false;

    const sessionService = getSessionService();
    const events = await sessionService.getAllMessageEvents();
    if (events.length === 0) return false;

    const latestSummary = await getLatestSummaryMetaFromSession(
      sessionService,
      sessionId
    );

    if (isAnchoredAtLastMessage(latestSummary, events.length)) {
      sessionService.updateLockedModelProvider(newProvider);
      return false;
    }

    const conversationHistory = events.map((e: DroolMessageEvent) => ({
      id: e.id,
      parentId: e.parentId,
      createdAt: new Date(e.timestamp).getTime(),
      updatedAt: new Date(e.timestamp).getTime(),
      ...e.message,
      content: convertLocallyPersistedMessageContentToDroolMessageContent(
        e.message.content
      ),
    }));

    await serializeAndPersistForProviderSwitch(sessionService, {
      sessionId,
      messages: conversationHistory,
    });

    sessionService.updateLockedModelProvider(newProvider);
    return true;
  }

  // ============================================================================
  // MCP OPERATIONS
  // ============================================================================

  /**
   * Toggle an MCP server on/off
   */
  async toggleMcpServer(
    serverName: string,
    enabled: boolean,
    settingsLevel: SettingsLevel
  ): Promise<McpOperationResult> {
    try {
      const mcpService = getMcpService();
      if (enabled) {
        await mcpService.enableServer(serverName, settingsLevel);
      } else {
        await mcpService.disableServer(serverName, settingsLevel);
      }
      logInfo('[SessionController] MCP server toggled', {
        name: serverName,
        isEnabled: enabled,
        state: settingsLevel,
      });
      return { success: true };
    } catch (error) {
      logWarn('[SessionController] MCP server toggle failed', {
        name: serverName,
        isEnabled: enabled,
        state: settingsLevel,
        cause: error,
      });
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : getI18n().t('common:sessionController.failedToggleServer'),
      };
    }
  }

  /**
   * Trigger authentication for an MCP server
   */
  async authenticateMcpServer(serverName: string): Promise<McpOperationResult> {
    try {
      await getMcpService().triggerAuthentication(serverName);
      logInfo('[SessionController] MCP server auth triggered', {
        name: serverName,
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : getI18n().t('common:sessionController.failedAuthenticate'),
      };
    }
  }

  /**
   * Clear authentication for an MCP server
   */
  async clearMcpAuth(serverName: string): Promise<McpOperationResult> {
    try {
      await getMcpService().clearAuthentication(serverName);
      logInfo('[SessionController] MCP server auth cleared', {
        name: serverName,
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : getI18n().t('common:sessionController.failedClearAuth'),
      };
    }
  }

  /**
   * Cancel an in-progress MCP OAuth authentication
   */
  async cancelMcpAuth(serverName: string): Promise<McpOperationResult> {
    try {
      await getMcpService().cancelAuthentication(serverName);
      logInfo('[SessionController] MCP auth cancelled', {
        name: serverName,
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : getI18n().t('common:sessionController.failedCancelAuth'),
      };
    }
  }

  // ============================================================================
  // WORKING STATE
  // ============================================================================

  /**
   * Set the working state
   */
  setWorkingState(state: DroolWorkingState): void {
    if (this.workingState !== state) {
      this.workingState = state;
      const sessionId = this.getSessionId();
      agentEventBus.emit(AgentEvent.WorkingStateChanged, {
        state,
        sessionId: sessionId ?? '',
      });
    }
  }

  // ============================================================================
  // SESSION SERVICE DELEGATION
  // These methods delegate to SessionService for operations that need direct access
  // ============================================================================

  /**
   * Get custom models from settings
   */
  getCustomModels() {
    return getSettingsService().getCustomModels();
  }

  /**
   * Process file attachments for a session
   */
  async processFileAttachments(
    sessionId: string,
    files?: Parameters<
      ReturnType<typeof getSessionService>['processFileAttachments']
    >[1]
  ) {
    return getSessionService().processFileAttachments(sessionId, files);
  }

  /**
   * Ensure session is loaded (creates if needed) - for defensive loading.
   */
  async ensureSessionLoaded(sessionId: string, cwd?: string): Promise<void> {
    const sessionService = getSessionService();
    try {
      await this.loadSession({ sessionId });
    } catch (error) {
      logWarn('[SessionController] Session not found, creating new session', {
        sessionId,
        cause: error,
      });
      await sessionService.createSessionWithId({
        sessionId,
        cwd,
        skipRemoteCreation: true,
      });
    }
  }

  private static retryHistoricalSessionTitleOnLoad(params: {
    sessionId: string;
    title?: string;
    sessionTitle?: string;
    messages: IndustryDroolMessage[];
  }): void {
    const { sessionId, title, sessionTitle, messages } = params;

    if (getDroolRuntimeService().isNonInteractiveCLIMode()) {
      return;
    }

    const sessionService = getSessionService();

    if (sessionService.isCurrentSessionBtwFork) {
      return;
    }

    if (
      !SessionController.shouldRetryHistoricalSessionTitle({
        title,
        sessionTitle,
      })
    ) {
      return;
    }

    const firstUserText = SessionController.getFirstUserText(messages);
    if (!firstUserText) {
      return;
    }
    const shouldAbortRetry = (): boolean =>
      sessionService.getCurrentSessionId() !== sessionId ||
      sessionService.isSessionTitleManuallySet(sessionId);

    if (shouldAbortRetry()) {
      return;
    }

    void (async () => {
      try {
        if (shouldAbortRetry()) {
          return;
        }

        const fallbackTitle =
          await sessionService.generateSessionTitle(firstUserText);

        if (shouldAbortRetry()) {
          return;
        }

        if (fallbackTitle) {
          agentEventBus.emit(AgentEvent.SessionTitleUpdated, {
            sessionId,
            title: fallbackTitle,
            updateType: SessionTitleUpdateType.FirstUserMessage,
          });
        }

        const llmTitle =
          await SessionController.generateLlmSessionTitleFromFirstMessage(
            sessionId,
            firstUserText
          );

        if (shouldAbortRetry()) {
          return;
        }

        if (llmTitle) {
          agentEventBus.emit(AgentEvent.SessionTitleUpdated, {
            sessionId,
            title: llmTitle,
            updateType: SessionTitleUpdateType.LlmGenerated,
          });
        }
      } catch (error) {
        logException(error, '[SessionTitle] Failed historical title retry');
      }
    })();
  }

  private static shouldRetryHistoricalSessionTitle(params: {
    title?: string;
    sessionTitle?: string;
  }): boolean {
    const effectiveTitle = params.sessionTitle ?? params.title;
    if (effectiveTitle == null) {
      return false;
    }

    const normalizedTitle = effectiveTitle.trim();
    return (
      normalizedTitle.length === 0 ||
      normalizedTitle === SESSION_PLACEHOLDER_TITLE
    );
  }

  private static getFirstUserText(messages: IndustryDroolMessage[]): string {
    for (const message of messages) {
      if (message.role !== MessageRole.User) {
        continue;
      }

      if (typeof message.content === 'string') {
        const cleanedContent = cleanMessage(message.content).trim();
        if (cleanedContent.length > 0) {
          return cleanedContent;
        }
        continue;
      }

      if (!Array.isArray(message.content)) {
        continue;
      }

      const cleanedTextParts: string[] = [];
      for (const block of message.content) {
        if (block.type !== MessageContentBlockType.Text) {
          continue;
        }

        const cleanedBlockText = cleanMessage(block.text).trim();
        if (cleanedBlockText.length > 0) {
          cleanedTextParts.push(cleanedBlockText);
        }
      }

      const cleanedText = cleanedTextParts.join(' ').trim();

      if (cleanedText.length > 0) {
        return cleanedText;
      }
    }

    return '';
  }

  private static async generateLlmSessionTitleFromFirstMessage(
    sessionId: string,
    firstUserText: string
  ): Promise<string | null> {
    return generateAndUpdateSessionTitle({
      sessionId,
      stage: SessionTitleAutoStage.FirstMessage,
      firstUserText,
    });
  }

  private emitSettingsChanged(changes: Partial<SessionSettings>): void {
    logInfo('[SessionController] Settings changed', { value: changes });
    const sessionId = this.getSessionId();
    agentEventBus.emit(AgentEvent.SettingsUpdated, {
      settings: changes,
      sessionId: sessionId ?? '',
    });
  }
}

// Singleton instance
let sessionControllerInstance: SessionController | null = null;

/**
 * Get the singleton SessionController instance
 */
export function getSessionController(): SessionController {
  if (!sessionControllerInstance) {
    sessionControllerInstance = new SessionController();
  }
  return sessionControllerInstance;
}

/**
 * Reset the singleton (useful for testing)
 */
export function resetSessionController(): void {
  sessionControllerInstance = null;
}
