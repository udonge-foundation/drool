import {
  DaemonBroadcastMessage,
  DaemonCronEvent,
  DaemonDroolEvent,
  DaemonSessionNotification,
  DaemonSessionNotificationSchema,
  DaemonSpecificNotificationType,
  MachineType,
  type DaemonCronStateChangedNotification,
  type DaemonCronStateChangedNotificationParams,
  type SessionInactivityNotification,
} from '@industry/common/daemon';
import { DroolClient, DroolClientEvent } from '@industry/drool-sdk';
import {
  INDUSTRY_PROTOCOL_VERSION,
  LEGACY_INDUSTRY_API_VERSION,
  JSONRPC_VERSION,
  SessionNotificationType,
  DroolWorkingState,
  type DecompSessionType,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logError, logException, logInfo } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { resolveRepoRoot } from '@industry/utils/git';
import { DEFAULT_E2B_KILL_TIMEOUT_MS } from '@industry/utils/workspaces';

import { ActiveListenerLifecycleEventType } from './enums';
import { shouldForwardToFilteredListener } from './notification-forwarding';
import {
  DaemonSessionState,
  DroolRegistryOptions,
  RegisterClientParams,
} from './types';
import { MonotonicClock } from '../utils/monotonic-clock';

import type { IAuthedDaemonConnection } from '../server/types';
import type { WorktreeSessionInfo } from '@industry/utils/git';

type ActiveListenerLifecycleEvent =
  | {
      type: ActiveListenerLifecycleEventType.Connected;
      sessionId: string;
      listener: IAuthedDaemonConnection;
    }
  | {
      type: ActiveListenerLifecycleEventType.Disconnected;
      sessionId: string;
      listener: IAuthedDaemonConnection;
    }
  | {
      type: ActiveListenerLifecycleEventType.SessionClosed;
      sessionId: string;
    };

type ActiveListenerLifecycleSubscriber = (
  event: ActiveListenerLifecycleEvent
) => void;

/** Default timeout for local + computer drool sessions. */
const DEFAULT_DROOL_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * DroolRegistry maintains a mapping from session IDs to DroolClient instances.
 * This allows the daemon to track active drool sessions and route requests
 * to the appropriate client while supporting multiple attached listeners.
 */
export class DroolRegistry {
  // Track sessions that are currently extending their timeout to prevent race conditions
  // Maps sessionId to the promise performing the extension
  private readonly extendingTimeouts: Map<string, Promise<void>> = new Map();

  /**
   * Monotonic clock tracking the last observed drool activity. Advanced on
   * every drool signal (safeExtendSessionTimeout, i.e. session notifications
   * and registration) so short bursts that complete between heartbeat polls
   * are still recorded, and advanced lazily by getLastDroolActivityAt while a
   * session is actively working so long-running silent work stays fresh. Read
   * by HeartbeatService to skip heartbeats when all sessions are stale.
   */
  private readonly activityClock: MonotonicClock = new MonotonicClock();

  /**
   * Machine ID for this daemon instance.
   * Used to determine session timeout duration (local vs remote).
   */
  private readonly machineId: string;

  private readonly machineType: MachineType;

  private readonly sessionTimeoutMsOverride: number | undefined;

  private readonly broadcastToAuthenticatedConnections?: (
    message: DaemonBroadcastMessage
  ) => void;

  constructor(
    machineId: string,
    machineType?: MachineType,
    options?: DroolRegistryOptions
  ) {
    this.machineId = machineId;
    this.machineType = machineType ?? MachineType.Local;
    this.sessionTimeoutMsOverride = options?.sessionTimeoutMsOverride;
    this.broadcastToAuthenticatedConnections =
      options?.broadcastToAuthenticatedConnections;
  }

