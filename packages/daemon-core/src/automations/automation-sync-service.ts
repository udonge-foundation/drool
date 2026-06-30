import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  AutomationStatus,
  AutomationTriggerType,
} from '@industry/common/api/v0/automations';
import {
  AUTOMATION_HEARTBEAT_FILE,
  AUTOMATION_VISUAL_FILE,
} from '@industry/common/automations';
import { logInfo, logWarn, Metric, Metrics } from '@industry/logging';
import { getActiveOrganizationId, getAuthToken } from '@industry/runtime/auth';
import {
  buildAutomationRunLabels,
  decideVisualPolicy,
  VisualPolicyBranch,
} from '@industry/utils/automations';
import { parseFrontmatter } from '@industry/utils/frontmatter';

import { readAutomationState } from './automation-state';
import { syncAutomationsToBackend, uploadVisualToBackend } from './sync';
import { ActiveListenerLifecycleEventType } from '../drool/enums';

import type { AutomationVisualBaseline, TrackedSessionInfo } from './types';
import type { DroolRegistry } from '../drool/drool-registry';
import type { Automation } from '@industry/common/api/v0/automations';
import type {
  AutomationDescriptor,
  AutomationDiscoveryResult,
  ValidAutomationDescriptor,
} from '@industry/common/automations';
import type { RuntimeAuthConfig } from '@industry/runtime/auth';

type FailureReason =
  | 'workflow_failed'
  | 'workflow_start_failed'
  | 'dispatch_skipped'
  | 'dispatch_failed'
  | 'dispatch_exception'
  | 'visual_missing'
  | 'visual_unchanged'
  | 'visual_non_compliant'
  | 'invalid_session_id';

const SYNC_COOLDOWN_MS = 30_000;

/**
 * Interval for the background reconcile sync. The daemon otherwise syncs only
 * after an automation run, so without this a delete made from the web (which
 * tombstones Firestore but cannot reach this machine's files) would not be
 * cleaned up until the next run. Paired with an on-startup sync in `start()`.
 */
const PERIODIC_SYNC_INTERVAL_MS = 60_000;

interface AutomationSyncServiceConfig {
  homeDir: string;
  machineId: string;
  apiBaseUrl: string;
  runtimeAuthConfig: RuntimeAuthConfig;
  registry: DroolRegistry;
}

const VISUAL_RETENTION_COUNT = 25;
const RUN_OUTCOME_VISUAL_FILES = Array.from(
  new Set([AUTOMATION_VISUAL_FILE, 'visual.html', 'visual.md', 'VISUAL.md'])
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reduce a session id to a filesystem-safe component for visual snapshot
 * filenames. Real sessions are uuidv4, but treat the id as untrusted input
 * regardless: strip path separators and any non `[A-Za-z0-9._-]` characters,
 * trim leading dots/dashes, and cap the length. Returns an empty string if
 * the result is empty or only consists of `.`/`..` (which would still be
 * unsafe as a filename).
 */
function sanitizeSessionIdForFilename(sessionId: string): string {
  if (UUID_RE.test(sessionId)) {
    return sessionId;
  }
  const cleaned = sessionId
    .replace(/[^A-Za-z0-9._-]+/g, '')
    .replace(/^[.-]+/, '')
    .slice(0, 64);
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return '';
  }
  return cleaned;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String(error.code) === 'ENOENT'
  );
}

function getChangedVisualFile(
  baseline: AutomationVisualBaseline | undefined,
  current: AutomationVisualBaseline
): string | undefined {
  for (const fileName of RUN_OUTCOME_VISUAL_FILES) {
    const currentFingerprint = current[fileName];
    if (!currentFingerprint) {
      continue;
    }
    const baselineFingerprint = baseline?.[fileName];
    if (
      !baselineFingerprint ||
      baselineFingerprint.sha256 !== currentFingerprint.sha256 ||
      baselineFingerprint.size !== currentFingerprint.size
    ) {
      return fileName;
    }
  }
  return undefined;
}

export class AutomationSyncService {
  private readonly trackedSessions = new Map<string, TrackedSessionInfo>();

  private readonly createOutcomeEvaluated = new Set<string>();

