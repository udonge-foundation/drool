import { SessionLoadState } from '@industry/common/daemon';
import {
  DroolWorkingState,
  SessionNotificationType,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  MessageContentBlockType,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { SessionStateManager } from './SessionStateManager';
import { SessionStore } from './SessionStore';
import { OptimisticSubmitStatus } from '../core/enums';

import type { QueuedUserMessageKind } from './enums';
import type { QueuedUserMessageState, SessionTodoList } from './types';
import type { PendingOptimisticSubmit } from '../core/types';
import type { ToolProgressNotifier } from '../types';
import type { DaemonSessionNotificationParams } from '@industry/common/daemon';
import type {
  ContentBlock,
  IndustryDroolMessage,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

type StateChangeListener = (
  sessionId: string,
  newState: SessionLoadState
) => void;

/** Default maximum number of sessions to keep in memory before eviction. */
const DEFAULT_MAX_CAPACITY = 20;

interface MultiSessionStateManagerOptions {
  onToolProgressUpdate?: ToolProgressNotifier;
  /** Maximum number of sessions to keep in memory. Defaults to 20. */
  maxCapacity?: number;
  /**
   * Bound the initially rendered tail of large transcripts on
   * initializeSession and expand via expandUiMessages(). Defaults to true
   * (the Ink CLI relies on it). Web/desktop pass false to render the full
   * transcript and rely on settled-row memoization instead.
   */
  progressiveUiRender?: boolean;
}

/**
 * Manages multiple SessionStateManager instances, one per session.
 * Routes notifications to the appropriate session based on message/session context.
 *
 * Implements LRU cache eviction to bound memory usage: when the number of sessions
 * exceeds the configured capacity, the least-recently-accessed session is evicted.
 * The currently active/viewed session and sessions in Loading state are never evicted.
 */
export class MultiSessionStateManager {
  private sessions: Map<string, SessionStateManager> = new Map();

  private stateChangeListeners: Set<StateChangeListener> = new Set();

  // Queue notifications that arrive before session is initialized
  // Prevents state drift when notifications arrive during loadSession request
  private pendingNotifications: Map<string, DaemonSessionNotificationParams[]> =
    new Map();

  // Track sessions that were not found (persists across component remounts)
  private notFoundSessions: Set<string> = new Set();

  // Track sessions that have already had their initial prompt sent (persists across remounts)
  private sentInitialPromptSessions: Set<string> = new Set();

  private readonly onToolProgressUpdate?: ToolProgressNotifier;

  private readonly progressiveUiRender: boolean;

  // Store for explicit setting changes made before a concrete session store
  // exists. Daemon-resolved defaults live in defaultSettingsStore.
  private readonly pendingStore: SessionStore;

  // Store for daemon-owned default settings. This is read-only from the
  // client's perspective and is refreshed exclusively from daemon settings RPCs.
  private readonly defaultSettingsStore: SessionStore;

  /**
   * In-flight optimistic submits keyed by externalKey (clientTurnId). The
   * user bubble for each entry lives in its session's optimisticMessages
   * map; this map holds only lifecycle bookkeeping (timeout, callbacks).
   * The externalKey is also passed to the daemon as `addUserMessage`'s
   * `externalRequestId`, so CREATE_MESSAGE notifications confirm by exact
   * id match via confirmOptimisticSubmit.
   */
  private pendingOptimisticSubmits: Map<string, PendingOptimisticSubmit> =
    new Map();

  /**
   * Default error timeout for pending submits. Replays the
   * OptimisticUpdateConfig defaults from before the manager was deleted.
   */
  private readonly OPTIMISTIC_SUBMIT_ERROR_TIMEOUT_MS = 20000;

  // LRU cache eviction state
  private readonly maxCapacity: number;

  private lastAccessTime: Map<string, number> = new Map();

  private accessCounter = 0;

  private activeSessionId: string | null = null;

  constructor(options?: MultiSessionStateManagerOptions) {
    this.onToolProgressUpdate = options?.onToolProgressUpdate;
    this.maxCapacity = options?.maxCapacity ?? DEFAULT_MAX_CAPACITY;
    this.progressiveUiRender = options?.progressiveUiRender ?? true;
    this.pendingStore = new SessionStore({
      sessionId: '__pending__',
      machineId: '',
      onToolProgressUpdate: this.onToolProgressUpdate,
    });
    this.defaultSettingsStore = new SessionStore({
      sessionId: '__defaults__',
      machineId: '',
      onToolProgressUpdate: this.onToolProgressUpdate,
    });
  }

  /**
   * Get the pending store for sessions not yet connected to the daemon.
   * Callers should populate it with resolved defaults on startup / session change.
   */
  getPendingStore(): SessionStore {
    return this.pendingStore;
  }

  /**
   * Get the daemon-owned default settings store.
   */
  getDefaultSettingsStore(): SessionStore {
    return this.defaultSettingsStore;
  }

  /**
   * Validates that a sessionId is not empty or whitespace.
   * @throws Error if sessionId is invalid
   */
  private static validateSessionId(sessionId: string): void {
    if (!sessionId || sessionId.trim() === '') {
      throw new Error(
        `Invalid sessionId: received empty or whitespace-only sessionId`
      );
    }
  }

  /**
   * Update the last-access time for a session, marking it as recently used.
   * Call this when a session is opened or viewed to prevent it from being evicted.
   */
  touchSession(sessionId: string): void {
    MultiSessionStateManager.validateSessionId(sessionId);
    this.accessCounter += 1;
    this.lastAccessTime.set(sessionId, this.accessCounter);
  }

  /**
   * Set the currently active/viewed session ID.
   * The active session is immune to LRU eviction regardless of access time.
   * Pass null to clear the active session.
   */
  setActiveSessionId(sessionId: string | null): void {
    if (sessionId !== null) {
      MultiSessionStateManager.validateSessionId(sessionId);
      this.touchSession(sessionId);
    }
    this.activeSessionId = sessionId;
  }

  /**
   * Evict the least-recently-accessed session if the number of sessions exceeds
   * the configured maximum capacity.
   *
   * Protected sessions (never evicted):
   * - The currently active/viewed session (this.activeSessionId)
   * - Sessions in Loading state
   */
  private evictIfNeeded(): void {
    while (this.sessions.size > this.maxCapacity) {
      const evictionTarget = this.findEvictionTarget();
      if (!evictionTarget) {
        break;
      }

      logInfo('[MultiSessionStateManager] Evicting session (LRU)', {
        sessionId: evictionTarget,
        count: this.sessions.size,
        limit: this.maxCapacity,
      });

      this.removeSession(evictionTarget);
      this.pendingNotifications.delete(evictionTarget);
      this.lastAccessTime.delete(evictionTarget);
    }
  }

  /**
   * Find the least-recently-accessed session that is eligible for eviction.
   * Returns null if no session can be evicted.
   */
  private findEvictionTarget(): string | null {
    let oldestTime = Infinity;
    let oldestSessionId: string | null = null;

    for (const [sessionId, sessionManager] of this.sessions) {
      if (sessionId === this.activeSessionId) {
        continue;
      }

      if (sessionManager.getLoadState() === SessionLoadState.Loading) {
        continue;
      }

      const accessTime = this.lastAccessTime.get(sessionId) ?? 0;
      if (accessTime < oldestTime) {
        oldestTime = accessTime;
        oldestSessionId = sessionId;
      }
    }

    return oldestSessionId;
  }

  /**
   * Subscribe to session load state changes
   */
  subscribeToStateChanges(listener: StateChangeListener): () => void {
    this.stateChangeListeners.add(listener);
    // Return unsubscribe function
    return () => {
      this.stateChangeListeners.delete(listener);
    };
  }

  /**
   * Emit state change to all subscribers
   */
  private emitStateChange(sessionId: string, newState: SessionLoadState): void {
    this.stateChangeListeners.forEach((listener) => {
      try {
        listener(sessionId, newState);
      } catch (error) {
        logWarn('[MultiSessionStateManager] Error in state change listener', {
          error,
        });
      }
    });
  }

  /**
   * Get the loading state of a session.
   */
  getSessionLoadState(sessionId: string): SessionLoadState {
    MultiSessionStateManager.validateSessionId(sessionId);
    // manager is undefined when the session hasn't been registered yet
    // (i.e., before markSessionLoading/initializeSession/loadSession is called)
    const manager = this.sessions.get(sessionId);
    return manager ? manager.getLoadState() : SessionLoadState.NotLoaded;
  }

  /**
   * Get the existing manager for `sessionId` or create a fresh one. Always
   * touches the session so it becomes the most-recently-used.
   */
  private getOrCreateSessionManager(
    sessionId: string,
    machineId: string
  ): { manager: SessionStateManager; isNew: boolean } {
    const isNew = !this.sessions.has(sessionId);
    if (isNew) {
      const store = new SessionStore({
        sessionId,
        machineId,
        onToolProgressUpdate: this.onToolProgressUpdate,
      });
      this.sessions.set(
        sessionId,
        new SessionStateManager(store, {
          progressiveUiRender: this.progressiveUiRender,
        })
      );
    }

    this.touchSession(sessionId);

    return { manager: this.sessions.get(sessionId)!, isNew };
  }

  /**
   * Drain any notifications that arrived for `sessionId` before its session
   * manager was registered, replaying them in arrival order.
   */
  private replayPendingNotifications(
    sessionId: string,
    manager: SessionStateManager,
    phase: 'init' | 'load'
  ): void {
    const queued = this.pendingNotifications.get(sessionId);
    if (!queued || queued.length === 0) return;

    logInfo(
      phase === 'init'
        ? '[MultiSessionStateManager] Replaying queued notifications after init'
        : '[MultiSessionStateManager] Replaying queued notifications after load',
      {
        sessionId,
        count: queued.length,
      }
    );
    queued.forEach((params) => {
      manager.handleNotification(params);
      this.maybeConfirmOptimisticSubmit(params);
    });
    this.pendingNotifications.delete(sessionId);
  }

  /**
   * Register a session for state tracking and mark it as loading.
   * Creates a session entry if it doesn't exist yet.
   * @param sessionId The session ID
   * @param machineId Machine ID, or empty string for optimistic sessions where machine doesn't exist yet
   */
  markSessionLoading(sessionId: string, machineId: string): void {
    MultiSessionStateManager.validateSessionId(sessionId);

    const { manager, isNew } = this.getOrCreateSessionManager(
      sessionId,
      machineId
    );
    const previousState = manager.getLoadState();

    // Do NOT downgrade an already-Loaded session back to Loading. Callers
    // (e.g. the NewSession fast path and Computer pre-init path) defensively
    // invoke markSessionLoading even when a prior pre-init already loaded the
    // session; downgrading here strands the UI in a "Loading" state forever
    // because consumePreInit only sends a user message and never re-runs
    // initializeSession to re-emit Loaded.
    if (previousState !== SessionLoadState.Loaded) {
      manager.setLoadState(SessionLoadState.Loading);

      // Emit state change if it actually changed
      if (previousState !== SessionLoadState.Loading) {
        this.emitStateChange(sessionId, SessionLoadState.Loading);
      }
    }

    // Evict after adding the new session (the new session is in Loading state
    // and therefore protected from immediate eviction)
    if (isNew) {
      this.evictIfNeeded();
    }
  }

  /**
   * Roll a session back to NotLoaded and emit so subscribers re-render.
   * Used by load-failure rollback paths that need to unblock retries
   * without going through markSessionLoading (which would re-emit Loading).
   */
  markSessionNotLoaded(sessionId: string): void {
    MultiSessionStateManager.validateSessionId(sessionId);
    const manager = this.sessions.get(sessionId);
    if (!manager) return;
    const previousState = manager.getLoadState();
    if (previousState === SessionLoadState.NotLoaded) return;
    manager.setLoadState(SessionLoadState.NotLoaded);
    this.emitStateChange(sessionId, SessionLoadState.NotLoaded);
  }

  /**
   * Lazy-create the per-session SessionStateManager when callers need to
   * seed state (e.g. an optimistic submit) before initializeSession or
   * markSessionLoading has run. Emits a state-change event when a new
   * manager is created so hooks subscribed via subscribeToStateChanges
   * attach their per-session store subscriptions — without this they'd
   * never re-render and the optimistic bubble wouldn't appear.
   */
  private ensureSessionManager(
    sessionId: string,
    machineId: string
  ): SessionStateManager {
    MultiSessionStateManager.validateSessionId(sessionId);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const store = new SessionStore({
      sessionId,
      machineId,
      onToolProgressUpdate: this.onToolProgressUpdate,
    });
    const manager = new SessionStateManager(store, {
      progressiveUiRender: this.progressiveUiRender,
    });
    this.sessions.set(sessionId, manager);
    this.touchSession(sessionId);
    this.emitStateChange(sessionId, manager.getLoadState());
    if (this.sessions.size > this.maxCapacity) {
      this.evictIfNeeded();
    }
    return manager;
  }

  /**
   * Seed UI state for a user submit *before* the daemon has confirmed it.
   *
   * Why this lives on MSSM (not in React state):
   * The user bubble and the streaming-placeholder assistant bubble both
   * render off SessionStateManager — same store the post-connection
   * notifications write into. Putting the optimistic stand-ins on the
   * same manager means a single render path handles both phases:
   * pre-confirm we read from optimisticMessages + assistantBubbleId,
   * and when the daemon's CREATE_MESSAGE notification lands, MSSM's
   * notification handler matches it by `externalKey === requestId` and
   * swaps the bubbles for the real messages without any React-side
   * coordination.
   *
   * What this method does:
   *   1. Records `(externalKey → pending entry)` in a cross-session map
   *      so confirmOptimisticSubmit / cancelOptimisticSubmit can find it.
   *   2. Pushes the user message into the session manager's
   *      optimisticMessages map and stamps the assistantBubbleId on it.
   *   3. Arms an error timeout so a submit that the daemon never
   *      acknowledges flips to Error (callers' onError surfaces a toast).
   *   4. Is idempotent on (externalKey, assistantBubbleId): NewSession
   *      seeds the bubble synchronously, then consumePreInit re-registers
   *      for the same turn — we just refresh the timer/callbacks instead
   *      of tearing the bubble down.
   *
   * The externalKey doubles as the addUserMessage `externalRequestId`,
   * which is what makes the requestId-based confirmation match work.
   */
  registerOptimisticSubmit(args: {
    sessionId: string;
    machineId: string;
    externalKey: string;
    userMessage: IndustryDroolMessage;
    assistantBubbleId: string;
    onConfirm?: () => void;
    onError?: (error: Error) => void;
    errorTimeoutMs?: number;
  }): void {
    const {
      sessionId,
      machineId,
      externalKey,
      userMessage,
      assistantBubbleId,
      onConfirm,
      onError,
      errorTimeoutMs,
    } = args;

    const existing = this.pendingOptimisticSubmits.get(externalKey);

    const scheduleErrorTimeout = () =>
      setTimeout(() => {
        const entry = this.pendingOptimisticSubmits.get(externalKey);
        if (!entry) return;
        entry.status = OptimisticSubmitStatus.Error;
        entry.onError?.(
          new MetaError('Optimistic submit timeout - no server confirmation')
        );
      }, errorTimeoutMs ?? this.OPTIMISTIC_SUBMIT_ERROR_TIMEOUT_MS);

    // Idempotent on same key + same assistantBubbleId: a downstream
    // caller (e.g. consumePreInit running after NewSession.submit
    // already seeded the bubble for the same turn) registering again
    // shouldn't tear down the user's already-rendered bubble. Just
    // refresh the timer and overlay callbacks.
    if (existing && existing.assistantBubbleId === assistantBubbleId) {
      if (existing.errorTimeoutId) {
        clearTimeout(existing.errorTimeoutId);
      }
      existing.onConfirm = onConfirm ?? existing.onConfirm;
      existing.onError = onError ?? existing.onError;
      existing.status = OptimisticSubmitStatus.Pending;
      existing.errorTimeoutId = scheduleErrorTimeout();
      return;
    }

    // Different bubble id (or no prior entry): clean up any prior
    // pending entry first so we don't leak a timer or leave a stale
    // bubble pointing at a different assistantBubbleId.
    if (existing) {
      this.cancelOptimisticSubmit(externalKey);
    }

    const manager = this.ensureSessionManager(sessionId, machineId);
    manager.addOptimisticMessage(externalKey, userMessage);
    manager.setOptimisticAssistantBubbleId(assistantBubbleId);

    const errorTimeoutId = scheduleErrorTimeout();

    this.pendingOptimisticSubmits.set(externalKey, {
      externalKey,
      sessionId,
      assistantBubbleId,
      onConfirm,
      onError,
      timestamp: Date.now(),
      status: OptimisticSubmitStatus.Pending,
      errorTimeoutId,
    });
  }

  /**
   * Confirm a pending submit by externalKey (typically the daemon's
   * CREATE_MESSAGE.requestId echo). Removes the user bubble + assistant
   * placeholder from session state and fires onConfirm. No-op if no
   * entry exists for the key.
   */
  confirmOptimisticSubmit(externalKey: string): boolean {
    const pending = this.pendingOptimisticSubmits.get(externalKey);
    if (!pending) return false;
    if (pending.errorTimeoutId) {
      clearTimeout(pending.errorTimeoutId);
    }
    const manager = this.sessions.get(pending.sessionId);
    if (manager) {
      manager.removeOptimisticMessage(externalKey);
      // A confirmed turn is a real, rendered message, so it must never
      // linger in (or later re-enter) the queued panel. The externalKey
      // doubles as the addUserMessage requestId, so clear any queued entry
      // for it and mark it processed. This closes a race where the
      // optimistic submit is confirmed via the text-based reconcile path
      // (which, unlike the CREATE_MESSAGE path, skips this bookkeeping)
      // while a slower addUserMessage RPC still resolves into the queue
      // branch for the same requestId.
      manager.clearQueuedMessage(externalKey);
      manager.markRequestIdProcessed(externalKey);
      if (
        manager.getOptimisticAssistantBubbleId() === pending.assistantBubbleId
      ) {
        manager.clearOptimisticAssistantBubbleId();
      }
    }
    this.pendingOptimisticSubmits.delete(externalKey);
    pending.onConfirm?.();
    return true;
  }

  /**
   * Cancel a pending submit (e.g. user interrupt, onRollback, or
   * loadSession defensive-clear on reconnect). Removes UI state
   * immediately. Does NOT fire onError.
   */
  cancelOptimisticSubmit(externalKey: string): boolean {
    const pending = this.pendingOptimisticSubmits.get(externalKey);
    if (!pending) return false;
    if (pending.errorTimeoutId) {
      clearTimeout(pending.errorTimeoutId);
    }
    const manager = this.sessions.get(pending.sessionId);
    if (manager) {
      manager.removeOptimisticMessage(externalKey);
      if (
        manager.getOptimisticAssistantBubbleId() === pending.assistantBubbleId
      ) {
        manager.clearOptimisticAssistantBubbleId();
      }
    }
    this.pendingOptimisticSubmits.delete(externalKey);
    return true;
  }

  /**
   * Cancel all in-flight submits for a given session (e.g. on session
   * disconnect or load-failure).
   */
  cancelOptimisticSubmitsForSession(sessionId: string): number {
    let count = 0;
    for (const [key, pending] of this.pendingOptimisticSubmits.entries()) {
      if (pending.sessionId === sessionId) {
        this.cancelOptimisticSubmit(key);
        count += 1;
      }
    }
    return count;
  }

  /** Inspect a single pending submit. For tests and diagnostics. */
  getPendingOptimisticSubmit(
    externalKey: string
  ): PendingOptimisticSubmit | null {
    return this.pendingOptimisticSubmits.get(externalKey) ?? null;
  }

  /**
   * True if any in-flight optimistic submit exists for this session.
   * Used by handleConnected to skip a phantom `loadSession` against
   * a session that the client itself is about to create via
   * `initializeSession` (otherwise the daemon's "session not found"
   * fires before init has had a chance to run).
   */
  hasPendingOptimisticSubmitForSession(sessionId: string): boolean {
    for (const pending of this.pendingOptimisticSubmits.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Set the machine ID for a session.
   * Used when the machine ID becomes known after markSessionLoading was called without one
   * (e.g., workspace flow after sandbox is created).
   */
  setMachineId(sessionId: string, machineId: string): void {
    MultiSessionStateManager.validateSessionId(sessionId);

    const manager = this.sessions.get(sessionId);
    if (!manager) {
      throw new MetaError(
        `Cannot set machineId: session manager not found. Call markSessionLoading first.`,
        { sessionId }
      );
    }

    if (manager.getMachineId() !== machineId) {
      logInfo('[MultiSessionStateManager] Setting machineId for session', {
        sessionId,
        machineId,
        previousState: manager.getMachineId() ?? '',
      });
      manager.setMachineId(machineId);
      this.emitStateChange(sessionId, manager.getLoadState());
    }
  }

  /**
   * Initialize a new session or update an existing one.
   * Session manager must already exist (created by markSessionLoading).
   */
  initializeSession(sessionId: string, messages: IndustryDroolMessage[]): void {
    MultiSessionStateManager.validateSessionId(sessionId);

    const manager = this.sessions.get(sessionId);
    if (!manager) {
      throw new MetaError(
        `Cannot initialize session: session manager not found. Call markSessionLoading first.`,
        { sessionId }
      );
    }

    this.touchSession(sessionId);

    const previousState = manager.getLoadState();
    manager.initializeSession(sessionId, messages);

    // Emit state change if it actually changed
    if (previousState !== SessionLoadState.Loaded) {
      this.emitStateChange(sessionId, SessionLoadState.Loaded);
    }

    this.replayPendingNotifications(sessionId, manager, 'init');

    // Session transitioned from Loading -> Loaded, making it eligible
    // for eviction. Re-run eviction to drain any capacity overage.
    if (this.sessions.size > this.maxCapacity) {
      this.evictIfNeeded();
    }
  }

  /**
   * Load an existing session.
   * @param machineId The machine ID where this session is running
   */
  loadSession(
    sessionId: string,
    machineId: string,
    messages: IndustryDroolMessage[],
    options?: { cwd?: string | null }
  ): void {
    MultiSessionStateManager.validateSessionId(sessionId);

    const { manager, isNew } = this.getOrCreateSessionManager(
      sessionId,
      machineId
    );
    const previousState = manager.getLoadState();

    // Snapshot the message ids already known to this manager *before* the
    // merge. The reconcile sweep below uses it to tell a newly persisted
    // turn apart from an already-loaded turn that happens to carry the same
    // text.
    const priorMessageIds = new Set(
      manager.getMessages().map((message) => message.id)
    );

    manager.loadSession(sessionId, messages);
    if (options && 'cwd' in options) {
      manager.getStore().setCwd(options.cwd ?? null);
    }

    // Emit state change to Loaded (loadSession sets this internally)
    if (previousState !== SessionLoadState.Loaded) {
      this.emitStateChange(sessionId, SessionLoadState.Loaded);
    }

    // Reconcile pending optimistic submits against the loaded messages.
    // CREATE_MESSAGE notifications can be lost across a WS drop — without
    // this sweep, the optimistic user bubble + assistant placeholder
    // would render alongside the persisted real message until the next
    // reload. Match by user-message text (IndustryDroolMessage carries no
    // externalRequestId we can compare against), restricted to messages
    // that newly appeared in this load.
    this.reconcileOptimisticSubmitsWithLoadedMessages(
      sessionId,
      messages,
      priorMessageIds
    );

    this.replayPendingNotifications(sessionId, manager, 'load');

    // Evict after adding the new session
    if (isNew) {
      this.evictIfNeeded();
    }
  }

  /**
   * Load optimistic messages for a session from local file reads.
   * Creates/updates the session manager with messages but keeps the load state
   * as Loading (not Loaded). This allows the UI to display messages immediately
   * while the daemon loads in the background. The daemon's loadSession will
   * later reconcile and transition to Loaded.
   */
  loadOptimisticMessages(
    sessionId: string,
    machineId: string,
    messages: IndustryDroolMessage[],
    options?: { cwd?: string | null }
  ): void {
    MultiSessionStateManager.validateSessionId(sessionId);

    const { manager, isNew } = this.getOrCreateSessionManager(
      sessionId,
      machineId
    );

    // Race guard: if a daemon-driven load is already in flight or has
    // populated the store, do NOT clobber it with stale local-file content.
    // Without this, an optimistic IPC that resolves while loadSession is
    // mid-stream would clearMessages() and overwrite the partial daemon
    // state. Bail when state is Loading or Loaded; we only apply optimistic
    // content from the cold NotLoaded entry path.
    if (manager.getLoadState() !== SessionLoadState.NotLoaded) {
      return;
    }

    // Set messages on the store without transitioning to Loaded.
    // Rebuild todo state before setSession so its notify already reflects it.
    manager.getStore().clearMessages();
    manager.rebuildTodoStateFromMessages(messages);
    manager.getStore().setSession(sessionId, { messages });
    if (options && 'cwd' in options) {
      manager.getStore().setCwd(options.cwd ?? null);
    }

    // Keep state as Loading -- daemon hasn't connected yet
    manager.setLoadState(SessionLoadState.Loading);
    this.emitStateChange(sessionId, SessionLoadState.Loading);

    // Evict after adding (the new session is in Loading state, protected from eviction)
    if (isNew) {
      this.evictIfNeeded();
    }
  }

  /**
   * Link a child/subagent session to its parent as soon as the Task tool emits
   * the child session id. This gives UI clients a shared optimistic state path
   * before the child session has been fully loaded from the daemon registry.
   */
  registerOptimisticChildSession(params: {
    parentSessionId: string;
    childSessionId: string;
    machineId: string;
    toolUseId?: string;
  }): void {
    const { parentSessionId, childSessionId, machineId, toolUseId } = params;
    MultiSessionStateManager.validateSessionId(parentSessionId);
    MultiSessionStateManager.validateSessionId(childSessionId);

    if (parentSessionId === childSessionId) {
      return;
    }

    const parentCwd =
      this.sessions.get(parentSessionId)?.getStore().getCwd() ?? null;
    const existingManager = this.sessions.get(childSessionId);
    const previousLoadState = existingManager?.getLoadState();
    const previousWorkingState = existingManager?.getDroolWorkingState();
    const manager = this.ensureSessionManager(childSessionId, machineId);
    const store = manager.getStore();

    if (!store.getCallingSessionId()) {
      store.setCallingSessionId(parentSessionId);
    }
    if (toolUseId && !store.getCallingToolUseId()) {
      store.setCallingToolUseId(toolUseId);
    }
    if (parentCwd && !store.getCwd()) {
      store.setCwd(parentCwd);
    }

    const shouldSeedStreaming =
      !existingManager ||
      (previousLoadState !== SessionLoadState.Loaded &&
        previousWorkingState === DroolWorkingState.Idle);

    if (shouldSeedStreaming) {
      manager.startStreaming();
    }
    // Drain child notifications that arrived before the optimistic manager was
    // registered so early tool progress is applied instead of dropped.
    this.replayPendingNotifications(childSessionId, manager, 'load');
  }

  /**
   * Get the SessionStateManager for a specific session.
   */
  getSessionManager(sessionId: string): SessionStateManager | null {
    MultiSessionStateManager.validateSessionId(sessionId);
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Get all session IDs currently being managed.
   */
  getAllSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get messages for a specific session.
   */
  getDisplayMessages(sessionId: string): IndustryDroolMessage[] {
    MultiSessionStateManager.validateSessionId(sessionId);
    const manager = this.sessions.get(sessionId);
    return manager ? manager.getDisplayMessages() : [];
  }

  truncateSessionMessages(sessionId: string, maxMessages: number): void {
    MultiSessionStateManager.validateSessionId(sessionId);
    const manager = this.sessions.get(sessionId);
    if (!manager) {
      return;
    }
    manager.getStore().truncateMessages(maxMessages);
  }

  getCurrentTodos(sessionId: string): SessionTodoList | null {
    MultiSessionStateManager.validateSessionId(sessionId);
    return this.sessions.get(sessionId)?.getCurrentTodos() ?? null;
  }

  /**
   * Remove a session from management.
   */
  removeSession(sessionId: string): void {
    MultiSessionStateManager.validateSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.getStore().clearAll();
    }
    this.cancelOptimisticSubmitsForSession(sessionId);
    this.sessions.delete(sessionId);
    this.lastAccessTime.delete(sessionId);
    this.pendingNotifications.delete(sessionId);
  }

  /**
   * Clear all sessions.
   */
  clear(): void {
    for (const pending of this.pendingOptimisticSubmits.values()) {
      if (pending.errorTimeoutId) {
        clearTimeout(pending.errorTimeoutId);
      }
    }
    this.pendingOptimisticSubmits.clear();
    this.sessions.clear();
    this.lastAccessTime.clear();
  }

  /**
   * Handle notifications and route them to the appropriate session.
   *
   * Queues notifications for sessions that haven't been initialized yet to handle
   * race conditions where notifications arrive before initializeSession/loadSession.
   * Queued notifications are replayed after session initialization.
   */
  handleNotification(params: DaemonSessionNotificationParams): void {
    const { sessionId } = params;

    // Handle invalid sessionId gracefully
    try {
      MultiSessionStateManager.validateSessionId(sessionId);
    } catch (error) {
      logWarn('Invalid sessionId in notification:', { cause: error });
      return;
    }

    const manager = this.sessions.get(sessionId);
    if (!manager) {
      if (
        params.notification.type ===
        SessionNotificationType.DROOL_WORKING_STATE_CHANGED
      ) {
        logInfo(
          '[MultiSessionStateManager] Queueing working state notification without session manager',
          {
            sessionId,
            value: params.notification.newState,
          }
        );
      }

      // Queue notifications for sessions that haven't been initialized yet
      // This prevents state drift when notifications arrive during loadSession request
      // The notifications will be replayed once the session is initialized
      if (!this.pendingNotifications.has(sessionId)) {
        this.pendingNotifications.set(sessionId, []);
      }
      this.pendingNotifications.get(sessionId)!.push(params);
      return;
    }

    // Track state before notification
    const previousState = manager.getLoadState();
    const previousWorkingState =
      params.notification.type ===
      SessionNotificationType.DROOL_WORKING_STATE_CHANGED
        ? manager.getDroolWorkingState()
        : undefined;

    // Delegate all notification handling to the SessionStateManager
    manager.handleNotification(params);

    // Confirm matching pending optimistic submit (if any) on
    // CREATE_MESSAGE — single point of entry for the lifecycle map.
    this.maybeConfirmOptimisticSubmit(params);

    // Check if state changed and emit if it did
    const newState = manager.getLoadState();
    if (previousState !== newState) {
      this.emitStateChange(sessionId, newState);
    }

    if (
      params.notification.type ===
      SessionNotificationType.DROOL_WORKING_STATE_CHANGED
    ) {
      logInfo('[MultiSessionStateManager] Applied working state notification', {
        sessionId,
        value: params.notification.newState,
        previousState: previousWorkingState,
        state: manager.getDroolWorkingState(),
      });
    }
  }

  /**
   * If the notification is a CREATE_MESSAGE carrying a requestId that
   * matches a pending submit, confirm it (clears UI, fires onConfirm).
   * Called from the main handleNotification path and from queued-
   * notification replay sites.
   */
  private maybeConfirmOptimisticSubmit(
    params: DaemonSessionNotificationParams
  ): void {
    if (
      params.notification.type === SessionNotificationType.CREATE_MESSAGE &&
      params.notification.requestId !== undefined
    ) {
      this.confirmOptimisticSubmit(params.notification.requestId);
    }
  }

  /**
   * Reconcile pending optimistic submits with messages returned by
   * loadSession. Covers the case where a CREATE_MESSAGE notification
   * was lost across a WS drop: the daemon already persisted the user
   * message, but MSSM never observed the confirmation, so the
   * optimistic bubble lingers alongside the real one. We match by user
   * message text since IndustryDroolMessage carries no externalRequestId
   * we could compare against.
   *
   * Matching is restricted to user messages that *newly appeared* in this
   * load -- i.e. whose ids were not already present in the manager before
   * the merge (`priorMessageIds`). Text alone cannot distinguish a newly
   * persisted turn from an already-loaded latest turn carrying the same
   * text: in the sequence "history latest = 'hi', user submits another
   * 'hi', loadSession runs before that addUserMessage RPC persists", a
   * text-only match against the old 'hi' would falsely confirm the new
   * submit. Because confirm now also clears the queued entry and marks the
   * requestId processed, that false confirm would suppress the real queued
   * message for the still-in-flight addUserMessage RPC, dropping the turn
   * entirely. A genuinely lost-CREATE_MESSAGE turn was persisted by the
   * daemon with a fresh id, so it shows up in `priorMessageIds`'s
   * complement; an unpersisted resubmit does not. We further restrict to
   * the most recent such message(s) and order by createdAt (daemon-assigned)
   * rather than compare against pending.timestamp (a client clock value),
   * so the match is robust to client/daemon clock skew.
   */
  private reconcileOptimisticSubmitsWithLoadedMessages(
    sessionId: string,
    messages: IndustryDroolMessage[],
    priorMessageIds: ReadonlySet<string>
  ): void {
    const pendingForSession = Array.from(
      this.pendingOptimisticSubmits.values()
    ).filter((entry) => entry.sessionId === sessionId);
    if (pendingForSession.length === 0) return;

    const newUserTexts = new Set<string>();
    const newUserMessages = messages
      .filter(
        (message) =>
          message.role === MessageRole.User && !priorMessageIds.has(message.id)
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const message of newUserMessages.slice(-pendingForSession.length)) {
      const text = MultiSessionStateManager.extractUserText(message);
      if (text) newUserTexts.add(text);
    }
    if (newUserTexts.size === 0) return;

    for (const entry of pendingForSession) {
      const optimistic = this.sessions
        .get(sessionId)
        ?.getOptimisticMessage(entry.externalKey);
      if (!optimistic) continue;
      const optimisticText =
        MultiSessionStateManager.extractUserText(optimistic);
      if (!optimisticText) continue;
      if (newUserTexts.has(optimisticText)) {
        this.confirmOptimisticSubmit(entry.externalKey);
      }
    }
  }

  private static extractUserText(message: IndustryDroolMessage): string {
    return message.content
      .filter(
        (block): block is Extract<ContentBlock, { type: 'text' }> =>
          block.type === MessageContentBlockType.Text
      )
      .map((block) => block.text)
      .join('');
  }

  /**
   * Queue a user message for display while waiting for backend response
   */
  queueUserMessage(params: {
    sessionId: string;
    requestId: string;
    content: ContentBlock[];
    kind?: QueuedUserMessageKind;
    createdAt?: number;
  }): void {
    const { sessionId, requestId, content, kind, createdAt } = params;
    MultiSessionStateManager.validateSessionId(sessionId);
    const manager = this.sessions.get(sessionId);
    if (manager) {
      manager.queueUserMessage(requestId, content, kind, createdAt);
    }
  }

  queueUserMessages(params: {
    sessionId: string;
    messages: QueuedUserMessageState[];
  }): void {
    const { sessionId, messages } = params;
    MultiSessionStateManager.validateSessionId(sessionId);
    const manager = this.sessions.get(sessionId);
    if (manager) {
      manager.queueUserMessages(messages);
    }
  }

  /**
   * Clear a specific queued message by requestId
   */
  clearQueuedMessage(sessionId: string, requestId: string): void {
    MultiSessionStateManager.validateSessionId(sessionId);
    const manager = this.sessions.get(sessionId);
    if (manager) {
      manager.clearQueuedMessage(requestId);
    }
  }

  /**
   * Get queued messages for a specific session
   */
  getQueuedMessages(sessionId: string): QueuedUserMessageState[] {
    MultiSessionStateManager.validateSessionId(sessionId);
    const manager = this.sessions.get(sessionId);
    return manager ? manager.getQueuedMessages() : [];
  }

  getQueuedMessage(
    sessionId: string,
    requestId: string
  ): QueuedUserMessageState | null {
    MultiSessionStateManager.validateSessionId(sessionId);
    const manager = this.sessions.get(sessionId);
    return manager?.getQueuedMessage(requestId) ?? null;
  }

  /**
   * Clear queues for all sessions (called on disconnect)
   */
  clearAllQueues(): void {
    this.sessions.forEach((manager) => {
      manager.clearQueuedMessages();
    });
  }

  getSessionStateManager(sessionId: string): SessionStateManager | null {
    MultiSessionStateManager.validateSessionId(sessionId);
    const manager = this.sessions.get(sessionId);
    return manager || null;
  }

  /**
   * Mark a session as not found (persists across component remounts)
   * Note: Emitting notification is handled by the caller (e.g., ActiveSession)
   * via DroolEvent.SessionNotFound
   */
  markSessionNotFound(sessionId: string): void {
    MultiSessionStateManager.validateSessionId(sessionId);
    this.notFoundSessions.add(sessionId);
    // Also remove from sessions map since it doesn't exist
    this.removeSession(sessionId);
  }

  /**
   * Check if a session was marked as not found
   */
  isSessionNotFound(sessionId: string): boolean {
    MultiSessionStateManager.validateSessionId(sessionId);
    return this.notFoundSessions.has(sessionId);
  }

  /**
   * Clear not found status for a session (e.g., after user creates a new session with same ID)
   */
  clearSessionNotFound(sessionId: string): void {
    MultiSessionStateManager.validateSessionId(sessionId);
    this.notFoundSessions.delete(sessionId);
  }

  /**
   * Mark that initial prompt has been sent for a session
   */
  markInitialPromptSent(sessionId: string): void {
    MultiSessionStateManager.validateSessionId(sessionId);
    this.sentInitialPromptSessions.add(sessionId);
  }

  /**
   * Check if initial prompt has already been sent for a session
   */
  hasInitialPromptBeenSent(sessionId: string): boolean {
    MultiSessionStateManager.validateSessionId(sessionId);
    return this.sentInitialPromptSessions.has(sessionId);
  }
}