  /** Returns the session timeout for this registry's machine type. */
  getDroolSessionTimeoutMs(): number {
    switch (this.machineType) {
      case MachineType.Local:
      case MachineType.Computer:
        return (
          this.sessionTimeoutMsOverride ?? DEFAULT_DROOL_SESSION_TIMEOUT_MS
        );
      case MachineType.Ephemeral:
        return DEFAULT_E2B_KILL_TIMEOUT_MS;
      default: {
        const exhaustiveCheck: never = this.machineType;
        throw new MetaError('Unknown machine type', {
          machineConnectionType: exhaustiveCheck,
        });
      }
    }
  }

  /** Returns the default session timeout for a machine type. */
  static getDroolSessionTimeoutMs(
    _machineId: string,
    machineType?: MachineType
  ): number {
    const resolvedType = machineType ?? MachineType.Local;
    switch (resolvedType) {
      case MachineType.Local:
      case MachineType.Computer:
        return DEFAULT_DROOL_SESSION_TIMEOUT_MS;
      case MachineType.Ephemeral:
        return DEFAULT_E2B_KILL_TIMEOUT_MS;
      default: {
        const exhaustiveCheck: never = resolvedType;
        throw new MetaError('Unknown machine type', {
          machineConnectionType: exhaustiveCheck,
        });
      }
    }
  }

  /**
   * Maps session ID to the DroolClient instance managing that session
   */
  private droolClients: Map<string, DroolClient> = new Map();

  /**
   * Maps session ID to consolidated session state (working state, listeners, timeouts, cleanup, etc.)
   */
  private sessionStates: Map<string, DaemonSessionState> = new Map();

  /**
   * Maps session ID to a pending DroolClient creation promise.
   * Used to prevent race conditions when multiple concurrent requests
   * attempt to create a client for the same session.
   */
  private pendingClientCreations: Map<string, Promise<DroolClient>> = new Map();

  private activeListenerLifecycleSubscribers: Set<ActiveListenerLifecycleSubscriber> =
    new Set();

  subscribeToActiveListenerLifecycle(
    subscriber: ActiveListenerLifecycleSubscriber
  ): () => void {
    this.activeListenerLifecycleSubscribers.add(subscriber);
    return () => {
      this.activeListenerLifecycleSubscribers.delete(subscriber);
    };
  }

  /**
   * Gets or creates session state for a given session ID.
   * If state doesn't exist, creates a new one with default values.
   */
  private getOrCreateSessionState(sessionId: string): DaemonSessionState {
    let state = this.sessionStates.get(sessionId);
    if (!state) {
      state = {
        workingState: DroolWorkingState.Idle,
        updatedAt: Math.floor(Date.now() / 1000), // Unix timestamp in seconds
        sessionListeners: new Set(),
        activeListener: undefined,
        cleanupFunction: undefined,
        timeout: undefined,
      };
      this.sessionStates.set(sessionId, state);
    }
    return state;
  }

  /**
   * Gets a pending DroolClient creation promise for a session, if one exists.
   * Used to prevent concurrent requests from creating duplicate clients.
   * @returns Promise that resolves to DroolClient if creation is in progress, undefined otherwise
   */
  getPendingClientCreation(
    sessionId: string
  ): Promise<DroolClient> | undefined {
    return this.pendingClientCreations.get(sessionId);
  }

  /**
   * Tracks a pending DroolClient creation promise for a session.
   * @param sessionId The session ID being created
   * @param promise The promise that will resolve to the DroolClient
   */
  setPendingClientCreation(
    sessionId: string,
    promise: Promise<DroolClient>
  ): void {
    this.pendingClientCreations.set(sessionId, promise);
  }

  /**
   * Removes a pending DroolClient creation promise for a session.
   * Should be called after client creation completes (success or failure).
   * @param sessionId The session ID to clean up
   */
  deletePendingClientCreation(sessionId: string): void {
    this.pendingClientCreations.delete(sessionId);
  }

