import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  CronRecordSchema,
  type CronRecord,
  type CronScope,
  type CronStatus,
  type DaemonCreateCronRequestParams,
  type DaemonCronStateChangedNotificationParams,
} from '@industry/common/daemon';
import { logWarn, Metrics } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { sanitizePathToDirectoryName } from '@industry/utils/sessionPaths';

interface CronRegistryOptions {
  cronsDir: string;
  onChange?: (event: DaemonCronStateChangedNotificationParams) => void;
}

interface ListCronsOptions {
  sessionId?: string;
  includeInactive?: boolean;
}

type SessionCronRecord = Extract<CronRecord, { kind: 'session_prompt' }>;
type RootCronRecord = Extract<CronRecord, { kind: 'root_prompt' }>;
type CronRecordPatch = {
  status?: CronStatus;
  schedule?: CronRecord['schedule'];
  stats?: CronRecord['stats'];
  payload?: CronRecord['payload'];
  heldAt?: string;
  holdReason?: string;
};

function isSessionPromptPayload(
  payload: CronRecord['payload'] | undefined
): payload is SessionCronRecord['payload'] {
  return payload?.target.type === 'same_session';
}

function isRootPromptPayload(
  payload: CronRecord['payload'] | undefined
): payload is RootCronRecord['payload'] {
  return payload?.target.type === 'new_session';
}

const RUNTIME_STATUSES = new Set<CronStatus>(['active', 'running']);
const INACTIVE_STATUSES = new Set<CronStatus>(['cancelled', 'expired']);
const CRON_DAEMON_METRIC = 'daemon_cron_operation_count';

function createCronId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

function logCronOperation(
  method: string,
  labels: {
    source?: string;
    status?: string;
    type?: string;
  } = {},
  count: number = 1
): void {
  Metrics.addToCounter(CRON_DAEMON_METRIC, count, { method, ...labels });
}

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  if (process.platform !== 'win32') {
    fs.chmodSync(dirPath, 0o700);
  }
}

