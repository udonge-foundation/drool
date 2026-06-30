import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

import {
  ROOT_MESSAGE_ID,
  MachineConnectionType,
  DroolExecutionStatus,
  SESSION_TAG_BTW_FORK,
  MISSION_SESSION_TAG,
  SessionPrivacyLevel,
} from '@industry/common/session';
import {
  EffectiveIndustryRouterModel,
  SessionSettings,
  TokenUsage,
} from '@industry/common/session/settings';
import {
  SessionSummaryEventSchema,
  SessionTitleAutoStage,
  type SessionSummaryEvent,
} from '@industry/common/session/summary';
import { type MissionModelSettings } from '@industry/common/settings';
import { resolveIndustryRouterModelForMessage } from '@industry/drool-core/llms/client/industry-router-routing';
import { IndustryRouterUnavailableError } from '@industry/drool-core/model-router';
import { MAX_PDF_SIZE_BYTES } from '@industry/drool-core/tools/definitions/cli/constants';
import {
  DecompSessionType,
  SessionNotificationType,
  type SettingsUpdatedNotification,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  ApiProvider,
  INDUSTRY_ROUTER_MODEL_ID,
  ModelProvider,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';
import {
  SessionOrigin,
  SessionSource,
  SessionTag,
} from '@industry/drool-sdk-ext/protocol/session';
import {
  DocumentSource,
  DocumentSourceType,
  IndustryDroolMessage,
  MessageContentBlockType,
  MessageRole,
  MessageVisibility,
  type Base64PDFSource,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import {
  AutonomyLevel,
  AutonomyMode,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import {
  logError,
  logException,
  logInfo,
  logWarn,
  Metrics,
} from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';
import { getHostIdentityService } from '@industry/runtime/host';
import {
  clampAutonomyLevelToMax,
  deriveAutonomyMode,
  getAllowedAutonomyLevels,
  parseAutonomyMode,
  resolveInteractionSettingsWithLegacyFallback,
} from '@industry/utils';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  resolveModelId,
} from '@industry/utils/llm';
import { sanitizeSessionTitle } from '@industry/utils/session';
import { sanitizePathToDirectoryName } from '@industry/utils/sessionPaths';
import { calculateIndustryTokenUsage } from '@industry/utils/usage';

import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { CompactionSummaryKind } from '@/hooks/compaction/enums';
import { HookEventName, PermissionMode } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { getDefaultModelId } from '@/models/availability';
import { getTuiModelConfig } from '@/models/config';
import {
  isIndustryRouterSelectable,
  resolveIfIndustryRouterOrFallback,
} from '@/models/industryRouterAvailability';
import { resolveIndustryRouterGenerationModel } from '@/models/industryRouterByok';
import { getCloudSyncService } from '@/services/CloudSyncService';
import { convertAutonomyModeToPermissionMode } from '@/services/hook-utils';
import { getHookService } from '@/services/HookService';
import {
  convertDroolMessageContentToLocallyPersistedMessageContent,
  populateMessagesWithPdfContent,
} from '@/services/message-converters';
import { getMissionExecutionWakeLockService } from '@/services/mission/MissionExecutionWakeLockService';
import { getMissionFileService } from '@/services/mission/MissionFileService';
import {
  getDecompSessionTypeFromTags,
  getMissionSessionTagMetadata,
  removeMissionSessionTag,
  upsertMissionSessionTag,
} from '@/services/mission/sessionTags';
import { SessionDiscoveryIndex } from '@/services/SessionDiscoveryIndex';
import {
  readSessionSummaryAndMessagesFromJsonl,
  readSessionWithCompactionTruncation,
} from '@/services/sessionJsonl';
import { getSettingsService } from '@/services/SettingsService';
import {
  DroolSession,
  DroolSessionEvent,
  DroolMessageEvent,
  CompactionStateEvent,
  SessionMetadata,
  TodoStateEvent,
} from '@/services/types';
import { cleanMessage } from '@/utils/cleanMessage';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';
import { SHUTDOWN_HOOK_PRIORITY } from '@/utils/constants';
import { SessionNotFoundError } from '@/utils/errors';
import {
  setSecureDirectoryPermissionsSync,
  setSecureFilePermissions,
  setSecureFilePermissionsSync,
} from '@/utils/filePermissions';
import {
  clampReasoningEffortForModel,
  isLastMessageText,
  resolveHardDeprecatedModelFallback,
} from '@/utils/modelUtils';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';
import {
  getSystemInfo,
  isValidSystemInfo,
  restartSystemInfoPrefetch,
} from '@/utils/systemInfo';
import { setTerminalTabTitle } from '@/utils/terminalTitle';
import { type ShutdownContext, SystemInfo } from '@/utils/types';
import { generateUUID } from '@/utils/uuid';

import type {
  AppliedDeprecatedModelFallback,
  ModelRoutingDeps,
  SessionLike,
} from '@industry/drool-core/llms/client/types';
import type { TodoWriteToolParams } from '@industry/drool-core/tools/definitions/todo';

function getManagedMaxAutonomyLevel(): AutonomyLevel | undefined {
  const settingsService = getSettingsService() as {
    getMaxAutonomyLevel?: () => AutonomyLevel | undefined;
  };
  if (typeof settingsService.getMaxAutonomyLevel !== 'function') {
    return undefined;
  }
  return settingsService.getMaxAutonomyLevel();
}

function applyMaxAutonomyLevel(requestedLevel: AutonomyLevel): AutonomyLevel {
  const maxLevel = getManagedMaxAutonomyLevel();
  const clampedLevel = clampAutonomyLevelToMax(requestedLevel, maxLevel);
  if (clampedLevel === requestedLevel) {
    return requestedLevel;
  }
  logInfo('[SessionService] Clamped autonomy level to organization maximum', {
    before: requestedLevel,
    after: clampedLevel,
  });
  return clampedLevel;
}

function getUiRenderCutoffFromCompaction(
  compaction: CompactionStateEvent | null,
  wasTruncatedAtCompaction: boolean
): string | null {
  if (!compaction) {
    return null;
  }

  if (compaction.uiRenderCutoffMessageId) {
    return compaction.uiRenderCutoffMessageId;
  }

  return wasTruncatedAtCompaction
    ? (compaction.anchorMessage?.id ?? null)
    : null;
}

function getAutonomyCycleLevels(): AutonomyLevel[] {
  return getAllowedAutonomyLevels(getManagedMaxAutonomyLevel());
}

function getSessionSummaryRuntimeCwd(
  session: Pick<SessionSummaryEvent, 'cwd' | 'lastCwd'>
): string | undefined {
  return session.lastCwd ?? session.cwd;
}

function limitAndFilterListedSessions(
  sessions: SessionMetadata[],
  maxOtherSessions?: number
): SessionMetadata[] {
  const currentProjectSessions = sessions.filter(
    (session) => session.isCurrentProject
  );
  const otherSessions = sessions.filter((session) => !session.isCurrentProject);

  // Limit only applies to other sessions - current project sessions are always included
  const limitedOther =
    maxOtherSessions !== undefined
      ? otherSessions
          .sort((a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime())
          .slice(0, maxOtherSessions)
      : otherSessions;

  // Filter out worker sessions (they should only appear in mission view)
  // and btw-fork sessions (hidden internal side-session for /btw command)
  const filteredSessions = [...currentProjectSessions, ...limitedOther].filter(
    (session) =>
      session.decompSessionType !== DecompSessionType.Worker &&
      !session.isBtwFork &&
      (!session.cwd || fs.existsSync(session.cwd))
  );

  return filteredSessions.sort(
    (a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime()
  );
}

function decodeSessionListOffset(cursor?: string): number {
  if (!cursor) {
    return 0;
  }

  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString()) as {
      offset?: unknown;
    };
    return typeof decoded.offset === 'number' && Number.isFinite(decoded.offset)
      ? Math.max(0, Math.floor(decoded.offset))
      : 0;
  } catch {
    return 0;
  }
}

function encodeSessionListOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64');
}

/**
 * Override settings applied during session creation, baked into the initial
 * synchronous settings write so they are never lost to an async race.
 */
interface CreateSessionInitialSettings {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  interactionMode?: DroolInteractionMode;
  autonomyLevel?: AutonomyLevel;
  specModeModel?: string | null;
  specModeReasoningEffort?: ReasoningEffort | null;
  compactionThresholdCheckEnabled?: boolean;
}

type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact';

interface CreateSessionWithIdParams {
  sessionId: string;
  firstUserMessage?: string;
  parentSessionId?: string;
  callingSessionId?: string;
  callingToolUseId?: string;
  skipRemoteCreation?: boolean;
  source?: SessionStartSource;
  cwd?: string; // Working directory where session is created
  selectedWorkspaceId?: string;
  workspaceSandboxId?: string;
  /** Durable execution-store identity for host-backed sessions. */
  hostId?: string;
  /**
   * Legacy remote-access Computer capability identifier.
   *
   * @deprecated Resolve the active Computer by `hostId` at access time for
   * host-backed sessions.
   */
  computerId?: string;
  /**
   * Legacy/display connection classification retained for compatibility.
   *
   * @deprecated Do not use for session identity, merge keys, or resume routing.
   */
  machineConnectionType?: MachineConnectionType;
  decompSessionType?: DecompSessionType;
  decompMissionId?: string; // Mission ID for worker sessions
  inheritTokenUsage?: TokenUsage; // Token usage to inherit from parent session (e.g., during compaction)
  sessionLocation?: string; // Session location for delegations (e.g., "Linear Agent Delegation")
  sessionSource?: SessionSource; // Session source metadata for delegations
  tags?: SessionTag[];
  privacyLevel?: SessionPrivacyLevel | 'private' | 'organization';
  sessionTitle?: string; // Explicit session title override (e.g., for Task tool subagents)
  enabledToolIds?: string[]; // Additional tool IDs to enable (e.g., Slack tools for delegations)
  disabledToolIds?: string[]; // Tool IDs explicitly disabled for the session
  /** Settings overrides included in the initial synchronous write. */
  initialSettings?: CreateSessionInitialSettings;
}

interface CreateNewSessionParams {
  firstUserMessage?: string;
  parentSessionId?: string;
  callingSessionId?: string;
  callingToolUseId?: string;
  cwd?: string; // Working directory (defaults to process.cwd(), pass empty string '' for base directory)
  tags?: SessionTag[];
  sessionTitle?: string; // Explicit session title override (e.g., for Task tool subagents)
  enabledToolIds?: string[]; // Additional tool IDs to enable (e.g., Slack tools for delegations)
  disabledToolIds?: string[]; // Tool IDs explicitly disabled for the session
  /** Settings overrides included in the initial synchronous write. */
  initialSettings?: CreateSessionInitialSettings;
}

function createEmptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    industryCredits: 0,
  };
}

function normalizeTokenUsage(
  usage: Partial<TokenUsage> | undefined
): TokenUsage {
  return {
    ...createEmptyTokenUsage(),
    ...(usage ?? {}),
    industryCredits: usage?.industryCredits ?? 0,
  };
}

function addTokenUsageValues(
  values: Iterable<Partial<TokenUsage>>
): TokenUsage {
  const total = createEmptyTokenUsage();
  for (const usage of values) {
    total.inputTokens += usage.inputTokens ?? 0;
    total.outputTokens += usage.outputTokens ?? 0;
    total.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
    total.cacheReadTokens += usage.cacheReadTokens ?? 0;
    total.thinkingTokens += usage.thinkingTokens ?? 0;
    total.industryCredits =
      (total.industryCredits ?? 0) + (usage.industryCredits ?? 0);
  }
  return total;
}

/**
 * SessionService manages conversation sessions for the Industry CLI.
 *
 * This service handles:
 * - Creating new conversation sessions
 * - Persisting messages to JSONL files
 * - Loading and reconstructing past sessions
 * - Managing session metadata
 *
 * Sessions are stored in `~/.industry/sessions/` (legacy) or `~/.industry/sessions/-<dir_path>/` as JSONL files where:
 * - First line: SessionSummaryEvent with metadata (id, title, owner)
 * - Subsequent lines: DroolMessageEvent entries containing Anthropic messages
 *
 * The service maintains a singleton instance to ensure consistent session state
 * across the application lifecycle.
 *
 */
class SessionService implements SessionLike {
  private currentSessionId: string | null = null;

  private ensureCurrentSessionPromise: Promise<string> | null = null;

  private currentSessionHostId: string | undefined = undefined;

  private lastMessageId: string | null = null;

  private activeUserMessageSource: SessionOrigin | undefined = undefined;

  private readonly sessionsDir: string;

  /**
   * Returns whether cloud session sync is enabled.
   * Reads from SettingsService on every access so toggling the setting
   * mid-session takes effect immediately, and worker sessions that inherit
   * the singleton always see the latest value.
   */
  private get cloudSessionSync(): boolean {
    return getSettingsService().getSettings().general?.cloudSessionSync ?? true;
  }

  /**
   * Returns true when the current session is a hidden /btw fork.
   * Cloud sync and auto-title generation should be skipped for such sessions.
   */
  public get isCurrentSessionBtwFork(): boolean {
    return (this.sessionSettings.tags ?? []).some(
      (t) => t.name === SESSION_TAG_BTW_FORK
    );
  }

  // Current session's runtime working directory
  private currentSessionCwd: string | undefined = undefined;

  // Original working directory used to locate transcript/settings files
  private currentSessionStorageCwd: string | undefined = undefined;

  // When true, the current session's file lives in the btw directory and all
  // reads/writes should target that directory instead of a project-dir path.
  private currentSessionInBtwDir = false;

  // Mission ID for decomposition worker sessions (links worker to its mission)
  private currentDecompMissionId: string | undefined = undefined;

  // Canonical mission id (state.json `mis_…`) for the active mission session,
  // resolved from the mission state file and surfaced to telemetry as the
  // ambient `missionId` tag. Tracked alongside the baseSessionId it belongs to
  // so a stale value is never attributed to a different active session.
  private currentMissionStateId: string | null = null;

  private currentMissionStateIdBaseSession: string | null = null;

  // Session type for decomposition sessions (orchestrator or worker)
  private currentDecompSessionType: DecompSessionType | undefined = undefined;

  // Client surface the current session belongs to (TUI, desktop, web, ...).
  // Set on create/load so prompting can be tailored per surface.
  private currentSessionOrigin: SessionOrigin | undefined = undefined;

  // Session settings for the current session
  private sessionSettings: SessionSettings = {};

  // Effective mission settings for the current session/mission.
  private currentMissionSettings: MissionModelSettings | undefined = undefined;