  /**
   * Registers a new DroolClient for a given session ID and associates it with a connection.
   * If a client already exists for this session, it will be replaced.
   * Sets up activity monitoring to reset timeout on drool process events.
   * The connection becomes the preferred interactive listener for this drool client.
   */
  async registerClient(params: RegisterClientParams): Promise<void> {
    const {
      sessionId,
      droolClient,
      connection,
      cleanupFn,
      cwd,
      repoRoot,
      hostId,
      decompSessionType,
      tags,
      callingSessionId,
      callingToolUseId,
      inactivityTimeoutMs,
      skipPermissionsUnsafe,
      runtimeSettingsPath,
      disableInactivityTimeout,
      worktreeInfo,
    } = params;

    // Cancel any pending timeout for this session (reconnection case)
    this.cancelSessionTimeout(sessionId);

    const existingDroolClient = this.droolClients.get(sessionId);
    if (existingDroolClient) {
      // Clean up existing event handlers
      const existingState = this.sessionStates.get(sessionId);
      if (existingState?.cleanupFunction) {
        existingState.cleanupFunction();
      }
      // Fire and forget - close in background
      void (async () => {
        try {
          await existingDroolClient.close();
        } catch (error) {
          logException(error, 'Failed to close existing drool client');
        }
      })();
    }

    // Set this authenticated connection as the active listener for this session
    await this.verifyUserAndSetActiveListener(sessionId, connection);

    // After authentication, set the drool client
    this.droolClients.set(sessionId, droolClient);

    // Set up activity monitoring: extend timeout on any session notification
    const activityHandler = async () => {
      await this.safeExtendSessionTimeout(sessionId);
    };
    droolClient.on(DroolClientEvent.SESSION_NOTIFICATION, activityHandler);

    // Combine user cleanup with activity listener cleanup
    const combinedCleanup = () => {
      droolClient.off(DroolClientEvent.SESSION_NOTIFICATION, activityHandler);
      if (cleanupFn) {
        cleanupFn();
      }
    };

    // Get or create session state and update cleanup function.
    // Use `!== undefined` (not falsy) so legitimate empty strings aren't dropped.
    const state = this.getOrCreateSessionState(sessionId);
    state.cleanupFunction = combinedCleanup;
    if (cwd !== undefined) {
      state.cwd = cwd;
    }
    if (repoRoot !== undefined) {
      state.repoRoot = repoRoot;
    }
    if (hostId !== undefined) {
      state.hostId = hostId;
    }
    if (decompSessionType !== undefined) {
      state.decompSessionType = decompSessionType;
    }
    if (tags !== undefined) {
      state.tags = tags;
    }
    if (callingSessionId !== undefined) {
      state.callingSessionId = callingSessionId;
    }
    if (callingToolUseId !== undefined) {
      state.callingToolUseId = callingToolUseId;
    }
    if (inactivityTimeoutMs !== undefined) {
      state.inactivityTimeoutMs = inactivityTimeoutMs;
    }
    if (skipPermissionsUnsafe !== undefined) {
      state.skipPermissionsUnsafe = skipPermissionsUnsafe;
    }
    if (runtimeSettingsPath !== undefined) {
      state.runtimeSettingsPath = runtimeSettingsPath;
    }
    if (disableInactivityTimeout !== undefined) {
      state.disableInactivityTimeout = disableInactivityTimeout;
    }
    if (worktreeInfo !== undefined) {
      state.worktreeInfo = worktreeInfo;
    }

    // Start the inactivity timeout immediately with initial timeout
    await this.safeExtendSessionTimeout(sessionId);
  }

  getWorktreeInfo(sessionId: string): WorktreeSessionInfo | undefined {
    return this.sessionStates.get(sessionId)?.worktreeInfo;
  }

  /**
   * Associates a connection with an existing session. Interactive connections
   * also become the preferred interactive listener.
   * @returns true if session exists and the connection was set as listener, false if session doesn't exist
   */
  async addConnectionToSession(
    sessionId: string,
    connection: IAuthedDaemonConnection
  ): Promise<boolean> {
    if (!this.droolClients.has(sessionId)) {
      return false;
    }

    // Cancel any pending timeout for this session (activity detected)
    this.cancelSessionTimeout(sessionId);

    // Set this authenticated connection as the active listener
    await this.verifyUserAndSetActiveListener(sessionId, connection);

    // Restart the inactivity timeout with regular timeout (activity detected)
    await this.safeExtendSessionTimeout(sessionId);

    return true;
  }