  /**
   * Fingerprint (`<sha256>:<byteLength>`) of the VISUAL.html most recently
   * published for a session. Used to re-publish on later idles only when the
   * on-disk visual actually changed, so a single run can keep the dashboard in
   * sync across multiple agent turns without redundant uploads.
   */
  private readonly lastPublishedHtmlFingerprint = new Map<string, string>();

  private readonly visualPublishQueues = new Map<string, Promise<void>>();

  private readonly trackedSyncQueues = new Map<string, Promise<void>>();

  private lastSyncAt = 0;

  private periodicSyncTimer: ReturnType<typeof setInterval> | undefined;

  private readonly homeDir: string;

  private readonly machineId: string;

  private readonly apiBaseUrl: string;

  private readonly runtimeAuthConfig: RuntimeAuthConfig;

  constructor(config: AutomationSyncServiceConfig) {
    this.homeDir = config.homeDir;
    this.machineId = config.machineId;
    this.apiBaseUrl = config.apiBaseUrl;
    this.runtimeAuthConfig = config.runtimeAuthConfig;
    config.registry.subscribeToActiveListenerLifecycle((event) => {
      if (event.type === ActiveListenerLifecycleEventType.SessionClosed) {
        this.onSessionClosed(event.sessionId);
      }
    });
  }

  /**
   * Begin background syncing: run one sync now (catches deletes that landed
   * while the daemon was offline) and schedule a periodic reconcile on
   * PERIODIC_SYNC_INTERVAL_MS (see that constant for why). Idempotent; call
   * once per daemon. Kept out of the constructor so unit tests can construct
   * without timers.
   */
  start(): void {
    if (this.periodicSyncTimer) {
      return;
    }
    void this.syncNow();
    this.periodicSyncTimer = setInterval(() => {
      void this.syncNow();
    }, PERIODIC_SYNC_INTERVAL_MS);
    // Don't keep the process alive solely for the reconcile timer.
    this.periodicSyncTimer.unref?.();
  }