  // Token usage tracking for the current session
  private sessionTokenUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    industryCredits: 0,
  };

  // Latest provider-reported usage used by threshold compaction (not accumulated).
  private lastCallTokenUsage: Pick<
    TokenUsage,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens'
  > = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  };

  private sessionTokenUsageTimer: NodeJS.Timeout | null = null;

  private lastSessionTokenUsageJson = '';

  // Track whether the current session was resumed (loaded from disk)
  // Used to determine if we need to inject fresh system info on the first message
  private wasSessionResumed: boolean = false;

  // Track whether a full system info refresh is needed on the next LLM turn
  // after the session working directory changes mid-session.
  private needsSystemInfoRefresh: boolean = false;

  // Pending context from SessionStart hooks to be injected on first message
  private pendingSessionStartContext: string | null = null;

  // Guard to prevent SessionEnd hooks from firing twice (e.g. /quit direct call + shutdown coordinator)
  private sessionEndHooksExecuted: boolean = false;

  private readonly sessionDiscoveryIndex: SessionDiscoveryIndex;

  constructor() {
    this.sessionsDir = path.join(
      getIndustryHome(),
      getIndustryDirName(),
      'sessions'
    );
    this.ensureSessionsDirectory();
    this.sessionDiscoveryIndex = new SessionDiscoveryIndex(this.sessionsDir);
  }

  /**
   * Load the saved autonomy/interaction mode from global settings.
   * Should be called once during startup (after SettingsService is ready).
   */
  public initializeAutonomyFromGlobalDefaults(): void {
    try {
      const svc = getSettingsService();
      const resolved = resolveInteractionSettingsWithLegacyFallback({
        interactionMode: svc.getInteractionMode(),
        autonomyLevel: svc.getAutonomyLevel(),
        autonomyMode: svc.getAutonomyMode(),
      });
      const mode = resolved.interactionMode ?? DroolInteractionMode.Auto;
      const level = resolved.autonomyLevel ?? AutonomyLevel.Off;
      const cappedLevel = applyMaxAutonomyLevel(level);

      this.sessionSettings.autonomyLevel = cappedLevel;
      this.sessionSettings.interactionMode = mode;
      this.sessionSettings.autonomyMode = deriveAutonomyMode(mode, cappedLevel);

      if (cappedLevel !== level) {
        const clampedMode = deriveAutonomyMode(mode, cappedLevel);
        getSettingsService().setAutonomyMode(clampedMode);
      }
    } catch (_error) {
      // Keep defaults if settings can't be loaded
    }
  }

  /**
   * Single transition point for the SessionService's active session.
   *
   * All callers that change which session is currently "active" in the TUI
   * (`createSessionWithId`, `forkSession` non-preserve branch, `loadSession`)
   * must route through this helper so the terminal tab title stays in sync
   * with `currentSessionId`. Other per-session bookkeeping (lastMessageId,
   * decomp metadata, etc.) is handled by the individual callers because their
   * inputs differ.
   *
   * Title is optional: callers pass `undefined` when no title is available
   * (e.g. corrupted-then-recreated session); `setTerminalTabTitle` is
   * defensive against empty input.
   */
  private setActiveSession(params: {
    sessionId: string;
    cwd: string | undefined;
    storageCwd?: string;
    hostId?: string;
    title: string | null | undefined;
  }): void {
    this.currentSessionId = params.sessionId;
    this.currentSessionCwd = params.cwd;
    this.currentSessionStorageCwd = params.storageCwd ?? params.cwd;
    this.currentSessionHostId = params.hostId;
    if (params.title) {
      setTerminalTabTitle(params.title);
    }
  }

  // True when either slot (main or spec) is still Auto Model; when both
  // leave Auto Model the cached routing decision is stale.
  private isIndustryRouterStillConfigured(): boolean {
    return (
      this.sessionSettings.model === INDUSTRY_ROUTER_MODEL_ID ||
      this.sessionSettings.specModeModel === INDUSTRY_ROUTER_MODEL_ID
    );
  }

  public setModel(model: string, reasoningEffort?: ReasoningEffort): void {
    const previousModel = this.getModel();
    const effectiveModel = resolveIfIndustryRouterOrFallback(model, {
      slotLabel: 'model',
      sessionId: this.currentSessionId ?? undefined,
    });
    const validation = getSettingsService().validateModelAccess(effectiveModel);
    if (!validation.allowed) {
      throw new MetaError('Model not allowed by organization policy', {
        modelId: effectiveModel,
      });
    }
    this.sessionSettings.model = effectiveModel;
    if (!this.isIndustryRouterStillConfigured()) {
      this.sessionSettings.effectiveIndustryRouterModel = undefined;
    }
    if (reasoningEffort) {
      this.sessionSettings.reasoningEffort = clampReasoningEffortForModel(
        effectiveModel,
        reasoningEffort
      );
    } else if (this.sessionSettings.reasoningEffort !== undefined) {
      // No explicit effort was passed, but the session already has one.
      // Re-clamp it against the new model so callers that switch the model
      // without supplying an effort (e.g. enforceOrgModelPolicyOnLoad and
      // enforceProviderLockOnLoad) cannot leave the session with an effort
      // value that is invalid for the newly-selected model.
      this.sessionSettings.reasoningEffort = clampReasoningEffortForModel(
        effectiveModel,
        this.sessionSettings.reasoningEffort
      );
    }
    if (this.currentSessionId) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: true });
      if (previousModel !== effectiveModel) {
        this.markSystemInfoRefreshNeeded();
      }
    }
    this.emitSessionSettingsChanged();
  }

  public setReasoningEffort(effort: ReasoningEffort): void {
    const model = this.getModel();
    this.sessionSettings.reasoningEffort = clampReasoningEffortForModel(
      model,
      effort
    );
    if (this.currentSessionId) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: true });
    }
    this.emitSessionSettingsChanged();
  }

  public setTags(tags: SessionTag[] | undefined): void {
    logInfo('[SessionService] setTags called', {
      sessionId: this.currentSessionId ?? undefined,
      sessionTags: JSON.stringify(tags),
      previousTags: JSON.stringify(this.sessionSettings.tags),
    });
    this.sessionSettings.tags = tags;
    // Update derived decomp session type based on tags
    const missionTagMetadata = getMissionSessionTagMetadata(tags);
    if (missionTagMetadata) {
      this.currentDecompSessionType = missionTagMetadata.role;
      this.currentDecompMissionId = missionTagMetadata.missionId;
      logInfo('[SessionService] Updated decomp session type from tags', {
        sessionId: this.currentSessionId ?? undefined,
        decompSessionType: this.currentDecompSessionType,
      });
      // Resolve the canonical mission id for the ambient telemetry tag (worker
      // sessions learn their mission only via this tag).
      this.currentMissionStateId = null;
      this.currentMissionStateIdBaseSession = null;
      void this.refreshMissionStateId();
    } else {
      this.currentDecompSessionType = undefined;
      this.currentDecompMissionId = undefined;
      this.currentMissionStateId = null;
      this.currentMissionStateIdBaseSession = null;
    }
    if (this.currentSessionId) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: true });
    }
    this.emitSessionSettingsChanged();
  }

  /**
   * Syncs drool execution status to the cloud.
   * Called when the agent starts/stops processing in TUI mode.
   */
  public syncDroolStatusToCloud(
    status: DroolExecutionStatus,
    pid: number | null = null
  ): void {
    const sessionId = this.currentSessionId;
    const missionWakeLockService = getMissionExecutionWakeLockService();

    if (status === DroolExecutionStatus.Idle) {
      missionWakeLockService.release({ sessionId: sessionId ?? undefined });
    } else if (
      status === DroolExecutionStatus.Running &&
      getSettingsService().getKeepSystemAwakeDuringMissions() &&
      sessionId
    ) {
      const missionId = this.getDecompMissionId();
      if (missionId) {
        missionWakeLockService.acquire({ sessionId, missionId });
      }
    }

    if (!this.cloudSessionSync || !sessionId || this.isCurrentSessionBtwFork) {
      return;
    }

    void getCloudSyncService().syncDroolStatus(sessionId, status, pid);
  }

  // For Auto Model sessions, returns the cached candidate's effort so the
  // engine sees a coherent (modelId, reasoningEffort, apiProvider)
  // triple instead of mixing the cached model with the [None] UI effort.
  public getReasoningEffort(): ReasoningEffort {
    const configured = this.sessionSettings.model;
    if (configured === INDUSTRY_ROUTER_MODEL_ID) {
      const cached = this.sessionSettings.effectiveIndustryRouterModel;
      if (cached) return cached.reasoningEffort;
    }
    return this.getDisplayReasoningEffort();
  }

  /** Display companion to {@link getReasoningEffort}; skips the Auto Model → cache translation. */
  public getDisplayReasoningEffort(): ReasoningEffort {
    return (
      this.sessionSettings.reasoningEffort ??
      getSettingsService().getReasoningEffort()
    );
  }

  public getMissionSettings(): MissionModelSettings | undefined {
    return this.currentMissionSettings;
  }

  public setMissionSettings(
    missionSettings: MissionModelSettings | undefined
  ): void {
    this.currentMissionSettings = missionSettings;
  }

  /**
   * Sync in-memory session settings from daemon notifications.
   *
   * The daemon is the source of truth after a session is running, so this
   * intentionally avoids persisting or emitting local SettingsUpdated events.
   * Spec mode fields mirror SessionStateManager semantics: omission means clear.
   */
  public syncSettingsFromDaemon(
    settings: SettingsUpdatedNotification['settings']
  ): void {
    if (settings.modelId !== undefined) {
      this.sessionSettings.model = settings.modelId;
    }

    if (settings.reasoningEffort !== undefined) {
      const modelId =
        settings.modelId ??
        this.sessionSettings.model ??
        getSettingsService().getModel();
      this.sessionSettings.reasoningEffort = clampReasoningEffortForModel(
        modelId,
        settings.reasoningEffort
      );
    }

    if (
      settings.interactionMode !== undefined ||
      settings.autonomyLevel !== undefined
    ) {
      const interactionMode =
        settings.interactionMode ?? this.getInteractionMode();
      const autonomyLevel = applyMaxAutonomyLevel(
        settings.autonomyLevel ?? this.getAutonomyLevel()
      );
      this.sessionSettings.interactionMode = interactionMode;
      this.sessionSettings.autonomyLevel = autonomyLevel;
      this.sessionSettings.autonomyMode = deriveAutonomyMode(
        interactionMode,
        autonomyLevel
      );
    } else if (settings.autonomyMode !== undefined) {
      const { mode, level } = parseAutonomyMode(settings.autonomyMode);
      const autonomyLevel = applyMaxAutonomyLevel(level);
      this.sessionSettings.interactionMode = mode;
      this.sessionSettings.autonomyLevel = autonomyLevel;
      this.sessionSettings.autonomyMode = deriveAutonomyMode(
        mode,
        autonomyLevel
      );
    }

    if (settings.specModeModelId !== undefined) {
      this.sessionSettings.specModeModel = settings.specModeModelId;
    } else {
      delete this.sessionSettings.specModeModel;
    }

    if (settings.specModeReasoningEffort !== undefined) {
      const specModeModelId =
        settings.specModeModelId ??
        this.sessionSettings.specModeModel ??
        getSettingsService().getSpecModeModel() ??
        this.getModel();
      this.sessionSettings.specModeReasoningEffort =
        clampReasoningEffortForModel(
          specModeModelId,
          settings.specModeReasoningEffort
        );
    } else {
      delete this.sessionSettings.specModeReasoningEffort;
    }

    this.currentMissionSettings = settings.missionSettings ?? undefined;

    if (settings.compactionThresholdCheckEnabled !== undefined) {
      this.sessionSettings.compactionThresholdCheckEnabled =
        settings.compactionThresholdCheckEnabled;
    }
  }

  public async updateMissionSettings(
    missionSessionId: string | null | undefined,
    missionOverrides: MissionModelSettings
  ): Promise<void> {
    const settingsService = getSettingsService();
    const globalMissionSettings = settingsService.getMissionModelSettings();
    const missionFileService = missionSessionId
      ? getMissionFileService(missionSessionId)
      : null;
    const exists = missionFileService
      ? await missionFileService.missionExists()
      : false;
    const currentSettings = exists
      ? await missionFileService!.readEffectiveModelSettings()
      : (this.currentMissionSettings ?? globalMissionSettings);
    const normalizedOverrides: MissionModelSettings = {
      ...missionOverrides,
    };
    const currentWorkerModel =
      currentSettings.workerModel ?? globalMissionSettings.workerModel;
    const currentWorkerReasoningEffort =
      currentSettings.workerReasoningEffort ??
      globalMissionSettings.workerReasoningEffort;
    const currentValidationWorkerModel =
      currentSettings.validationWorkerModel ??
      globalMissionSettings.validationWorkerModel;
    const currentValidationWorkerReasoningEffort =
      currentSettings.validationWorkerReasoningEffort ??
      globalMissionSettings.validationWorkerReasoningEffort;

    if (normalizedOverrides.workerModel !== undefined) {
      normalizedOverrides.workerModel = resolveIfIndustryRouterOrFallback(
        normalizedOverrides.workerModel,
        {
          slotLabel: 'missionWorkerModel',
          sessionId: this.currentSessionId ?? undefined,
        }
      );
      const validation = settingsService.validateModelAccess(
        normalizedOverrides.workerModel
      );
      if (!validation.allowed) {
        throw new MetaError(
          'Mission worker model not allowed by organization policy',
          {
            modelId: normalizedOverrides.workerModel,
          }
        );
      }
      normalizedOverrides.workerReasoningEffort = clampReasoningEffortForModel(
        normalizedOverrides.workerModel,
        normalizedOverrides.workerReasoningEffort ??
          currentWorkerReasoningEffort
      );
    } else if (normalizedOverrides.workerReasoningEffort !== undefined) {
      normalizedOverrides.workerReasoningEffort = clampReasoningEffortForModel(
        currentWorkerModel,
        normalizedOverrides.workerReasoningEffort
      );
    }

    if (normalizedOverrides.validationWorkerModel !== undefined) {
      normalizedOverrides.validationWorkerModel =
        resolveIfIndustryRouterOrFallback(
          normalizedOverrides.validationWorkerModel,
          {
            slotLabel: 'missionValidationWorkerModel',
            sessionId: this.currentSessionId ?? undefined,
          }
        );
      const validation = settingsService.validateModelAccess(
        normalizedOverrides.validationWorkerModel
      );
      if (!validation.allowed) {
        throw new MetaError(
          'Mission validation worker model not allowed by organization policy',
          {
            modelId: normalizedOverrides.validationWorkerModel,
          }
        );
      }
      normalizedOverrides.validationWorkerReasoningEffort =
        clampReasoningEffortForModel(
          normalizedOverrides.validationWorkerModel,
          normalizedOverrides.validationWorkerReasoningEffort ??
            currentValidationWorkerReasoningEffort
        );
    } else if (
      normalizedOverrides.validationWorkerReasoningEffort !== undefined
    ) {
      normalizedOverrides.validationWorkerReasoningEffort =
        clampReasoningEffortForModel(
          currentValidationWorkerModel,
          normalizedOverrides.validationWorkerReasoningEffort
        );
    }

    if (exists) {
      await missionFileService!.writeModelSettings(normalizedOverrides);
    }

    this.setMissionSettings({
      ...globalMissionSettings,
      ...currentSettings,
      ...normalizedOverrides,
    });
    this.emitMissionSettingsChanged();
  }

  private emitMissionSettingsChanged(): void {
    agentEventBus.emit(AgentEvent.SettingsUpdated, {
      settings: {
        missionSettings: this.currentMissionSettings,
      },
      sessionId: this.currentSessionId ?? '',
    });
  }

  // ---------------------------------------------------------------------------
  // Autonomy / interaction mode — single source of truth
  // ---------------------------------------------------------------------------

  /**
   * Set the combined autonomy mode (legacy, for backward compatibility).
   * @deprecated Use setInteractionMode() and setAutonomyLevel() instead
   */
  public setAutonomyMode(mode: AutonomyMode): void {
    const { mode: newInteractionMode, level: newAutonomyLevel } =
      parseAutonomyMode(mode);
    const cappedLevel = applyMaxAutonomyLevel(newAutonomyLevel);
    const effectiveMode = deriveAutonomyMode(newInteractionMode, cappedLevel);

    this.sessionSettings.autonomyLevel = cappedLevel;
    this.sessionSettings.autonomyMode = effectiveMode;
    this.sessionSettings.interactionMode = newInteractionMode;
    if (this.currentSessionId) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: true });
    }

    this.emitSessionSettingsChanged();
  }

  /**
   * Set the interaction mode (Auto, Spec, or Mission).
   * When no explicit spec model is configured, reasoning effort is
   * carried between Auto and Spec modes automatically.
   */
  public setInteractionMode(mode: DroolInteractionMode): void {
    const previousMode = this.getInteractionMode();

    // Sync reasoning effort between Auto and Spec when no explicit spec model
    if (!this.hasSpecModeModel()) {
      if (
        previousMode === DroolInteractionMode.Auto &&
        mode === DroolInteractionMode.Spec
      ) {
        this.sessionSettings.specModeReasoningEffort =
          this.getReasoningEffort();
      } else if (
        previousMode === DroolInteractionMode.Spec &&
        mode === DroolInteractionMode.Auto
      ) {
        this.sessionSettings.reasoningEffort =
          this.getSpecModeReasoningEffort();
      }
    }

    const currentLevel = this.getAutonomyLevel();
    const derivedMode = deriveAutonomyMode(mode, currentLevel);

    this.sessionSettings.interactionMode = mode;
    this.sessionSettings.autonomyLevel = currentLevel;
    this.sessionSettings.autonomyMode = derivedMode;

    if (this.currentSessionId) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: true });
    }

    this.emitSessionSettingsChanged();
  }

  /**
   * Set the autonomy level (Off, Low, Medium, High).
   */
  public setAutonomyLevel(level: AutonomyLevel): void {
    const cappedLevel = applyMaxAutonomyLevel(level);
    const currentMode = this.getInteractionMode();
    const derivedMode = deriveAutonomyMode(currentMode, cappedLevel);

    this.sessionSettings.autonomyLevel = cappedLevel;
    this.sessionSettings.interactionMode = currentMode;
    this.sessionSettings.autonomyMode = derivedMode;
    if (this.currentSessionId) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: true });
    }

    this.emitSessionSettingsChanged();
  }

  // ---------------------------------------------------------------------------
  // Autonomy / interaction mode — getters & derived helpers
  // ---------------------------------------------------------------------------

  public getInteractionMode(): DroolInteractionMode {
    return this.sessionSettings.interactionMode ?? DroolInteractionMode.Auto;
  }

  public getAutonomyLevel(): AutonomyLevel {
    if (this.sessionSettings.autonomyLevel !== undefined) {
      return this.sessionSettings.autonomyLevel;
    }
    if (this.sessionSettings.autonomyMode) {
      return parseAutonomyMode(this.sessionSettings.autonomyMode).level;
    }
    return AutonomyLevel.Off;
  }

  public getCurrentAutonomyMode(): AutonomyMode {
    return deriveAutonomyMode(
      this.getInteractionMode(),
      this.getAutonomyLevel()
    );
  }

  public isSpecMode(): boolean {
    return this.getInteractionMode() === DroolInteractionMode.Spec;
  }

  public isMissionMode(): boolean {
    return this.getInteractionMode() === DroolInteractionMode.Mission;
  }

  public isAutoRunMode(): boolean {
    return (
      this.getInteractionMode() === DroolInteractionMode.Auto &&
      this.getAutonomyLevel() !== AutonomyLevel.Off
    );
  }

  public shouldAutoApproveFileEdits(): boolean {
    if (this.isMissionMode()) {
      return true;
    }
    return this.isAutoRunMode();
  }

  public getEffectiveAutonomyModeForPermissions(): AutonomyMode {
    if (this.isMissionMode()) {
      return AutonomyMode.AutoHigh;
    }
    return this.getCurrentAutonomyMode();
  }

  public ensureOrchestratorModeInvariant(
    decompSessionType: DecompSessionType | undefined
  ): boolean {
    if (decompSessionType === DecompSessionType.Orchestrator) {
      if (this.getInteractionMode() !== DroolInteractionMode.Mission) {
        logInfo(
          '[SessionService] Auto-enabling Mission mode for Orchestrator session',
          { previousMode: this.getInteractionMode() }
        );
        this.setInteractionMode(DroolInteractionMode.Mission);
        return true;
      }
    }
    return false;
  }

  public getNextInteractionMode(): DroolInteractionMode {
    switch (this.getInteractionMode()) {
      case DroolInteractionMode.Auto:
        return DroolInteractionMode.Spec;
      case DroolInteractionMode.Spec:
      case DroolInteractionMode.Mission:
      default:
        return DroolInteractionMode.Auto;
    }
  }

  public cycleInteractionMode(): DroolInteractionMode {
    const newMode = this.getNextInteractionMode();
    this.setInteractionMode(newMode);
    return newMode;
  }

  public getNextAutonomyLevel(): AutonomyLevel {
    const cycleLevels = getAutonomyCycleLevels();
    const currentLevel = applyMaxAutonomyLevel(this.getAutonomyLevel());
    const currentIndex = cycleLevels.indexOf(currentLevel);
    if (currentIndex === -1 || cycleLevels.length === 0) {
      return AutonomyLevel.Off;
    }
    return cycleLevels[(currentIndex + 1) % cycleLevels.length];
  }

  public cycleAutonomyLevel(): AutonomyLevel {
    const newLevel = this.getNextAutonomyLevel();
    this.setAutonomyLevel(newLevel);
    return newLevel;
  }

  /**
   * @deprecated Use getNextInteractionMode() or getNextAutonomyLevel() instead
   */
  public getNextAutonomyMode(): AutonomyMode {
    const currentMode = this.getCurrentAutonomyMode();
    switch (currentMode) {
      case AutonomyMode.Normal:
        return AutonomyMode.Spec;
      case AutonomyMode.Spec:
        return AutonomyMode.AutoLow;
      case AutonomyMode.AutoLow:
        return AutonomyMode.AutoMedium;
      case AutonomyMode.AutoMedium:
        return AutonomyMode.AutoHigh;
      case AutonomyMode.AutoHigh:
        return AutonomyMode.Normal;
      default:
        return AutonomyMode.Normal;
    }
  }

  public setSpecModeModel(
    model: string,
    reasoningEffort?: ReasoningEffort
  ): void {
    const previousModel = this.sessionSettings.specModeModel;
    const effectiveModel = resolveIfIndustryRouterOrFallback(model, {
      slotLabel: 'specModeModel',
      sessionId: this.currentSessionId ?? undefined,
    });
    const validation = getSettingsService().validateModelAccess(effectiveModel);
    if (!validation.allowed) {
      throw new MetaError(
        'Spec mode model not allowed by organization policy',
        {
          modelId: effectiveModel,
        }
      );
    }
    this.sessionSettings.specModeModel = effectiveModel;
    if (!this.isIndustryRouterStillConfigured()) {
      this.sessionSettings.effectiveIndustryRouterModel = undefined;
    }
    if (reasoningEffort) {
      this.sessionSettings.specModeReasoningEffort =
        clampReasoningEffortForModel(effectiveModel, reasoningEffort);
    } else if (this.sessionSettings.specModeReasoningEffort !== undefined) {
      this.sessionSettings.specModeReasoningEffort =
        clampReasoningEffortForModel(
          effectiveModel,
          this.sessionSettings.specModeReasoningEffort
        );
    }
    if (this.currentSessionId) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: true });
      if (previousModel !== effectiveModel) {
        this.markSystemInfoRefreshNeeded();
      }
    }
    this.emitSessionSettingsChanged();
  }

  public setSpecModeReasoningEffort(effort: ReasoningEffort): void {
    const model = this.getSpecModeModel();
    this.sessionSettings.specModeReasoningEffort = clampReasoningEffortForModel(
      model,
      effort
    );
    if (this.currentSessionId) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: true });
    }
    this.emitSessionSettingsChanged();
  }

  // See `getReasoningEffort`; same Auto Model → cache translation.
  public getSpecModeReasoningEffort(): ReasoningEffort {
    const configuredSpecModel =
      this.sessionSettings.specModeModel ??
      getSettingsService().getSpecModeModel();
    if (configuredSpecModel === INDUSTRY_ROUTER_MODEL_ID) {
      const cached = this.sessionSettings.effectiveIndustryRouterModel;
      if (cached) return cached.reasoningEffort;
    }
    return this.getDisplaySpecModeReasoningEffort();
  }

  /** Display companion to {@link getSpecModeReasoningEffort}; skips the Auto Model → cache translation. */
  public getDisplaySpecModeReasoningEffort(): ReasoningEffort {
    return (
      this.sessionSettings.specModeReasoningEffort ??
      getSettingsService().getSpecModeReasoningEffort()
    );
  }

  public clearSpecModeModel(): void {
    const hadSpecModeModel = this.sessionSettings.specModeModel !== undefined;
    delete this.sessionSettings.specModeModel;
    delete this.sessionSettings.specModeReasoningEffort;
    if (this.currentSessionId) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: true });
      if (hadSpecModeModel) {
        this.markSystemInfoRefreshNeeded();
      }
    }
    this.emitSessionSettingsChanged();
  }

  /**
   * Engine-dispatchable model id for the engine to run.
   * For Auto Model sessions: cached pick from `primeForMessage`, with a
   * default fallback + telemetry warn if the engine hits this
   * unprimed. UI / status-line / picker / protocol-forwarder callers
   * should use {@link getDisplayModel} instead, which preserves
   * `auto` so clients render "Auto Model".
   */
  public getModel(): string {
    const configured =
      this.sessionSettings.model ?? getSettingsService().getModel();
    if (configured !== INDUSTRY_ROUTER_MODEL_ID) return configured;
    const cached = this.sessionSettings.effectiveIndustryRouterModel;
    if (cached) return resolveIndustryRouterGenerationModel(cached.modelId);
    const fallback = getDefaultModelId();
    logWarn(
      '[Session] getModel() on Auto Model session before priming; falling back to default',
      {
        sessionId: this.currentSessionId ?? undefined,
        fallbackModelId: fallback,
      }
    );
    return fallback;
  }

  /**
   * Literal user choice (may be INDUSTRY_ROUTER_MODEL_ID). Use for status-line,
   * model picker, and protocol forwarders that show "Auto Model" to clients.
   * NOT for engine / send-message reads — those need the resolved
   * concrete pick from {@link getModel}.
   */
  public getDisplayModel(): string {
    return this.sessionSettings.model ?? getSettingsService().getModel();
  }

  /** Spec model when spec mode is active+explicit, else main. */
  public getDisplayActiveModel(): string {
    if (this.isSpecMode() && this.hasSpecModeModel()) {
      return this.getDisplaySpecModeModel();
    }
    return this.getDisplayModel();
  }

  public getInheritableActiveModelSelection(): {
    modelId: string;
    reasoningEffort: ReasoningEffort;
  } {
    if (this.isSpecMode() && this.hasSpecModeModel()) {
      return {
        modelId: this.getDisplaySpecModeModel(),
        reasoningEffort: this.getDisplaySpecModeReasoningEffort(),
      };
    }

    return {
      modelId: this.getDisplayModel(),
      reasoningEffort: this.getDisplayReasoningEffort(),
    };
  }

  public getEffectiveIndustryRouterModel():
    | EffectiveIndustryRouterModel
    | undefined {
    return this.sessionSettings.effectiveIndustryRouterModel;
  }

  public setEffectiveIndustryRouterModel(
    decision: EffectiveIndustryRouterModel
  ): void {
    this.sessionSettings.effectiveIndustryRouterModel = decision;
    if (this.currentSessionId) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: true });
    }
    this.emitSessionSettingsChanged();
  }

  /** Clear the cached effective model (e.g. when the user switches off auto). */
  public clearEffectiveIndustryRouterModel(): void {
    if (this.sessionSettings.effectiveIndustryRouterModel === undefined) return;
    this.sessionSettings.effectiveIndustryRouterModel = undefined;
    if (this.currentSessionId) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: true });
    }
    this.emitSessionSettingsChanged();
  }

  public isSubAgentSession(): boolean {
    return this.currentDecompSessionType === DecompSessionType.Worker;
  }

  /**
   * Awaited before every LLM call by AgentLoop. Classification is cached, so
   * repeat calls are cheap. No-op for non-Auto Model sessions.
   */
  public async primeForMessage({
    conversationHistory,
    sessionId,
    routing,
  }: {
    conversationHistory: readonly IndustryDroolMessage[];
    sessionId: string;
    routing: ModelRoutingDeps;
  }): Promise<void> {
    if (this.getDisplayActiveModel() !== INDUSTRY_ROUTER_MODEL_ID) return;
    try {
      await resolveIndustryRouterModelForMessage({
        routing,
        conversationHistory,
        sessionId,
      });
    } catch (error) {
      if (error instanceof IndustryRouterUnavailableError) throw error;
      logWarn(
        '[Session] primeForMessage failed; turn will use the un-primed fallback path',
        { sessionId, cause: error }
      );
    }
  }

  /** See {@link getModel}; same Auto Model → cache translation. */
  public getSpecModeModel(): string {
    const configured =
      this.sessionSettings.specModeModel ??
      getSettingsService().getSpecModeModel();
    if (configured !== INDUSTRY_ROUTER_MODEL_ID) return configured;
    const cached = this.sessionSettings.effectiveIndustryRouterModel;
    if (cached) return resolveIndustryRouterGenerationModel(cached.modelId);
    const fallback = getDefaultModelId();
    logWarn(
      '[Session] getSpecModeModel() on Auto Model session before priming; falling back to default',
      {
        sessionId: this.currentSessionId ?? undefined,
        fallbackModelId: fallback,
      }
    );
    return fallback;
  }

  /** Display companion to {@link getSpecModeModel}; skips the Auto Model → cache translation. */
  public getDisplaySpecModeModel(): string {
    return (
      this.sessionSettings.specModeModel ??
      getSettingsService().getSpecModeModel()
    );
  }

  /**
   * Check if a spec mode model is configured for the current session.
   * No fallback to global settings — the global spec model is eagerly
   * copied into session settings at creation and load time.
   */
  public hasSpecModeModel(): boolean {
    return this.sessionSettings.specModeModel !== undefined;
  }

  private async appendUserOnlySystemMessageIfNotLast(
    text: string,
    messages: IndustryDroolMessage[]
  ): Promise<IndustryDroolMessage | undefined> {
    if (isLastMessageText(messages, text)) {
      return undefined;
    }

    return this.appendUserOnlySystemMessage(text, { messages });
  }

  /**
   * Get the enabled tool IDs for the current session.
   * These are additional tools enabled beyond defaults.
   */
  public getEnabledToolIds(): string[] {
    return this.sessionSettings.enabledToolIds || [];
  }

  /**
   * Set additional tool IDs to enable for the current session.
   * Used by CLI commands like --enabled-tools or /readiness-report.
   */
  public setEnabledToolIds(ids: string[]): void {
    this.setToolSelectionOverrides({ enabledToolIds: ids });
  }

  /**
   * Get the disabled tool IDs for the current session.
   */
  public getDisabledToolIds(): string[] {
    return this.sessionSettings.disabledToolIds || [];
  }

  /**
   * Set tool IDs to disable for the current session.
   */
  public setDisabledToolIds(ids: string[]): void {
    this.setToolSelectionOverrides({ disabledToolIds: ids });
  }

  /**
   * Update enabled/disabled tool overrides for the current session in a single write.
   */
  public setToolSelectionOverrides(params: {
    enabledToolIds?: string[];
    disabledToolIds?: string[];
  }): void {
    let changed = false;

    if (params.enabledToolIds !== undefined) {
      this.sessionSettings.enabledToolIds = params.enabledToolIds;
      changed = true;
    }

    if (params.disabledToolIds !== undefined) {
      this.sessionSettings.disabledToolIds = params.disabledToolIds;
      changed = true;
    }

    if (changed && this.currentSessionId) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: false });
    }
  }

  public getCompactionThresholdCheckEnabled(): boolean {
    return this.sessionSettings.compactionThresholdCheckEnabled ?? true;
  }

  public setCompactionThresholdCheckEnabled(enabled: boolean): void {
    this.sessionSettings.compactionThresholdCheckEnabled = enabled;
    if (this.currentSessionId) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: true });
    }
    this.emitSessionSettingsChanged();
  }

  /**
   * Get the sessions directory for a given working directory.
   * If no cwd is provided, returns the default sessions directory.
   */
  private getSessionsDirectory(cwd?: string): string {
    if (!cwd) {
      return this.sessionsDir; // Default ~/.industry/sessions/
    }
    const dirName = sanitizePathToDirectoryName(cwd);
    return path.join(this.sessionsDir, dirName);
  }

  /**
   * Ensure a project-specific sessions directory exists with proper permissions.
   */
  private ensureProjectSessionsDirectory(cwd: string): void {
    const projectDir = this.getSessionsDirectory(cwd);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
      setSecureDirectoryPermissionsSync(projectDir);
    }
  }

  /**
   * Get the attachments directory for a session.
   */
  private getAttachmentsDirectory(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId, 'attachments');
  }

  /**
   * Processes file attachments: saves PDFs to disk and adds path reference.
   * Text files are kept in-memory and not saved to disk.
   * Returns processed files with path set for PDFs.
   */
  public async processFileAttachments(
    sessionId: string,
    files: DocumentSource[] | undefined
  ): Promise<DocumentSource[] | undefined> {
    if (!files || files.length === 0) {
      return files;
    }

    const attachmentsDir = this.getAttachmentsDirectory(sessionId);
    await fs.promises.mkdir(attachmentsDir, { recursive: true });
    setSecureDirectoryPermissionsSync(attachmentsDir);

    const processedFiles: DocumentSource[] = [];

    for (const file of files) {
      if (!file.data) {
        // Skip files without data
        processedFiles.push(file);
        continue;
      }

      // Only save PDFs to disk - text files keep their data in-memory
      if (file.mediaType === 'application/pdf') {
        // Check PDF size — oversized PDFs fall back to text extraction
        const rawSize = Math.ceil((file.data.length * 3) / 4); // Approximate decoded size from base64
        if (rawSize > MAX_PDF_SIZE_BYTES) {
          const maxMB = MAX_PDF_SIZE_BYTES / (1024 * 1024);
          const fileMB = (rawSize / (1024 * 1024)).toFixed(1);
          logWarn(
            '[Session] PDF attachment exceeds native size limit, falling back to text extraction',
            { name: file.name, sizeMb: Number(fileMB), maxSizeMb: maxMB }
          );

          // Try to extract text from the oversized PDF
          let parsedData = 'parsedData' in file ? file.parsedData : undefined;
          if (!parsedData) {
            try {
              const { getDocumentProxy, extractText } = await import('unpdf');
              const buffer = Buffer.from(file.data, 'base64');
              const pdf = await getDocumentProxy(new Uint8Array(buffer));
              const result = await extractText(pdf, { mergePages: true });
              parsedData = result.text.trim() || undefined;
            } catch {
              logWarn(
                '[Session] PDF text extraction failed for oversized attachment',
                { name: file.name }
              );
            }
          }

          const name = file.name ?? 'document.pdf';
          const pdfSource: Base64PDFSource = {
            type: DocumentSourceType.Base64,
            mediaType: 'application/pdf',
            data: '',
            parsedData:
              parsedData ??
              `[PDF: ${name} — too large for native support, text extraction failed]`,
            name,
          };
          processedFiles.push(pdfSource);
          continue;
        }

        const timestamp = Date.now();
        const filename = `${timestamp}-${file.name ?? 'file'}`;
        const filePath = path.join(attachmentsDir, filename);

        // Decode and save PDF file
        const buffer = Buffer.from(file.data, 'base64');
        await fs.promises.writeFile(filePath, buffer);

        logInfo('[Session] Saved PDF attachment', {
          sessionId,
          fileName: filename,
          filePath,
          mimeType: file.mediaType,
        });

        // PDF: keep data for immediate use, set path for disk storage
        const pdfSource: Base64PDFSource = {
          type: DocumentSourceType.Base64,
          mediaType: 'application/pdf',
          data: file.data,
          parsedData: 'parsedData' in file ? file.parsedData : undefined,
          name: file.name,
          path: filePath,
        };
        processedFiles.push(pdfSource);
      } else {
        // Text files: keep data as-is, no disk storage needed
        processedFiles.push(file);
      }
    }

    return processedFiles;
  }

  /**
   * Get all project directories (subdirectories starting with hyphen).
   */
  private getAllProjectDirectories(): string[] {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('-'))
      .map((entry) => path.join(this.sessionsDir, entry.name));
  }

  /**
   * Find a session file across different directories.
   * Searches in: 1) Current project directory, 2) Global directory, 3) All project directories (if allowed)
   *
   * @param params.sessionId - The session ID to find
   * @param params.searchAllProjects - Whether to search all project directories if not found in current project or global
   */
  private findSessionFile(params: {
    sessionId: string;
    searchAllProjects?: boolean;
  }): string | null {
    const { sessionId, searchAllProjects = false } = params;
    const currentCwd = process.cwd();

    // 1. Try current working directory first
    const projectPath = this.getSessionMessagesPath(sessionId, currentCwd);
    if (fs.existsSync(projectPath)) {
      return projectPath;
    }

    // 2. Try global sessions directory (backward compatibility)
    const globalPath = this.getSessionMessagesPath(sessionId);
    if (fs.existsSync(globalPath)) {
      return globalPath;
    }

    // 3. Check the dedicated btw fork directory before scanning project
    // directories. btw forks are also loaded by the parent CLI process
    // which may create a stale project-dir copy; the btw copy is
    // the authoritative source.
    const btwPath = path.join(
      this.getBtwSessionsDirectory(),
      `${sessionId}.jsonl`
    );
    if (fs.existsSync(btwPath)) {
      return btwPath;
    }

    // 4. Search all session directories (only if flag is set)
    if (searchAllProjects) {
      const sessionDirs = this.getAllProjectDirectories();
      for (const dir of sessionDirs) {
        const dirSessionPath = path.join(dir, `${sessionId}.jsonl`);
        if (fs.existsSync(dirSessionPath)) {
          return dirSessionPath;
        }
      }
    }

    return null;
  }

  private findSessionSettingsPath(
    sessionId: string,
    searchAllProjects: boolean = false
  ): string | null {
    const sessionPath = this.findSessionFile({
      sessionId,
      searchAllProjects,
    });
    return sessionPath
      ? path.join(path.dirname(sessionPath), `${sessionId}.settings.json`)
      : null;
  }

  private ensureSessionsDirectory(): void {
    const industryDir = path.join(getIndustryHome(), getIndustryDirName());
    if (!fs.existsSync(industryDir)) {
      fs.mkdirSync(industryDir, { recursive: true });
      setSecureDirectoryPermissionsSync(industryDir);
    }
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
      setSecureDirectoryPermissionsSync(this.sessionsDir);
    }
  }

  private getBtwSessionsDirectory(): string {
    return path.join(this.sessionsDir, 'btw');
  }

  private ensureBtwSessionsDirectory(): void {
    const dir = this.getBtwSessionsDirectory();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      setSecureDirectoryPermissionsSync(dir);
    }
  }

  /**
   * Creates a new session and sets it as the current active session.
   * @param params - Session creation parameters
   * @param params.firstUserMessage - Optional first user message for title generation
   * @param params.parentSessionId - Optional parent session ID for linked sessions
   * @param params.cwd - Working directory (defaults to process.cwd())
   */
  public async createNewSession(
    params?: CreateNewSessionParams
  ): Promise<string> {
    const sessionId = generateUUID();
    return this.createSessionWithId({
      sessionId,
      firstUserMessage: params?.firstUserMessage,
      parentSessionId: params?.parentSessionId,
      callingSessionId: params?.callingSessionId,
      callingToolUseId: params?.callingToolUseId,
      cwd: params?.cwd,
      tags: params?.tags,
      sessionTitle: params?.sessionTitle,
      enabledToolIds: params?.enabledToolIds,
      disabledToolIds: params?.disabledToolIds,
      initialSettings: params?.initialSettings,
    });
  }

  public async ensureCurrentSession(
    params?: CreateNewSessionParams
  ): Promise<string> {
    if (this.currentSessionId) {
      return this.currentSessionId;
    }

    if (!this.ensureCurrentSessionPromise) {
      this.ensureCurrentSessionPromise = this.createNewSession(params).finally(
        () => {
          this.ensureCurrentSessionPromise = null;
        }
      );
    }

    return this.ensureCurrentSessionPromise;
  }

  /**
   * Creates a session with a specific ID and sets it as the current active session.
   * This is used when syncing with a pre-created session from backend.
   *
   * @param params - Session creation parameters
   * @param params.sessionId - The specific session ID to use
   * @param params.firstUserMessage - Optional first user message for title generation
   * @param params.parentSessionId - Optional parent session ID (for linking sessions, e.g., after compaction)
   * @param params.skipRemoteCreation - If true, skip remote session creation (session already exists remotely)
   * @param params.cwd - Working directory where the session is created
   * @returns The session ID
   * @throws {MetaError} If a session with this ID already exists locally
   */
  public async createSessionWithId(
    params: CreateSessionWithIdParams
  ): Promise<string> {
    const {
      sessionId,
      firstUserMessage,
      parentSessionId,
      callingSessionId,
      callingToolUseId,
      skipRemoteCreation = false,
      source = 'startup',
      cwd = process.cwd(),
      hostId: requestedHostId,
      computerId,
      machineConnectionType,
      selectedWorkspaceId,
      workspaceSandboxId,
      decompSessionType,
      decompMissionId,
      inheritTokenUsage,
      sessionLocation,
      sessionSource,
      tags: requestedTags,
      privacyLevel,
      sessionTitle: explicitSessionTitle,
      enabledToolIds,
      disabledToolIds,
      initialSettings,
    } = params;
    const effectiveCwd = cwd || process.cwd();
    const resolvedMachineConnectionType =
      machineConnectionType ?? MachineConnectionType.TUI;
    const hostId =
      requestedHostId ??
      (await getHostIdentityService().getHostIdentity()).hostId;

    const missionTagMetadata = getMissionSessionTagMetadata(requestedTags);
    const resolvedDecompSessionType =
      getDecompSessionTypeFromTags(requestedTags) ?? decompSessionType;
    const resolvedDecompMissionId =
      missionTagMetadata?.missionId ??
      decompMissionId ??
      (resolvedDecompSessionType === DecompSessionType.Orchestrator
        ? sessionId
        : undefined);
    if (
      resolvedDecompSessionType === DecompSessionType.Worker &&
      !resolvedDecompMissionId
    ) {
      throw new MetaError('Worker sessions require an orchestrator session ID');
    }
    const resolvedMissionTagMetadata =
      resolvedDecompSessionType && resolvedDecompMissionId
        ? {
            role: resolvedDecompSessionType,
            missionId: resolvedDecompMissionId,
          }
        : undefined;
    const tags = resolvedMissionTagMetadata
      ? upsertMissionSessionTag(requestedTags, resolvedMissionTagMetadata)
      : requestedTags;

    // For worker sessions, set callingSessionId to the orchestrator session ID
    // so worker sessions are linked to their parent mission in Firestore
    const resolvedCallingSessionId =
      callingSessionId ??
      (resolvedDecompSessionType === DecompSessionType.Worker
        ? resolvedDecompMissionId
        : undefined);

    // Ensure project directory exists if cwd provided
    this.ensureProjectSessionsDirectory(effectiveCwd);

    const sessionPath = this.getSessionMessagesPath(sessionId, effectiveCwd);

    // Check if session already exists locally to prevent overwriting
    if (fs.existsSync(sessionPath)) {
      try {
        logInfo('[Session] Session already exists locally, loading instead', {
          sessionId,
        });
        await this.loadSession(sessionId, { sessionStartSource: source });
        return sessionId;
      } catch (error) {
        // Session file exists but is corrupted - delete and recreate
        logException(
          error,
          '[Session] Failed to load existing session, recreating file',
          {
            sessionId,
          }
        );
        fs.rmSync(sessionPath, { force: true });
        // Continue to create new session with same ID
      }
    }

    const title = explicitSessionTitle
      ? sanitizeSessionTitle(explicitSessionTitle)
      : SessionService.generateTitle(firstUserMessage);
    const owner = SessionService.getCurrentUser();

    const sessionSummary: SessionSummaryEvent = {
      type: 'session_start',
      id: sessionId,
      title,
      sessionTitle: title,
      ...(explicitSessionTitle ? { isSessionTitleManuallySet: true } : {}),
      owner,
      ...(parentSessionId ? { parent: parentSessionId } : {}),
      ...(resolvedCallingSessionId
        ? { callingSessionId: resolvedCallingSessionId }
        : {}),
      ...(callingToolUseId ? { callingToolUseId } : {}),
      version: 2,
      cwd: effectiveCwd,
      ...(hostId ? { hostId } : {}),
    };

    fs.writeFileSync(sessionPath, `${JSON.stringify(sessionSummary)}\n`);
    setSecureFilePermissionsSync(sessionPath);

    // Capture any pending settings that were set before the session existed
    // (e.g., user pressed Ctrl+N before the async session creation completed).
    const pendingSettings = !this.currentSessionId
      ? { ...this.sessionSettings }
      : {};

    this.setActiveSession({ sessionId, cwd: effectiveCwd, hostId, title });
    this.currentDecompMissionId = resolvedDecompMissionId;
    this.currentDecompSessionType = resolvedDecompSessionType;
    this.lastMessageId = null;
    this.activeUserMessageSource = undefined;
    this.wasSessionResumed = false; // New session, not resumed
    this.sessionEndHooksExecuted = false;
    this.resetSessionTokenUsageEmitter();

    // Initialize session settings from global defaults, applying any
    // pending values that were set before the session existed.
    const settingsService = getSettingsService();

    const hasGlobalSpecModel = settingsService.hasSpecModeModel();

    const resolvedDefaults = resolveInteractionSettingsWithLegacyFallback({
      interactionMode: settingsService.getInteractionMode(),
      autonomyLevel: settingsService.getAutonomyLevel(),
      autonomyMode: settingsService.getAutonomyMode(),
    });
    const defaultInteractionMode =
      resolvedDefaults.interactionMode ?? DroolInteractionMode.Auto;
    const defaultAutonomyLevel =
      resolvedDefaults.autonomyLevel ?? AutonomyLevel.Off;

    // initialSettings (from caller) take priority over pendingSettings (from
    // pre-session UI interactions) which take priority over global defaults.
    const sessionModel =
      initialSettings?.model ??
      pendingSettings.model ??
      settingsService.getModel();
    const sessionEffort =
      initialSettings?.reasoningEffort ??
      pendingSettings.reasoningEffort ??
      settingsService.getReasoningEffort();
    // When initialSettings explicitly provides specModeModel (even as null to
    // clear), treat it as a hard override with no fallback to pending/global.
    const sessionSpecModel =
      initialSettings?.specModeModel !== undefined
        ? (initialSettings.specModeModel ?? undefined)
        : (pendingSettings.specModeModel ??
          (hasGlobalSpecModel
            ? settingsService.getSpecModeModel()
            : undefined));
    const sessionSpecEffort =
      initialSettings?.specModeReasoningEffort !== undefined
        ? (initialSettings.specModeReasoningEffort ?? undefined)
        : (pendingSettings.specModeReasoningEffort ??
          (hasGlobalSpecModel
            ? settingsService.getSpecModeReasoningEffort()
            : undefined));
    // Orchestrator sessions must use Mission mode so the mission UI (green border)
    // renders correctly. Without this, /new in mission mode would reset the
    // interactionMode to the global default (Auto) and the green box would vanish.
    const sessionInteractionMode =
      resolvedDecompSessionType === DecompSessionType.Orchestrator
        ? DroolInteractionMode.Mission
        : (initialSettings?.interactionMode ??
          pendingSettings.interactionMode ??
          defaultInteractionMode);
    const sessionAutonomyLevel =
      initialSettings?.autonomyLevel ??
      pendingSettings.autonomyLevel ??
      defaultAutonomyLevel;
    const sessionAutonomyMode =
      pendingSettings.autonomyMode ??
      deriveAutonomyMode(sessionInteractionMode, sessionAutonomyLevel);
    const sessionCompactionThresholdCheckEnabled =
      initialSettings?.compactionThresholdCheckEnabled ??
      pendingSettings.compactionThresholdCheckEnabled ??
      true;

    this.sessionSettings = {
      assistantActiveTimeMs: 0,
      model: sessionModel,
      reasoningEffort: clampReasoningEffortForModel(
        sessionModel,
        sessionEffort
      ),
      interactionMode: sessionInteractionMode,
      autonomyLevel: sessionAutonomyLevel,
      autonomyMode: sessionAutonomyMode,
      specModeModel: sessionSpecModel,
      specModeReasoningEffort:
        sessionSpecModel && sessionSpecEffort
          ? clampReasoningEffortForModel(sessionSpecModel, sessionSpecEffort)
          : sessionSpecEffort,
      compactionThresholdCheckEnabled: sessionCompactionThresholdCheckEnabled,
      ...(tags ? { tags } : {}),
      // Preserve enabledToolIds from params or pending settings (set before session created)
      ...((enabledToolIds?.length ||
        pendingSettings.enabledToolIds?.length) && {
        enabledToolIds: enabledToolIds ?? pendingSettings.enabledToolIds,
      }),
      ...((disabledToolIds?.length ||
        pendingSettings.disabledToolIds?.length) && {
        disabledToolIds: disabledToolIds ?? pendingSettings.disabledToolIds,
      }),
    };
    this.migrateNewSessionModels();

    // Inherit token usage from parent session (e.g., during compaction) or reset to zero
    if (inheritTokenUsage) {
      this.sessionTokenUsage = normalizeTokenUsage(inheritTokenUsage);
      this.sessionSettings.tokenUsage = { ...this.sessionTokenUsage };
      logInfo('[Session] Inheriting token usage from parent session', {
        sessionId,
        inputTokens: inheritTokenUsage.inputTokens,
        outputTokens: inheritTokenUsage.outputTokens,
        cachedTokensWritten: inheritTokenUsage.cacheCreationTokens,
        cachedTokensRead: inheritTokenUsage.cacheReadTokens,
        reasoningTokens: inheritTokenUsage.thinkingTokens,
      });
    } else {
      this.resetTokenUsage();
    }
    this.recomputeInclusiveTokenUsage();
    // Inform telemetry client of the new active session
    CliTelemetryClient.getInstance().setSessionId(sessionId);

    // Register the remote create before any follow-up cloud syncs (including
    // the initial settings save below) so CloudSyncService can queue them
    // behind /api/sessions/create instead of racing update-settings first.
    const shouldSkipRemoteCreation = skipRemoteCreation;
    if (shouldSkipRemoteCreation) {
      logInfo('[SessionService] Skipping remote session creation', {
        skipRemoteCreation,
      });
    }
    if (this.cloudSessionSync && !shouldSkipRemoteCreation) {
      void getCloudSyncService().syncSessionCreate({
        sessionId,
        title,
        machineConnectionType: resolvedMachineConnectionType,
        parentSessionId,
        callingSessionId: resolvedCallingSessionId,
        callingToolUseId,
        hostId,
        computerId,
        sessionLocation,
        sessionSource,
        tags,
        ...(privacyLevel ? { privacyLevel } : {}),
        selectedWorkspaceId,
        workspaceSandboxId,
        cwd: effectiveCwd,
      });
    }

    this.saveSessionSettings({ async: false, shouldSyncToCloud: true });

    // Notify UI hooks that session settings have been initialized
    this.emitSessionSettingsChanged();

    // Execute SessionStart hooks for new session
    await this.executeSessionStartHooks(
      source,
      parentSessionId,
      resolvedCallingSessionId
    );

    void restartSystemInfoPrefetch().catch((err) => {
      logWarn('[Session] Failed to restart system info prefetch', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return sessionId;
  }

  public async generateSessionTitle(
    firstUserMessage: string
  ): Promise<string | null> {
    if (!this.currentSessionId) {
      throw new MetaError('Session must exist before generating title');
    }

    const sessionPath = this.getSessionMessagesPath(
      this.currentSessionId,
      this.currentSessionStorageCwd
    );
    if (!fs.existsSync(sessionPath)) {
      throw new SessionNotFoundError({ sessionId: this.currentSessionId });
    }

    try {
      const fileContent = fs.readFileSync(sessionPath, 'utf-8');
      const lines = fileContent.split('\n');
      if (lines.length === 0 || !lines[0].trim()) {
        throw new MetaError('Invalid session file: missing session summary');
      }

      // Parse and update the first line (SessionSummaryEvent)
      const sessionSummary: SessionSummaryEvent = JSON.parse(lines[0]);
      if (sessionSummary.type !== 'session_start') {
        throw new MetaError(
          'Invalid session file: first line is not session_start event'
        );
      }

      // Use the first user message as a local-only fallback title (for session list display).
      // The LLM-generated title from SessionTitleGenerator will replace this via updateSessionTitle.
      const title = SessionService.generateTitle(firstUserMessage);
      sessionSummary.title = title;

      // Rewrite the file with updated title
      lines[0] = JSON.stringify(sessionSummary);
      fs.writeFileSync(sessionPath, lines.join('\n'));
      setSecureFilePermissionsSync(sessionPath);

      logInfo('[Session] Session title updated locally', {
        sessionId: this.currentSessionId,
        length: title.length,
      });

      // Keep backend title in sync so refreshes don't regress to "New Session"
      // when daemon-local state isn't available.
      void this.syncSessionTitleToCloud(this.currentSessionId, title);

      return title;
    } catch (error) {
      logException(error, 'Failed to update session title during generation');
      return null;
    }
  }

  /**
   * Forks an existing session by copying messages up to a specific message ID.
   * This is much faster than repeatedly calling appendMessage.
   *
   * @param sourceSessionId - The session to fork from
   * @param targetMessageId - Copy all messages up to (but not including) this message. If null, copies all messages.
   * @param newTitle - Title for the forked session
   * @param parentSessionId - Optional parent session ID for linking
   * @param source - Optional source identifier for metrics (e.g., 'create-skill', 'rewind')
   * @param options - Optional fork options (extraTags, skipRemoteCreation)
   * @returns The new session ID
   */
  public async forkSession(
    sourceSessionId: string,
    targetMessageId: string | null,
    newTitle: string,
    parentSessionId?: string,
    source?: string,
    options?: {
      extraTags?: SessionTag[];
      skipRemoteCreation?: boolean;
      cwdOverride?: string;
      /**
       * When true, the fork is created without switching the SessionService's
       * current session. This is required for background forks (e.g. /btw)
       * where the main session must continue unaffected.
       */
      preserveCurrentSession?: boolean;
      /**
       * When true, the fork's JSONL and settings files are written to the
       * dedicated `sessions/btw/` subdirectory instead of the project's
       * session directory. This directory is not enumerated by session
       * discovery, search, or cloud sync, so the fork is hidden by path
       * rather than by tag filtering.
       */
      useBtwDirectory?: boolean;
    }
  ): Promise<string> {
    const forkStartTime = Date.now();
    const metricsLabels = source ? { source } : {};
    Metrics.addToCounter(Metric.SESSION_FORK_COUNT, 1, metricsLabels);

    // Find the source session file
    const sourceSessionPath = this.findSessionFile({
      sessionId: sourceSessionId,
      searchAllProjects: true,
    });
    if (!sourceSessionPath || !fs.existsSync(sourceSessionPath)) {
      Metrics.addToCounter(Metric.SESSION_FORK_FAILURE_COUNT, 1, metricsLabels);
      throw new SessionNotFoundError({ sessionId: sourceSessionId });
    }

    const newSessionId = generateUUID();
    let cwd: string | undefined;
    let newSessionPath: string | undefined;

    logInfo('[Session] Forking session', {
      sessionId: newSessionId,
    });

    const sourceSettingsPath = path.join(
      path.dirname(sourceSessionPath),
      `${sourceSessionId}.settings.json`
    );
    let sourceTags: SessionTag[] | undefined;
    if (fs.existsSync(sourceSettingsPath)) {
      try {
        const sourceSettings = JSON.parse(
          fs.readFileSync(sourceSettingsPath, 'utf-8')
        ) as { tags?: SessionTag[] };
        sourceTags = sourceSettings.tags;
      } catch (error) {
        logWarn('[Session] Failed to read source session tags during fork', {
          sessionId: sourceSessionId,
          cause: error,
        });
      }
    }
    let forkedMissionTagMetadata = getMissionSessionTagMetadata(sourceTags);

    // Read source session line by line and copy events up to target message
    const fileStream = fs.createReadStream(sourceSessionPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const eventsToWrite: string[] = [];
    let foundTargetMessage = false;
    let isFirstLine = true;

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;

        try {
          const event: DroolSessionEvent = JSON.parse(line);

          // Handle first line (session summary)
          if (isFirstLine) {
            isFirstLine = false;
            if (event.type === 'session_start') {
              const summaryEvent = event as SessionSummaryEvent;
              const effectiveSourceCwd =
                options?.cwdOverride ??
                summaryEvent.lastCwd ??
                summaryEvent.cwd ??
                this.currentSessionCwd ??
                process.cwd();
              cwd = effectiveSourceCwd;
              if (options?.useBtwDirectory) {
                this.ensureBtwSessionsDirectory();
                newSessionPath = path.join(
                  this.getBtwSessionsDirectory(),
                  `${newSessionId}.jsonl`
                );
              } else {
                this.ensureProjectSessionsDirectory(cwd);
                newSessionPath = this.getSessionMessagesPath(newSessionId, cwd);
              }
              if (fs.existsSync(newSessionPath)) {
                Metrics.addToCounter(
                  Metric.SESSION_FORK_FAILURE_COUNT,
                  1,
                  metricsLabels
                );
                throw new MetaError('New session ID already exists', {
                  newSessionId,
                });
              }
              const summaryMissionId =
                summaryEvent.decompSessionType ===
                DecompSessionType.Orchestrator
                  ? (summaryEvent.decompMissionId ?? sourceSessionId)
                  : summaryEvent.decompMissionId;
              const summaryMissionTagMetadata =
                summaryEvent.decompSessionType && summaryMissionId
                  ? {
                      role: summaryEvent.decompSessionType,
                      missionId: summaryMissionId,
                    }
                  : null;
              const sourceMissionTagMetadata =
                forkedMissionTagMetadata ?? summaryMissionTagMetadata;
              forkedMissionTagMetadata = sourceMissionTagMetadata;
              const summaryBase = {
                ...summaryEvent,
                cwd: effectiveSourceCwd,
              };
              const hostId =
                summaryEvent.hostId ??
                (await getHostIdentityService().getHostIdentity()).hostId;
              delete summaryBase.decompSessionType;
              delete summaryBase.decompMissionId;
              delete summaryBase.lastCwd;

              // Update session metadata for the fork
              const newSummaryEvent: SessionSummaryEvent = {
                ...summaryBase,
                id: newSessionId,
                title: newTitle,
                sessionTitle: newTitle,
                isSessionTitleManuallySet: false,
                sessionTitleAutoStage: undefined,
                parent: parentSessionId || summaryEvent.parent,
                // Propagate callingSessionId only for btw forks so the
                // daemon registry can link them back to their parent
                // (used by restoreEntries). Regular /fork sessions should
                // appear as top-level entries in the sidebar.
                callingSessionId: options?.preserveCurrentSession
                  ? parentSessionId || summaryEvent.callingSessionId
                  : summaryEvent.callingSessionId,
                hostId,
              };
              eventsToWrite.push(JSON.stringify(newSummaryEvent));
              continue;
            } else {
              throw new MetaError(
                'Invalid session file: first line is not session_start event'
              );
            }
          }

          // Check if this is the target message (only if targetMessageId is specified)
          if (
            targetMessageId !== null &&
            event.type === 'message' &&
            event.id === targetMessageId
          ) {
            foundTargetMessage = true;
            break; // Stop copying at this message
          }

          // Copy all events before the target message (or all events if targetMessageId is null)
          // This includes:
          // - message events (user, assistant, tool messages)
          // - compaction_state events (conversation summaries)
          // - todo_state events (pinned todos)
          eventsToWrite.push(line);
        } catch (parseError) {
          logWarn('[Session] Skipping malformed line during fork', {
            error: parseError,
          });
          continue;
        }
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }

    // Only check for target message if one was specified
    if (targetMessageId !== null && !foundTargetMessage) {
      Metrics.addToCounter(Metric.SESSION_FORK_FAILURE_COUNT, 1, metricsLabels);
      throw new MetaError('Target message not found in source session');
    }

    if (!newSessionPath) {
      Metrics.addToCounter(Metric.SESSION_FORK_FAILURE_COUNT, 1, metricsLabels);
      throw new MetaError(
        'Invalid session file: first line is not session_start event'
      );
    }

    // Write all events to the new session file
    const newSessionContent = `${eventsToWrite.join('\n')}\n`;
    fs.writeFileSync(newSessionPath, newSessionContent);
    setSecureFilePermissionsSync(newSessionPath);

    logInfo('[Session] Session forked successfully', {
      sessionId: newSessionId,
    });
    Metrics.addToCounter(Metric.SESSION_FORK_SUCCESS_COUNT, 1, metricsLabels);
    Metrics.recordHistogram(
      Metric.SESSION_FORK_LATENCY,
      (Date.now() - forkStartTime) / 1000,
      metricsLabels
    );

    // Rebuild state from copied events
    let lastMsgId: string | null = null;
    for (let i = eventsToWrite.length - 1; i >= 1; i--) {
      try {
        const event: DroolSessionEvent = JSON.parse(eventsToWrite[i]);
        if (event.type === 'message' && lastMsgId === null) {
          lastMsgId = event.id;
        }
      } catch {
        continue;
      }
    }

    // Compute the merged settings for the new fork (preserving source model,
    // reasoning effort, etc. and adding any extra tags).
    const baseTags = forkedMissionTagMetadata
      ? upsertMissionSessionTag(sourceTags, forkedMissionTagMetadata)
      : sourceTags;
    const extraTags = options?.extraTags ?? [];
    const mergedTags =
      extraTags.length === 0
        ? baseTags
        : [
            ...(baseTags ?? []),
            ...extraTags.filter(
              (tag) => !(baseTags ?? []).some((t) => t.name === tag.name)
            ),
          ];
    const forkedSessionSettings = {
      ...this.sessionSettings,
      assistantActiveTimeMs: 0,
      tokenUsage: undefined,
      archivedAt: undefined,
      tags: mergedTags,
    };

    if (options?.preserveCurrentSession) {
      // Write the fork's settings file directly without mutating any
      // SessionService state — the main session must stay current.
      const forkSettingsPath = options.useBtwDirectory
        ? path.join(
            this.getBtwSessionsDirectory(),
            `${newSessionId}.settings.json`
          )
        : this.getSessionSettingsPath(newSessionId, cwd);
      try {
        fs.writeFileSync(
          forkSettingsPath,
          JSON.stringify(forkedSessionSettings, null, 2)
        );
        setSecureFilePermissionsSync(forkSettingsPath);
      } catch (err) {
        logError(
          '[Session] Failed to write fork settings (preserveCurrentSession)',
          {
            error: err instanceof Error ? err.message : String(err),
          }
        );
      }
      if (this.cloudSessionSync && !options.skipRemoteCreation) {
        void getCloudSyncService().syncSessionSettings(
          newSessionId,
          forkedSessionSettings
        );
      }

      // Update the discovery index so getCachedNonEmptySessions immediately
      // knows about this fork (including isBtwFork from the settings tags).
      if (newSessionPath) {
        const forkSummary: SessionSummaryEvent = JSON.parse(eventsToWrite[0]);
        this.sessionDiscoveryIndex.noteSessionMutation({
          sessionId: newSessionId,
          sessionPath: newSessionPath,
          sessionSummary: forkSummary,
          messageCount: Math.max(eventsToWrite.length - 1, 0),
        });
        this.sessionDiscoveryIndex.noteSessionSettingsMutation({
          sessionId: newSessionId,
          sessionPath: newSessionPath,
        });
      }

      return newSessionId;
    }

    // Set the new session as current
    const forkSummary: SessionSummaryEvent = JSON.parse(eventsToWrite[0]);
    this.setActiveSession({
      sessionId: newSessionId,
      cwd,
      hostId: forkSummary.hostId,
      title: newTitle,
    });
    this.lastMessageId = lastMsgId;
    this.activeUserMessageSource = undefined;
    this.currentDecompSessionType = forkedMissionTagMetadata?.role;
    this.currentDecompMissionId = forkedMissionTagMetadata?.missionId;

    // Preserve the source session's settings (model, reasoning effort, etc.)
    // and only reset per-session counters. Previously this read from global
    // defaults which would silently change the model on fork.
    this.sessionSettings = forkedSessionSettings;
    this.sessionTokenUsage = createEmptyTokenUsage();
    this.lastCallTokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    };
    delete this.sessionSettings.tokenUsage;
    delete this.sessionSettings.inclusiveTokenUsage;
    delete this.sessionSettings.childInclusiveTokenUsageBySessionId;

    this.saveSessionSettings({
      async: false,
      shouldSyncToCloud: !options?.skipRemoteCreation,
    });

    return newSessionId;
  }

  /**
   * Returns the locked model provider for the current session, if any.
   */
  public getLockedModelProvider(): ModelProvider | null {
    return this.sessionSettings.providerLock ?? null;
  }

  /**
   * Locks the model provider for the current session, only if not already set.
   * Also persists the provider lock to the session settings file.
   */
  public setLockedModelProviderOnce(provider: ModelProvider): void {
    if (!this.currentSessionId) return;
    if (!this.sessionSettings.providerLock) {
      // Update in-memory settings
      this.sessionSettings.providerLock = provider;
      this.sessionSettings.providerLockTimestamp = new Date().toISOString();

      // Persist to file
      this.saveSessionSettings({ async: false, shouldSyncToCloud: true });

      logInfo('[Session] Provider locked', {
        sessionId: this.currentSessionId!,
      });
    }
  }

  /**
   * Updates the locked model provider for the current session regardless of prior value.
   * Use with care: callers must ensure conversation state is safe to switch providers.
   */
  public updateLockedModelProvider(provider: ModelProvider): void {
    if (!this.currentSessionId) return;
    this.sessionSettings.providerLock = provider;
    this.sessionSettings.providerLockTimestamp = new Date().toISOString();

    this.saveSessionSettings({ async: false, shouldSyncToCloud: true });

    logInfo('[Session] Provider lock updated', {
      sessionId: this.currentSessionId!,
    });
  }

  /**
   * Migrate the session-pinned model and spec model on load so that
   * downstream routing and the request body always agree.
   *
   * Four concerns are funneled into a single pass per slot:
   *   1. Known-id check (FAC-19594 / FAC-16834 Pattern A): if
   *      `getTuiModelConfig(id)` returned a fallback config (the id is not
   *      in CLI_MODEL_ORDER, not an alias of an in-CLI id, and not a custom
   *      model), migrate to an allowed model so request routing and the
   *      body's `model` field stay in sync.
   *   2. Hard deprecation: if the current id has been retired by flag,
   *      migrate to its configured allowed replacement model.
   *   3. Org policy: if the current id is denied by the org's
   *      `modelPolicy`, migrate to the first allowed model.
   *   4. Provider lock (primary slot only): if the session has a
   *      `providerLock` and the current model belongs to a different
   *      provider, switch to the provider default (or first allowed in
   *      that provider).
   *
   * Custom (BYOK) `custom:`-prefixed ids are preserved verbatim — they
   * legitimately do not appear in CLI_MODEL_ORDER and downstream routing
   * handles them via the registered custom-model entry.
   *
   * If no fallback is available we leave the pinned model in place rather
   * than throw the session away — the user can still switch via the model
   * picker before sending a message.
   */
  private async migrateSessionModelsOnLoad(
    messages: IndustryDroolMessage[]
  ): Promise<void> {
    // setModel re-clamps reasoningEffort against the new model when no
    // explicit effort is passed, so the session lands on a valid effort
    // for the migrated model.
    const mainFallback = this.migrateSessionModelSlot({
      label: 'model',
      get: () => this.sessionSettings.model,
      set: (next) => this.setModel(next),
      enforceProviderLock: true,
    });

    const specModeFallback = this.migrateSessionModelSlot({
      label: 'specModeModel',
      get: () => this.sessionSettings.specModeModel,
      set: (next) => this.setSpecModeModel(next),
      // Provider lock applies to the active turn's provider routing; the
      // spec-mode model is not expected to honor it.
      enforceProviderLock: false,
    });

    const deprecationFallback =
      this.isSpecMode() && this.hasSpecModeModel()
        ? specModeFallback
        : mainFallback;
    if (deprecationFallback) {
      await this.appendUserOnlySystemMessageIfNotLast(
        deprecationFallback.message,
        messages
      );
    }
  }

  private migrateNewSessionModels(): void {
    this.migrateSessionModelSlot({
      label: 'model',
      get: () => this.sessionSettings.model,
      set: (next) => this.setModel(next),
      enforceProviderLock: false,
    });

    this.migrateSessionModelSlot({
      label: 'specModeModel',
      get: () => this.sessionSettings.specModeModel,
      set: (next) => this.setSpecModeModel(next),
      enforceProviderLock: false,
    });
  }

  public async appendUserOnlySystemMessage(
    text: string,
    options?: { messages?: IndustryDroolMessage[] }
  ): Promise<IndustryDroolMessage> {
    const now = Date.now();
    const message: IndustryDroolMessage = {
      id: generateUUID(),
      role: MessageRole.System,
      content: [
        {
          type: MessageContentBlockType.Text,
          text,
        },
      ],
      visibility: MessageVisibility.UserOnly,
      createdAt: now,
      updatedAt: now,
    };
    options?.messages?.push(message);
    await this.appendMessage(message);
    return message;
  }

  private migrateSessionModelSlot(slot: {
    label: string;
    get: () => string | undefined;
    set: (next: string) => void;
    enforceProviderLock: boolean;
  }): AppliedDeprecatedModelFallback | undefined {
    const initial = slot.get();
    if (!initial) return undefined;

    // Custom (BYOK) models — never migrated.
    if (initial.startsWith('custom:')) return undefined;

    const settingsService = getSettingsService();
    let resolved = initial;
    let deprecatedModelFallback: AppliedDeprecatedModelFallback | undefined;
    const migrate = (next: string): void => {
      slot.set(next);
      resolved = next;
    };
    const getCurrentDeprecationFallback = () =>
      deprecatedModelFallback?.fallbackModelId === resolved
        ? deprecatedModelFallback
        : undefined;

    const canonical = resolveModelId(resolved);
    if (canonical && canonical !== resolved) {
      logWarn('[Session] Migrating persisted model id to canonical ModelID', {
        sessionId: this.currentSessionId ?? undefined,
        slot: slot.label,
        previousModelId: resolved,
        modelId: canonical,
      });
      migrate(canonical);
    }

    // (0) Migrate persisted Auto Model sessions away when Auto Model is no
    // longer selectable (flag off or every candidate org-blocked).
    if (resolved === INDUSTRY_ROUTER_MODEL_ID && !isIndustryRouterSelectable()) {
      const fallback =
        settingsService.getFirstAllowedModel() ?? getDefaultModelId();
      logWarn(
        '[Session] Loaded session is on Auto Model but Auto Model is not selectable; migrating',
        {
          sessionId: this.currentSessionId ?? undefined,
          slot: slot.label,
          previousModelId: resolved,
          modelId: fallback,
        }
      );
      migrate(fallback);
    }

    // (1) Known-id check. `getTuiModelConfig` already canonicalizes
    // aliases (e.g. `gemini-3-pro-preview` -> `gemini-3.1-pro-preview`)
    // before flagging `isUnknownFallback`, so true-canonical ids never
    // trigger this branch.
    if (getTuiModelConfig(resolved).isUnknownFallback) {
      const fallback =
        settingsService.getFirstAllowedModel() ?? getDefaultModelId();
      logWarn(
        '[Session] Loaded session model is no longer in the registry; migrating',
        {
          sessionId: this.currentSessionId ?? undefined,
          value: slot.label,
          modelId: resolved,
          selectedModel: fallback,
        }
      );
      migrate(fallback);
    }

    // Step (0) already migrated unselectable Auto Model. Anything still on
    // the pseudo-id is an intentional, selectable pick — deprecation
    // and org policy run on the concrete pick at routing time.
    if (resolved === INDUSTRY_ROUTER_MODEL_ID) {
      return;
    }

    // (2) Hard-deprecated models.
    const hardDeprecationResolution = resolveHardDeprecatedModelFallback(
      resolved,
      {
        isCandidateAllowed: (candidate) =>
          settingsService.validateModelAccess(candidate).allowed,
      }
    );
    if (hardDeprecationResolution) {
      if (hardDeprecationResolution.fallbackModelId) {
        logWarn('[Session] Migrating hard-deprecated model on session resume', {
          sessionId: this.currentSessionId ?? undefined,
          value: slot.label,
          modelId: resolved,
          selectedModel: hardDeprecationResolution.fallbackModelId,
        });
        deprecatedModelFallback = hardDeprecationResolution;
        migrate(hardDeprecationResolution.fallbackModelId);
      } else {
        logWarn(
          '[Session] Hard-deprecated model has no allowed fallback on session resume',
          {
            sessionId: this.currentSessionId ?? undefined,
            value: slot.label,
            modelId: resolved,
          }
        );
      }
    }

    // (3) Org policy.
    const access = settingsService.validateModelAccess(resolved);
    if (!access.allowed) {
      const fallback = settingsService.getFirstAllowedModel();
      if (!fallback) {
        logWarn(
          '[Session] Loaded session model blocked by org policy and no allowed fallback exists',
          {
            sessionId: this.currentSessionId ?? undefined,
            value: slot.label,
            modelId: resolved,
            reason: access.reason,
          }
        );
      } else {
        logWarn('[Session] Migrating blocked model on session resume', {
          sessionId: this.currentSessionId ?? undefined,
          value: slot.label,
          modelId: resolved,
          selectedModel: fallback,
          reason: access.reason,
        });
        migrate(fallback);
      }
    }

    // (4) Provider lock — primary slot only.
    if (!slot.enforceProviderLock) return getCurrentDeprecationFallback();
    const providerLock = this.sessionSettings.providerLock;
    if (!providerLock) return getCurrentDeprecationFallback();
    const currentProvider = getTuiModelConfig(resolved).modelProvider;
    if (currentProvider === providerLock)
      return getCurrentDeprecationFallback();

    const providerDefault =
      providerLock === ModelProvider.ANTHROPIC
        ? DEFAULT_ANTHROPIC_MODEL
        : providerLock === ModelProvider.OPENAI
          ? DEFAULT_OPENAI_MODEL
          : null;

    let target: string | null = null;
    if (
      providerDefault &&
      settingsService.validateModelAccess(providerDefault).allowed
    ) {
      target = providerDefault;
    } else {
      // Provider default is unknown or blocked. Pick the first allowed
      // model within the locked provider so we don't blindly call
      // setModel(providerDefault) and throw.
      target = settingsService.getFirstAllowedModel(
        (id) => getTuiModelConfig(id).modelProvider === providerLock
      );
    }

    if (!target) {
      logWarn(
        '[Session] Provider-locked session cannot switch: no allowed model for the locked provider',
        {
          sessionId: this.currentSessionId ?? undefined,
          value: slot.label,
          modelProvider: providerLock,
          modelId: resolved,
          selectedModel: providerDefault ?? undefined,
        }
      );
      return getCurrentDeprecationFallback();
    }

    migrate(target);
    return getCurrentDeprecationFallback();
  }

  // For Auto Model sessions, returns the cached candidate's apiProvider
  // so the engine doesn't fall through to the registry default.
  public getLockedApiProvider(): ApiProvider | null {
    const configured = this.sessionSettings.model;
    if (configured === INDUSTRY_ROUTER_MODEL_ID) {
      const cached = this.sessionSettings.effectiveIndustryRouterModel;
      if (cached) return cached.apiProvider;
    }
    return this.sessionSettings.apiProviderLock ?? null;
  }

  /**
   * Locks the API provider for the current session, only if not already set.
   * Also persists the API provider lock to the session settings file.
   */
  public setLockedApiProviderOnce(apiProvider: ApiProvider): void {
    if (!this.currentSessionId) return;
    if (!this.sessionSettings.apiProviderLock) {
      this.sessionSettings.apiProviderLock = apiProvider;
      this.saveSessionSettings({ async: false, shouldSyncToCloud: true });

      logInfo('[Session] API Provider locked', {
        sessionId: this.currentSessionId!,
        apiProvider,
      });
    }
  }

  /**
   * Updates the locked API provider for the current session when it changed.
   * Use when switching model provider families to ensure routing stays valid.
   */
  public updateLockedApiProvider(apiProvider: ApiProvider): void {
    if (!this.currentSessionId) return;
    if (this.sessionSettings.apiProviderLock === apiProvider) return;

    this.sessionSettings.apiProviderLock = apiProvider;
    this.saveSessionSettings({ async: false, shouldSyncToCloud: true });

    logInfo('[Session] API Provider lock updated', {
      sessionId: this.currentSessionId!,
      apiProvider,
    });
  }

  /**
   * Clears the locked API provider for the current session.
   * Use when switching to custom models that route by their saved settings.
   */
  public clearLockedApiProvider(): void {
    if (!this.currentSessionId) return;
    if (!this.sessionSettings.apiProviderLock) return;

    delete this.sessionSettings.apiProviderLock;
    this.saveSessionSettings({ async: false, shouldSyncToCloud: true });

    logInfo('[Session] API Provider lock cleared', {
      sessionId: this.currentSessionId!,
    });
  }

  public getAssistantActiveTime(): number {
    return this.sessionSettings.assistantActiveTimeMs ?? 0;
  }

  public setAssistantActiveTime(totalMs: number): void {
    if (!this.currentSessionId) return;
    this.sessionSettings.assistantActiveTimeMs = Math.max(0, totalMs);
    this.saveSessionSettings({ async: false, shouldSyncToCloud: true });
  }

  /**
   * Adds token usage from a single streaming operation and persists it.
   * SessionService internally accumulates the totals.
   */
  public addTokenUsage(
    usage: Partial<TokenUsage>,
    isTokenStreaming: boolean
  ): void {
    if (!this.currentSessionId) return;

    const industryCredits =
      usage.industryCredits ?? this.calculateIndustryCreditsForUsage(usage) ?? 0;

    // Track the latest usage components checked by threshold compaction.
    if (usage.inputTokens !== undefined) {
      this.lastCallTokenUsage.inputTokens = usage.inputTokens;
    }
    if (usage.outputTokens !== undefined) {
      this.lastCallTokenUsage.outputTokens = usage.outputTokens;
    }
    if (usage.cacheReadTokens !== undefined) {
      this.lastCallTokenUsage.cacheReadTokens = usage.cacheReadTokens;
    }

    // Accumulate tokens internally
    if (usage.inputTokens !== undefined) {
      this.sessionTokenUsage.inputTokens += usage.inputTokens;
    }
    if (usage.outputTokens !== undefined) {
      this.sessionTokenUsage.outputTokens += usage.outputTokens;
    }
    if (usage.cacheCreationTokens !== undefined) {
      this.sessionTokenUsage.cacheCreationTokens += usage.cacheCreationTokens;
    }
    if (usage.cacheReadTokens !== undefined) {
      this.sessionTokenUsage.cacheReadTokens += usage.cacheReadTokens;
    }
    if (usage.thinkingTokens !== undefined) {
      this.sessionTokenUsage.thinkingTokens += usage.thinkingTokens;
    }
    this.sessionTokenUsage.industryCredits =
      (this.sessionTokenUsage.industryCredits ?? 0) + industryCredits;

    // Persist to settings file (non-blocking for performance)
    this.sessionSettings.tokenUsage = { ...this.sessionTokenUsage };
    this.recomputeInclusiveTokenUsage();
    this.saveSessionSettings({
      async: true,
      shouldSyncToCloud: !isTokenStreaming,
    });
    this.scheduleSessionTokenUsageEmit({ isTokenStreaming });
  }

  private calculateIndustryCreditsForUsage(
    usage: Partial<TokenUsage>
  ): number | null {
    const activeModel =
      this.isSpecMode() && this.hasSpecModeModel()
        ? this.getSpecModeModel()
        : this.getModel();
    const modelId = getTuiModelConfig(activeModel).modelId;
    if (!modelId) {
      return null;
    }

    try {
      return calculateIndustryTokenUsage({
        model: modelId,
        inputTokens: usage.inputTokens ?? 0,
        cacheCreationInputTokens: usage.cacheCreationTokens ?? 0,
        cacheReadInputTokens: usage.cacheReadTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      });
    } catch (error) {
      logWarn('[Session] Failed to calculate Industry credit usage', {
        sessionId: this.currentSessionId ?? undefined,
        modelId,
        cause: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  public applyChildInclusiveTokenUsage(
    childSessionId: string,
    childInclusiveTokenUsage: TokenUsage
  ): void {
    if (!this.currentSessionId || childSessionId === this.currentSessionId) {
      return;
    }

    this.sessionSettings.childInclusiveTokenUsageBySessionId = {
      ...(this.sessionSettings.childInclusiveTokenUsageBySessionId ?? {}),
      [childSessionId]: normalizeTokenUsage(childInclusiveTokenUsage),
    };
    this.recomputeInclusiveTokenUsage();
    this.saveSessionSettings({
      async: true,
      shouldSyncToCloud: false,
    });
    this.scheduleSessionTokenUsageEmit({ isTokenStreaming: false });
  }

  public applyChildInclusiveTokenUsageFromSession(
    childSessionId: string,
    parentSessionId?: string
  ): void {
    const childUsage = this.readSessionInclusiveTokenUsage(childSessionId);
    if (!childUsage) {
      return;
    }

    if (parentSessionId && parentSessionId !== this.currentSessionId) {
      this.applyChildInclusiveTokenUsageToSettingsFile(
        parentSessionId,
        childSessionId,
        childUsage
      );
      return;
    }

    this.applyChildInclusiveTokenUsage(childSessionId, childUsage);
  }

  public readSessionInclusiveTokenUsage(sessionId: string): TokenUsage | null {
    const settingsPath = this.findSessionSettingsPath(sessionId, true);
    if (!settingsPath || !fs.existsSync(settingsPath)) {
      return null;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        tokenUsage?: Partial<TokenUsage>;
        inclusiveTokenUsage?: Partial<TokenUsage>;
      };
      const usage = parsed.inclusiveTokenUsage ?? parsed.tokenUsage;
      return usage ? normalizeTokenUsage(usage) : null;
    } catch {
      return null;
    }
  }

  private applyChildInclusiveTokenUsageToSettingsFile(
    parentSessionId: string,
    childSessionId: string,
    childInclusiveTokenUsage: TokenUsage
  ): void {
    if (parentSessionId === childSessionId) {
      return;
    }

    const settingsPath = this.findSessionSettingsPath(parentSessionId, true);
    if (!settingsPath || !fs.existsSync(settingsPath)) {
      return;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as
        | SessionSettings
        | undefined;
      const settings = parsed ?? {};
      const childUsageBySessionId = {
        ...(settings.childInclusiveTokenUsageBySessionId ?? {}),
        [childSessionId]: normalizeTokenUsage(childInclusiveTokenUsage),
      };
      const inclusiveTokenUsage = addTokenUsageValues([
        normalizeTokenUsage(settings.tokenUsage),
        ...Object.values(childUsageBySessionId),
      ]);
      const nextSettings: SessionSettings = {
        ...settings,
        childInclusiveTokenUsageBySessionId: childUsageBySessionId,
        inclusiveTokenUsage,
      };
      fs.writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2));
      setSecureFilePermissionsSync(settingsPath);
    } catch (error) {
      logException(error, '[Session] Failed to apply child token usage');
    }
  }

  private recomputeInclusiveTokenUsage(): TokenUsage {
    const selfUsage = normalizeTokenUsage(
      this.sessionSettings.tokenUsage ?? this.sessionTokenUsage
    );
    const childUsages = Object.values(
      this.sessionSettings.childInclusiveTokenUsageBySessionId ?? {}
    );
    const inclusiveUsage = addTokenUsageValues([selfUsage, ...childUsages]);
    this.sessionSettings.inclusiveTokenUsage = inclusiveUsage;
    return inclusiveUsage;
  }

  private scheduleSessionTokenUsageEmit(params: {
    isTokenStreaming: boolean;
  }): void {
    if (!this.currentSessionId) {
      return;
    }

    const { isTokenStreaming } = params;
    const sessionId = this.currentSessionId;

    if (this.sessionTokenUsageTimer) {
      if (isTokenStreaming) {
        return;
      }
      clearTimeout(this.sessionTokenUsageTimer);
    }

    const delayMs = isTokenStreaming ? 500 : 0;
    this.sessionTokenUsageTimer = setTimeout(() => {
      void this.emitSessionTokenUsage(sessionId);
    }, delayMs);
  }

  private async emitSessionTokenUsage(sessionId: string): Promise<void> {
    this.sessionTokenUsageTimer = null;

    if (!this.currentSessionId || this.currentSessionId !== sessionId) {
      return;
    }

    const tokenUsage = this.getTokenUsage();
    const inclusiveTokenUsage = this.recomputeInclusiveTokenUsage();
    const tokenUsageJson = JSON.stringify({ tokenUsage, inclusiveTokenUsage });
    if (tokenUsageJson !== this.lastSessionTokenUsageJson) {
      this.lastSessionTokenUsageJson = tokenUsageJson;
      agentEventBus.emit(AgentEvent.ProjectNotification, {
        notification: {
          type: SessionNotificationType.SESSION_TOKEN_USAGE_CHANGED,
          sessionId,
          tokenUsage,
          inclusiveTokenUsage,
          lastCallTokenUsage: { ...this.lastCallTokenUsage },
        },
      });
    }
  }

  /**
   * Gets the current session's token usage.
   */
  public getTokenUsage(): TokenUsage {
    return { ...this.sessionTokenUsage };
  }

  /**
   * Returns the latest provider-reported components used by threshold
   * compaction without accumulating usage from prior model calls.
   */
  public getLastCallTokenUsage(): Pick<
    TokenUsage,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens'
  > {
    return { ...this.lastCallTokenUsage };
  }

  /**
   * Resets token usage to zero.
   */
  private resetTokenUsage(): void {
    this.sessionTokenUsage = createEmptyTokenUsage();
    this.sessionSettings.tokenUsage = { ...this.sessionTokenUsage };
    this.sessionSettings.childInclusiveTokenUsageBySessionId = {};
    this.recomputeInclusiveTokenUsage();
    this.lastCallTokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    };
  }

  private resetSessionTokenUsageEmitter(): void {
    if (this.sessionTokenUsageTimer) {
      clearTimeout(this.sessionTokenUsageTimer);
    }
    this.sessionTokenUsageTimer = null;
    this.lastSessionTokenUsageJson = '';
  }

  /**
   * Converts Anthropic content blocks to Industry-compatible user message contents array.
   */

  /**
   * Appends a message to the current session with optional per-message metadata.
   * If no session exists, creates a new one automatically.
   */
  public async appendMessage(
    message: IndustryDroolMessage,
    meta?: {
      tokens?: number;
      compactionSummaryId?: string;
      /** Request ID for tracking queued messages - passed through to CREATE_MESSAGE notification */
      requestId?: string;
    }
  ): Promise<string> {
    if (!this.currentSessionId) {
      throw new MetaError('Session must exist before calling appendMessage');
    }

    const id = message.id || generateUUID();
    const effectiveUserMessageSource =
      message.userMessageSource ??
      (message.role === MessageRole.Assistant
        ? this.activeUserMessageSource
        : undefined);

    if (message.role === MessageRole.User) {
      this.activeUserMessageSource = message.userMessageSource;
    }

    const messageEvent: DroolMessageEvent = {
      type: 'message',
      id,
      timestamp: new Date().toISOString(),
      message: {
        role:
          message.role === MessageRole.Assistant
            ? MessageRole.Assistant
            : MessageRole.User,
        content: convertDroolMessageContentToLocallyPersistedMessageContent(
          message.content
        ),
        userMessageSource: effectiveUserMessageSource,
        visibility: message.visibility,
        openaiMessageId: message.openaiMessageId,
        openaiPhase: message.openaiPhase,
        openaiEncryptedContent: message.openaiEncryptedContent,
        openaiReasoningId: message.openaiReasoningId,
        openaiReasoningSummary: message.openaiReasoningSummary,
        chatCompletionReasoningField: message.chatCompletionReasoningField,
        chatCompletionReasoningContent: message.chatCompletionReasoningContent,
        isUserVisible: message.isUserVisible,
        modelId: message.modelId,
        routerId: message.routerId,
        reasoningEffort: message.reasoningEffort,
      },
      parentId: this.lastMessageId ?? undefined,
      ...(meta?.tokens !== undefined ? { tokens: meta.tokens } : {}),
      ...(meta?.compactionSummaryId
        ? { compactionSummaryId: meta.compactionSummaryId }
        : {}),
    };

    const sessionPath = this.getSessionMessagesPath(
      this.currentSessionId,
      this.currentSessionStorageCwd
    );
    fs.appendFileSync(sessionPath, `${JSON.stringify(messageEvent)}\n`);

    const parent = this.lastMessageId ?? ROOT_MESSAGE_ID;
    this.lastMessageId = id;

    if (this.cloudSessionSync && !this.isCurrentSessionBtwFork) {
      const remoteMessage: IndustryDroolMessage = {
        ...message,
        id,
        parentId: message.parentId ?? parent,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        ...(effectiveUserMessageSource
          ? { userMessageSource: effectiveUserMessageSource }
          : {}),
      };
      void getCloudSyncService().syncMessage(
        this.currentSessionId,
        remoteMessage
      );
    }

    // Emit to AgentEventBus for subscribers (JsonRpcProtocolAdapter, etc.)
    if (this.currentSessionId) {
      agentEventBus.emit(AgentEvent.MessageCreated, {
        message: {
          ...message,
          id,
          parentId: message.parentId ?? parent,
          ...(effectiveUserMessageSource
            ? { userMessageSource: effectiveUserMessageSource }
            : {}),
        },
        sessionId: this.currentSessionId,
        requestId: meta?.requestId,
      });
    }

    return id;
  }

  /**
   * Persists a compaction summary event to the current session.
   * Returns the generated compactionSummaryId.
   */
  public saveCompactionSummary(args: {
    summaryText: string;
    summaryTokens: number;
    summaryKind?: CompactionSummaryKind;
    anchorMessage?: { id?: string; index?: number };
    removedCount: number;
    timestamp?: string;
    systemInfo?: SystemInfo;
    uiRenderCutoffMessageId?: string;
  }): string {
    if (!this.currentSessionId) {
      throw new MetaError(
        'Session must exist before calling saveCompactionSummary'
      );
    }
    const id = generateUUID();
    const event: CompactionStateEvent = {
      type: 'compaction_state',
      id,
      timestamp: args.timestamp ?? new Date().toISOString(),
      summaryText: args.summaryText,
      summaryTokens: args.summaryTokens,
      summaryKind: args.summaryKind,

      ...(args.anchorMessage ? { anchorMessage: args.anchorMessage } : {}),
      removedCount: args.removedCount,
      systemInfo: args.systemInfo,
      ...(args.uiRenderCutoffMessageId
        ? { uiRenderCutoffMessageId: args.uiRenderCutoffMessageId }
        : {}),
    };
    const sessionPath = this.getSessionMessagesPath(
      this.currentSessionId,
      this.currentSessionStorageCwd
    );
    fs.appendFileSync(sessionPath, `${JSON.stringify(event)}\n`);
    const logPayload: Record<string, unknown> = {
      summaryMessageId: id,
      tokens: args.summaryTokens,
    };
    if (args.summaryKind) {
      logPayload.summaryKind = args.summaryKind;
    }
    if (args.anchorMessage) {
      if (typeof args.anchorMessage.index === 'number') {
        logPayload.index = args.anchorMessage.index;
      }
      if (args.anchorMessage.id) {
        logPayload.anchorMessageId = args.anchorMessage.id;
      }
    }
    logInfo('[Session] Compaction summary saved', logPayload);
    // Note: No remote persistence for compaction events at this time
    return id;
  }

  /**
   * Loads the latest compaction summary event from disk for a session.
   * Returns null if none exists.
   */
  public async loadLatestCompactionSummary(
    sessionId?: string
  ): Promise<CompactionStateEvent | null> {
    const id = sessionId ?? this.currentSessionId;
    if (!id) return null;

    // Find the session file if sessionId is provided, otherwise use current session path
    const sessionPath = sessionId
      ? this.findSessionFile({ sessionId, searchAllProjects: true })
      : this.getSessionMessagesPath(
          this.currentSessionId!,
          this.currentSessionStorageCwd
        );
    if (!sessionPath || !fs.existsSync(sessionPath)) return null;

    let latest: CompactionStateEvent | null = null;
    const fileStream = fs.createReadStream(sessionPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event: DroolSessionEvent = JSON.parse(line);
          if (event.type === 'compaction_state') {
            latest = event as CompactionStateEvent;
          }
        } catch {
          // ignore malformed lines
        }
      }
    } finally {
      // Ensure cleanup of file descriptors
      rl.close();
      fileStream.destroy();
    }

    // SystemInfo may have been generated by an older version of Industry CLI
    // Check compatibility and regenerate if invalid
    if (latest?.systemInfo) {
      if (!isValidSystemInfo(latest.systemInfo)) {
        logInfo(
          '[Session] Incompatible systemInfo detected in compaction summary, regenerating',
          {
            sessionId: id,
          }
        );

        try {
          latest.systemInfo = await getSystemInfo();
        } catch (error) {
          logException(
            error,
            '[Session] Failed to regenerate systemInfo for compaction summary'
          );
          latest.systemInfo = undefined;
        }
      }
    }

    logInfo('[Session] Loaded latest compaction summary', {
      sessionId: id,
      found: !!latest,
    });
    return latest;
  }

  /**
   * Loads the latest LLM-generated compaction summary event from disk for a session.
   *
   * Notes:
   * - Treats missing summaryKind as 'llm_summary' for backward compatibility.
   * - Skips provider-switch serializations (which are not suitable as summarizer previousSummary).
   */
  public async loadLatestLlmCompactionSummary(
    sessionId?: string
  ): Promise<CompactionStateEvent | null> {
    const id = sessionId ?? this.currentSessionId;
    if (!id) return null;

    const sessionPath = sessionId
      ? this.findSessionFile({ sessionId, searchAllProjects: true })
      : this.getSessionMessagesPath(
          this.currentSessionId!,
          this.currentSessionStorageCwd
        );
    if (!sessionPath || !fs.existsSync(sessionPath)) return null;

    let latest: CompactionStateEvent | null = null;
    const fileStream = fs.createReadStream(sessionPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event: DroolSessionEvent = JSON.parse(line);
          if (event.type !== 'compaction_state') continue;
          const compactionEvent = event as CompactionStateEvent;
          const kind =
            compactionEvent.summaryKind ?? CompactionSummaryKind.LlmSummary;
          if (kind === CompactionSummaryKind.LlmSummary) {
            latest = compactionEvent;
          }
        } catch {
          // ignore malformed lines
        }
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }

    if (latest?.systemInfo) {
      if (!isValidSystemInfo(latest.systemInfo)) {
        logInfo(
          '[Session] Incompatible systemInfo detected in LLM compaction summary, regenerating',
          {
            sessionId: id,
          }
        );

        try {
          latest.systemInfo = await getSystemInfo();
        } catch (error) {
          logException(
            error,
            '[Session] Failed to regenerate systemInfo for LLM compaction summary'
          );
          latest.systemInfo = undefined;
        }
      }
    }

    logInfo('[Session] Loaded latest LLM compaction summary', {
      sessionId: id,
      found: !!latest,
    });
    return latest;
  }

  /**
   * Returns all message events from a session file in order.
   */
  public async getAllMessageEvents(
    sessionId?: string
  ): Promise<DroolMessageEvent[]> {
    const id = sessionId ?? this.currentSessionId;
    if (!id) return [];

    // Find the session file if sessionId is provided, otherwise use current session path
    const sessionPath = sessionId
      ? this.findSessionFile({ sessionId, searchAllProjects: true })
      : this.getSessionMessagesPath(
          this.currentSessionId!,
          this.currentSessionStorageCwd
        );
    if (!sessionPath || !fs.existsSync(sessionPath)) return [];

    const events: DroolMessageEvent[] = [];
    const fileStream = fs.createReadStream(sessionPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event: DroolSessionEvent = JSON.parse(line);
          if (event.type === 'message') {
            events.push(event as DroolMessageEvent);
          }
        } catch {
          // ignore malformed lines
        }
      }
    } finally {
      // Ensure cleanup of file descriptors
      rl.close();
      fileStream.destroy();
    }

    logInfo('[Session] getAllMessageEvents', {
      sessionId: id,
      count: events.length,
    });
    return events;
  }

  /**
   * Persists the latest TODO list state for the current session.
   *
   * @param todos - Full TODO list payload (authoritative list)
   * @param messageIndex - Index of the user message after which this list is valid
   */
  public appendTodoState(
    todos: TodoWriteToolParams,
    messageIndex: number
  ): void {
    // Only persist if a session is active – don't implicitly create sessions here.
    if (!this.currentSessionId) {
      return;
    }

    const todoEvent: TodoStateEvent = {
      type: 'todo_state',
      id: generateUUID(),
      timestamp: new Date().toISOString(),
      todos,
      messageIndex,
    };

    try {
      const sessionPath = this.getSessionMessagesPath(
        this.currentSessionId,
        this.currentSessionStorageCwd
      );
      fs.appendFileSync(sessionPath, `${JSON.stringify(todoEvent)}\n`);
      // At the moment we only persist to local JSONL. Remote DB persistence
      // can be added later if needed.
    } catch (error) {
      logException(error, 'Failed to persist TODO state');
    }
  }

  /**
   * Gets the latest TODO state from the current session.
   * Returns null if no TODO state exists.
   */
  public getLatestTodoState(): {
    todos: TodoWriteToolParams;
    messageIndex: number;
  } | null {
    if (!this.currentSessionId) {
      return null;
    }

    const sessionPath = this.getSessionMessagesPath(
      this.currentSessionId,
      this.currentSessionStorageCwd
    );
    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    // Read the file and find the last TODO state event
    let latestTodoState: TodoStateEvent | null = null;

    try {
      const content = fs.readFileSync(sessionPath, 'utf-8');
      const lines = content.trim().split('\n');

      // Process lines in reverse to find the most recent TODO state
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line) {
          try {
            const event: DroolSessionEvent = JSON.parse(line);
            if (event.type === 'todo_state') {
              latestTodoState = event;
              break;
            }
          } catch {
            // Skip invalid lines
          }
        }
      }

      if (latestTodoState) {
        return {
          todos: latestTodoState.todos,
          messageIndex: latestTodoState.messageIndex,
        };
      }
    } catch (error) {
      logException(error, 'Failed to read TODO state from session');
    }

    return null;
  }

  /**
   * Loads a session from disk and sets it as the current active session.
   *
   * @param sessionId - The ID of the session to load
   * @returns A DroolSession containing session metadata and loaded messages
   * @throws {MetaError} If the session file doesn't exist
   * @throws {Error} If the session file is invalid (missing session_start event)
   */
  public async loadSession(
    sessionId: string,
    options: {
      loadAllMessages?: boolean;
      sessionStartSource?: SessionStartSource;
    } = {}
  ): Promise<DroolSession> {
    const sessionStartSource = options.sessionStartSource ?? 'resume';

    // Find the session file across all directories (including other projects)
    const sessionMessagesPath = this.findSessionFile({
      sessionId,
      searchAllProjects: true,
    });
    if (!sessionMessagesPath) {
      throw new SessionNotFoundError({ sessionId });
    }

    const messages: IndustryDroolMessage[] = [];
    let sessionMetadata: SessionSummaryEvent | null = null;

    // Determine the directory where the session file was found
    const sessionDir = path.dirname(sessionMessagesPath);
    const sessionBaseName = path.basename(sessionDir);

    // If the session is in a project directory (starts with -), reconstruct the cwd
    if (sessionBaseName.startsWith('-')) {
      // This is a project-specific session, but we'll get the actual cwd from metadata
      // The directory name is just for organization
    }

    // Read session settings from settings file (in same directory as session file)
    const sessionSettingsPath = path.join(
      sessionDir,
      `${sessionId}.settings.json`
    );
    logInfo('[Session] Loading session settings', {
      sessionId,
      configPath: sessionSettingsPath,
      found: fs.existsSync(sessionSettingsPath),
    });
    if (fs.existsSync(sessionSettingsPath)) {
      try {
        const settingsContent = fs.readFileSync(sessionSettingsPath, 'utf-8');
        this.sessionSettings = JSON.parse(settingsContent) as SessionSettings;
        logInfo('[Session] Settings loaded from file', {
          sessionId,
          inputTokens: this.sessionSettings.tokenUsage?.inputTokens,
          outputTokens: this.sessionSettings.tokenUsage?.outputTokens,
          cachedTokensWritten:
            this.sessionSettings.tokenUsage?.cacheCreationTokens,
          cachedTokensRead: this.sessionSettings.tokenUsage?.cacheReadTokens,
          reasoningTokens: this.sessionSettings.tokenUsage?.thinkingTokens,
        });
      } catch (error) {
        // If settings file is invalid, start with empty settings
        this.sessionSettings = {};
        logInfo('[Session] Invalid settings file, using empty settings', {
          sessionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    } else {
      // No settings file exists
      this.sessionSettings = {};
      logInfo(
        '[Session] No settings file found, using empty session settings',
        {
          sessionId,
        }
      );
    }

    // Backfill any missing settings from global defaults (for older sessions
    // that were created before session-scoped settings existed).
    if (this.sessionSettings.assistantActiveTimeMs === undefined) {
      this.sessionSettings.assistantActiveTimeMs = 0;
    }
    {
      const settingsService = getSettingsService();
      if (this.sessionSettings.model === undefined) {
        this.sessionSettings.model = settingsService.getModel();
      }
      if (this.sessionSettings.reasoningEffort === undefined) {
        this.sessionSettings.reasoningEffort =
          settingsService.getReasoningEffort();
      }
      if (
        this.sessionSettings.interactionMode === undefined ||
        this.sessionSettings.autonomyMode === undefined
      ) {
        // First try to derive from the session's own autonomyMode (older
        // sessions stored autonomyMode but not the decoupled fields).
        // Fall back to global settings only if the session has nothing.
        const sessionAutonomyMode = this.sessionSettings.autonomyMode;
        const resolvedBackfill = sessionAutonomyMode
          ? resolveInteractionSettingsWithLegacyFallback({
              interactionMode: undefined,
              autonomyLevel: undefined,
              autonomyMode: sessionAutonomyMode,
            })
          : resolveInteractionSettingsWithLegacyFallback({
              interactionMode: settingsService.getInteractionMode(),
              autonomyLevel: settingsService.getAutonomyLevel(),
              autonomyMode: settingsService.getAutonomyMode(),
            });
        if (this.sessionSettings.interactionMode === undefined) {
          this.sessionSettings.interactionMode =
            resolvedBackfill.interactionMode ?? DroolInteractionMode.Auto;
        }
        if (this.sessionSettings.autonomyLevel === undefined) {
          this.sessionSettings.autonomyLevel =
            resolvedBackfill.autonomyLevel ?? AutonomyLevel.Off;
        }
        if (this.sessionSettings.autonomyMode === undefined) {
          this.sessionSettings.autonomyMode = deriveAutonomyMode(
            this.sessionSettings.interactionMode,
            this.sessionSettings.autonomyLevel
          );
        }
      }
      if (
        this.sessionSettings.specModeModel === undefined &&
        settingsService.hasSpecModeModel()
      ) {
        this.sessionSettings.specModeModel = settingsService.getSpecModeModel();
        this.sessionSettings.specModeReasoningEffort =
          settingsService.getSpecModeReasoningEffort();
      }
    }

    const hadStaleCompactionModelSnapshot =
      this.sessionSettings.compactionModel !== undefined;
    delete this.sessionSettings.compactionModel;

    // Clamp reasoning efforts to supported values for the model.
    // Persisted settings may contain efforts that are no longer valid
    // (e.g., user had Anthropic model with "Max", then switched to OpenAI).
    if (this.sessionSettings.model && this.sessionSettings.reasoningEffort) {
      this.sessionSettings.reasoningEffort = clampReasoningEffortForModel(
        this.sessionSettings.model,
        this.sessionSettings.reasoningEffort
      );
    }
    if (
      this.sessionSettings.specModeModel &&
      this.sessionSettings.specModeReasoningEffort
    ) {
      this.sessionSettings.specModeReasoningEffort =
        clampReasoningEffortForModel(
          this.sessionSettings.specModeModel,
          this.sessionSettings.specModeReasoningEffort
        );
    }

    // Restore token usage from settings or initialize to zero
    if (this.sessionSettings.tokenUsage) {
      this.sessionTokenUsage = normalizeTokenUsage(
        this.sessionSettings.tokenUsage
      );
      this.sessionSettings.tokenUsage = { ...this.sessionTokenUsage };
      logInfo('[Session] Token usage restored from settings', {
        sessionId,
        inputTokens: this.sessionSettings.tokenUsage?.inputTokens,
        outputTokens: this.sessionSettings.tokenUsage?.outputTokens,
        cachedTokensWritten:
          this.sessionSettings.tokenUsage?.cacheCreationTokens,
        cachedTokensRead: this.sessionSettings.tokenUsage?.cacheReadTokens,
        reasoningTokens: this.sessionSettings.tokenUsage?.thinkingTokens,
      });
    } else {
      this.resetTokenUsage();
      logInfo('[Session] No token usage in settings, initialized to zero', {
        sessionId,
        configPath: this.getSessionSettingsPath(
          sessionId,
          this.currentSessionStorageCwd
        ),
      });
    }
    this.recomputeInclusiveTokenUsage();

    // Backwards compatibility: Set API provider lock for built-in OpenAI sessions without one
    if (
      this.sessionSettings.providerLock === ModelProvider.OPENAI &&
      !this.sessionSettings.apiProviderLock &&
      !this.sessionSettings.model?.startsWith('custom:')
    ) {
      this.sessionSettings.apiProviderLock = ApiProvider.OPENAI;
      this.currentSessionId = sessionId; // Temporarily set to allow saveSessionSettings
      this.saveSessionSettings({ async: false, shouldSyncToCloud: true });
      this.currentSessionId = null;
      logInfo(
        '[Session] Backwards compatibility: Set API provider lock to OPENAI',
        {
          sessionId,
        }
      );
    }

    let wasTruncatedAtCompaction = false;
    let uiRenderCutoffMessageId: string | null = null;
    if (options.loadAllMessages) {
      const { sessionMetadata: parsedMetadata, messages: parsedMessages } =
        await readSessionSummaryAndMessagesFromJsonl({
          sessionPath: sessionMessagesPath,
        });

      sessionMetadata = parsedMetadata;
      messages.push(...parsedMessages);
    } else {
      const {
        sessionMetadata: parsedMetadata,
        messages: parsedMessages,
        latestCompaction,
        wasTruncated,
      } = await readSessionWithCompactionTruncation({
        sessionPath: sessionMessagesPath,
      });

      sessionMetadata = parsedMetadata;
      messages.push(...parsedMessages);
      wasTruncatedAtCompaction = wasTruncated;
      uiRenderCutoffMessageId = getUiRenderCutoffFromCompaction(
        latestCompaction,
        wasTruncatedAtCompaction
      );
    }

    if (!sessionMetadata) {
      throw new MetaError('Invalid session file: missing session_start event');
    }

    const runtimeCwd = getSessionSummaryRuntimeCwd(sessionMetadata);

    // If the session file lives in the btw directory, mark it so writes
    // continue going to the btw dir instead of a project-dir path.
    this.currentSessionInBtwDir = sessionDir === this.getBtwSessionsDirectory();

    this.setActiveSession({
      sessionId,
      cwd: runtimeCwd,
      storageCwd: sessionMetadata.cwd,
      hostId: sessionMetadata.hostId,
      // Fall back to the legacy `title` field for sessions persisted before
      // `sessionTitle` existed so resumes still update the terminal tab.
      title: sessionMetadata.sessionTitle ?? sessionMetadata.title,
    });
    this.lastMessageId =
      messages.length > 0 ? messages[messages.length - 1].id : null;
    this.activeUserMessageSource = undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const userMessageSource = messages[i]?.userMessageSource;
      if (userMessageSource) {
        this.activeUserMessageSource = userMessageSource;
        break;
      }
    }
    this.resetSessionTokenUsageEmitter();
    this.lastSessionTokenUsageJson = JSON.stringify({
      tokenUsage: this.getTokenUsage(),
      inclusiveTokenUsage: this.recomputeInclusiveTokenUsage(),
    });
    this.sessionEndHooksExecuted = false;

    this.migrateDeprecatedMissionMetadataToSessionTags({
      sessionId,
      sessionPath: sessionMessagesPath,
      sessionMetadata,
      messageCount: messages.length,
    });
    const missionTagMetadata = getMissionSessionTagMetadata(
      this.sessionSettings.tags
    );
    this.currentDecompMissionId =
      missionTagMetadata?.missionId ?? sessionMetadata.decompMissionId;
    this.currentDecompSessionType =
      getDecompSessionTypeFromTags(this.sessionSettings.tags) ??
      sessionMetadata.decompSessionType;
    // Resolve the canonical mission id for the ambient telemetry tag. Worker
    // and resumed sessions don't hold it in memory, so read it from the
    // mission state file (fire-and-forget; the getter omits it until ready).
    this.currentMissionStateId = null;
    this.currentMissionStateIdBaseSession = null;
    void this.refreshMissionStateId();

    // Enforce invariant: orchestrator sessions must use Mission interaction mode
    this.ensureOrchestratorModeInvariant(this.currentDecompSessionType);

    // that funnels previously-separate concerns: known-id check
    // (FAC-19594 / FAC-16834 Pattern A), hard deprecation, org model policy,
    // and provider lock.
    await this.migrateSessionModelsOnLoad(messages);

    // Self-heal old session files: persist without the dropped compaction
    // model snapshot so a stale value (possibly an id no longer in the model
    // registry) doesn't linger on disk and in the cloud copy.
    if (hadStaleCompactionModelSnapshot) {
      this.saveSessionSettings({ async: true, shouldSyncToCloud: true });
    }

    // Inform telemetry client of the loaded active session
    CliTelemetryClient.getInstance().setSessionId(sessionId);

    // Notify UI hooks that session settings have been restored
    this.emitSessionSettingsChanged();

    // Execute SessionStart hooks for resumed session
    await this.executeSessionStartHooks(
      sessionStartSource,
      sessionMetadata.parent || undefined,
      sessionMetadata.callingSessionId || undefined
    );

    // Populate PDF content from disk for frontend display
    const messagesWithPdfContent =
      await populateMessagesWithPdfContent(messages);

    // Mark true only for real resumes so startup pre-created sessions do not
    // inherit resume-only first-turn behavior.
    this.wasSessionResumed = sessionStartSource === 'resume';

    return {
      id: sessionMetadata.id,
      title: sessionMetadata.title,
      sessionTitle: sessionMetadata.sessionTitle,
      owner: sessionMetadata.owner,
      messages: messagesWithPdfContent,
      cwd: runtimeCwd,
      ...(sessionMetadata.hostId ? { hostId: sessionMetadata.hostId } : {}),
      ...(sessionMetadata.callingSessionId
        ? { callingSessionId: sessionMetadata.callingSessionId }
        : {}),
      ...(sessionMetadata.callingToolUseId
        ? { callingToolUseId: sessionMetadata.callingToolUseId }
        : {}),
      decompSessionType:
        getDecompSessionTypeFromTags(this.sessionSettings.tags) ??
        sessionMetadata.decompSessionType,
      decompMissionId:
        missionTagMetadata?.missionId ?? sessionMetadata.decompMissionId,
      tokenUsage: this.getTokenUsage(),
      wasTruncatedAtCompaction,
      uiRenderCutoffMessageId,
    };
  }

  /**
   * Get sessions from a specific directory.
   * @param directory - Directory path to search for sessions
   * @param isCurrentProject - Whether this is the current project directory
   * @param onlyFiles - If true, only look for .jsonl files directly in the directory (not subdirectories)
   */
  private async getSessionsFromDirectory(
    directory: string,
    isCurrentProject: boolean = false,
    onlyFiles: boolean = false
  ): Promise<SessionMetadata[]> {
    const sessions: SessionMetadata[] = [];

    if (!fs.existsSync(directory)) {
      return sessions;
    }

    const favoriteIds = this.loadFavoriteSessions();
    const entries = fs.readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
      // Skip subdirectories if onlyFiles is true
      if (onlyFiles && entry.isDirectory()) {
        continue;
      }

      // Skip non-.jsonl files and subdirectories
      if (!entry.name.endsWith('.jsonl')) {
        continue;
      }

      const sessionId = entry.name.replace('.jsonl', '');
      const sessionPath = path.join(directory, entry.name);

      // Check if session is archived via .settings.json
      const settingsPath = path.join(directory, `${sessionId}.settings.json`);
      let settingsTags: SessionTag[] | undefined;
      if (fs.existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(
            fs.readFileSync(settingsPath, 'utf-8')
          ) as { archivedAt?: string; tags?: SessionTag[] };
          if (settings.archivedAt) {
            continue; // Skip archived sessions
          }
          settingsTags = settings.tags;
        } catch {
          // Ignore settings parse errors - treat as not archived
        }
      }

      const stats = fs.statSync(sessionPath);

      try {
        const firstLine = fs.readFileSync(sessionPath, 'utf-8').split('\n')[0];
        if (firstLine) {
          const sessionSummary: SessionSummaryEvent = JSON.parse(firstLine);
          if (sessionSummary.type === 'session_start') {
            const messageCount =
              fs
                .readFileSync(sessionPath, 'utf-8')
                .split('\n')
                .filter((line) => line.trim()).length - 1;

            sessions.push({
              ...(getMissionSessionTagMetadata(settingsTags)?.missionId
                ? {
                    decompMissionId:
                      getMissionSessionTagMetadata(settingsTags)?.missionId,
                  }
                : {}),
              id: sessionId,
              title: sessionSummary.title,
              sessionTitle: sessionSummary.sessionTitle,
              owner: sessionSummary.owner,
              messageCount,
              modifiedTime: stats.mtime,
              createdTime: stats.birthtime || stats.ctime,
              isFavorite: favoriteIds.has(sessionId),
              cwd: getSessionSummaryRuntimeCwd(sessionSummary),
              ...(sessionSummary.hostId
                ? { hostId: sessionSummary.hostId }
                : {}),
              isCurrentProject,
              decompSessionType:
                getDecompSessionTypeFromTags(settingsTags) ??
                sessionSummary.decompSessionType,
            });
          }
        }
      } catch {
        // Skip invalid session files
      }
    }

    return sessions;
  }

  /**
   * Retrieves metadata for all available sessions, sorted by modification time.
   * By default, only returns sessions from the current project directory and global sessions.
   *
   * @param options - Options for filtering sessions
   * @param options.currentCwd - Optional current working directory for project-based filtering
   * @param options.fetchOutsideCWD - If true, includes sessions from other project directories (default: false)
   * @param options.maxOtherSessions - Maximum sessions from other folders (current folder sessions always included)
   * @returns An array of session summaries with metadata and message counts
   */
  public async getAllSessions(options?: {
    currentCwd?: string;
    fetchOutsideCWD?: boolean;
    maxOtherSessions?: number;
  }): Promise<SessionMetadata[]> {
    const {
      currentCwd,
      fetchOutsideCWD = false,
      maxOtherSessions,
    } = options || {};
    const sessions = this.sessionDiscoveryIndex.querySessions({
      currentCwd,
      fetchOutsideCWD,
    });
    return limitAndFilterListedSessions(sessions, maxOtherSessions);
  }

  public async getCachedSessions(options?: {
    currentCwd?: string;
    fetchOutsideCWD?: boolean;
    maxOtherSessions?: number;
  }): Promise<SessionMetadata[]> {
    const {
      currentCwd,
      fetchOutsideCWD = false,
      maxOtherSessions,
    } = options || {};
    const sessions = this.sessionDiscoveryIndex.queryCachedSessions({
      currentCwd,
      fetchOutsideCWD,
    });
    return limitAndFilterListedSessions(sessions, maxOtherSessions);
  }

  public async getAllNonEmptySessions(options?: {
    currentCwd?: string;
    fetchOutsideCWD?: boolean;
    maxOtherSessions?: number;
  }): Promise<SessionMetadata[]> {
    const { maxOtherSessions, ...rest } = options || {};
    const sessions = await this.getAllSessions(rest);
    const nonEmpty = sessions.filter((session) => session.messageCount > 0);

    if (maxOtherSessions === undefined) {
      return nonEmpty;
    }

    const currentProjectSessions = nonEmpty.filter((s) => s.isCurrentProject);
    const otherSessions = nonEmpty
      .filter((s) => !s.isCurrentProject)
      .sort((a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime())
      .slice(0, maxOtherSessions);

    return [...currentProjectSessions, ...otherSessions].sort(
      (a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime()
    );
  }

  public async getCachedNonEmptySessions(options?: {
    currentCwd?: string;
    fetchOutsideCWD?: boolean;
    maxOtherSessions?: number;
  }): Promise<SessionMetadata[]> {
    const { maxOtherSessions, ...rest } = options || {};
    const sessions = await this.getCachedSessions(rest);
    const nonEmpty = sessions.filter((session) => session.messageCount > 0);

    if (maxOtherSessions === undefined) {
      return nonEmpty;
    }

    const currentProjectSessions = nonEmpty.filter((s) => s.isCurrentProject);
    const otherSessions = nonEmpty
      .filter((s) => !s.isCurrentProject)
      .sort((a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime())
      .slice(0, maxOtherSessions);

    return [...currentProjectSessions, ...otherSessions].sort(
      (a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime()
    );
  }

  public async getSessionListPage(options?: {
    currentCwd?: string;
    cursor?: string;
    pageSize?: number;
  }): Promise<{
    sessions: SessionMetadata[];
    nextCursor?: string;
  }> {
    const { currentCwd, cursor, pageSize = 50 } = options || {};
    const allSessions = await this.getAllNonEmptySessions({
      currentCwd,
      fetchOutsideCWD: !currentCwd,
    });

    const filteredSessions = currentCwd
      ? allSessions.filter(
          (session) => session.isCurrentProject && session.cwd === currentCwd
        )
      : allSessions.filter(
          (session) => session.cwd !== undefined && fs.existsSync(session.cwd)
        );

    const startIndex = decodeSessionListOffset(cursor);
    const paginatedSessions = filteredSessions.slice(
      startIndex,
      startIndex + pageSize
    );

    const nextCursor =
      startIndex + pageSize < filteredSessions.length
        ? encodeSessionListOffset(startIndex + pageSize)
        : undefined;

    return {
      sessions: paginatedSessions,
      nextCursor,
    };
  }

  public async getMostRecentResumableSession(
    currentCwd: string
  ): Promise<SessionMetadata | null> {
    const sessions = await this.getAllNonEmptySessions({
      currentCwd,
      fetchOutsideCWD: false,
    });

    return sessions[0] ?? null;
  }

  public getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  public getCurrentSessionCwd(): string | undefined {
    return this.currentSessionCwd;
  }

  public getCurrentSessionHostId(): string | undefined {
    return this.currentSessionHostId;
  }

  public getDecompMissionId(): string | undefined {
    if (this.currentDecompMissionId) {
      return this.currentDecompMissionId;
    }

    const missionTagMetadata = getMissionSessionTagMetadata(
      this.sessionSettings.tags
    );
    if (missionTagMetadata?.missionId) {
      this.currentDecompMissionId = missionTagMetadata.missionId;
      this.currentDecompSessionType = missionTagMetadata.role;
      return missionTagMetadata.missionId;
    }

    const summary = this.getSessionSummary();
    if (
      summary?.decompMissionId ||
      summary?.decompSessionType === DecompSessionType.Orchestrator
    ) {
      this.currentDecompMissionId = summary.decompMissionId ?? summary.id;
      if (summary.decompSessionType) {
        this.currentDecompSessionType = summary.decompSessionType;
      }
      return this.currentDecompMissionId;
    }

    return undefined;
  }

  /**
   * Sync push of the canonical mission id (state.json `mis_…`) from mission
   * code that already holds it (orchestrator run paths). Guarded by
   * baseSessionId so one session's mission id is never attributed to another
   * active session. Surfaced to telemetry via getActiveMissionStateId().
   */
  public setActiveMissionStateId(
    baseSessionId: string,
    missionId: string
  ): void {
    if (this.currentDecompMissionId === baseSessionId) {
      this.currentMissionStateId = missionId;
      this.currentMissionStateIdBaseSession = baseSessionId;
    }
  }

  /**
   * Resolve the canonical mission id from the mission state file for the
   * active mission session. Used by worker / resumed sessions that don't
   * otherwise hold it in memory. Async IO, so callers fire-and-forget; never
   * throws and never runs on the telemetry hot path.
   */
  public async refreshMissionStateId(): Promise<void> {
    const baseSessionId = this.currentDecompMissionId;
    if (!baseSessionId) {
      return;
    }
    try {
      const state = await getMissionFileService(baseSessionId).readState();
      if (this.currentDecompMissionId === baseSessionId && state?.missionId) {
        this.currentMissionStateId = state.missionId;
        this.currentMissionStateIdBaseSession = baseSessionId;
      }
    } catch {
      // Best effort: telemetry simply omits missionId until it resolves.
    }
  }

  /**
   * Side-effect-free read of the canonical mission id (state.json `mis_…`) for
   * the active mission session, used by the telemetry client to ambiently tag
   * every event. Runs on the hot path of every telemetry event, so it never
   * does IO; returns null until a push/refresh has resolved it for the
   * current session.
   */
  public getActiveMissionStateId(): string | null {
    if (
      this.currentDecompMissionId &&
      this.currentMissionStateIdBaseSession === this.currentDecompMissionId
    ) {
      return this.currentMissionStateId;
    }
    return null;
  }

  public getDecompSessionType(): DecompSessionType | undefined {
    if (this.currentDecompSessionType) {
      return this.currentDecompSessionType;
    }

    const decompSessionTypeFromTags = getDecompSessionTypeFromTags(
      this.sessionSettings.tags
    );
    if (decompSessionTypeFromTags) {
      this.currentDecompSessionType = decompSessionTypeFromTags;
      this.currentDecompMissionId = getMissionSessionTagMetadata(
        this.sessionSettings.tags
      )?.missionId;
      return decompSessionTypeFromTags;
    }

    const summary = this.getSessionSummary();
    if (summary?.decompSessionType) {
      this.currentDecompSessionType = summary.decompSessionType;
      this.currentDecompMissionId = summary.decompMissionId;
      return summary.decompSessionType;
    }

    return this.currentDecompSessionType;
  }

  public getCurrentSessionTags(): SessionTag[] | undefined {
    return this.sessionSettings.tags;
  }

  public setCurrentSessionOrigin(origin: SessionOrigin | undefined): void {
    this.currentSessionOrigin = origin;
  }

  public getCurrentSessionOrigin(): SessionOrigin | undefined {
    return this.currentSessionOrigin;
  }

  public getCallingSessionId(sessionId?: string): string | undefined {
    return this.getSessionSummary(sessionId)?.callingSessionId || undefined;
  }

  public getCallingToolUseId(sessionId?: string): string | undefined {
    return this.getSessionSummary(sessionId)?.callingToolUseId || undefined;
  }

  private migrateDeprecatedMissionMetadataToSessionTags(params: {
    sessionId: string;
    sessionPath: string;
    sessionMetadata: SessionSummaryEvent;
    messageCount: number;
  }): void {
    const { sessionId, sessionPath, sessionMetadata, messageCount } = params;
    const rawMissionTag = this.sessionSettings.tags?.find(
      (tag) => tag.name === MISSION_SESSION_TAG
    );
    const rawMissionTagRole = rawMissionTag?.metadata?.role;
    const hasLegacyMissionTagWithoutMissionId =
      rawMissionTag !== undefined &&
      typeof rawMissionTagRole === 'string' &&
      rawMissionTag.metadata?.missionId === undefined;
    const hasDeprecatedMissionMetadata =
      sessionMetadata.decompSessionType !== undefined ||
      sessionMetadata.decompMissionId !== undefined;

    if (!hasDeprecatedMissionMetadata && !hasLegacyMissionTagWithoutMissionId) {
      return;
    }

    const existingMissionTagMetadata = getMissionSessionTagMetadata(
      this.sessionSettings.tags
    );
    const decompSessionType =
      existingMissionTagMetadata?.role ??
      (rawMissionTagRole === DecompSessionType.Orchestrator ||
      rawMissionTagRole === DecompSessionType.Worker
        ? rawMissionTagRole
        : undefined) ??
      sessionMetadata.decompSessionType;
    const decompMissionId =
      existingMissionTagMetadata?.missionId ??
      sessionMetadata.decompMissionId ??
      (decompSessionType === DecompSessionType.Orchestrator
        ? sessionId
        : sessionMetadata.callingSessionId);

    if (!decompSessionType) {
      logWarn(
        '[Session] Unable to migrate deprecated mission metadata without a session type',
        { sessionId }
      );
      return;
    }
    if (!decompMissionId) {
      logWarn(
        '[Session] Unable to migrate deprecated mission metadata without a mission ID',
        { sessionId, decompSessionType }
      );
      return;
    }

    const needsTagBackfill =
      existingMissionTagMetadata?.role !== decompSessionType ||
      existingMissionTagMetadata?.missionId !== decompMissionId;

    if (needsTagBackfill) {
      this.sessionSettings.tags = upsertMissionSessionTag(
        this.sessionSettings.tags,
        {
          role: decompSessionType,
          missionId: decompMissionId,
        }
      );
      this.saveSessionSettings({ async: false, shouldSyncToCloud: true });
    }

    if (!hasDeprecatedMissionMetadata) {
      return;
    }

    this.clearDecompFieldsFromSessionSummary(
      sessionId,
      sessionPath,
      messageCount
    );
  }

  private clearDecompFieldsFromSessionSummary(
    sessionId: string,
    sessionPath: string,
    messageCount: number
  ): void {
    try {
      const content = fs.readFileSync(sessionPath, 'utf-8');
      const lines = content.split('\n');
      if (lines.length === 0 || !lines[0].trim()) {
        throw new MetaError('Invalid session file: missing session summary');
      }
      const summary = JSON.parse(lines[0]) as SessionSummaryEvent;
      if (summary.type !== 'session_start') return;
      delete summary.decompSessionType;
      delete summary.decompMissionId;
      lines[0] = JSON.stringify(summary);
      fs.writeFileSync(sessionPath, lines.join('\n'));
      setSecureFilePermissionsSync(sessionPath);
      this.sessionDiscoveryIndex.noteSessionMutation({
        sessionId,
        sessionPath,
        sessionSummary: summary,
        messageCount,
      });
    } catch (error) {
      logWarn(
        '[Session] Failed to clear decomp metadata from session summary',
        { sessionId, cause: error }
      );
    }
  }

  /**
   * Upgrade the current session to an orchestrator session for Mission mode.
   * This preserves the existing conversation history while enabling Mission mode features.
   *
   * @throws {MetaError} If no active session exists
   */
  public async upgradeToOrchestratorSession(): Promise<void> {
    if (!this.currentSessionId) {
      throw new MetaError('No active session to upgrade to orchestrator');
    }

    // If already an orchestrator session, this is a no-op
    if (
      getMissionSessionTagMetadata(this.sessionSettings.tags)?.role ===
      DecompSessionType.Orchestrator
    ) {
      logInfo('[Session] Session is already an orchestrator session', {
        sessionId: this.currentSessionId,
      });
      return;
    }

    // Update in-memory state first so React re-renders (green highlight, system prompt)
    // happen immediately, without waiting for the daemon to be ready.
    const previousMissionId = this.currentDecompMissionId;
    this.currentDecompSessionType = DecompSessionType.Orchestrator;
    this.currentDecompMissionId = this.currentSessionId;

    const previousTags = this.sessionSettings.tags;
    this.sessionSettings.tags = upsertMissionSessionTag(previousTags, {
      role: DecompSessionType.Orchestrator,
      missionId: this.currentSessionId,
    });

    try {
      this.saveSessionSettings({
        async: false,
        shouldSyncToCloud: true,
        throwOnSyncError: true,
      });

      logInfo('[Session] Upgraded session to orchestrator', {
        sessionId: this.currentSessionId,
      });
    } catch (error) {
      // Revert in-memory state on failure so a stale missionId/type can't leak
      // into the ambient telemetry tag after a failed upgrade.
      this.currentDecompSessionType = undefined;
      this.currentDecompMissionId = previousMissionId;
      this.sessionSettings.tags = previousTags;
      throw error;
    }
  }

  /**
   * Downgrade the current session from an orchestrator session back to a normal session.
   * This preserves the existing conversation history while disabling Mission mode features.
   *
   * @throws {MetaError} If no active session exists
   */
  public async downgradeFromOrchestratorSession(): Promise<void> {
    if (!this.currentSessionId) {
      throw new MetaError('No active session to downgrade from orchestrator');
    }

    // If not an orchestrator session, this is a no-op
    if (this.currentDecompSessionType !== DecompSessionType.Orchestrator) {
      logInfo('[Session] Session is not an orchestrator session', {
        sessionId: this.currentSessionId,
      });
      return;
    }

    // Update in-memory state
    const previousType = this.currentDecompSessionType;
    const previousMissionId = this.currentDecompMissionId;
    const previousTags = this.sessionSettings.tags;
    this.currentDecompSessionType = undefined;
    this.currentDecompMissionId = undefined;

    this.sessionSettings.tags = removeMissionSessionTag(previousTags) ?? [];

    try {
      this.saveSessionSettings({
        async: false,
        shouldSyncToCloud: true,
        throwOnSyncError: true,
      });

      const sessionPath = this.getSessionMessagesPath(
        this.currentSessionId,
        this.currentSessionStorageCwd
      );
      if (sessionPath && fs.existsSync(sessionPath)) {
        const content = fs.readFileSync(sessionPath, 'utf-8');
        const messageCount =
          content.split('\n').filter((line) => line.trim()).length - 1;
        this.clearDecompFieldsFromSessionSummary(
          this.currentSessionId,
          sessionPath,
          messageCount
        );
      }

      logInfo('[Session] Downgraded session from orchestrator', {
        sessionId: this.currentSessionId,
      });
    } catch (error) {
      // Revert in-memory state on failure
      this.currentDecompSessionType = previousType;
      this.currentDecompMissionId = previousMissionId;
      this.sessionSettings.tags = previousTags;
      throw error;
    }
  }

  /**
   * Check if the current session was resumed (loaded from disk) and clear the flag.
   * Used by useAgent to determine if fresh system info should be injected on the first message.
   * The flag is automatically cleared after being checked to ensure it only triggers once.
   */
  public checkAndClearWasSessionResumed(): boolean {
    const wasResumed = this.wasSessionResumed;
    this.wasSessionResumed = false;
    return wasResumed;
  }

  /**
   * Non-destructive read of `wasSessionResumed`. Use
   * {@link checkAndClearWasSessionResumed} when you need the one-shot semantics.
   */
  public isSessionResumed(): boolean {
    return this.wasSessionResumed;
  }

  /**
   * Mark that a full system info refresh is needed on the next LLM turn.
   * Used after changing model context or the working directory mid-session.
   */
  public markSystemInfoRefreshNeeded(): void {
    this.needsSystemInfoRefresh = true;
  }

  /**
   * Check whether a system info refresh was requested and clear the flag.
   */
  public checkAndClearSystemInfoRefreshNeeded(): boolean {
    const needsRefresh = this.needsSystemInfoRefresh;
    this.needsSystemInfoRefresh = false;
    return needsRefresh;
  }

  /**
   * Consume the pending SessionStart hook context.
   * Returns the context string and clears it so it's only injected once.
   * Used by useAgent to inject hook output into the LLM context on the first message.
   */
  public consumePendingSessionStartContext(): string | null {
    const context = this.pendingSessionStartContext;
    this.pendingSessionStartContext = null;
    return context;
  }

  /**
   * Get the transcript path for the current session.
   * Returns the path to the .jsonl file containing the session messages.
   */
  public getSessionTranscriptPath(): string | null {
    if (!this.currentSessionId) {
      return null;
    }
    return this.getSessionMessagesPath(
      this.currentSessionId,
      this.currentSessionStorageCwd
    );
  }

  /**
   * Get the settings file path for the current session.
   * Returns null if no session is active.
   */
  public getCurrentSessionSettingsPath(): string | null {
    if (!this.currentSessionId) {
      return null;
    }
    return this.getSessionSettingsPath(
      this.currentSessionId,
      this.currentSessionStorageCwd
    );
  }

  /**
   * Get the ID of the last message in the current session.
   * Used for determining parent relationships before appending new messages.
   * Note: This is inherently racy in concurrent scenarios but acceptable in practice.
   */
  public getParentMessageId(): string | null {
    return this.lastMessageId;
  }

  /**
   * Checks if a session has any messages (synchronous check).
   * Used to determine if resume command should be shown on exit.
   */
  public sessionHasMessages(sessionId: string): boolean {
    // Try to find the session across all directories (including other projects)
    const sessionPath = this.findSessionFile({
      sessionId,
      searchAllProjects: true,
    });
    if (!sessionPath || !fs.existsSync(sessionPath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(sessionPath, 'utf-8');
      const lines = content.trim().split('\n');
      // More than just the session_start event (first line)
      return lines.length > 1;
    } catch {
      return false;
    }
  }

  /**
   * Returns the parent session id for the given session (or current session), if present.
   */
  public getParentSessionId(sessionId?: string): string | null {
    const id = sessionId ?? this.currentSessionId;
    if (!id) return null;

    // Find the session file if sessionId is provided, otherwise use current session path
    const sessionPath = sessionId
      ? this.findSessionFile({ sessionId })
      : this.getSessionMessagesPath(
          this.currentSessionId!,
          this.currentSessionStorageCwd
        );
    if (!sessionPath || !fs.existsSync(sessionPath)) return null;
    try {
      const firstLine = fs.readFileSync(sessionPath, 'utf-8').split('\n')[0];
      if (!firstLine) return null;
      const summary = JSON.parse(firstLine) as SessionSummaryEvent;
      if (summary.type !== 'session_start') return null;
      return summary.parent ?? null;
    } catch {
      return null;
    }
  }

  public getSessionTitle(sessionId?: string): string | null {
    const id = sessionId ?? this.currentSessionId;
    if (!id) return null;

    // Find the session file if sessionId is provided, otherwise use current session path
    const sessionPath = sessionId
      ? this.findSessionFile({ sessionId })
      : this.getSessionMessagesPath(
          this.currentSessionId!,
          this.currentSessionStorageCwd
        );
    if (!sessionPath || !fs.existsSync(sessionPath)) return null;
    try {
      const firstLine = fs.readFileSync(sessionPath, 'utf-8').split('\n')[0];
      if (!firstLine) return null;
      const summary = JSON.parse(firstLine) as SessionSummaryEvent;
      if (summary.type !== 'session_start') return null;
      return summary.title ?? null;
    } catch {
      return null;
    }
  }

  private getSessionSummary(sessionId?: string): SessionSummaryEvent | null {
    const id = sessionId ?? this.currentSessionId;
    if (!id) return null;

    const sessionPath = sessionId
      ? this.findSessionFile({ sessionId, searchAllProjects: true })
      : this.getSessionMessagesPath(
          this.currentSessionId!,
          this.currentSessionStorageCwd
        );
    if (!sessionPath || !fs.existsSync(sessionPath)) return null;
    try {
      const firstLine = fs.readFileSync(sessionPath, 'utf-8').split('\n')[0];
      if (!firstLine) return null;
      const parsed = SessionSummaryEventSchema.safeParse(JSON.parse(firstLine));
      if (!parsed.success) return null;
      return parsed.data as SessionSummaryEvent;
    } catch {
      return null;
    }
  }

  public getSessionTitleText(sessionId?: string): string | null {
    const summary = this.getSessionSummary(sessionId);
    return summary?.sessionTitle ?? null;
  }

  /**
   * Update the last-used working directory stored in the session summary.
   * This allows resume flows to restore the latest runtime cwd without moving
   * the session transcript to a different storage directory.
   */
  public updateSessionLastCwd(newCwd: string): void {
    if (!this.currentSessionId) {
      return;
    }

    const sessionPath = this.getSessionMessagesPath(
      this.currentSessionId,
      this.currentSessionStorageCwd
    );
    if (!sessionPath || !fs.existsSync(sessionPath)) {
      return;
    }

    try {
      const content = fs.readFileSync(sessionPath, 'utf-8');
      const lines = content.split('\n');
      if (!lines[0]?.trim()) {
        return;
      }

      const summary = JSON.parse(lines[0]) as SessionSummaryEvent;
      if (summary.type !== 'session_start') {
        return;
      }

      if (newCwd === summary.cwd) {
        delete summary.lastCwd;
      } else {
        summary.lastCwd = newCwd;
      }
      lines[0] = JSON.stringify(summary);

      fs.writeFileSync(sessionPath, lines.join('\n'));
      setSecureFilePermissionsSync(sessionPath);
      this.currentSessionCwd = newCwd;
      this.sessionDiscoveryIndex.noteSessionMutation({
        sessionId: this.currentSessionId,
        sessionPath,
        sessionSummary: summary,
        messageCount: Math.max(
          lines.filter((line) => line.trim().length > 0).length - 1,
          0
        ),
        sessionStats: fs.statSync(sessionPath),
      });
    } catch (error) {
      logException(error, 'Failed to update session lastCwd');
    }
  }

  public isSessionTitleManuallySet(sessionId?: string): boolean {
    const summary = this.getSessionSummary(sessionId);
    return summary?.isSessionTitleManuallySet === true;
  }

  public getSessionTitleAutoStage(
    sessionId?: string
  ): SessionTitleAutoStage | null {
    const summary = this.getSessionSummary(sessionId);
    return summary?.sessionTitleAutoStage ?? null;
  }

  public async updateSessionTitle(
    sessionId: string,
    title: string,
    options?: { manual?: boolean; stage?: SessionTitleAutoStage }
  ): Promise<void> {
    const isManual = options?.manual === true;
    const stage = options?.stage;
    const sanitizedTitle = sanitizeSessionTitle(title);

    try {
      const sessionPath =
        this.currentSessionId === sessionId
          ? this.getSessionMessagesPath(
              sessionId,
              this.currentSessionStorageCwd
            )
          : this.findSessionFile({ sessionId, searchAllProjects: true });
      if (!sessionPath || !fs.existsSync(sessionPath)) {
        logWarn(
          '[Session] Cannot update sessionTitle: session file not found',
          {
            sessionId,
          }
        );
        return;
      }

      const fileContent = fs.readFileSync(sessionPath, 'utf-8');
      const lines = fileContent.split('\n');
      if (lines.length === 0 || !lines[0].trim()) {
        throw new MetaError('Invalid session file: missing session summary');
      }

      const sessionSummary: SessionSummaryEvent = JSON.parse(lines[0]);
      if (sessionSummary.type !== 'session_start') {
        throw new MetaError(
          'Invalid session file: first line is not session_start event'
        );
      }

      if (!isManual && sessionSummary.isSessionTitleManuallySet === true) {
        return;
      }

      const existingStage = sessionSummary.sessionTitleAutoStage;
      if (!isManual && stage === 'first_message') {
        if (existingStage === 'first_file_edit') {
          return;
        }
        if (existingStage === 'first_message' && sessionSummary.sessionTitle) {
          return;
        }
      }
      if (!isManual && stage === 'first_file_edit') {
        if (existingStage === 'first_file_edit') {
          return;
        }
      }

      sessionSummary.sessionTitle = sanitizedTitle;
      sessionSummary.isSessionTitleManuallySet = isManual;
      if (stage) {
        sessionSummary.sessionTitleAutoStage = stage;
      }

      lines[0] = JSON.stringify(sessionSummary);

      // For manual renames, preserve the original mtime so the session
      // doesn't jump to the top of the list. Auto-title updates happen
      // during active sessions where mtime should reflect activity.
      const originalStats = isManual ? fs.statSync(sessionPath) : null;

      fs.writeFileSync(sessionPath, lines.join('\n'));
      setSecureFilePermissionsSync(sessionPath);

      if (originalStats) {
        fs.utimesSync(sessionPath, originalStats.atime, originalStats.mtime);
      }

      this.sessionDiscoveryIndex.noteSessionMutation({
        sessionId,
        sessionPath,
        sessionSummary,
        messageCount: Math.max(
          lines.filter((line) => line.trim()).length - 1,
          0
        ),
        sessionStats: originalStats ?? fs.statSync(sessionPath),
      });

      // Only mirror the rename to the terminal tab when the renamed session
      // is the active one. Renaming a different session (e.g. from the session
      // list) must not steal the active tab title.
      if (this.currentSessionId === sessionId) {
        setTerminalTabTitle(sanitizedTitle);
      }

      await this.syncSessionTitleToCloud(sessionId, title);
    } catch (error) {
      logException(error, 'Failed to update session title during rename');
    }
  }

  private syncSessionTitleToCloud(sessionId: string, title: string): void {
    if (!this.cloudSessionSync || this.isCurrentSessionBtwFork) {
      return;
    }

    void getCloudSyncService().syncSessionTitle(
      sessionId,
      sanitizeSessionTitle(title)
    );
  }

  /**
   * Archives a session by setting archivedAt in its .settings.json file.
   * Archived sessions are hidden from the session list but not deleted.
   * Syncs to cloud if cloudSessionSync is enabled.
   */
  public async archiveSession(sessionId: string): Promise<void> {
    const sessionPath = this.findSessionFile({
      sessionId,
      searchAllProjects: true,
    });
    if (!sessionPath) {
      logWarn('[Session] Cannot archive: session file not found', {
        sessionId,
      });
      return;
    }

    const sessionDir = path.dirname(sessionPath);
    const settingsPath = path.join(sessionDir, `${sessionId}.settings.json`);

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      } catch {
        // Start with empty settings if parse fails
      }
    }

    const archivedAt = new Date().toISOString();
    settings.archivedAt = archivedAt;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    setSecureFilePermissionsSync(settingsPath);
    this.sessionDiscoveryIndex.noteSessionSettingsMutation({
      sessionId,
      sessionPath,
    });

    logInfo('[Session] Session archived', { sessionId, timestamp: archivedAt });

    if (this.cloudSessionSync && !this.isCurrentSessionBtwFork) {
      void getCloudSyncService().syncSessionArchive(sessionId);
    }
  }

  /**
   * Unarchives a session by removing archivedAt from its .settings.json file.
   * Syncs to cloud if cloudSessionSync is enabled.
   */
  public async unarchiveSession(sessionId: string): Promise<void> {
    const sessionPath = this.findSessionFile({
      sessionId,
      searchAllProjects: true,
    });
    if (!sessionPath) {
      logWarn('[Session] Cannot unarchive: session file not found', {
        sessionId,
      });
      return;
    }

    const sessionDir = path.dirname(sessionPath);
    const settingsPath = path.join(sessionDir, `${sessionId}.settings.json`);

    if (!fs.existsSync(settingsPath)) {
      return;
    }

    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      return;
    }

    delete settings.archivedAt;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    setSecureFilePermissionsSync(settingsPath);
    this.sessionDiscoveryIndex.noteSessionSettingsMutation({
      sessionId,
      sessionPath,
    });

    logInfo('[Session] Session unarchived', { sessionId });

    if (this.cloudSessionSync && !this.isCurrentSessionBtwFork) {
      void getCloudSyncService().syncSessionUnarchive(sessionId);
    }
  }

  private getSessionMessagesPath(sessionId: string, cwd?: string): string {
    if (this.isCurrentSessionStillInBtwDir(sessionId)) {
      return path.join(this.getBtwSessionsDirectory(), `${sessionId}.jsonl`);
    }
    const directory = this.getSessionsDirectory(cwd);
    return path.join(directory, `${sessionId}.jsonl`);
  }

  private getSessionSettingsPath(sessionId: string, cwd?: string): string {
    if (this.isCurrentSessionStillInBtwDir(sessionId)) {
      return path.join(
        this.getBtwSessionsDirectory(),
        `${sessionId}.settings.json`
      );
    }
    const directory = this.getSessionsDirectory(cwd);
    return path.join(directory, `${sessionId}.settings.json`);
  }

  // The daemon promotes a btw fork by renaming its JSONL/settings out of
  // sessions/btw/ into the project directory while this exec subprocess
  // is still running with `currentSessionInBtwDir = true`. If we trusted
  // the in-memory flag blindly, subsequent appends would re-create a
  // corrupted btw/<id>.jsonl (no session_start header), which then breaks
  // fork/load on the promoted session. Detect the disappearance and
  // clear the flag so writes flow back to the project directory.
  private isCurrentSessionStillInBtwDir(sessionId: string): boolean {
    if (!this.currentSessionInBtwDir || sessionId !== this.currentSessionId) {
      return false;
    }
    const btwPath = path.join(
      this.getBtwSessionsDirectory(),
      `${sessionId}.jsonl`
    );
    if (fs.existsSync(btwPath)) {
      return true;
    }
    this.currentSessionInBtwDir = false;
    return false;
  }

  private emitSessionSettingsChanged(): void {
    agentEventBus.emit(AgentEvent.SettingsUpdated, {
      settings: {
        ...(this.sessionSettings.model !== undefined && {
          modelId: this.sessionSettings.model,
        }),
        ...(this.sessionSettings.reasoningEffort !== undefined && {
          reasoningEffort: this.sessionSettings.reasoningEffort,
        }),
        ...(this.sessionSettings.autonomyMode !== undefined && {
          autonomyMode: this.sessionSettings.autonomyMode,
        }),
        ...(this.sessionSettings.interactionMode !== undefined && {
          interactionMode: this.sessionSettings.interactionMode,
        }),
        ...(this.sessionSettings.autonomyLevel !== undefined && {
          autonomyLevel: this.sessionSettings.autonomyLevel,
        }),
        ...(this.sessionSettings.specModeModel !== undefined && {
          specModeModelId: this.sessionSettings.specModeModel,
        }),
        ...(this.sessionSettings.specModeReasoningEffort !== undefined && {
          specModeReasoningEffort: this.sessionSettings.specModeReasoningEffort,
        }),
        ...(this.sessionSettings.compactionThresholdCheckEnabled !==
          undefined && {
          compactionThresholdCheckEnabled:
            this.sessionSettings.compactionThresholdCheckEnabled,
        }),
      },
      sessionId: this.currentSessionId ?? '',
    });
  }

  private saveSessionSettings(params: {
    async: boolean;
    shouldSyncToCloud: boolean;
    throwOnSyncError?: boolean;
  }): void {
    if (!this.currentSessionId) {
      return;
    }

    const sessionSettingsPath = this.getSessionSettingsPath(
      this.currentSessionId,
      this.currentSessionStorageCwd
    );

    // Preserve daemon-managed fields (`archivedAt`, `tags`) that are written
    // directly to disk by the daemon (e.g. handleArchiveSession). The CLI
    // loads `this.sessionSettings` once at session start and never re-reads
    // it, so a save here would otherwise clobber an archive flag that was
    // set after this session was loaded. Merge from disk so daemon writes
    // survive subsequent CLI-side saves.
    let onDiskSettings: Partial<SessionSettings> | undefined;
    try {
      if (fs.existsSync(sessionSettingsPath)) {
        const raw = fs.readFileSync(sessionSettingsPath, 'utf-8');
        onDiskSettings = JSON.parse(raw) as Partial<SessionSettings>;
      }
    } catch (err) {
      logWarn('[Session] Failed to read on-disk settings before save', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const merged: SessionSettings = { ...this.sessionSettings };
    if (
      onDiskSettings?.archivedAt &&
      this.sessionSettings.archivedAt === undefined
    ) {
      merged.archivedAt = onDiskSettings.archivedAt;
      this.sessionSettings.archivedAt = onDiskSettings.archivedAt;
    }
    if (onDiskSettings?.tags && this.sessionSettings.tags === undefined) {
      merged.tags = onDiskSettings.tags;
      this.sessionSettings.tags = onDiskSettings.tags;
    }
    const content = JSON.stringify(merged, null, 2);

    if (params.async) {
      fs.writeFile(sessionSettingsPath, content, (err) => {
        if (err) {
          logError('[Session] Failed to save session settings (async write)', {
            error: err.message,
          });
        } else {
          void setSecureFilePermissions(sessionSettingsPath).catch((error) => {
            logException(
              error,
              '[Session] Failed to set permissions on settings file'
            );
          });
        }
      });
    } else {
      logInfo('[Session] Saving session settings', {
        sessionId: this.currentSessionId,
        path: sessionSettingsPath,
        inputTokens: this.sessionSettings.tokenUsage?.inputTokens,
        outputTokens: this.sessionSettings.tokenUsage?.outputTokens,
        cachedTokensWritten:
          this.sessionSettings.tokenUsage?.cacheCreationTokens,
        cachedTokensRead: this.sessionSettings.tokenUsage?.cacheReadTokens,
        reasoningTokens: this.sessionSettings.tokenUsage?.thinkingTokens,
      });
      try {
        fs.writeFileSync(sessionSettingsPath, content);
        setSecureFilePermissionsSync(sessionSettingsPath);
      } catch (err) {
        logError('[Session] Failed to save session settings (sync write)', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (params.throwOnSyncError) {
          throw err;
        }
      }
    }

    // Don't trigger cloud sync on every token update during streaming
    if (
      this.cloudSessionSync &&
      params.shouldSyncToCloud &&
      !this.isCurrentSessionBtwFork
    ) {
      void getCloudSyncService().syncSessionSettings(
        this.currentSessionId,
        this.sessionSettings
      );
    }
  }

  /**
   * Execute SessionEnd hooks on session termination
   */
  async executeSessionEndHooks(
    reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other'
  ): Promise<void> {
    if (this.sessionEndHooksExecuted) {
      return;
    }
    if (
      !getHookService().hasMatchingHooks({
        eventName: HookEventName.SessionEnd,
      })
    ) {
      return;
    }
    this.sessionEndHooksExecuted = true;

    try {
      const sessionId = this.currentSessionId;
      if (!sessionId) {
        return; // No active session to end
      }

      // Calculate session duration
      const sessionPath = this.getSessionMessagesPath(
        sessionId,
        this.currentSessionStorageCwd
      );
      if (!fs.existsSync(sessionPath)) {
        return; // Session file doesn't exist
      }

      const sessionStats = fs.statSync(sessionPath);
      const sessionStartTime = sessionStats.birthtimeMs;
      const sessionDurationMs = Date.now() - sessionStartTime;

      // Count messages in the session
      let messageCount = 0;
      try {
        const fileContent = fs.readFileSync(sessionPath, 'utf-8');
        const lines = fileContent.split('\n').filter((line) => line.trim());
        // Count message events (skip session_start and compaction_state events)
        messageCount = lines.filter((line) => {
          try {
            const event = JSON.parse(line);
            return event.type === 'message';
          } catch {
            return false;
          }
        }).length;
      } catch (error) {
        logException(
          error,
          '[Session] Failed to count messages for SessionEnd hook'
        );
      }

      const currentMode = this.getCurrentAutonomyMode();
      const permissionMode = convertAutonomyModeToPermissionMode(currentMode);

      const transcriptPath = this.getSessionMessagesPath(
        sessionId,
        this.currentSessionStorageCwd
      );
      const hookResults = await getHookService().executeHooks({
        eventName: HookEventName.SessionEnd,
        input: {
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: process.cwd(),
          permission_mode: permissionMode,
          hook_event_name: HookEventName.SessionEnd,
          reason,
          session_duration_ms: sessionDurationMs,
          message_count: messageCount,
          message_id: undefined,
        },
      });

      // Log any hook failures
      for (const result of hookResults) {
        if (result.exitCode !== 0) {
          logWarn('[Session] SessionEnd hook failed', {
            exitCode: result.exitCode,
            stderr: result.stderr,
          });
        }
      }
    } catch (error) {
      // Log but don't fail - hooks should never break session termination
      logException(error, '[Session] Error executing SessionEnd hooks');
    }
  }

  /**
   * Execute SessionStart hooks with environment variable support
   */
  private async executeSessionStartHooks(
    source: SessionStartSource,
    previousSessionId?: string,
    callingSessionId?: string
  ): Promise<void> {
    try {
      const currentMode = this.getCurrentAutonomyMode();
      const permissionMode = convertAutonomyModeToPermissionMode(currentMode);

      // Create temporary file for environment variables
      const tempDir = path.join(
        getIndustryHome(),
        getIndustryDirName(),
        'temp',
        'env'
      );
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const envFilePath = path.join(
        tempDir,
        `drool-env-${this.currentSessionId}.sh`
      );

      const transcriptPath = this.currentSessionId
        ? this.getSessionMessagesPath(
            this.currentSessionId,
            this.currentSessionStorageCwd
          )
        : '';
      const hookResults = await getHookService().executeHooks({
        eventName: HookEventName.SessionStart,
        input: {
          session_id: this.currentSessionId || 'unknown',
          transcript_path: transcriptPath,
          cwd: process.cwd(),
          permission_mode: permissionMode,
          hook_event_name: HookEventName.SessionStart,
          source,
          previous_session_id: previousSessionId,
          calling_session_id: callingSessionId,
          CLAUDE_ENV_FILE: envFilePath,
          message_id: undefined,
        },
      });

      // Process hook results and apply environment variables if file was created
      if (fs.existsSync(envFilePath)) {
        try {
          const envContent = fs.readFileSync(envFilePath, 'utf-8');
          // Parse and apply environment variables
          const lines = envContent.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && trimmed.startsWith('export ')) {
              // Extract variable assignment from export statement
              const assignment = trimmed.substring(7).trim();
              const eqIndex = assignment.indexOf('=');
              if (eqIndex > 0) {
                const key = assignment.substring(0, eqIndex);
                let value = assignment.substring(eqIndex + 1);
                // Remove quotes if present
                if (
                  (value.startsWith('"') && value.endsWith('"')) ||
                  (value.startsWith("'") && value.endsWith("'"))
                ) {
                  value = value.substring(1, value.length - 1);
                }
                process.env[key] = value;
                logInfo('[Session] Applied environment variable from hook', {
                  key,
                });
              }
            }
          }
        } catch (error) {
          logException(
            error,
            '[Session] Failed to apply environment variables from hook'
          );
        } finally {
          // Clean up temporary file
          try {
            fs.unlinkSync(envFilePath);
          } catch {
            // Ignore cleanup errors
          }
        }
      }

      // Collect additionalContext or stdout from successful hooks for LLM injection
      for (const result of hookResults) {
        if (result.exitCode === 0) {
          // Prefer additionalContext from JSON output (first-match semantics)
          if (
            result.hookSpecificOutput?.additionalContext &&
            !this.pendingSessionStartContext
          ) {
            this.pendingSessionStartContext =
              result.hookSpecificOutput.additionalContext;
            logInfo(
              '[Session] Collected additionalContext from SessionStart hook',
              {
                length: this.pendingSessionStartContext.length,
              }
            );
          }
          // Fallback to raw stdout if no JSON additionalContext
          if (result.stdout?.trim() && !this.pendingSessionStartContext) {
            this.pendingSessionStartContext = result.stdout.trim();
            logInfo('[Session] Collected stdout from SessionStart hook', {
              length: this.pendingSessionStartContext.length,
            });
          }
        }
      }

      // Log any hook failures
      for (const result of hookResults) {
        if (result.exitCode !== 0) {
          logWarn('[Session] SessionStart hook failed', {
            exitCode: result.exitCode,
            stderr: result.stderr,
          });
        }
      }
    } catch (error) {
      // Log but don't fail - hooks should never break session creation
      logException(error, '[Session] Error executing SessionStart hooks');
    }
  }

  // Pinned Sessions Management
  //
  // Pinned state is persisted to the backend API and cached locally in
  // the `.favorites` file for fast synchronous reads and offline fallback.

  private get favoriteSessionsPath(): string {
    return path.join(this.sessionsDir, '.favorites');
  }

  private loadFavoriteSessions(): Set<string> {
    const favoritePath = this.favoriteSessionsPath;
    if (!fs.existsSync(favoritePath)) {
      return new Set();
    }

    try {
      const content = fs.readFileSync(favoritePath, 'utf-8');
      const favoriteIds = JSON.parse(content);

      if (!Array.isArray(favoriteIds)) {
        logError(
          '[Session] Invalid favorite sessions file format - expected array'
        );
        return new Set();
      }

      return new Set(favoriteIds);
    } catch (error) {
      logException(error, 'Failed to load favorite sessions');
      return new Set();
    }
  }

  private saveFavoriteSessions(favoriteIds: Set<string>): void {
    try {
      const favoritePath = this.favoriteSessionsPath;
      const content = JSON.stringify(Array.from(favoriteIds), null, 2);
      fs.writeFileSync(favoritePath, content);
      setSecureFilePermissionsSync(favoritePath);
      this.sessionDiscoveryIndex.noteFavoritesMutation(favoriteIds);
    } catch (error) {
      logException(error, 'Failed to save favorite sessions');
    }
  }

  /**
   * Sync pinned sessions from the backend API into the local cache.
   * On the first call, migrates any local-only `.favorites` entries
   * to the backend, then renames the file to `.favorites.migrated`.
   */
  public async syncPinnedSessions(): Promise<void> {
    try {
      const { fetch } = await import('@industry/drool-core/api/fetch');
      const response = await fetch('/api/sessions/pinned', { method: 'GET' });
      const data = (await response.json()) as { sessionIds: string[] };
      if (!Array.isArray(data.sessionIds)) return;

      const serverIds = new Set(data.sessionIds);
      const failedLocalMigrationIds = new Set<string>();

      // Migrate local-only favorites to the backend (once)
      const migrationMarkerPath = `${this.favoriteSessionsPath}.migrated`;
      if (!fs.existsSync(migrationMarkerPath)) {
        const localIds = this.loadFavoriteSessions();
        const toMigrate = [...localIds].filter((id) => !serverIds.has(id));

        if (toMigrate.length > 0) {
          for (const sessionId of toMigrate) {
            try {
              await fetch(`/api/sessions/${sessionId}/pin`, {
                method: 'POST',
              });
              serverIds.add(sessionId);
            } catch {
              if (
                this.findSessionFile({ sessionId, searchAllProjects: true })
              ) {
                failedLocalMigrationIds.add(sessionId);
              }
            }
          }
          logInfo('[Session] Migrated local favorites to backend API', {
            count: toMigrate.length - failedLocalMigrationIds.size,
            errorCount: failedLocalMigrationIds.size,
          });
        }

        if (failedLocalMigrationIds.size === 0) {
          // Write marker so migration doesn't run again
          try {
            fs.writeFileSync(migrationMarkerPath, '', 'utf-8');
          } catch {
            // Non-fatal
          }
        }
      }

      for (const sessionId of failedLocalMigrationIds) {
        serverIds.add(sessionId);
      }

      // Replace local cache with the authoritative server state, while keeping
      // locally present favorites that could not be migrated yet.
      this.saveFavoriteSessions(serverIds);
    } catch (error) {
      logWarn('[Session] Failed to sync pinned sessions from API', { error });
    }
  }

  private pinSessionViaApi(sessionId: string): void {
    void import('@industry/drool-core/api/fetch').then(({ fetch }) => {
      fetch(`/api/sessions/${sessionId}/pin`, { method: 'POST' }).catch(
        (error: unknown) => {
          logWarn('[Session] Failed to pin session via API', {
            sessionId,
            error,
          });
        }
      );
    });
  }

  private unpinSessionViaApi(sessionId: string): void {
    void import('@industry/drool-core/api/fetch').then(({ fetch }) => {
      fetch(`/api/sessions/${sessionId}/pin`, { method: 'DELETE' }).catch(
        (error: unknown) => {
          logWarn('[Session] Failed to unpin session via API', {
            sessionId,
            error,
          });
        }
      );
    });
  }

  /**
   * Pin a session by its ID.
   */
  public pinSession(sessionId?: string): boolean {
    const targetSessionId = sessionId || this.currentSessionId;
    if (!targetSessionId) {
      return false;
    }

    const favorites = this.loadFavoriteSessions();
    if (favorites.has(targetSessionId)) {
      return false;
    }

    favorites.add(targetSessionId);
    this.saveFavoriteSessions(favorites);
    this.pinSessionViaApi(targetSessionId);
    logInfo('[Session] Session pinned', { sessionId: targetSessionId });
    return true;
  }

  /**
   * @deprecated Use pinSession instead.
   */
  public favoriteSession(sessionId?: string): boolean {
    return this.pinSession(sessionId);
  }

  /**
   * Unpin a session by its ID.
   */
  public unpinSession(sessionId?: string): boolean {
    const targetSessionId = sessionId || this.currentSessionId;
    if (!targetSessionId) {
      return false;
    }

    const favorites = this.loadFavoriteSessions();
    if (!favorites.has(targetSessionId)) {
      return false;
    }

    favorites.delete(targetSessionId);
    this.saveFavoriteSessions(favorites);
    this.unpinSessionViaApi(targetSessionId);
    logInfo('[Session] Session unpinned', { sessionId: targetSessionId });
    return true;
  }

  /**
   * @deprecated Use unpinSession instead.
   */
  public unfavoriteSession(sessionId?: string): boolean {
    return this.unpinSession(sessionId);
  }

  /**
   * Check if a session is pinned.
   */
  public isPinned(sessionId: string): boolean {
    const favorites = this.loadFavoriteSessions();
    return favorites.has(sessionId);
  }

  /**
   * @deprecated Use isPinned instead.
   */
  public isFavorited(sessionId: string): boolean {
    return this.isPinned(sessionId);
  }

  /**
   * Toggle the pinned state of a session.
   * Returns true if session is now pinned, false if unpinned.
   */
  public togglePinSession(sessionId?: string): boolean {
    const targetSessionId = sessionId || this.currentSessionId;
    if (!targetSessionId) {
      throw new MetaError('No session ID provided and no current session');
    }

    if (this.isPinned(targetSessionId)) {
      this.unpinSession(targetSessionId);
      return false;
    }
    this.pinSession(targetSessionId);
    return true;
  }

  /**
   * @deprecated Use togglePinSession instead.
   */
  public toggleFavoriteSession(sessionId?: string): boolean {
    return this.togglePinSession(sessionId);
  }

  /**
   * Get all pinned sessions with metadata.
   * Searches across all project directories since pinned sessions can be from any project.
   */
  public async getPinnedSessions(): Promise<SessionMetadata[]> {
    const favoriteIds = this.loadFavoriteSessions();
    const allSessions = await this.getAllNonEmptySessions({
      currentCwd: process.cwd(),
      fetchOutsideCWD: true,
    });

    return allSessions
      .filter((session) => favoriteIds.has(session.id))
      .map((session) => ({ ...session, isFavorite: true }));
  }

  /**
   * @deprecated Use getPinnedSessions instead.
   */
  public async getFavoriteSessions(): Promise<SessionMetadata[]> {
    return this.getPinnedSessions();
  }

  private static generateTitle(firstMessage?: string): string {
    const cleaned = cleanMessage(firstMessage || '');
    if (!cleaned) {
      try {
        return getI18n().t('common:appMessages.newSession');
      } catch {
        return 'New Session';
      }
    }
    const truncated = cleaned.substring(0, 150);
    return truncated.length < cleaned.length ? `${truncated}...` : truncated;
  }

  private static getCurrentUser(): string {
    try {
      return os.userInfo().username;
    } catch {
      return 'unknown';
    }
  }
}

let sessionServiceInstance: SessionService | null = null;

/**
 * Gets the singleton SessionService instance.
 */
export function getSessionService(): SessionService {
  if (!sessionServiceInstance) {
    sessionServiceInstance = new SessionService();
  }
  return sessionServiceInstance;
}

// Register SessionEnd hook execution on process exit
let sessionEndHookRegistered = false;

function registerSessionEndHook(): void {
  if (sessionEndHookRegistered) {
    return;
  }
  sessionEndHookRegistered = true;

  // Track if we're in the middle of exiting to avoid duplicate hook calls
  let isExiting = false;

  const executeSessionEndHooks = async (reason: ShutdownContext['reason']) => {
    if (isExiting) {
      return;
    }
    isExiting = true;

    try {
      getMissionExecutionWakeLockService().release({ force: true });
      const sessionService = getSessionService();
      await sessionService.executeSessionEndHooks(reason);
    } catch (error) {
      // Log but don't fail - hooks should never prevent exit
      logException(error, '[Session] Error in SessionEnd exit handler');
    }
  };

  const shutdownCoordinator = getShutdownCoordinator();
  shutdownCoordinator.registerHook(
    'session-end',
    async ({ reason }) => {
      await executeSessionEndHooks(reason);
    },
    { priority: SHUTDOWN_HOOK_PRIORITY.SessionEnd }
  );
}

// Register the hooks when SessionService is first instantiated
export function ensureSessionEndHookRegistered(): void {
  registerSessionEndHook();
}

/**
 * Map AutonomyMode to PermissionMode string for hooks.
 */
export function getPermissionModeString(mode: AutonomyMode): PermissionMode {
  switch (mode) {
    case AutonomyMode.Normal:
      return PermissionMode.Off;
    case AutonomyMode.Spec:
      return PermissionMode.Spec;
    case AutonomyMode.AutoLow:
      return PermissionMode.AutoLow;
    case AutonomyMode.AutoMedium:
      return PermissionMode.AutoMedium;
    case AutonomyMode.AutoHigh:
      return PermissionMode.AutoHigh;
    default:
      return PermissionMode.Off;
  }
}