  /**
   * Adds an authenticated connection to a session's listener set. Accepts
   * interactive connections and non-interactive child-IPC forwarders
   * (sourceSessionId set); only interactive connections become the preferred
   * activeListener for backwards-compatible request replay.
   */
  async verifyUserAndSetActiveListener(
    sessionId: string,
    connection: IAuthedDaemonConnection
  ): Promise<void> {
    if (!connection.interactive && connection.sourceSessionId === undefined) {
      return;
    }

    // Get or create session state
    const state = this.getOrCreateSessionState(sessionId);
    const sessionListeners = state.sessionListeners ?? new Set();
    state.sessionListeners = sessionListeners;
    const hadConnection = sessionListeners.has(connection);
    sessionListeners.add(connection);

    if (connection.interactive) {
      state.activeListener = connection;
    }
    if (!hadConnection && connection.interactive) {
      this.emitActiveListenerLifecycleEvent({
        type: ActiveListenerLifecycleEventType.Connected,
        sessionId,
        listener: connection,
      });
    }
  }

  /**
   * Retrieves the DroolClient for a given session ID.
   * @returns DroolClient if found, undefined otherwise
   */
  getDroolClient(sessionId: string): DroolClient | undefined {
    return this.droolClients.get(sessionId);
  }

  /**
   * Retrieves the session state for a given session ID.
   * @returns DaemonSessionState if found, undefined otherwise
   */
  getSessionState(sessionId: string): DaemonSessionState | undefined {
    return this.sessionStates.get(sessionId);
  }

  /**
   * Checks if a session ID has an active DroolClient.
   */
  hasDroolClient(sessionId: string): boolean {
    return this.droolClients.has(sessionId);
  }

  /**
   * Unregisters and cleans up a DroolClient for a given session ID.
   * Also cleans up listener tracking for this session.
   * @returns true if a client was removed, false if no client existed
   */
  async unregisterDroolClient(sessionId: string): Promise<boolean> {
    const client = this.droolClients.get(sessionId);
    if (!client) {
      return false;
    }

    // Cancel any pending session timeout
    this.cancelSessionTimeout(sessionId);

    // Clean up event handlers first
    const state = this.sessionStates.get(sessionId);
    if (state?.cleanupFunction) {
      state.cleanupFunction();
    }

    // Remove synchronously before awaiting close so registry membership
    // continues to mean the client is routable.
    if (this.droolClients.get(sessionId) === client) {
      this.droolClients.delete(sessionId);
    }

    this.emitActiveListenerLifecycleEvent({
      type: ActiveListenerLifecycleEventType.SessionClosed,
      sessionId,
    });

    // The connection remains authenticated and can still receive
    // droolWorkingState broadcasts. It will be removed from
    // authenticatedWebSockets when it disconnects.
    this.sessionStates.delete(sessionId);

    try {
      await client.close();
    } catch (error) {
      logException(error, 'Failed to close drool client during unregister');
      // Still remove from registry even if close fails
    }
    return true;
  }

  /**
   * Unregisters and cleans up all DroolClients.
   * Also clears listener tracking and cancels all pending timeouts.
   * Useful for shutdown scenarios.
   */
  async unregisterAllDroolClients(): Promise<void> {
    // Cancel all pending timeouts first
    for (const state of this.sessionStates.values()) {
      if (state.timeout) {
        clearTimeout(state.timeout);
      }
    }

    // Clean up all event handlers
    for (const state of this.sessionStates.values()) {
      if (state.cleanupFunction) {
        state.cleanupFunction();
      }
    }

    const closePromises = Array.from(this.droolClients.values()).map(
      async (client) => {
        try {
          await client.close();
        } catch (error) {
          logException(error, 'Failed to close drool client during shutdown');
        }
      }
    );
    await Promise.all(closePromises);
    this.droolClients.clear();

    for (const sessionId of this.sessionStates.keys()) {
      this.emitActiveListenerLifecycleEvent({
        type: ActiveListenerLifecycleEventType.SessionClosed,
        sessionId,
      });
    }

    this.sessionStates.clear();
  }