  /** Stop the periodic reconcile timer. */
  dispose(): void {
    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = undefined;
    }
  }

  registerAutomationRun(sessionId: string, info: TrackedSessionInfo): void {
    this.trackedSessions.set(sessionId, info);
  }

  static async captureVisualBaseline(
    automationPath: string,
    seed?: AutomationVisualBaseline
  ): Promise<AutomationVisualBaseline> {
    const filesToRead = RUN_OUTCOME_VISUAL_FILES.filter(
      (fileName) => !seed || !(fileName in seed)
    );
    const entries = await Promise.all(
      filesToRead.map(async (fileName) => {
        try {
          const filePath = path.join(automationPath, fileName);
          // realpath canonicalizes the entry on case-insensitive filesystems
          // (macOS APFS, Windows NTFS) so e.g. `VISUAL.html` and
          // `visual.html` collapse to a single fingerprint instead of being
          // counted as two separate "changed" candidates.
          let canonicalKey: string;
          try {
            canonicalKey = await fs.promises.realpath(filePath);
          } catch (realpathError) {
            if (!isMissingFileError(realpathError)) {
              logWarn(
                '[AutomationSyncService] realpath failed; falling back to literal path',
                { cause: realpathError, fileName }
              );
            }
            canonicalKey = filePath;
          }
          const buffer = await fs.promises.readFile(filePath);
          return {
            fileName,
            canonicalKey,
            fingerprint: {
              sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
              size: buffer.byteLength,
            },
          };
        } catch (error) {
          if (!isMissingFileError(error)) {
            logWarn(
              '[AutomationSyncService] Failed to fingerprint visual file',
              { cause: error, fileName }
            );
          }
          return null;
        }
      })
    );
    const fingerprints: AutomationVisualBaseline = { ...(seed ?? {}) };
    const seenCanonical = new Set<string>();
    for (const entry of entries) {
      if (!entry || seenCanonical.has(entry.canonicalKey)) continue;
      seenCanonical.add(entry.canonicalKey);
      fingerprints[entry.fileName] = entry.fingerprint;
    }
    return fingerprints;
  }

  snapshotAutomationVisual(sessionId: string): void {
    const info = this.trackedSessions.get(sessionId);
    if (!info) {
      return;
    }
    void this.enqueueVisualPublish(sessionId, info);
  }

  evaluateCreateOutcome(sessionId: string): void {
    const info = this.trackedSessions.get(sessionId);
    if (!info || info.outcome.kind !== 'create') {
      return;
    }
    if (this.createOutcomeEvaluated.has(sessionId)) {
      return;
    }
    this.createOutcomeEvaluated.add(sessionId);
    void this.emitCreateOutcome(info);
  }

  syncTrackedAutomation(sessionId: string): void {
    const info = this.trackedSessions.get(sessionId);
    if (!info) {
      return;
    }

    this.enqueueTrackedAutomationSync(sessionId, info);
  }

  syncAutomation(info: TrackedSessionInfo): void {
    this.enqueueTrackedAutomationSync(
      `manual:${this.getTrackedSyncKey(info)}`,
      info
    );
  }

  private onSessionClosed(sessionId: string): void {
    const info = this.trackedSessions.get(sessionId);
    if (!info) {
      this.createOutcomeEvaluated.delete(sessionId);
      this.lastPublishedHtmlFingerprint.delete(sessionId);
      this.visualPublishQueues.delete(sessionId);
      return;
    }
    const createOutcomeAlreadyEvaluated =
      this.createOutcomeEvaluated.has(sessionId);
    this.trackedSessions.delete(sessionId);
    this.createOutcomeEvaluated.delete(sessionId);

    logInfo(
      '[AutomationSyncService] Automation session closed, triggering sync',
      {
        sessionId,
      }
    );

    if (info.syncRequiresCompleteStructure) {
      this.enqueueTrackedAutomationSync(sessionId, info);
    } else {
      void this.syncNow();
    }

    void this.finalizeClosedSession(
      sessionId,
      info,
      createOutcomeAlreadyEvaluated
    );
  }

  /**
   * On session close, publish any final visual change (the run may have
   * updated VISUAL.html after the last idle) and emit the run/create outcome
   * exactly once. Publishing is change-gated, so this is a no-op upload when
   * the visual already matches what was last published during the session.
   */
  private async finalizeClosedSession(
    sessionId: string,
    info: TrackedSessionInfo,
    createOutcomeAlreadyEvaluated: boolean
  ): Promise<void> {
    try {
      await this.enqueueVisualPublish(sessionId, info);
      if (info.outcome.kind === 'run') {
        await this.emitRunOutcomeIfTracked(info);
      } else if (
        info.outcome.kind === 'create' &&
        !createOutcomeAlreadyEvaluated
      ) {
        await this.emitCreateOutcome(info);
      }
    } finally {
      this.lastPublishedHtmlFingerprint.delete(sessionId);
    }
  }

  private enqueueTrackedAutomationSync(
    sessionId: string,
    info: TrackedSessionInfo
  ): void {
    const key = this.getTrackedSyncKey(info);
    const previous = this.trackedSyncQueues.get(key) ?? Promise.resolve();
    const next = previous
      .catch((error) => {
        logWarn(
          '[AutomationSyncService] Previous tracked automation sync failed',
          { cause: error }
        );
      })
      .then(() => this.syncTrackedAutomationIfReady(sessionId, info));

    this.trackedSyncQueues.set(key, next);
    const cleanup = () => {
      if (this.trackedSyncQueues.get(key) === next) {
        this.trackedSyncQueues.delete(key);
      }
    };
    void next.then(cleanup, cleanup);
  }

  private getTrackedSyncKey(info: TrackedSessionInfo): string {
    return info.automationUuid ?? info.automationId ?? info.automationPath;
  }

  private enqueueVisualPublish(
    sessionId: string,
    info: TrackedSessionInfo
  ): Promise<void> {
    const previous =
      this.visualPublishQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch((error) => {
        logWarn('[AutomationSyncService] Previous visual publish failed', {
          cause: error,
        });
      })
      .then(() => this.publishVisualIfChanged(sessionId, info));

    this.visualPublishQueues.set(sessionId, next);
    const cleanup = () => {
      if (this.visualPublishQueues.get(sessionId) === next) {
        this.visualPublishQueues.delete(sessionId);
      }
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  private async syncTrackedAutomationIfReady(
    sessionId: string,
    info: TrackedSessionInfo
  ): Promise<void> {
    try {
      const { discoverAllAutomations } = await import(
        '@industry/drool-core/automations'
      );
      const discovery = await discoverAllAutomations(this.homeDir);
      const descriptor = discovery.automations.find((automation) =>
        this.matchesTrackedAutomation(automation, info)
      );

      if (
        !descriptor ||
        !descriptor.isValid ||
        !this.hasCompleteAutomationStructure(descriptor)
      ) {
        logInfo(
          '[AutomationSyncService] Skipping tracked automation sync until scaffold is complete',
          {
            sessionId,
            automationId: info.automationId,
          }
        );
        return;
      }

      logInfo('[AutomationSyncService] Syncing tracked automation', {
        sessionId,
        automationId: info.automationId,
      });

      await this.syncNow({
        ignoreCooldown: true,
        discovery: {
          ...discovery,
          automations: [descriptor],
          validCount: 1,
          invalidCount: 0,
        },
      });
    } catch (error) {
      logWarn('[AutomationSyncService] Failed to sync tracked automation', {
        cause: error,
      });
    }
  }

  private matchesTrackedAutomation(
    descriptor: AutomationDescriptor,
    info: TrackedSessionInfo
  ): boolean {
    return (
      descriptor.path === info.automationPath ||
      descriptor.id === info.automationId ||
      descriptor.config?.id === info.automationUuid ||
      descriptor.config?.id === info.automationId
    );
  }

  private hasCompleteAutomationStructure(
    descriptor: ValidAutomationDescriptor
  ): boolean {
    return (
      descriptor.structure.hasHeartbeat &&
      descriptor.structure.hasVisual &&
      descriptor.structure.hasMemoryDir &&
      descriptor.structure.hasReportsDir
    );
  }

  /**
   * Publish the automation's VISUAL.html (snapshot to `visuals/<sessionId>.html`
   * and upload to the backend) when it differs from what was last published for
   * this session. Safe to call on every idle: it no-ops when the on-disk visual
   * is unchanged or missing, so later-turn edits within a single run reliably
   * reach the dashboard without redundant uploads. Outcome metrics are emitted
   * by the caller, not here.
   */
  private async publishVisualIfChanged(
    sessionId: string,
    info: TrackedSessionInfo
  ): Promise<void> {
    const visualSrc = path.join(info.automationPath, AUTOMATION_VISUAL_FILE);

    let content: string;
    try {
      content = await fs.promises.readFile(visualSrc, 'utf-8');
    } catch (readError) {
      logWarn('[AutomationSyncService] No VISUAL.html found', {
        cause: readError,
      });
      return;
    }

    const fingerprint = `${crypto
      .createHash('sha256')
      .update(content)
      .digest('hex')}:${Buffer.byteLength(content, 'utf-8')}`;
    if (this.lastPublishedHtmlFingerprint.get(sessionId) === fingerprint) {
      return;
    }

    // Defensive: constrain sessionId to a safe filename component before
    // composing the snapshot path so a malformed/adversarial id can't
    // traverse outside the visuals directory (e.g. `../../etc/passwd`).
    const safeSessionId = sanitizeSessionIdForFilename(sessionId);
    if (!safeSessionId) {
      logWarn(
        '[AutomationSyncService] Skipping visual snapshot: session id has no safe filename component',
        { sessionId }
      );
      this.emitRunFailure(info, 'invalid_session_id');
      return;
    }

    try {
      // Evaluate the policy for observability but never block publishing:
      // the next scheduled run re-checks VISUAL.html before dispatch and
      // can rebuild, so an imperfect visual is better than a stale one.
      const decision = decideVisualPolicy({
        existingHtml: content,
        isFirstRun: false,
      });
      if (decision.branch === VisualPolicyBranch.Rebuild) {
        // Log-only for local-generation visibility. The visual-compliance
        // counters are emitted solely by the backend publish gate (the single
        // chokepoint for published visuals); emitting here too would
        // double-count the same visual across the daemon and backend sinks.
        logWarn(
          '[AutomationSyncService] Publishing non-compliant visual; next run will rebuild',
          {
            automationId: info.automationId,
            sessionId,
            // eslint-disable-next-line industry/no-nested-log-metadata -- policy decision branch + issue ids consumed as a unit
            value: {
              branch: decision.branch,
              issues: decision.issues.map((issue) => issue.id),
            },
          }
        );
      }
      const visualsDir = path.resolve(info.automationPath, 'visuals');
      const visualDst = path.resolve(visualsDir, `${safeSessionId}.html`);
      // Belt-and-braces: even after sanitization, ensure the resolved path
      // is contained within visualsDir before any write.
      if (!visualDst.startsWith(`${visualsDir}${path.sep}`)) {
        logWarn(
          '[AutomationSyncService] Refusing to snapshot visual outside visuals dir',
          { sessionId, targetPath: visualDst, directory: visualsDir }
        );
        return;
      }

      await fs.promises.mkdir(visualsDir, { recursive: true });
      await fs.promises.writeFile(visualDst, content, 'utf-8');
      await this.pruneVisuals(visualsDir, VISUAL_RETENTION_COUNT);

      logInfo('[AutomationSyncService] Visual snapshot saved', {
        sessionId,
        automationId: info.automationId,
      });

      // Upload to S3 if authenticated (auth + URL resolved inside helper)
      if (info.automationUuid) {
        try {
          const uploaded = await uploadVisualToBackend(
            info.automationUuid,
            sessionId,
            content,
            this.apiBaseUrl,
            this.runtimeAuthConfig
          );
          if (uploaded === false) {
            return;
          }
        } catch (error) {
          // Network errors to S3/backend are transient and should not page
          // Sentry; they're expected during network blips.
          logWarn('[AutomationSyncService] Failed to upload visual to S3', {
            cause: error,
          });
          return;
        }
      }

      this.lastPublishedHtmlFingerprint.set(sessionId, fingerprint);
    } catch (writeError) {
      logWarn('[AutomationSyncService] Failed to publish visual snapshot', {
        cause: writeError,
      });
    }
  }

  private async emitRunOutcomeIfTracked(
    info: TrackedSessionInfo
  ): Promise<void> {
    if (info.outcome.kind !== 'run') {
      return;
    }
    const runLabels = buildAutomationRunLabels({
      executionLocation: info.outcome.executionLocation,
      triggerSource: info.outcome.triggerSource,
    });

    // Execution signal: reaching the run-outcome path means the session ran
    // to completion. Execution success is intentionally independent of the
    // visual; artifact presence (below) and brand compliance (emitted by the
    // backend publish gate) are layered quality signals, not gates. Genuine
    // execution failures (invalid_session_id, and the backend workflow steps:
    // computer_not_found, sandbox_resume_*, …) are emitted via emitRunFailure
    // / the backend, not here.
    Metrics.addToCounter(Metric.AUTOMATION_RUN_SUCCEEDED, 1, runLabels);

    // Artifact signal: did this run produce or refresh a visual?
    await this.emitVisualArtifact(
      Metric.AUTOMATION_RUN_VISUAL_ARTIFACT,
      info,
      runLabels
    );
  }

  private async emitCreateOutcome(info: TrackedSessionInfo): Promise<void> {
    if (info.outcome.kind !== 'create') {
      return;
    }
    const baseLabels = buildAutomationRunLabels({
      executionLocation: info.outcome.executionLocation,
    });

    // Execution signal: reaching the create-outcome path means the create
    // session completed. Execution success is intentionally independent of
    // the visual; artifact presence (below) and brand compliance (emitted by
    // the backend publish gate) are layered quality signals, not gates.
    Metrics.addToCounter(Metric.AUTOMATION_CREATE_SUCCEEDED, 1, baseLabels);

    // Artifact signal: did this create produce or refresh a visual?
    await this.emitVisualArtifact(
      Metric.AUTOMATION_CREATE_VISUAL_ARTIFACT,
      info,
      baseLabels
    );
  }

  /**
   * Emit the artifact signal for a completed run/create: did the session
   * produce or refresh a visual? Compares the visual baseline captured at
   * session start against the current on-disk visuals and buckets the result
   * as `visual_present` / `visual_missing` / `visual_unchanged`. Shared by
   * both outcome emitters so the bucketing stays in one place.
   */
  private async emitVisualArtifact(
    metric: Metric,
    info: TrackedSessionInfo,
    baseLabels: Record<string, string>
  ): Promise<void> {
    if (info.outcome.kind === 'none') {
      return;
    }
    const current = await AutomationSyncService.captureVisualBaseline(
      info.automationPath
    );
    const changedVisualFile = getChangedVisualFile(
      info.outcome.visualBaseline,
      current
    );
    const artifact = changedVisualFile
      ? 'visual_present'
      : Object.keys(current).length === 0
        ? 'visual_missing'
        : 'visual_unchanged';
    Metrics.addToCounter(metric, 1, {
      ...baseLabels,
      artifact,
      ...(changedVisualFile ? { visualFile: changedVisualFile } : {}),
    });
  }

  private emitRunFailure(
    info: TrackedSessionInfo,
    reason: FailureReason
  ): void {
    if (info.outcome.kind !== 'run') {
      return;
    }
    Metrics.addToCounter(Metric.AUTOMATION_RUN_FAILED, 1, {
      ...buildAutomationRunLabels({
        executionLocation: info.outcome.executionLocation,
        triggerSource: info.outcome.triggerSource,
      }),
      reason,
    });
  }

  private async pruneVisuals(visualsDir: string, keep: number): Promise<void> {
    try {
      const files = await fs.promises.readdir(visualsDir);
      if (files.length <= keep) return;

      const stats = await Promise.all(
        files.map(async (name) => {
          try {
            const { mtimeMs } = await fs.promises.stat(
              path.join(visualsDir, name)
            );
            return { name, mtime: mtimeMs };
          } catch (statError) {
            if (!isMissingFileError(statError)) {
              logWarn('[AutomationSyncService] Failed to stat visual', {
                cause: statError,
                name,
              });
            }
            return null;
          }
        })
      );

      const entries = stats.filter(
        (entry): entry is { name: string; mtime: number } => entry !== null
      );
      entries.sort((a, b) => b.mtime - a.mtime);

      const toDelete = entries.slice(keep);
      await Promise.all(
        toDelete.map(async (entry) => {
          try {
            await fs.promises.unlink(path.join(visualsDir, entry.name));
          } catch (unlinkError) {
            if (!isMissingFileError(unlinkError)) {
              logWarn('[AutomationSyncService] Failed to unlink visual', {
                cause: unlinkError,
                name: entry.name,
              });
            }
          }
        })
      );
    } catch (pruneError) {
      logWarn('[AutomationSyncService] Failed to prune visuals', {
        cause: pruneError,
      });
    }
  }

  private async syncNow(options?: {
    ignoreCooldown?: boolean;
    discovery?: AutomationDiscoveryResult;
  }): Promise<void> {
    const now = Date.now();
    if (!options?.ignoreCooldown && now - this.lastSyncAt < SYNC_COOLDOWN_MS) {
      logInfo('[AutomationSyncService] Skipping sync, within cooldown');
      return;
    }
    if (!options?.ignoreCooldown) {
      this.lastSyncAt = now;
    }

    try {
      const token = await getAuthToken(this.runtimeAuthConfig);
      if (!token) {
        logWarn(
          '[AutomationSyncService] No auth token available, skipping sync'
        );
        return;
      }

      let discovery = options?.discovery;
      if (!discovery) {
        const { discoverAllAutomations } = await import(
          '@industry/drool-core/automations'
        );
        discovery = await discoverAllAutomations(this.homeDir);
      }
      const validAutomations = discovery.automations.filter(
        (a): a is ValidAutomationDescriptor => a.isValid
      );

      if (validAutomations.length === 0) {
        return;
      }

      const automations = await this.mapToV0Automations(validAutomations);
      const activeOrganizationId = await getActiveOrganizationId(
        this.runtimeAuthConfig
      );

      const result = await syncAutomationsToBackend(
        automations,
        this.apiBaseUrl,
        token,
        activeOrganizationId
      );

      logInfo('[AutomationSyncService] Sync completed', {
        count: result.synced,
        errorCount: result.errors.length,
      });

      if (result.deleted.length > 0) {
        await this.wipeTombstonedAutomations(result.deleted, discovery);
      }
    } catch (error) {
      // Network errors against the backend are expected during outages or
      // when the user is offline; route to logWarn (console-only) instead
      // of logException (Sentry) to avoid pager noise.
      logWarn('[AutomationSyncService] Sync failed', { cause: error });
    }
  }

  /**
   * Remove the on-disk directories for automations the backend reported as
   * tombstoned. Ids are matched against the just-synced discovery (the same
   * descriptors we reported), and each resolved path is confirmed to live
   * under `homeDir` before removal so a malformed id can never escape the
   * automations tree. Best-effort: a failed removal is logged and retried on
   * the next sync.
   */
  private async wipeTombstonedAutomations(
    deletedIds: string[],
    discovery: AutomationDiscoveryResult
  ): Promise<void> {
    const deletedSet = new Set(deletedIds);
    const resolvedHome = path.resolve(this.homeDir);

    for (const descriptor of discovery.automations) {
      const reportedId = descriptor.config?.id ?? descriptor.id;
      if (!deletedSet.has(reportedId)) {
        continue;
      }

      const resolvedPath = path.resolve(descriptor.path);
      if (
        resolvedPath !== resolvedHome &&
        !resolvedPath.startsWith(resolvedHome + path.sep)
      ) {
        logWarn(
          '[AutomationSyncService] Refusing to wipe automation outside home dir',
          { automationId: reportedId }
        );
        continue;
      }

      try {
        await fs.promises.rm(resolvedPath, { recursive: true, force: true });
        logInfo('[AutomationSyncService] Wiped tombstoned automation files', {
          automationId: reportedId,
        });
      } catch (err) {
        logWarn(
          '[AutomationSyncService] Failed to wipe tombstoned automation',
          {
            automationId: reportedId,
            cause: err,
          }
        );
      }
    }
  }

  private async mapToV0Automations(
    descriptors: ValidAutomationDescriptor[]
  ): Promise<Automation[]> {
    const results: Automation[] = [];

    for (const descriptor of descriptors) {
      try {
        const heartbeatPath = path.join(
          descriptor.path,
          AUTOMATION_HEARTBEAT_FILE
        );
        const content = await fs.promises.readFile(heartbeatPath, 'utf-8');

        const { body } = parseFrontmatter(content);
        const prompt = body.trim();

        // Local state.json is the source of truth for run outcome (the agent
        // writes runCount + lastRunStatus on completion; the poller seeds
        // lastRunAt). Forwarding it on every sync backfills the denormalized
        // doc fields the Software Industry health reads, even for docs whose
        // config backup is suppressed by fileSyncPending.
        const state = readAutomationState(descriptor.path);

        results.push({
          id: descriptor.config.id ?? descriptor.id,
          ownerId: '',
          name: descriptor.config.name,
          description: descriptor.config.description ?? '',
          prompt,
          schedule: descriptor.config.schedule?.cadence ?? '',
          tags: descriptor.config.tags ?? [],
          model: descriptor.config.model,
          templateId: descriptor.config.templateId,
          status: descriptor.config.paused
            ? AutomationStatus.Paused
            : AutomationStatus.Active,
          privacyLevel: descriptor.config.privacyLevel,
          createdBy: descriptor.config.createdBy,
          machineId: this.machineId,
          triggerType: AutomationTriggerType.Schedule,
          forkedFrom: descriptor.config.forkedFrom,
          ...(state?.lastRunAt != null && { lastRunAt: state.lastRunAt }),
          ...(state?.lastRunStatus != null && {
            lastRunStatus: state.lastRunStatus,
          }),
          ...(state?.runCount != null && { runCount: state.runCount }),
          createdAt: 0,
          updatedAt: 0,
        });
      } catch (err) {
        // Skip automations with unreadable HEARTBEAT.md
        logWarn(
          '[AutomationSyncService] Failed to read HEARTBEAT.md for automation, skipping',
          { automationId: descriptor.id, cause: err }
        );
      }
    }

    return results;
  }
}
