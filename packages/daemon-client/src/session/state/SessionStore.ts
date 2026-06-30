import {
  AgentTurnCompletionReason,
  McpStatus,
  type DecompSessionType,
  type AvailableModelConfig,
  type LoadSessionResult,
  type McpServerStatusInfo,
  type SessionTokenUsageChangedNotification,
  type ToolStreamingUpdate,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logInfo } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { orderMessagesByParentChain } from '@industry/utils/messages';
import { areToolStreamingUpdatesEqual } from '@industry/utils/session';

import { SessionNotInitializedError } from '../errors';

import type {
  HookExecutionData,
  IToolProgressStore,
  Session,
  TerminalMetadata,
  ToolProgressNotifier,
} from '../types';
import type { TokenUsage } from '@industry/common/session/settings';
import type { MissionModelSettings } from '@industry/common/settings';
import type { SessionTag } from '@industry/drool-sdk-ext/protocol/session';
import type {
  IndustryDroolMessage,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import type {
  AutonomyLevel,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';

interface SessionStoreParams {
  sessionId: string;
  /** Machine ID where this session runs, or empty string for optimistic sessions before machine exists. */
  machineId: string;
  /**
   * Optional callback to notify UI about tool progress updates.
   * Replaces direct import of notifyToolProgressUpdate from @industry/component-library.
   * If not provided, tool progress notifications are silently skipped.
   */
  onToolProgressUpdate?: ToolProgressNotifier;
}

interface AddToolExecutionUpdateParams {
  toolUseId: string;
  update: ToolStreamingUpdate;
}

type LoopState = NonNullable<LoadSessionResult['loopState']>;

/**
 * SessionStore provides primitive CRUD operations for session state.
 * This is the storage layer that maintains the raw data.
 * Complex business logic should be handled by SessionStateManager.
 *
 * SessionStore is immutable in terms of sessionId. machineId may be set later
 * for sessions created optimistically before the machine exists.
 */
export class SessionStore implements IToolProgressStore {
  private readonly sessionId: string;

  private machineId: string;

  private messages: Map<string, IndustryDroolMessage> = new Map();

  private terminals: Map<string, TerminalMetadata> = new Map();

  private activeTerminalId: string | null = null;

  private messageOrder: string[] = [];

  private sessionMetadata: Map<string, unknown> = new Map();

  private modelId: string | null = null;

  private reasoningEffort: string | null = null;

  private interactionMode: DroolInteractionMode | null = null;

  private autonomyLevel: AutonomyLevel | null = null;

  private specModeModelId: string | null = null;

  private specModeReasoningEffort: string | null = null;

  private missionSettings: MissionModelSettings | null = null;

  private compactionThresholdCheckEnabled: boolean | null = null;

  private cwd: string | null = null;

  private title: string | null = null;

  private availableModels: AvailableModelConfig[] | null = null;

  private mcpServers: McpServerStatusInfo[] = [];

  private mcpStatus: McpStatus = McpStatus.NotInitialized;

  private lastCallTokenUsage: NonNullable<
    SessionTokenUsageChangedNotification['lastCallTokenUsage']
  > | null = null;

  private tokenUsage: TokenUsage | null = null;

  private decompSessionType: DecompSessionType | null = null;

  private callingSessionId: string | null = null;

  private tags: SessionTag[] | null = null;

  private callingToolUseId: string | null = null;

  private agentTurnCompletionReason: AgentTurnCompletionReason | null = null;

  private loopState: LoopState | null = null;

  // ============ UI Render State ============

  private uiRenderCutoffMessageId: string | null = null;

  // ============ Tool Progress Fields ============

  private toolProgressUpdates: Map<string, ToolStreamingUpdate[]> = new Map();

  private toolProgressCleanupTimers: Map<
    string,
    ReturnType<typeof setTimeout>
  > = new Map();

  private static readonly TOOL_PROGRESS_CLEANUP_DELAY_MS = 60_000;

  private static readonly EMPTY_TOOL_UPDATES: ToolStreamingUpdate[] = [];

  private readonly onToolProgressUpdate?: ToolProgressNotifier;

  private hookExecutions: Map<string, HookExecutionData> = new Map();

  private listeners: Set<() => void> = new Set();

  private streamingListeners: Set<() => void> = new Set();

  private version = 0;

  private messagesVersion = 0;

  // Set by silent message mutations (streaming deltas). Folded into
  // messagesVersion on the next notify so coarse-cadence consumers (Ink CLI)
  // keep a stable snapshot identity between notifications, matching the
  // pre-messagesVersion behavior of the general version counter.
  private hasPendingSilentMessageChanges = false;

  private streamingVersion = 0;

  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  private pendingNotify = false;

  private streamingNotifyTimer: ReturnType<typeof setTimeout> | null = null;

  private streamingNotifyFrame: number | null = null;

  private pendingStreamingNotify = false;

  private static readonly NOTIFY_THROTTLE_MS = 50;

  private static readonly STREAMING_NOTIFY_FALLBACK_MS = 16;

  constructor({
    sessionId,
    machineId,
    onToolProgressUpdate,
  }: SessionStoreParams) {
    this.sessionId = sessionId;
    this.machineId = machineId;
    this.onToolProgressUpdate = onToolProgressUpdate;
  }

  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   * Listener callbacks are throttled (fired at most once per NOTIFY_THROTTLE_MS)
   * to avoid excessive re-renders during high-frequency events.
   *
   * NOTE: useSyncExternalStore expects subscribe to fire on every change.
   * Throttling technically violates this contract, but correctness is
   * maintained because the version counter increments synchronously in
   * notify(), so getSnapshot() always returns fresh data when React reads
   * it. The only effect is up to NOTIFY_THROTTLE_MS of visual delay, which
   * is acceptable for Ink's synchronous renderer.
   */
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Subscribe to high-frequency assistant text/thinking streaming changes.
   * These listeners are intentionally separate from the default subscriber set
   * so consumers that cannot handle chunk-level updates (notably Ink CLI) can
   * keep the coarser store notification cadence.
   */
  subscribeToStreamingChanges(callback: () => void): () => void {
    this.streamingListeners.add(callback);
    return () => {
      this.streamingListeners.delete(callback);
    };
  }

  /**
   * Notify subscribers of a state change. Increments the version counter
   * immediately (so getSnapshot sees fresh data) but throttles listener
   * callbacks to fire at most once per NOTIFY_THROTTLE_MS.
   */
  notify(): void {
    if (this.hasPendingSilentMessageChanges) {
      this.hasPendingSilentMessageChanges = false;
      this.messagesVersion++;
    }
    this.version++;
    if (this.throttleTimer !== null) {
      this.pendingNotify = true;
      return;
    }
    for (const cb of this.listeners) {
      cb();
    }
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      if (this.pendingNotify) {
        this.pendingNotify = false;
        for (const cb of this.listeners) {
          cb();
        }
      }
    }, SessionStore.NOTIFY_THROTTLE_MS);
  }

  /**
   * Flush any pending throttle and notify listeners synchronously.
   * Clears the throttle timer, increments the version, and fires all
   * listener callbacks immediately. Used at state transitions (e.g.
   * working state changes) to ensure subscribers see the latest content
   * and state in a single synchronous pass.
   */
  flushNotify(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
      this.pendingNotify = false;
    }
    if (this.hasPendingSilentMessageChanges) {
      this.hasPendingSilentMessageChanges = false;
      this.messagesVersion++;
    }
    this.version++;
    for (const cb of this.listeners) {
      cb();
    }
  }

  /**
   * Get the version number. Incremented on every state mutation.
   * Used by useSyncExternalStore hooks for snapshot memoization — if the
   * version hasn't changed, the cached snapshot can be returned directly,
   * avoiding expensive element-wise comparisons.
   */
  getVersion(): number {
    return this.version;
  }

  /**
   * Get the message-content version. Incremented only when the message list
   * (or the optimistic overlay merged into it) actually changes, so message
   * snapshot hooks can keep returning a stable array across unrelated store
   * mutations (terminal buffers, token usage, MCP status, working state).
   */
  getMessagesVersion(): number {
    return this.messagesVersion;
  }

  /**
   * Notify subscribers of a change that affects derived message snapshots
   * but lives outside this store's message map (e.g. the state manager's
   * optimistic message overlay).
   */
  notifyMessagesChanged(): void {
    this.messagesVersion++;
    this.notify();
  }

  /**
   * Get the chunk-level streaming version. Incremented only for assistant
   * text/thinking deltas so opt-in snapshot hooks can invalidate their cache
   * without waking normal store subscribers.
   */
  getStreamingVersion(): number {
    return this.streamingVersion;
  }

  /**
   * Notify subscribers that opted in to chunk-level assistant text/thinking
   * updates. This does not notify regular store listeners.
   *
   * Listener callbacks are coalesced to at most one per animation frame
   * (16ms timer fallback) while every delta still lands in store state and
   * bumps streamingVersion immediately. This is the only transcript-wide
   * invalidation cadence: it bounds how often consumers rebuild snapshots
   * and re-derive the transcript. The separate markdown smoothing layer
   * (component-library useSmoothedText) is a per-row reveal animation whose
   * rAF loop re-renders only the live text leaf, so the two schedulers
   * compose rather than stack redundant transcript renders.
   */
  notifyStreamingChange(): void {
    this.streamingVersion++;
    this.pendingStreamingNotify = true;
    this.scheduleStreamingNotify();
  }

  /**
   * Flush pending chunk-level streaming subscribers immediately. Used when a
   * completion or state transition should show the latest accumulated stream
   * without waiting for the next presentation cadence.
   */
  flushStreamingChanges(): void {
    if (
      !this.pendingStreamingNotify &&
      this.streamingNotifyTimer === null &&
      this.streamingNotifyFrame === null
    ) {
      return;
    }

    this.clearStreamingNotifySchedule();
    this.pendingStreamingNotify = false;
    this.notifyStreamingListeners();
  }

  private scheduleStreamingNotify(): void {
    if (
      this.streamingNotifyTimer !== null ||
      this.streamingNotifyFrame !== null
    ) {
      return;
    }

    const notify = () => {
      this.streamingNotifyTimer = null;
      this.streamingNotifyFrame = null;
      if (!this.pendingStreamingNotify) return;
      this.pendingStreamingNotify = false;
      this.notifyStreamingListeners();
    };

    if (typeof globalThis.requestAnimationFrame === 'function') {
      this.streamingNotifyFrame = globalThis.requestAnimationFrame(notify);
      return;
    }

    this.streamingNotifyTimer = setTimeout(
      notify,
      SessionStore.STREAMING_NOTIFY_FALLBACK_MS
    );
  }

  private notifyStreamingListeners(): void {
    for (const cb of this.streamingListeners) {
      cb();
    }
  }

  private clearStreamingNotifySchedule(): void {
    if (this.streamingNotifyFrame !== null) {
      globalThis.cancelAnimationFrame?.(this.streamingNotifyFrame);
      this.streamingNotifyFrame = null;
    }
    if (this.streamingNotifyTimer !== null) {
      clearTimeout(this.streamingNotifyTimer);
      this.streamingNotifyTimer = null;
    }
  }

  /**
   * Set the session messages (clears existing messages first).
   * Note: sessionId is immutable and cannot be changed.
   */
  setSession(sessionId: string, session: Session): void {
    // Validate that we're not trying to change the session ID
    if (sessionId !== this.sessionId) {
      throw new MetaError(
        'Cannot change session ID. Create a new SessionStore instead.',
        { oldSessionId: this.sessionId, sessionId }
      );
    }

    this.messages.clear();
    this.messageOrder = [];

    // Add messages to Map and track order
    session.messages.forEach((msg) => {
      this.messages.set(msg.id, { ...msg });
      this.messageOrder.push(msg.id);
    });

    this.messagesVersion++;
    this.notify();
  }

  /**
   * Add a message to the session
   * Inserts in correct position based on createdAt to handle out-of-order notifications
   */
  addMessage(
    message: IndustryDroolMessage,
    options?: { silent?: boolean }
  ): void {
    if (!this.sessionId) {
      throw new SessionNotInitializedError();
    }
    this.messages.set(message.id, { ...message }); // Store a copy

    if (this.messageOrder.includes(message.id)) {
      logInfo(
        '[SessionStore] Received addMessage request for message that already exists in store',
        {
          messageId: message.id,
          role: message.role,
        }
      );
    } else {
      // Insert in correct position based on createdAt timestamp
      // Use message ID as tie-breaker for deterministic ordering when timestamps are equal
      const insertIndex = this.messageOrder.findIndex((id) => {
        const existingMsg = this.messages.get(id);
        if (!existingMsg) return false;

        // Compare timestamps first
        if (existingMsg.createdAt > message.createdAt) return true;
        if (existingMsg.createdAt < message.createdAt) return false;

        // Timestamps equal - use message ID as tie-breaker
        return existingMsg.id > message.id;
      });

      if (insertIndex === -1) {
        // No message with later timestamp found, add to end
        this.messageOrder.push(message.id);
      } else {
        // Insert before the first message with a later timestamp
        this.messageOrder.splice(insertIndex, 0, message.id);
      }
    }

    if (options?.silent) {
      this.hasPendingSilentMessageChanges = true;
    } else {
      this.messagesVersion++;
      this.notify();
    }
  }

  /**
   * Update an existing message
   */
  updateMessage(
    messageId: string,
    updates: Partial<IndustryDroolMessage>,
    options?: { silent?: boolean }
  ): void {
    const existing = this.messages.get(messageId);
    if (existing) {
      this.messages.set(messageId, {
        ...existing,
        ...updates,
      });
      if (options?.silent) {
        this.hasPendingSilentMessageChanges = true;
      } else {
        this.messagesVersion++;
        this.notify();
      }
    }
  }

  /**
   * Get all messages (returns a copy)
   */
  getMessages(): IndustryDroolMessage[] {
    return this.messageOrder
      .map((id) => this.messages.get(id))
      .filter((msg): msg is IndustryDroolMessage => msg !== undefined)
      .map((msg) => ({ ...msg }));
  }

  truncateMessages(maxMessages: number): void {
    if (maxMessages < 0) {
      throw new MetaError('Cannot truncate messages to a negative count', {
        count: maxMessages,
        sessionId: this.sessionId,
      });
    }

    if (this.messageOrder.length <= maxMessages) {
      return;
    }

    // Retain the last maxMessages message IDs and remove the rest
    const retainedIds =
      maxMessages === 0
        ? new Set<string>()
        : new Set(this.messageOrder.slice(-maxMessages));
    this.messageOrder = this.messageOrder.filter((id) => retainedIds.has(id));

    for (const messageId of this.messages.keys()) {
      if (!retainedIds.has(messageId)) {
        this.messages.delete(messageId);
      }
    }

    this.messagesVersion++;
    this.notify();
  }

  /**
   * Get all messages ordered by parent-child relationships.
   * Returns the conversation history from root to the most recent message.
   * Uses shared ordering logic from @industry/utils/messages.
   */
  getOrderedMessages(): IndustryDroolMessage[] {
    return orderMessagesByParentChain(Array.from(this.messages.values()));
  }

  /**
   * Get a specific message by ID
   */
  getMessage(messageId: string): IndustryDroolMessage | undefined {
    const message = this.messages.get(messageId);
    return message ? { ...message } : undefined;
  }

  /**
   * Get the current session ID (immutable after construction)
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get the current session as a Session object
   */
  getSession(): Session | null {
    if (!this.sessionId) {
      return null;
    }

    return {
      messages: this.getMessages(),
    };
  }

  /**
   * Set metadata for the session
   */
  setMetadata(key: string, value: unknown): void {
    this.sessionMetadata.set(key, value);
    this.notify();
  }

  /**
   * Get metadata for the session
   */
  getMetadata(key: string): unknown {
    return this.sessionMetadata.get(key);
  }

  /**
   * Get all metadata
   */
  getAllMetadata(): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    this.sessionMetadata.forEach((value, key) => {
      metadata[key] = value;
    });
    return metadata;
  }

  /**
   * Get message count
   */
  getMessageCount(): number {
    return this.messages.size;
  }

  /**
   * Get last message
   */
  getLastMessage(): IndustryDroolMessage | undefined {
    if (this.messageOrder.length === 0) {
      return undefined;
    }
    const lastMessageId = this.messageOrder[this.messageOrder.length - 1];
    const lastMessage = this.messages.get(lastMessageId);
    return lastMessage ? { ...lastMessage } : undefined;
  }

  /**
   * Get messages by role
   */
  getMessagesByRole(
    role: MessageRole.User | MessageRole.Assistant | MessageRole.Tool
  ): IndustryDroolMessage[] {
    return this.messageOrder
      .map((id) => this.messages.get(id))
      .filter(
        (msg): msg is IndustryDroolMessage =>
          msg !== undefined && msg.role === role
      )
      .map((msg) => ({ ...msg }));
  }

  /**
   * Remove a message by ID
   */
  removeMessage(messageId: string): void {
    const existed = this.messages.delete(messageId);
    if (existed) {
      this.messageOrder = this.messageOrder.filter((id) => id !== messageId);
      this.messagesVersion++;
      this.notify();
    }
  }

  /**
   * Set the title
   */
  setTitle(title: string): void {
    this.title = title;
    this.notify();
  }

  /**
   * Get the title
   */
  getTitle(): string | null {
    return this.title;
  }

  /**
   * Set the model ID
   */
  setModelId(modelId: string): void {
    this.modelId = modelId;
    this.notify();
  }

  /**
   * Get the model ID
   */
  getModelId(): string | null {
    return this.modelId;
  }

  /**
   * Set the reasoning effort
   */
  setReasoningEffort(reasoningEffort: string): void {
    this.reasoningEffort = reasoningEffort;
    this.notify();
  }

  /**
   * Get the reasoning effort
   */
  getReasoningEffort(): string | null {
    return this.reasoningEffort;
  }

  /**
   * Set the interaction mode
   */
  setInteractionMode(interactionMode: DroolInteractionMode): void {
    this.interactionMode = interactionMode;
    this.notify();
  }

  /**
   * Get the interaction mode
   */
  getInteractionMode(): DroolInteractionMode | null {
    return this.interactionMode;
  }

  /**
   * Set the autonomy level
   */
  setAutonomyLevel(autonomyLevel: AutonomyLevel): void {
    this.autonomyLevel = autonomyLevel;
    this.notify();
  }

  /**
   * Get the autonomy level
   */
  getAutonomyLevel(): AutonomyLevel | null {
    return this.autonomyLevel;
  }

  /**
   * Set the spec mode model ID
   */
  setSpecModeModelId(specModeModelId: string | null): void {
    this.specModeModelId = specModeModelId;
    this.notify();
  }

  /**
   * Get the spec mode model ID
   */
  getSpecModeModelId(): string | null {
    return this.specModeModelId;
  }

  /**
   * Set the spec mode reasoning effort
   */
  setSpecModeReasoningEffort(specModeReasoningEffort: string | null): void {
    this.specModeReasoningEffort = specModeReasoningEffort;
    this.notify();
  }

  /**
   * Get the spec mode reasoning effort
   */
  getSpecModeReasoningEffort(): string | null {
    return this.specModeReasoningEffort;
  }

  setMissionSettings(missionSettings: MissionModelSettings | null): void {
    this.missionSettings = missionSettings;
    this.notify();
  }

  getMissionSettings(): MissionModelSettings | null {
    return this.missionSettings;
  }

  setCompactionThresholdCheckEnabled(enabled: boolean): void {
    this.compactionThresholdCheckEnabled = enabled;
    this.notify();
  }

  getCompactionThresholdCheckEnabled(): boolean | null {
    return this.compactionThresholdCheckEnabled;
  }

  setCwd(cwd: string | null): void {
    this.cwd = cwd;
    this.notify();
  }

  getCwd(): string | null {
    return this.cwd;
  }

  setDecompSessionType(type: DecompSessionType): void {
    this.decompSessionType = type;
  }

  getDecompSessionType(): DecompSessionType | null {
    return this.decompSessionType;
  }

  setCallingSessionId(id: string): void {
    this.callingSessionId = id;
  }

  getCallingSessionId(): string | null {
    return this.callingSessionId;
  }

  setTags(tags: SessionTag[] | null): void {
    this.tags = tags;
    this.notify();
  }

  getTags(): SessionTag[] | null {
    return this.tags;
  }

  setCallingToolUseId(id: string): void {
    this.callingToolUseId = id;
  }

  getCallingToolUseId(): string | null {
    return this.callingToolUseId;
  }

  setAgentTurnCompletionReason(reason: AgentTurnCompletionReason): void {
    this.agentTurnCompletionReason = reason;
    this.notify();
  }

  getAgentTurnCompletionReason(): AgentTurnCompletionReason | null {
    return this.agentTurnCompletionReason;
  }

  setLoopState(loopState: LoopState | null): void {
    this.loopState = loopState;
    this.notify();
  }

  getLoopState(): LoopState | null {
    return this.loopState;
  }

  /**
   * Get the available models
   */
  getAvailableModels(): AvailableModelConfig[] | null {
    return this.availableModels;
  }

  /**
   * Set the available models
   */
  setAvailableModels(models: AvailableModelConfig[]): void {
    this.availableModels = models;
    this.notify();
  }

  /**
   * Get the machine ID for this session.
   * May be empty string for optimistic sessions before the machine is created.
   */
  getMachineId(): string {
    return this.machineId;
  }

  /**
   * Set the machine ID for this session
   */
  setMachineId(machineId: string): void {
    this.machineId = machineId;
    this.notify();
  }

  /**
   * Clear all mutable session data (messages, terminals, metadata).
   * Preserves immutable sessionId and machineId.
   * Also clears settings like modelId, reasoningEffort, autonomy settings,
   * specMode settings, mission settings, and cwd.
   */
  clearMessages(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
      this.pendingNotify = false;
    }
    this.clearStreamingNotifySchedule();
    this.pendingStreamingNotify = false;
    this.messages.clear();
    this.messageOrder = [];
    this.messagesVersion++;
    this.sessionMetadata.clear();
    this.terminals.clear();
    this.activeTerminalId = null;
    this.modelId = null;
    this.reasoningEffort = null;
    this.interactionMode = null;
    this.autonomyLevel = null;
    this.specModeModelId = null;
    this.specModeReasoningEffort = null;
    this.missionSettings = null;
    this.compactionThresholdCheckEnabled = null;
    this.cwd = null;
    this.availableModels = null;
    this.clearAllToolProgress();
    this.notify();
  }

  // ============ Terminal Management Methods ============

  /**
   * Set the active terminal ID
   */
  setActiveTerminalId(terminalId: string | null): void {
    this.activeTerminalId = terminalId;
    this.notify();
  }

  /**
   * Get the active terminal ID
   */
  getActiveTerminalId(): string | null {
    return this.activeTerminalId;
  }

  /**
   * Add or update a terminal in the session
   */
  addTerminal(terminal: TerminalMetadata): void {
    if (!this.sessionId) {
      throw new SessionNotInitializedError();
    }
    this.terminals.set(terminal.id, { ...terminal });
    this.notify();
  }

  /**
   * Update terminal metadata (dimensions, content, status, etc.)
   */
  updateTerminal(terminalId: string, updates: Partial<TerminalMetadata>): void {
    const existing = this.terminals.get(terminalId);
    if (existing) {
      this.terminals.set(terminalId, {
        ...existing,
        ...updates,
      });
      this.notify();
    }
  }

  /**
   * Get a specific terminal by ID
   */
  getTerminal(terminalId: string): TerminalMetadata | undefined {
    const terminal = this.terminals.get(terminalId);
    return terminal ? { ...terminal } : undefined;
  }

  /**
   * Get all terminals (returns a copy)
   */
  getTerminals(): Map<string, TerminalMetadata> {
    return new Map(this.terminals);
  }

  /**
   * Remove a terminal by ID
   */
  removeTerminal(terminalId: string): void {
    const existed = this.terminals.delete(terminalId);
    if (existed) {
      this.notify();
    }
  }

  // ============ Terminal Serialization Methods ============

  /**
   * Store serialized terminal state (called on unmount)
   */
  storeTerminalSerializedState(
    terminalId: string,
    state: {
      serialized: string;
      cols: number;
      rows: number;
      timestamp: number;
      cursorHidden?: boolean;
    }
  ): void {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      this.terminals.set(terminalId, {
        ...terminal,
        serializedState: state,
        // Clear buffered data when storing new serialized state
        // The buffered data is now included in the serialized state
        bufferedData: undefined,
      });
      this.notify();
    }
  }

  /**
   * Get serialized terminal state
   */
  getTerminalSerializedState(
    terminalId: string
  ):
    | { serialized: string; cols: number; rows: number; timestamp: number }
    | undefined {
    return this.terminals.get(terminalId)?.serializedState;
  }

  /**
   * Append data to terminal buffer (called for DATA notifications while unmounted)
   */
  appendTerminalBufferedData(terminalId: string, data: string): void {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      this.terminals.set(terminalId, {
        ...terminal,
        bufferedData: (terminal.bufferedData || '') + data,
      });
      this.notify();
    }
  }

  /**
   * Get buffered data for terminal
   */
  getTerminalBufferedData(terminalId: string): string | undefined {
    return this.terminals.get(terminalId)?.bufferedData;
  }

  /**
   * Clear only buffered data for terminal (called after flushing)
   */
  clearTerminalBufferedData(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      this.terminals.set(terminalId, {
        ...terminal,
        bufferedData: undefined,
      });
      this.notify();
    }
  }

  /**
   * Clear serialized state and buffered data (called after restoration)
   */
  clearTerminalRestorationState(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (terminal) {
      this.terminals.set(terminalId, {
        ...terminal,
        serializedState: undefined,
        bufferedData: undefined,
      });
      this.notify();
    }
  }

  /**
   * Get MCP server status info
   */
  getMcpServers(): McpServerStatusInfo[] {
    return this.mcpServers;
  }

  /**
   * Set MCP server status info
   */
  setMcpServers(servers: McpServerStatusInfo[]): void {
    this.mcpServers = servers;
    this.notify();
  }

  /**
   * Get MCP status
   */
  getMcpStatus(): McpStatus {
    return this.mcpStatus;
  }

  /**
   * Set MCP status
   */
  setMcpStatus(status: McpStatus): void {
    this.mcpStatus = status;
    this.notify();
  }

  /**
   * Get token usage
   */
  getTokenUsage(): TokenUsage | null {
    return this.tokenUsage;
  }

  getLastCallTokenUsage(): NonNullable<
    SessionTokenUsageChangedNotification['lastCallTokenUsage']
  > | null {
    return this.lastCallTokenUsage;
  }

  /**
   * Set token usage
   */
  setTokenUsage(tokenUsage: TokenUsage): void {
    this.tokenUsage = tokenUsage;
    this.notify();
  }

  setLastCallTokenUsage(
    tokenUsage: NonNullable<
      SessionTokenUsageChangedNotification['lastCallTokenUsage']
    > | null
  ): void {
    this.lastCallTokenUsage = tokenUsage;
    this.notify();
  }

  // ============ Tool Progress Methods (IToolProgressStore) ============

  addUpdate({ toolUseId, update }: AddToolExecutionUpdateParams): void {
    const existing =
      this.toolProgressUpdates.get(toolUseId) ||
      SessionStore.EMPTY_TOOL_UPDATES;

    const lastUpdate = existing[existing.length - 1];
    if (lastUpdate && areToolStreamingUpdatesEqual(lastUpdate, update)) {
      return;
    }

    this.toolProgressUpdates.set(toolUseId, [...existing, update]);

    this.notify();
    this.onToolProgressUpdate?.(this.sessionId, toolUseId);

    const existingTimer = this.toolProgressCleanupTimers.get(toolUseId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.toolProgressCleanupTimers.delete(toolUseId);
    }
  }

  getUpdates(toolUseId: string): ToolStreamingUpdate[] {
    return (
      this.toolProgressUpdates.get(toolUseId) || SessionStore.EMPTY_TOOL_UPDATES
    );
  }

  getAllUpdates(): ToolStreamingUpdate[] {
    return [...this.toolProgressUpdates.values()]
      .flat()
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  hasUpdates(toolUseId: string): boolean {
    const updates = this.toolProgressUpdates.get(toolUseId);
    return updates !== undefined && updates.length > 0;
  }

  markToolCompleted(toolUseId: string): void {
    const existingTimer = this.toolProgressCleanupTimers.get(toolUseId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.clearToolProgress(toolUseId);
      this.toolProgressCleanupTimers.delete(toolUseId);
      logInfo('[SessionStore] Cleaned up completed tool progress', {
        sessionId: this.sessionId,
        toolUseId,
      });
    }, SessionStore.TOOL_PROGRESS_CLEANUP_DELAY_MS);

    this.toolProgressCleanupTimers.set(toolUseId, timer);
  }

  // ============ Hook Execution Methods ============

  addHookExecution(
    hookId: string,
    data: Omit<HookExecutionData, 'createdAt'>
  ): void {
    this.hookExecutions.set(hookId, { ...data, createdAt: Date.now() });
    this.notify();
  }

  updateHookExecution(
    hookId: string,
    update: {
      hookStatus: 'completed' | 'error';
      hookResults?: Array<{
        exitCode: number;
        stdout: string;
        stderr: string;
        suppressOutput?: boolean;
      }>;
    }
  ): void {
    const existing = this.hookExecutions.get(hookId);
    if (existing) {
      existing.hookStatus = update.hookStatus;
      existing.hookResults = update.hookResults;
      this.notify();
    }
  }

  getHookExecutions(): HookExecutionData[] {
    return [...this.hookExecutions.values()];
  }

  // ============ UI Render Cutoff Methods ============

  setUiRenderCutoff(messageId: string | null): void {
    this.uiRenderCutoffMessageId = messageId;
    this.notify();
  }

  getUiRenderCutoff(): string | null {
    return this.uiRenderCutoffMessageId;
  }

  clearAll(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
      this.pendingNotify = false;
    }
    this.clearStreamingNotifySchedule();
    this.pendingStreamingNotify = false;
    this.clearAllToolProgress();
    this.hookExecutions.clear();
    this.notify();
  }

  private clearToolProgress(toolUseId: string): void {
    this.toolProgressUpdates.delete(toolUseId);
    this.onToolProgressUpdate?.(this.sessionId, toolUseId);

    const timer = this.toolProgressCleanupTimers.get(toolUseId);
    if (timer) {
      clearTimeout(timer);
      this.toolProgressCleanupTimers.delete(toolUseId);
    }
  }

  private clearAllToolProgress(): void {
    const toolUseIds = [...this.toolProgressUpdates.keys()];
    this.toolProgressUpdates.clear();

    for (const timer of this.toolProgressCleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.toolProgressCleanupTimers.clear();

    for (const toolUseId of toolUseIds) {
      this.onToolProgressUpdate?.(this.sessionId, toolUseId);
    }
  }
}