  /**
   * Returns the number of active DroolClients.
   */
  getDroolClientCount(): number {
    return this.droolClients.size;
  }

  /**
   * Gets all active session IDs.
   */
  getAllSessionIds(): string[] {
    return Array.from(this.droolClients.keys());
  }

  /**
   * Sets the message count for a session.
   * Called when initializing or loading a session.
   * @param sessionId The session ID
   * @param count The message count
   */
  setMessagesCount(sessionId: string, count: number): void {
    const state = this.sessionStates.get(sessionId);
    if (state) {
      state.messagesCount = count;
    }
  }

  setSessionTags(sessionId: string, tags: DaemonSessionState['tags']): void {
    const state = this.sessionStates.get(sessionId);
    if (state) {
      state.tags = tags;
    }
  }

  setSessionArchivedAt(sessionId: string, archivedAt: string | null): void {
    const state = this.sessionStates.get(sessionId);
    if (!state) {
      return;
    }
    if (archivedAt === null) {
      delete state.archivedAt;
    } else {
      state.archivedAt = archivedAt;
    }
  }

  /**
   * Gets all active sessions with their working states.
   * Returns an array of objects with sessionId, workingState, timestamp, cwd, messagesCount, and callingSessionId.
   */
  getAllSessionsWithStates(): Array<{
    sessionId: string;
    workingState: DroolWorkingState;
    updatedAt: number;
    cwd?: string;
    repoRoot?: string;
    hostId?: string;
    decompSessionType?: DecompSessionType;
    tags?: DaemonSessionState['tags'];
    archivedAt?: string;
    messagesCount?: number;
    callingSessionId?: string;
    callingToolUseId?: string;
  }> {
    return Array.from(this.droolClients.keys()).map((sessionId) => {
      const state = this.sessionStates.get(sessionId);
      const cwd = state?.cwd;
      // For sessions registered before the worktree feature shipped, state
      // won't have `repoRoot` cached. Resolve lazily from `cwd` so existing
      // worktree sessions group under their parent project on next refresh.
      const repoRoot =
        state?.repoRoot ?? (cwd ? resolveRepoRoot(cwd) : undefined);
      return {
        sessionId,
        workingState: state?.workingState || DroolWorkingState.Idle,
        updatedAt: state?.updatedAt || Math.floor(Date.now() / 1000),
        cwd,
        repoRoot,
        hostId: state?.hostId,
        decompSessionType: state?.decompSessionType,
        tags: state?.tags,
        archivedAt: state?.archivedAt,
        messagesCount: state?.messagesCount,
        callingSessionId: state?.callingSessionId,
        callingToolUseId: state?.callingToolUseId,
      };
    });
  }

  /**
   * Gets the active listener connection for a specific session.
   * @returns The active listener connection, or undefined if no listener is set
   */
  getActiveListenerForSession(
    sessionId: string
  ): IAuthedDaemonConnection | undefined {
    return this.sessionStates.get(sessionId)?.activeListener;
  }

  getListenersForSession(sessionId: string): IAuthedDaemonConnection[] {
    const state = this.sessionStates.get(sessionId);
    if (!state) {
      return [];
    }

    return Array.from(state.sessionListeners ?? []);
  }

  private static shouldBroadcastDaemonWide(notificationType: string): boolean {
    return (
      notificationType ===
        SessionNotificationType.DROOL_WORKING_STATE_CHANGED ||
      notificationType === SessionNotificationType.SESSION_TITLE_UPDATED
    );
  }

