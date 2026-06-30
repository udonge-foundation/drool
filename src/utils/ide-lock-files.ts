import * as fs from 'fs/promises';
import * as path from 'path';

import { logException, logInfo } from '@industry/logging';

import { getLockFileDirectory } from '@/utils/getLockFileDirectory';

// eslint-disable-next-line industry/types-file-organization
export interface IdeLockFileData {
  pid: number;
  ideName: string;
  workspaceFolders: string[];
  port: number;
}

/**
 * Check if a process with the given PID is currently running.
 */
function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ESRCH') {
      return false;
    }
    if (nodeError.code === 'EPERM') {
      return true;
    }
    return true;
  }
}

/**
 * Discover all running IDE instances by reading lock files from ~/.industry/ide/
 * Filters out stale lock files where the PID is no longer running.
 */
export async function discoverRunningIdeInstances(): Promise<
  IdeLockFileData[]
> {
  const lockDir = getLockFileDirectory();
  const instances: IdeLockFileData[] = [];

  try {
    const files = await fs.readdir(lockDir);

    for (const file of files) {
      if (!file.endsWith('.lock')) {
        continue;
      }

      const port = parseInt(file.replace('.lock', ''), 10);
      if (Number.isNaN(port)) {
        continue;
      }

      const lockFilePath = path.join(lockDir, file);

      try {
        const content = await fs.readFile(lockFilePath, 'utf-8');

        // IDE extensions write the lock file non-atomically, so a startup
        // race can observe an empty or partially-written file. Treat that as
        // a transient/not-ready lock and skip it without escalating to an
        // exception (this is a self-recovering condition, not a real error).
        if (content.trim().length === 0) {
          logInfo('[IDE Lock Files] Skipping empty lock file', {
            port,
            reason: 'empty',
          });
          continue;
        }

        let data: {
          pid: number;
          ideName: string;
          workspaceFolders: string[];
        };
        try {
          data = JSON.parse(content) as {
            pid: number;
            ideName: string;
            workspaceFolders: string[];
          };
        } catch {
          logInfo('[IDE Lock Files] Skipping malformed lock file', {
            port,
            reason: 'invalid-json',
          });
          continue;
        }

        // Check if the process is still running
        if (data.pid != null && !isPidRunning(data.pid)) {
          logInfo('[IDE Lock Files] Skipping stale lock file', {
            port,
            pid: data.pid,
          });
          // Clean up stale lock file
          try {
            await fs.unlink(lockFilePath);
          } catch {
            // Ignore cleanup errors
          }
          continue;
        }

        instances.push({
          pid: data.pid,
          ideName: data.ideName,
          workspaceFolders: data.workspaceFolders || [],
          port,
        });
      } catch (error) {
        logException(error, '[IDE Lock Files] Failed to read lock file', {
          fileName: file,
        });
      }
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      logException(error, '[IDE Lock Files] Failed to read lock directory');
    }
  }

  return instances;
}

/**
 * Check if the file system is case-insensitive (Windows and macOS default volumes).
 */
function isCaseInsensitiveFileSystem(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

/**
 * Normalize a path for comparison, handling case-insensitivity on Windows/macOS.
 */
function normalizePathForComparison(p: string): string {
  let normalized = path.resolve(p);
  if (isCaseInsensitiveFileSystem()) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Check if any workspace folder in the instance matches or contains the current working directory.
 */
export function matchesWorkspace(
  instance: IdeLockFileData,
  cwd: string
): boolean {
  const normalizedCwd = normalizePathForComparison(cwd);

  for (const folder of instance.workspaceFolders) {
    const normalizedFolder = normalizePathForComparison(folder);

    // Check if cwd is exactly the workspace folder or is inside it
    if (
      normalizedCwd === normalizedFolder ||
      normalizedCwd.startsWith(normalizedFolder + path.sep)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Find the best matching IDE instance for the current workspace.
 * Prioritizes instances that match the detected IDE type when running inside an IDE terminal.
 */
export async function findMatchingIdeInstance(
  cwd: string,
  preferredIdeName?: string
): Promise<IdeLockFileData | null> {
  const instances = await discoverRunningIdeInstances();
  const matchingInstances = instances.filter((instance) =>
    matchesWorkspace(instance, cwd)
  );

  if (matchingInstances.length === 0) {
    return null;
  }

  // If we have a preferred IDE name, try to find it first
  if (preferredIdeName) {
    const preferredMatch = matchingInstances.find((instance) =>
      instance.ideName.toLowerCase().includes(preferredIdeName.toLowerCase())
    );
    if (preferredMatch) {
      return preferredMatch;
    }
  }

  // Return the first matching instance
  return matchingInstances[0];
}
