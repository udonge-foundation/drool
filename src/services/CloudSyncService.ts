import { UpdateSessionMissionSyncMode } from '@industry/common/api/backend/enums';
import {
  MachineConnectionType,
  SessionPrivacyLevel,
} from '@industry/common/session';
import { SessionSettings } from '@industry/common/session/settings';
import { fetch } from '@industry/drool-core/api/fetch';
import {
  SessionSource,
  SessionTag,
} from '@industry/drool-sdk-ext/protocol/session';
import { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logWarn } from '@industry/logging';
import { FetchError, HttpStatusCode } from '@industry/logging/errors';
import { retry } from '@industry/utils/function';

import { getRuntimeAuthConfig } from '@/environment';
import { stripPdfDataFromMessage } from '@/services/message-converters';
import { SHUTDOWN_HOOK_PRIORITY } from '@/utils/constants';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';

import type { UpdateSessionMissionRequest } from '@industry/common/api/backend';
import type { IndustryMissionArtifactMetadata } from '@industry/common/session';

/**
 * CloudSync depends entirely on Industry's `/api/sessions/*` routes, which
 * are forbidden in airgap mode. We resolve airgap once per call so toggling
 * the env between tests behaves consistently.
 */
function isAirgapEnabled(): boolean {
  try {
    return getRuntimeAuthConfig().airgapEnabled === true;
  } catch {
    return false;
  }
}

const CLOUD_SYNC_FLUSH_TIMEOUT_MS = 5000;
const CLOUD_SYNC_SHUTDOWN_HOOK_NAME = 'cloud-sync-flush';

// Retry create so transient failures do not strand backend sessions.
const SESSION_CREATE_MAX_ATTEMPTS = 6;
const SESSION_CREATE_RETRY_BASE_DELAY_MS = 500;
const MISSING_SESSION_STATUS_CODES = new Set([
  HttpStatusCode.NotFound,
  HttpStatusCode.Gone,
]);

interface SyncSessionCreateParams {
  sessionId: string;
  title: string;
  /**
   * Legacy/display connection classification retained for backend
   * compatibility while host-backed routing migrates to `hostId`.
   *
   * @deprecated Do not use for session identity, merge keys, or resume routing.
   */
  machineConnectionType: MachineConnectionType;
  parentSessionId?: string;
  callingSessionId?: string;
  callingToolUseId?: string;
  /** Durable execution-store identity for host-backed sessions. */
  hostId?: string;
  /**
   * Legacy remote-access Computer capability identifier.
   *
   * @deprecated Resolve the active Computer by `hostId` at access time for
   * host-backed sessions.
   */
  computerId?: string;
  sessionLocation?: string;
  sessionSource?: SessionSource;
  tags?: SessionTag[];
  privacyLevel?: SessionPrivacyLevel | 'private' | 'organization';
  selectedWorkspaceId?: string;
  workspaceSandboxId?: string;
  cwd?: string;
}

interface SyncMissionMetadataOptions {
  syncMode?: UpdateSessionMissionSyncMode;
}

/**
 * Encapsulates all daemon-to-backend cloud sync operations.
 *
 * All methods are fire-and-forget with error logging — the daemon's local
 * state is the source of truth; cloud persistence is best-effort.
 *
 * All calls go to the internal `/api/sessions/...` routes (NOT the v0 API)
 * to avoid circular callback loops between the backend and the daemon.
 */
export class CloudSyncService {
  private pendingSyncs = new Set<Promise<unknown>>();

  private sessionCreateBodies = new Map<string, string>();

  /** Per-session create promises used to order follow-up syncs. */
  private sessionCreatePromises = new Map<string, Promise<void>>();

  /**
   * Last title we attempted to sync per session. Used to dedupe redundant
   * title syncs from different callers (fallback title, first-message stage,
   * first-file-edit stage, manual rename) so a single bad title doesn't
   * amplify into multiple backend errors.
   */
  private lastSyncedTitles = new Map<string, string>();

  private lastSyncedMissionMetadata = new Map<string, string>();