  /**
   * Broadcasts a message for a session. The broadcast strategy depends on the notification type:
   * - Tool-execution heartbeats are suppressed
   * - Working-state and title notifications fan out to all interactive daemon connections
   * - Critical requests (e.g. permission requests) go only to interactive listeners
   * - Other notifications fan out to interactive listeners plus filtered
   *   child-IPC forwarders per shouldForwardToFilteredListener
   *
   * @throws {MetaError} If message is a critical request (e.g., permission request) and sending fails
   */
  broadcastForSession(
    sessionId: string,
    message: DaemonBroadcastMessage,
    listenerOverride?: IAuthedDaemonConnection
  ): void {
    // Parse and check if this is a droolWorkingState notification
    const parseResult = DaemonSessionNotificationSchema.safeParse(message);

    // Tool-execution heartbeats are internal keep-alive signals used by the
    // session inactivity timer (activityHandler refreshes on any incoming
    // DroolClient SESSION_NOTIFICATION). They are never forwarded to
    // external clients to avoid polluting the notification stream.
    if (
      parseResult.success &&
      parseResult.data.params.notification.type ===
        SessionNotificationType.TOOL_EXECUTION_HEARTBEAT
    ) {
      return;
    }

    if (
      parseResult.success &&
      parseResult.data.params.notification.type ===
        SessionNotificationType.DROOL_WORKING_STATE_CHANGED
    ) {
      // TypeScript now knows notification is DroolWorkingStateChangedNotification.
      // Update registry state, then continue to fan out only to this session's listeners.
      const { newState } = parseResult.data.params.notification;

      const state = this.getOrCreateSessionState(sessionId);
      state.workingState = newState;
      state.updatedAt = Math.floor(Date.now() / 1000);

      logInfo('[DroolRegistry] Working state updated for session', {
        sessionId,
        value: newState,
        count: state.sessionListeners
          ? Array.from(state.sessionListeners).filter(
              (listener) => listener.interactive
            ).length
          : 0,
        isActive: DroolRegistry.shouldBroadcastDaemonWide(
          parseResult.data.params.notification.type
        ),
      });
    }

    const shouldBroadcastDaemonWide =
      parseResult.success &&
      message.type === 'notification' &&
      DroolRegistry.shouldBroadcastDaemonWide(
        parseResult.data.params.notification.type
      );

    // Check if this is a critical request (permission requests, etc.)
    const isCriticalRequest = message.type === 'request';

    const messageString = JSON.stringify(message);

    if (!listenerOverride && shouldBroadcastDaemonWide) {
      this.broadcastToAllDaemonConnections(message);
      return;
    }

    let listeners: IAuthedDaemonConnection[];
    if (listenerOverride) {
      listeners = [listenerOverride];
    } else {
      listeners = this.getListenersForSession(sessionId);
    }

    if (isCriticalRequest) {
      const interactiveListeners = listeners.filter(
        (listener) => listener.interactive
      );
      if (interactiveListeners.length === 0) {
        throw new MetaError('No interactive listener for critical request', {
          sessionId,
          method: 'method' in message ? message.method : 'unknown',
        });
      }

      let delivered = false;
      let lastError: unknown;
      for (const listener of interactiveListeners) {
        try {
          listener.sendMessage(messageString);
          delivered = true;
        } catch (error) {
          lastError = error;
          logException(error, 'Failed to send request to connection', {
            sessionId,
          });
        }
      }

      if (!delivered) {
        throw new MetaError('Failed to send critical request to connection', {
          cause: lastError,
          sessionId,
          method: 'method' in message ? message.method : 'unknown',
        });
      }
      return;
    }

    const forwardToFilteredListener = shouldForwardToFilteredListener(message);

    for (const listener of listeners) {
      if (!listener.interactive && !forwardToFilteredListener) {
        continue;
      }
      try {
        listener.sendMessage(messageString);
      } catch (error) {
        logException(error, 'Failed to send notification to connection', {
          sessionId,
        });
      }
    }
  }

  /**
   * Delegates a message to the connection layer for delivery to every
   * authenticated daemon connection. Used specifically for droolWorkingState
   * notifications that all clients should receive.
   */
  private broadcastToAllDaemonConnections(
    message: DaemonBroadcastMessage
  ): void {
    if (!this.broadcastToAuthenticatedConnections) {
      logInfo(
        'Authenticated connection broadcaster not set - skipping broadcast to all connections'
      );
      return;
    }

    this.broadcastToAuthenticatedConnections(message);
  }

