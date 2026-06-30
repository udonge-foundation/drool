import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { z } from 'zod';

import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getErrorCode } from '@industry/utils/errors';

import type { FileLockOptions } from './types';

const DEFAULT_LOCK_WAIT_MS = 2_000;
const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_POLL_MS = 15;
const LOCK_OWNER_FILE_NAME = 'owner.json';

const LockOwnerSchema = z.object({
  token: z.string(),
  pid: z.number().int().positive(),
});

type LockOwner = z.infer<typeof LockOwnerSchema>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseLockOwner(raw: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = LockOwnerSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch (error) {
    logWarn('Secure storage write lock owner record is unreadable', {
      cause: error,
    });
  }
  return null;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  const ownerPath = path.join(lockPath, LOCK_OWNER_FILE_NAME);
  const raw = await fs
    .readFile(ownerPath, 'utf8')
    .catch(async (error: unknown) => {
      const code = getErrorCode(error);
      if (code === 'ENOENT') {
        return null;
      }
      if (code !== 'ENOTDIR') {
        throw error;
      }
      return await fs
        .readFile(lockPath, 'utf8')
        .catch((legacyError: unknown) => {
          if (getErrorCode(legacyError) === 'ENOENT') {
            return null;
          }
          throw legacyError;
        });
    });
  if (raw === null) {
    return null;
  }
  return parseLockOwner(raw);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (getErrorCode(error) === 'ESRCH') {
      return false;
    }
    // EPERM and other failures are treated as alive; the staleness window
    // still bounds how long such a lock can block writers.
    logWarn('Could not verify secure storage write lock owner', {
      cause: error,
    });
    return true;
  }
}

function resolveOptions(
  options: FileLockOptions = {}
): Required<FileLockOptions> {
  return {
    waitMs: options.waitMs ?? DEFAULT_LOCK_WAIT_MS,
    staleMs: options.staleMs ?? DEFAULT_LOCK_STALE_MS,
    pollMs: options.pollMs ?? DEFAULT_LOCK_POLL_MS,
    reclaimStaleWhileAlive: options.reclaimStaleWhileAlive ?? false,
  };
}

/**
 * Remove the lock file when its owner is dead or it has outlived the
 * staleness window. Returns true when the lock was removed.
 */
async function tryReclaimLock(
  lockPath: string,
  options: Pick<Required<FileLockOptions>, 'staleMs' | 'reclaimStaleWhileAlive'>
): Promise<boolean> {
  const stats = await fs.stat(lockPath).catch((error: unknown) => {
    if (getErrorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (!stats) {
    return true;
  }

  const owner = await readLockOwner(lockPath);
  const isStale = Date.now() - stats.mtimeMs >= options.staleMs;
  const ownerIsDead = owner !== null && !isProcessAlive(owner.pid);
  const isReclaimableStale =
    isStale && (owner === null || options.reclaimStaleWhileAlive);
  if (!isReclaimableStale && !ownerIsDead) {
    return false;
  }

  // Lock acquisition is directory-based: no fresh owner can acquire this
  // lockPath until the current directory is removed. Re-read the owner just
  // before removal so a release/reclaim race never removes a different token.
  const currentOwner = await readLockOwner(lockPath);
  if (
    owner !== null &&
    currentOwner !== null &&
    currentOwner.token !== owner.token
  ) {
    return false;
  }

  logWarn('Removing stale secure storage write lock', {
    targetPath: lockPath,
  });
  await fs
    .rm(lockPath, { recursive: true, force: true })
    .catch((error: unknown) => {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
    });
  return true;
}

/**
 * Acquire a file lock and return its owner token. Exposed (alongside
 * {@link releaseFileLock}) so callers that must hold the lock across awaits
 * spanning multiple calls -- e.g. an MCP OAuth refresh that brackets a network
 * token request -- can manage the critical section explicitly. Prefer
 * {@link withFileLock} for self-contained critical sections.
 */
export async function acquireFileLock(
  lockPath: string,
  options?: FileLockOptions
): Promise<string> {
  const resolvedOptions = resolveOptions(options);
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + resolvedOptions.waitMs;
  const token = randomUUID();
  const payload = JSON.stringify(
    LockOwnerSchema.parse({ token, pid: process.pid })
  );

  while (true) {
    const acquired = await fs.mkdir(lockPath, { mode: 0o700 }).then(
      async () => {
        await fs.writeFile(path.join(lockPath, LOCK_OWNER_FILE_NAME), payload, {
          flag: 'wx',
          mode: 0o600,
        });
        return true;
      },
      (error: unknown) => {
        if (getErrorCode(error) === 'EEXIST') {
          return false;
        }
        throw error;
      }
    );
    if (acquired) {
      return token;
    }

    if (await tryReclaimLock(lockPath, resolvedOptions)) {
      continue;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new MetaError('Timed out waiting for secure storage write lock', {
        targetPath: lockPath,
      });
    }
    await sleep(Math.min(resolvedOptions.pollMs, remainingMs));
  }
}

export async function releaseFileLock(
  lockPath: string,
  token: string
): Promise<void> {
  const owner = await readLockOwner(lockPath);
  if (owner?.token !== token) {
    return;
  }
  await fs
    .rm(lockPath, { recursive: true, force: true })
    .catch((error: unknown) => {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
    });
}

/**
 * Mutual exclusion for short read-modify-write critical sections.
 *
 * The lock is a single file created atomically with O_EXCL and holding the
 * owner pid; it is intended for writers only -- readers must never take it.
 * A lock whose owner pid is dead is reclaimed immediately. Stale locks owned by
 * a live process are not reclaimed unless the caller explicitly opts into that
 * lease behavior.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: FileLockOptions
): Promise<T> {
  const ownerToken = await acquireFileLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await releaseFileLock(lockPath, ownerToken);
  }
}