  private missionMetadataSyncPromises = new Map<string, Promise<boolean>>();

  private track<T>(promise: Promise<T>): Promise<T> {
    const trackedPromise = promise.finally(() => {
      this.pendingSyncs.delete(trackedPromise);
    });
    this.pendingSyncs.add(trackedPromise);
    return trackedPromise;
  }

  /** Waits only if this process still has a pending create for this session. */
  private async awaitSessionCreate(sessionId: string): Promise<void> {
    const pending = this.sessionCreatePromises.get(sessionId);
    if (!pending) return;
    try {
      await pending;
    } catch {
      // syncSessionCreate already logs failures; never block follow-ups.
    }
  }

  private getStatusCode(error: unknown): number | undefined {
    return error instanceof FetchError ? error.response.status : undefined;
  }

  private async attemptSessionCreate(
    sessionId: string,
    body: string
  ): Promise<boolean> {
    return retry(
      async (): Promise<boolean> => {
        await fetch('/api/sessions/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        return true;
      },
      {
        retries: SESSION_CREATE_MAX_ATTEMPTS,
        delay: SESSION_CREATE_RETRY_BASE_DELAY_MS,
        exponentialBackoff: true,
        getDelay: (_error, attempt) =>
          SESSION_CREATE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        onRetry: (error, attempt) => {
          const statusCode = this.getStatusCode(error);
          logWarn('Cloud sync session create attempt failed', {
            cause: error,
            sessionId,
            attempt,
            maxAttempts: SESSION_CREATE_MAX_ATTEMPTS,
            statusCode,
          });
        },
        onAllError: (error) => {
          logWarn('Failed to persist session to cloud after retries', {
            cause: error,
            sessionId,
            maxAttempts: SESSION_CREATE_MAX_ATTEMPTS,
          });
          return Promise.resolve(false);
        },
      }
    )();
  }

  private async selfHealMissingSession(
    sessionId: string,
    operation: string
  ): Promise<boolean> {
    const body = this.sessionCreateBodies.get(sessionId);
    if (!body) {
      logWarn('Cloud sync cannot self-heal missing session', {
        sessionId,
        actionType: operation,
      });
      return false;
    }

    logWarn('Cloud sync self-healing missing session', {
      sessionId,
      actionType: operation,
    });
    return this.attemptSessionCreate(sessionId, body);
  }

  private async syncAfterCreateResult(
    sessionId: string,
    operation: string,
    sync: () => Promise<void>,
    logFailure: (error: unknown) => void
  ): Promise<boolean> {
    await this.awaitSessionCreate(sessionId);
    // If no create was pending, or the pending create settled but the backend
    // still lacks the session, this follow-up sync returns 404/410 and we
    // replay create once before retrying the follow-up.
    try {
      await sync();
      return true;
    } catch (error) {
      const statusCode = this.getStatusCode(error);
      logFailure(error);
      if (!statusCode || !MISSING_SESSION_STATUS_CODES.has(statusCode)) {
        return false;
      }

      const healed = await this.selfHealMissingSession(sessionId, operation);
      if (!healed) return false;

      try {
        await sync();
        return true;
      } catch (retryError) {
        logWarn('Cloud sync retry after self-heal failed', {
          cause: retryError,
          sessionId,
          actionType: operation,
          statusCode: this.getStatusCode(retryError),
        });
        return false;
      }
    }
  }

  private async syncAfterCreate(
    sessionId: string,
    operation: string,
    sync: () => Promise<void>,
    logFailure: (error: unknown) => void
  ): Promise<void> {
    await this.syncAfterCreateResult(sessionId, operation, sync, logFailure);
  }

  async flush(timeoutMs: number = CLOUD_SYNC_FLUSH_TIMEOUT_MS): Promise<void> {
    const pendingSyncs = Array.from(this.pendingSyncs);
    if (pendingSyncs.length === 0) {
      return;
    }

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      const timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
      timeoutId.unref?.();
    });

    const result = await Promise.race([
      Promise.allSettled(pendingSyncs).then(() => 'completed' as const),
      timeoutPromise,
    ]);