  /**
   * Fans out a cron state-change to every authenticated daemon connection.
   * Target of the `CronRegistry.onChange` callback.
   */
  broadcastCronStateChanged(
    params: DaemonCronStateChangedNotificationParams
  ): void {
    const message: DaemonCronStateChangedNotification = {
      type: 'notification',
      jsonrpc: JSONRPC_VERSION,
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      method: DaemonCronEvent.STATE_CHANGED,
      params,
    };

    this.broadcastToAllDaemonConnections(message);
  }

  /**
   * Handles connection disconnection by removing the connection-to-session mapping.
   * Sessions remain alive and their existing inactivity timeouts continue to run.
   * Timeouts are automatically reset when the drool process emits events, so sessions
   * will only be cleaned up after the configured timeout period of inactivity.
   * @returns Session IDs that were actively listening on this connection.
   */
  scheduleCleanupForConnection(connection: IAuthedDaemonConnection): string[] {
    const affectedSessionIds: string[] = [];

    for (const [sessionId, state] of this.sessionStates.entries()) {
      const sessionListeners = state.sessionListeners;
      if (!sessionListeners?.has(connection)) {
        continue;
      }

      sessionListeners.delete(connection);
      if (state.activeListener === connection) {
        const remainingInteractive = Array.from(sessionListeners).filter(
          (listener) => listener.interactive
        );
        state.activeListener = remainingInteractive.at(-1);
      }
      affectedSessionIds.push(sessionId);
      if (connection.interactive) {
        this.emitActiveListenerLifecycleEvent({
          type: ActiveListenerLifecycleEventType.Disconnected,
          sessionId,
          listener: connection,
        });
      }
    }

    if (affectedSessionIds.length > 0) {
      logInfo(
        'Connection disconnected, keeping sessions alive with inactivity monitoring',
        {
          sessionIds: affectedSessionIds,
        }
      );
    }

    return affectedSessionIds;
  }

  private async extendSessionTimeout(sessionId: string): Promise<void> {
    // Ensure this method is truly async to allow Vitest fake timers to work correctly
    await Promise.resolve();

    try {
      // Cancel any existing timeout for this session
      this.cancelSessionTimeout(sessionId);

      // Session might have been removed
      if (!this.droolClients.has(sessionId)) {
        return;
      }

      const sessionState = this.sessionStates.get(sessionId);
      if (sessionState?.disableInactivityTimeout) {
        return;
      }
      const timeoutMs =
        sessionState?.inactivityTimeoutMs ?? this.getDroolSessionTimeoutMs();

      const timeout = setTimeout(() => {
        logInfo('Cleaning up inactive drool session', { sessionId });

        // Send inactivity notification to all connected clients
        const timeoutSeconds = timeoutMs / 1000;
        const sessionInactivityNotification: SessionInactivityNotification = {
          type: DaemonSpecificNotificationType.SESSION_INACTIVITY,
          message: 'Session cleaned up after inactivity',
          timestamp: Date.now(),
          timeoutSeconds,
        };
        const daemonNotification: DaemonSessionNotification = {
          industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
          industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
          jsonrpc: JSONRPC_VERSION,
          type: 'notification',
          method: DaemonDroolEvent.SESSION_NOTIFICATION as const,
          params: {
            sessionId,
            notification: sessionInactivityNotification,
          },
        };

        this.broadcastForSession(sessionId, daemonNotification);

        logInfo('Sent inactivity notification to clients', {
          sessionId,
        });

        // Clean up event handlers first
        const state = this.sessionStates.get(sessionId);
        if (state?.cleanupFunction) {
          state.cleanupFunction();
        }

        const client = this.droolClients.get(sessionId);
        if (client) {
          // Fire and forget - close in background
          void (async () => {
            try {
              await client.close();
            } catch (error) {
              logException(
                error,
                'Failed to close drool client during timeout cleanup',
                {
                  sessionId,
                }
              );
            } finally {
              this.droolClients.delete(sessionId);

              this.emitActiveListenerLifecycleEvent({
                type: ActiveListenerLifecycleEventType.SessionClosed,
                sessionId,
              });

              // Clean up session state to prevent memory leak
              // The connection remains authenticated and can still receive broadcasts
              // It's removed from authenticatedWebSockets only when it disconnects
              this.sessionStates.delete(sessionId);
            }
          })();
        }
      }, timeoutMs);

      // Store timeout in session state
      const state = this.getOrCreateSessionState(sessionId);
      state.timeout = timeout;
    } finally {
      // Always remove from extending map, even if an error occurred
      this.extendingTimeouts.delete(sessionId);
    }
  }