function assertSafeCronSessionId(sessionId: string): void {
  if (
    !sessionId ||
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('..') ||
    sessionId.includes('\0')
  ) {
    throw new MetaError('Invalid cron session ID', {
      reason: 'invalid_cron_session_id',
    });
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureDirectory(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  if (process.platform !== 'win32') {
    fs.chmodSync(tmpPath, 0o600);
  }
  fs.renameSync(tmpPath, filePath);
}

function normalizeCronRecord(cron: CronRecord): CronRecord {
  if (cron.kind === 'root_prompt') {
    return cron;
  }

  return {
    ...cron,
    scope: {
      ...cron.scope,
      storageDir: sanitizePathToDirectoryName(cron.scope.sessionCwd),
    },
  };
}

function getSessionPromptPayload(
  cron: SessionCronRecord,
  patch: CronRecordPatch
): SessionCronRecord['payload'] {
  return isSessionPromptPayload(patch.payload) ? patch.payload : cron.payload;
}

function getRootPromptPayload(
  cron: RootCronRecord,
  patch: CronRecordPatch
): RootCronRecord['payload'] {
  return isRootPromptPayload(patch.payload) ? patch.payload : cron.payload;
}

export class CronRegistry {
  private readonly cronsDir: string;

  private readonly onChange?: (
    event: DaemonCronStateChangedNotificationParams
  ) => void;

  constructor(options: CronRegistryOptions) {
    this.cronsDir = options.cronsDir;
    this.onChange = options.onChange;
    ensureDirectory(this.cronsDir);
  }

  createCron(params: DaemonCreateCronRequestParams): CronRecord {
    const timestamp = new Date().toISOString();
    const baseCron = {
      version: 1,
      id: createCronId(),
      status: 'active',
      source: params.source,
      schedule: {
        expression: params.schedule.expression,
        recurring: params.schedule.recurring,
        timezone: 'UTC',
      },
      stats: { fireCount: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    } as const;
    const cron =
      params.kind === 'root_prompt'
        ? CronRecordSchema.parse({
            ...baseCron,
            kind: 'root_prompt',
            scope: params.scope,
            runPolicy: params.runPolicy ?? {
              whenSessionInactive: 'run_in_background',
            },
            payload: params.payload,
          })
        : CronRecordSchema.parse({
            ...baseCron,
            kind: 'session_prompt',
            scope: {
              ...params.scope,
              storageDir: sanitizePathToDirectoryName(params.scope.sessionCwd),
            },
            runPolicy: params.runPolicy ?? { whenSessionInactive: 'hold' },
            payload: params.payload,
          });

    this.writeCron(cron);
    this.emitChange('created', [cron.id], [cron]);
    logCronOperation('create', {
      source: cron.source,
      status: cron.status,
      type: cron.kind,
    });
    return cron;
  }

  listCrons(options: ListCronsOptions = {}): CronRecord[] {
    logCronOperation('list');
    const crons = this.readAllCrons();
    return crons
      .filter((cron) => {
        if (!options.includeInactive && INACTIVE_STATUSES.has(cron.status)) {
          return false;
        }
        if (options.sessionId) {
          return (
            cron.scope.type === 'session' &&
            cron.scope.sessionId === options.sessionId
          );
        }
        return true;
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listRuntimeCrons(): CronRecord[] {
    return this.readAllCrons().filter((cron) =>
      RUNTIME_STATUSES.has(cron.status)
    );
  }

  getCron(cronId: string, sessionId?: string): CronRecord | null {
    return (
      this.readAllCrons().find((cron) => {
        if (cron.id !== cronId) return false;
        if (!sessionId) return true;
        return (
          cron.scope.type === 'session' && cron.scope.sessionId === sessionId
        );
      }) ?? null
    );
  }

  updateCron(
    cronId: string,
    patch: CronRecordPatch,
    sessionId?: string
  ): CronRecord | null {
    const cron = this.getCron(cronId, sessionId);
    if (!cron) return null;

    const updatedAt = new Date().toISOString();
    const updated = CronRecordSchema.parse(
      cron.kind === 'root_prompt'
        ? {
            ...cron,
            status: patch.status ?? cron.status,
            schedule: patch.schedule
              ? { ...cron.schedule, ...patch.schedule }
              : cron.schedule,
            stats: patch.stats ? { ...cron.stats, ...patch.stats } : cron.stats,
            payload: getRootPromptPayload(cron, patch),
            updatedAt,
          }
        : normalizeCronRecord({
            ...cron,
            status: patch.status ?? cron.status,
            schedule: patch.schedule
              ? { ...cron.schedule, ...patch.schedule }
              : cron.schedule,
            stats: patch.stats ? { ...cron.stats, ...patch.stats } : cron.stats,
            payload: getSessionPromptPayload(cron, patch),
            heldAt: patch.heldAt ?? cron.heldAt,
            holdReason: patch.holdReason ?? cron.holdReason,
            updatedAt,
          })
    );
    this.writeCron(updated);
    this.emitChange('updated', [updated.id], [updated]);
    logCronOperation('update', {
      source: updated.source,
      status: updated.status,
      type: updated.kind,
    });
    return updated;
  }

  deleteCron(cronId: string, sessionId?: string): boolean {
    const cron = this.getCron(cronId, sessionId);
    if (!cron) return false;

    const cancelled = CronRecordSchema.parse(
      normalizeCronRecord({
        ...cron,
        status: 'cancelled',
        updatedAt: new Date().toISOString(),
      })
    );
    this.writeCron(cancelled);
    this.emitChange('deleted', [cancelled.id], [cancelled]);
    logCronOperation('delete', {
      source: cancelled.source,
      status: cancelled.status,
      type: cancelled.kind,
    });
    return true;
  }

  holdSessionCrons(sessionId: string, reason: string): number {
    const crons = this.listCrons({ sessionId });
    let heldCount = 0;
    for (const cron of crons) {
      if (
        cron.scope.type !== 'session' ||
        (cron.status !== 'active' && cron.status !== 'running') ||
        cron.runPolicy.whenSessionInactive !== 'hold'
      ) {
        continue;
      }
      this.updateCron(cron.id, {
        status: 'held',
        heldAt: new Date().toISOString(),
        holdReason: reason,
      });
      heldCount++;
    }
    logCronOperation('hold_session_crons', {}, heldCount);
    return heldCount;
  }

  resumeSessionCrons(sessionId: string): number {
    const crons = this.listCrons({ sessionId, includeInactive: true });
    let resumedCount = 0;
    for (const cron of crons) {
      if (cron.status !== 'held') {
        continue;
      }
      if (cron.kind !== 'session_prompt' || cron.scope.type !== 'session') {
        continue;
      }
      this.createCron({
        kind: cron.kind,
        source: cron.source,
        scope: {
          type: 'session',
          sessionId: cron.scope.sessionId,
          sessionCwd: cron.scope.sessionCwd,
        },
        schedule: {
          expression: cron.schedule.expression,
          recurring: cron.schedule.recurring,
        },
        runPolicy: cron.runPolicy,
        payload: cron.payload,
      });
      this.updateCron(cron.id, {
        status: 'cancelled',
      });
      resumedCount++;
    }
    logCronOperation('resume_session_crons', {}, resumedCount);
    return resumedCount;
  }

  private readAllCrons(): CronRecord[] {
    const records: CronRecord[] = [];
    if (!fs.existsSync(this.cronsDir)) {
      return records;
    }

    const visit = (dirPath: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch (error) {
        logWarn('[CronRegistry] Failed to read cron directory', {
          cause: error,
        });
        return;
      }

      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          visit(entryPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue;
        }
        try {
          records.push(
            CronRecordSchema.parse(
              JSON.parse(fs.readFileSync(entryPath, 'utf-8'))
            )
          );
        } catch (error) {
          logWarn('[CronRegistry] Skipping invalid cron file', {
            cause: error,
          });
        }
      }
    };

    visit(this.cronsDir);
    return records;
  }

  private writeCron(cron: CronRecord): void {
    const normalized = normalizeCronRecord(cron);
    writeJsonFile(
      this.getCronPath(normalized.scope, normalized.id),
      normalized
    );
  }

  private getCronPath(scope: CronScope, cronId: string): string {
    if (scope.type === 'root') {
      return path.join(this.cronsDir, 'root', `${cronId}.json`);
    }

    assertSafeCronSessionId(scope.sessionId);
    return path.join(
      this.cronsDir,
      sanitizePathToDirectoryName(scope.sessionCwd),
      scope.sessionId,
      `${cronId}.json`
    );
  }

  private emitChange(
    reason: DaemonCronStateChangedNotificationParams['reason'],
    cronIds: string[],
    crons?: CronRecord[]
  ): void {
    this.onChange?.({
      reason,
      cronIds,
      ...(crons ? { crons } : {}),
    });
  }
}
