import fs from 'fs';
import path from 'path';

import { logException, logWarn } from '@industry/logging';
import { withFileLock } from '@industry/runtime/auth';

import { setSecureFilePermissionsSync } from '@/utils/filePermissions';

const lastLoadErrors = new Map<string, string | null>();
const lastSaveErrors = new Map<string, string | null>();

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as NodeJS.ErrnoException).code === 'string'
  ) {
    return (error as NodeJS.ErrnoException).code;
  }
  return undefined;
}

function isPermissionError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === 'EACCES' || code === 'EPERM';
}

function tryParseJsonFile<T>(
  filePath: string,
  validate: (data: unknown) => data is T
): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const content = raw.replace(/\0+$/u, '').trim();
    if (!content) return null;
    const parsed: unknown = JSON.parse(content);
    if (!validate(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function tryUnlinkAndRecreate<T>(
  storePath: string,
  backupPath: string,
  empty: () => T
): T | null {
  try {
    try {
      fs.unlinkSync(storePath);
    } catch {
      // May not exist or may also be inaccessible
    }
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // Best-effort
    }
    const data = empty();
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), {
      mode: 0o600,
    });
    setSecureFilePermissionsSync(storePath);
    logWarn('Auto-remediated inaccessible store by recreating it', {
      path: storePath,
    });
    return data;
  } catch {
    return null;
  }
}

export function loadJsonFileWithBackup<T>(
  storePath: string,
  backupPath: string,
  validate: (data: unknown) => data is T,
  empty: () => T
): T {
  const primary = tryParseJsonFile(storePath, validate);
  if (primary) {
    lastLoadErrors.set(storePath, null);
    return primary;
  }

  const backup = tryParseJsonFile(backupPath, validate);
  if (backup) {
    try {
      fs.writeFileSync(storePath, JSON.stringify(backup, null, 2), {
        mode: 0o600,
      });
    } catch {
      // Best-effort restore
    }
    lastLoadErrors.set(storePath, null);
    logWarn('Recovered store from backup after primary corruption', {
      path: storePath,
    });
    return backup;
  }

  // Both primary and backup failed. Only auto-remediate if the failure is
  // a confirmed permission error (EACCES/EPERM from wrong ownership, e.g.
  // prior sudo run). For corruption/validation failures the file is still
  // accessible and will be overwritten on the next successful save.
  if (fs.existsSync(storePath)) {
    try {
      fs.accessSync(storePath, fs.constants.R_OK);
    } catch (accessErr) {
      if (isPermissionError(accessErr)) {
        const remediated = tryUnlinkAndRecreate(storePath, backupPath, empty);
        if (remediated) {
          lastLoadErrors.set(storePath, null);
          return remediated;
        }
      }
    }
  }

  const errorKey = 'primary+backup';
  if (lastLoadErrors.get(storePath) !== errorKey) {
    lastLoadErrors.set(storePath, errorKey);
    logWarn('Failed to load store from primary and backup, returning empty', {
      path: storePath,
    });
  }
  return empty();
}

export function saveJsonFileAtomic<T>(
  storePath: string,
  backupPath: string,
  store: T,
  options?: { throwOnError?: boolean }
): void {
  const tempPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), {
      mode: 0o600,
    });

    if (fs.existsSync(storePath)) {
      try {
        fs.copyFileSync(storePath, backupPath);
      } catch {
        // Best-effort backup
      }
    }

    fs.renameSync(tempPath, storePath);
    setSecureFilePermissionsSync(storePath);
    lastSaveErrors.set(storePath, null);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore temp cleanup errors
    }
    const errorKey = getErrorCode(error) ?? 'unknown';
    if (lastSaveErrors.get(storePath) === errorKey) {
      return;
    }
    lastSaveErrors.set(storePath, errorKey);
    if (isPermissionError(error)) {
      logWarn('Failed to save store (permission denied)', {
        path: storePath,
        code: errorKey,
      });
    } else {
      logException(error, 'Failed to save store', { path: storePath });
    }
    if (options?.throwOnError) {
      throw error;
    }
  }
}

/**
 * Serialize a read-modify-write of a JSON store across processes. The load and
 * save happen inside a cross-process file lock and the store is re-read inside
 * the critical section, so a stale whole-file snapshot from one process cannot
 * clobber a concurrent committed write from another. Writers only; readers rely
 * on the atomic rename in {@link saveJsonFileAtomic} and must not take the lock.
 */
export async function mutateJsonFileAtomic<T>(
  storePath: string,
  backupPath: string,
  validate: (data: unknown) => data is T,
  empty: () => T,
  mutator: (store: T) => T | void
): Promise<void> {
  await withFileLock(`${storePath}.lock`, async () => {
    const store = loadJsonFileWithBackup(
      storePath,
      backupPath,
      validate,
      empty
    );
    const next = mutator(store) ?? store;
    saveJsonFileAtomic(storePath, backupPath, next);
  });
}