  /**
   * Safely schedules cleanup for a specific session after timeout
   * @param sessionId The session ID to schedule cleanup for
   */
  /**
   * Returns the timestamp (ms) of the last drool activity across all sessions.
   */
  getLastDroolActivityAt(): number {
    if (this.hasActiveDroolWorkingState()) {
      this.activityClock.update();
    }

    return this.activityClock.now();
  }

  /**
   * Returns true if any registered session is in a working state that
   * represents in-flight drool work (thinking, streaming, executing a tool,
   * or compacting).
   *
   * Scanning every session (not just one) makes this mission-aware: a busy
   * worker session keeps the sandbox alive even when the orchestrator parent
   * has gone Idle after a background delegation. For foreground delegation the
   * parent itself stays in ExecutingTool while it awaits the worker.
   *
   * Idle and WaitingForToolConfirmation are intentionally treated as inactive:
   * the former means nothing is in flight, and the latter is gated on a human
   * decision and must not pin a sandbox open indefinitely.
   */
  private hasActiveDroolWorkingState(): boolean {
    for (const state of this.sessionStates.values()) {
      switch (state.workingState) {
        case DroolWorkingState.Idle:
        case DroolWorkingState.WaitingForToolConfirmation:
          continue;
        case DroolWorkingState.Thinking:
        case DroolWorkingState.StreamingAssistantMessage:
        case DroolWorkingState.ExecutingTool:
        case DroolWorkingState.CompactingConversation:
          return true;
        default: {
          // Forwards compatibility: a newer client/protocol could report a
          // working state this daemon's enum doesn't know. Treat it as
          // inactive and keep scanning rather than throwing on the
          // heartbeat path.
          const exhaustiveCheck: never = state.workingState;
          logError('Unknown drool working state', { value: exhaustiveCheck });
          continue;
        }
      }
    }
    return false;
  }

  public async safeExtendSessionTimeout(sessionId: string): Promise<void> {
    // Only extend if the session still exists
    if (!this.droolClients.has(sessionId)) {
      return;
    }

    this.activityClock.update();

    // Check if another call is already extending this session's timeout
    const existingPromise = this.extendingTimeouts.get(sessionId);
    if (existingPromise) {
      return existingPromise;
    }

    // Create and track the extension promise
    const extensionPromise = this.extendSessionTimeout(sessionId);

    this.extendingTimeouts.set(sessionId, extensionPromise);
    return extensionPromise;
  }

  /**
   * Cancels scheduled cleanup for a session (e.g., when client reconnects)
   */
  private cancelSessionTimeout(sessionId: string): void {
    const state = this.sessionStates.get(sessionId);
    if (state?.timeout) {
      clearTimeout(state.timeout);
      state.timeout = undefined;
    }
  }

  private emitActiveListenerLifecycleEvent(
    event: ActiveListenerLifecycleEvent
  ): void {
    for (const subscriber of this.activeListenerLifecycleSubscribers) {
      try {
        subscriber(event);
      } catch (error) {
        logException(error, 'Active listener lifecycle subscriber failed', {
          eventType: event.type,
          sessionId: event.sessionId,
        });
      }
    }
  }
}
