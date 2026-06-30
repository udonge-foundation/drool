import fs from 'fs';
import os from 'os';
import path from 'path';

import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { TaskInvocationStatus } from '@/utils/enums';
import {
  loadJsonFileWithBackup,
  mutateJsonFileAtomic,
} from '@/utils/jsonFileStore';
import type {
  TaskInvocationState,
  TaskInvocationStoreData,
  TaskInvocationUpsertInput,
} from '@/utils/types';
import { generateUUID } from '@/utils/uuid';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function emptyStore(): TaskInvocationStoreData {
  return { invocations: [] };
}

function isTaskInvocationState(value: unknown): value is TaskInvocationState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.taskInvocationId === 'string' &&
    typeof record.parentSessionId === 'string' &&
    typeof record.parentToolUseId === 'string' &&
    typeof record.childSessionId === 'string' &&
    typeof record.runInBackground === 'boolean' &&
    typeof record.status === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number'
  );
}

function isTaskInvocationStoreData(
  value: unknown
): value is TaskInvocationStoreData {
  if (!isRecord(value)) {
    return false;
  }
  const { invocations } = value;
  return Array.isArray(invocations) && invocations.every(isTaskInvocationState);
}

function getStorePath(): { storePath: string; backupPath: string } {
  if (process.env.VITEST_WORKER_ID !== undefined) {
    const storePath = path.join(
      os.tmpdir(),
      `industry-task-invocations-${process.pid}.json`
    );
    return { storePath, backupPath: `${storePath}.bak` };
  }

  const storePath = path.join(
    getIndustryHome(),
    getIndustryDirName(),
    'task-invocations.json'
  );
  return { storePath, backupPath: `${storePath}.bak` };
}

function loadStore(): TaskInvocationStoreData {
  const { storePath, backupPath } = getStorePath();
  return loadJsonFileWithBackup(
    storePath,
    backupPath,
    isTaskInvocationStoreData,
    emptyStore
  );
}

async function mutateStore(
  mutator: (store: TaskInvocationStoreData) => TaskInvocationStoreData | void
): Promise<void> {
  const { storePath, backupPath } = getStorePath();
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  await mutateJsonFileAtomic(
    storePath,
    backupPath,
    isTaskInvocationStoreData,
    emptyStore,
    mutator
  );
}

function keyFor(parentSessionId: string, parentToolUseId: string): string {
  return `${parentSessionId}:${parentToolUseId}`;
}

/**
 * Look up the durable Task invocation record for a parent's Task tool use.
 * Use when a parent session needs to re-attach to (or reason about) a child
 * it previously launched, keyed by the launching tool-use id.
 */
export function getTaskInvocation(params: {
  parentSessionId: string;
  parentToolUseId: string;
}): TaskInvocationState | undefined {
  const key = keyFor(params.parentSessionId, params.parentToolUseId);
  return loadStore().invocations.find(
    (invocation) =>
      keyFor(invocation.parentSessionId, invocation.parentToolUseId) === key
  );
}

/**
 * Look up the durable Task invocation record by the child session it spawned.
 * Use on paths that only know the child (e.g. a child terminal notification)
 * and need the owing parent or invocation metadata.
 */
export function getTaskInvocationByChildSessionId(
  childSessionId: string
): TaskInvocationState | undefined {
  return loadStore().invocations.find(
    (invocation) => invocation.childSessionId === childSessionId
  );
}

/**
 * Record (or update) a Task invocation, keyed by parent session + tool-use id.
 * Call when a Task launches or its durable metadata changes; preserves the
 * existing invocation id and creation time on update.
 */
export async function upsertTaskInvocation(
  next: TaskInvocationUpsertInput
): Promise<TaskInvocationState> {
  const now = Date.now();
  let invocation!: TaskInvocationState;
  await mutateStore((store) => {
    const existingIndex = store.invocations.findIndex(
      (candidate) =>
        candidate.parentSessionId === next.parentSessionId &&
        candidate.parentToolUseId === next.parentToolUseId
    );
    const existing =
      existingIndex === -1 ? undefined : store.invocations[existingIndex];
    invocation = {
      ...(existing ?? {
        taskInvocationId: next.taskInvocationId ?? generateUUID(),
        createdAt: next.createdAt ?? now,
      }),
      ...next,
      updatedAt: now,
    };

    if (existingIndex === -1) {
      store.invocations.push(invocation);
    } else {
      store.invocations[existingIndex] = invocation;
    }
  });
  return invocation;
}

/**
 * Persist a child's invocation status transition (e.g. Running -> Completed).
 * No-op when the child has no recorded invocation. Terminal statuses gate
 * resume/recovery, so call this only once the transition is actually owed
 * (e.g. after a successful wake delivery).
 */
export async function updateTaskInvocationStatus(params: {
  childSessionId: string;
  status: TaskInvocationStatus;
}): Promise<void> {
  await mutateStore((store) => {
    const index = store.invocations.findIndex(
      (invocation) => invocation.childSessionId === params.childSessionId
    );
    if (index === -1) {
      return;
    }
    store.invocations[index] = {
      ...store.invocations[index],
      status: params.status,
      updatedAt: Date.now(),
    };
  });
}

/**
 * A Task invocation is resumable only while it is still in flight. Terminal
 * states (completed / failed / cancelled) are never re-attached or recovered:
 * a completed result is already delivered to the parent, and a user-cancelled
 * or failed subagent must not be silently restarted. Single source of truth so
 * the eager coordinator recovery and the parent's Task re-attach stay in sync.
 */
export function isResumableTaskInvocationStatus(
  status: TaskInvocationStatus
): boolean {
  return (
    status === TaskInvocationStatus.Pending ||
    status === TaskInvocationStatus.Running
  );
}

/**
 * A parent's still-in-flight Task invocations (foreground and background).
 * Use for recovery paths that re-attach a reloaded parent to children it is
 * still waiting on.
 */
export function getUnfinishedTaskInvocationsForParent(
  parentSessionId: string
): TaskInvocationState[] {
  return loadStore().invocations.filter(
    (invocation) =>
      invocation.parentSessionId === parentSessionId &&
      isResumableTaskInvocationStatus(invocation.status)
  );
}

/**
 * Create an empty store file if one does not already exist. Best-effort and
 * safe under concurrency: the exclusive 'wx' flag leaves an existing file (or
 * one written by a racing creator) untouched. Call from a process entry point
 * so the store is always present; reads already tolerate a missing file.
 */
export function ensureTaskInvocationStoreExists(): void {
  const { storePath } = getStorePath();
  if (fs.existsSync(storePath)) {
    return;
  }
  try {
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(storePath, JSON.stringify(emptyStore(), null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    // EEXIST from a concurrent creator or permission errors are non-fatal.
  }
}