    if (result === 'timeout') {
      logWarn('Timed out waiting for cloud sync flush', {
        pendingRequestCount: pendingSyncs.length,
        timeout: timeoutMs,
      });
    }
  }

  syncSessionCreate(params: SyncSessionCreateParams): Promise<void> {
    if (isAirgapEnabled()) return Promise.resolve();
    const body = JSON.stringify({
      id: params.sessionId,
      title: params.title,
      isStarted: false,
      version: 2,
      machineConnectionType: params.machineConnectionType,
      parent: params.parentSessionId,
      callingSessionId: params.callingSessionId,
      callingToolUseId: params.callingToolUseId,
      hostId: params.hostId,
      computerId: params.computerId,
      location: params.sessionLocation,
      sessionSource: params.sessionSource,
      tags: params.tags,
      privacyLevel: params.privacyLevel,
      selectedWorkspaceId: params.selectedWorkspaceId,
      workspaceSandboxId: params.workspaceSandboxId,
      originalWorkingDirectory: params.cwd || undefined,
    });

    this.sessionCreateBodies.set(params.sessionId, body);
    const tracked = this.track(
      this.attemptSessionCreate(params.sessionId, body).then(() => undefined)
    );
    // Queue same-session syncs behind create, then clear it.
    this.sessionCreatePromises.set(params.sessionId, tracked);
    void tracked.finally(() => {
      if (this.sessionCreatePromises.get(params.sessionId) === tracked) {
        this.sessionCreatePromises.delete(params.sessionId);
      }
    });
    return tracked;
  }

  syncDroolStatus(
    sessionId: string,
    status: string,
    processId: number | null
  ): Promise<void> {
    if (isAirgapEnabled()) return Promise.resolve();
    return this.track(
      this.syncAfterCreate(
        sessionId,
        'drool-status',
        async () => {
          await fetch(`/api/sessions/${sessionId}/drool-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              droolStatus: status,
              droolProcessId: processId,
            }),
          });
        },
        (error) => {
          logWarn('Failed to sync drool status to cloud', {
            cause: error,
            sessionId,
            statusCode: this.getStatusCode(error),
          });
        }
      )
    );
  }

  syncSessionTitle(sessionId: string, title: string): Promise<void> {
    if (isAirgapEnabled()) return Promise.resolve();
    if (this.lastSyncedTitles.get(sessionId) === title) {
      return Promise.resolve();
    }
    this.lastSyncedTitles.set(sessionId, title);

    return this.track(
      this.syncAfterCreate(
        sessionId,
        'title',
        async () => {
          await fetch(`/api/sessions/${sessionId}/update-title`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title }),
          });
        },
        (error) => {
          logException(error, 'Failed to sync session title to cloud', {
            sessionId,
            statusCode: this.getStatusCode(error),
          });
        }
      )
    );
  }

  syncSessionArchive(sessionId: string): Promise<void> {
    if (isAirgapEnabled()) return Promise.resolve();
    return this.track(
      this.syncAfterCreate(
        sessionId,
        'archive',
        async () => {
          await fetch(`/api/sessions/${sessionId}/archive`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
        },
        (error) => {
          logException(error, 'Failed to sync session archive to cloud', {
            sessionId,
            statusCode: this.getStatusCode(error),
          });
        }
      )
    );
  }

  syncSessionUnarchive(sessionId: string): Promise<void> {
    if (isAirgapEnabled()) return Promise.resolve();
    return this.track(
      this.syncAfterCreate(
        sessionId,
        'unarchive',
        async () => {
          await fetch(`/api/sessions/${sessionId}/unarchive`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
        },
        (error) => {
          logException(error, 'Failed to sync session unarchive to cloud', {
            sessionId,
            statusCode: this.getStatusCode(error),
          });
        }
      )
    );
  }

  syncSessionSettings(
    sessionId: string,
    settings: SessionSettings
  ): Promise<void> {
    if (isAirgapEnabled()) return Promise.resolve();
    return this.track(
      this.syncAfterCreate(
        sessionId,
        'settings',
        async () => {
          await fetch(`/api/sessions/${sessionId}/update-settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionSettings: settings }),
          });
        },
        (error) => {
          logWarn('Failed to sync session settings to cloud', {
            cause: error,
            sessionId,
            statusCode: this.getStatusCode(error),
          });
        }
      )
    );
  }

  syncMissionMetadata(
    sessionId: string,
    mission: IndustryMissionArtifactMetadata,
    options: SyncMissionMetadataOptions = {}
  ): Promise<boolean> {
    if (isAirgapEnabled()) return Promise.resolve(false);
    const requestBody = {
      mission,
      ...(options.syncMode === UpdateSessionMissionSyncMode.Backfill
        ? { syncMode: UpdateSessionMissionSyncMode.Backfill }
        : {}),
    } satisfies UpdateSessionMissionRequest;
    const serializedMission = JSON.stringify(requestBody);
    const shouldCacheMissionMetadata =
      options.syncMode !== UpdateSessionMissionSyncMode.Backfill;
    if (
      shouldCacheMissionMetadata &&
      this.lastSyncedMissionMetadata.get(sessionId) === serializedMission
    ) {
      return Promise.resolve(true);
    }

    const previousMissionSync =
      this.missionMetadataSyncPromises.get(sessionId) ?? Promise.resolve();
    const missionSync = previousMissionSync
      .catch(() => undefined)
      .then(async () => {
        if (
          shouldCacheMissionMetadata &&
          this.lastSyncedMissionMetadata.get(sessionId) === serializedMission
        ) {
          return true;
        }

        const didSync = await this.syncAfterCreateResult(
          sessionId,
          'mission-metadata',
          async () => {
            await fetch(`/api/sessions/${sessionId}/mission/metadata`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: serializedMission,
            });
          },
          (error) => {
            logWarn('Failed to sync mission metadata to cloud', {
              cause: error,
              sessionId,
              statusCode: this.getStatusCode(error),
            });
          }
        );
        if (didSync && shouldCacheMissionMetadata) {
          this.lastSyncedMissionMetadata.set(sessionId, serializedMission);
        }
        return didSync;
      });
    this.missionMetadataSyncPromises.set(sessionId, missionSync);
    void missionSync.finally(() => {
      if (this.missionMetadataSyncPromises.get(sessionId) === missionSync) {
        this.missionMetadataSyncPromises.delete(sessionId);
      }
    });

    return this.track(missionSync);
  }

  syncMessage(sessionId: string, message: IndustryDroolMessage): Promise<void> {
    if (isAirgapEnabled()) return Promise.resolve();
    const strippedMessage = stripPdfDataFromMessage(message);
    return this.track(
      this.syncAfterCreate(
        sessionId,
        'message',
        async () => {
          await fetch(`/api/sessions/${sessionId}/message/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: strippedMessage }),
          });
        },
        (error) => {
          logWarn('Failed to persist message remotely', {
            cause: error,
            sessionId,
            statusCode: this.getStatusCode(error),
          });
        }
      )
    );
  }
}

let cloudSyncServiceInstance: CloudSyncService | undefined;
let shutdownHookRegistered = false;

function registerCloudSyncShutdownHook(): void {
  if (shutdownHookRegistered) {
    return;
  }
  shutdownHookRegistered = true;

  getShutdownCoordinator().registerHook(
    CLOUD_SYNC_SHUTDOWN_HOOK_NAME,
    async () => {
      await cloudSyncServiceInstance?.flush();
    },
    {
      priority: SHUTDOWN_HOOK_PRIORITY.Default,
      timeoutMs: CLOUD_SYNC_FLUSH_TIMEOUT_MS,
    }
  );
}

export function getCloudSyncService(): CloudSyncService {
  if (!cloudSyncServiceInstance) {
    cloudSyncServiceInstance = new CloudSyncService();
  }
  registerCloudSyncShutdownHook();
  return cloudSyncServiceInstance;
}
