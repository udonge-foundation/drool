/**
 * File permission utilities for securing update binaries and staging directories.
 */

import * as fs from 'fs';
import { promisify } from 'util';

import { logException } from '@industry/logging';

// Create chmodAsync only if fs.chmod exists (might not exist in test mocks)
const chmodAsync = fs.chmod ? promisify(fs.chmod) : async () => {};

// Permission constants
const SECURE_DIRECTORY_MODE = 0o700; // rwx------ (owner read/write/execute only)
const EXECUTABLE_MODE = 0o755; // rwxr-xr-x (owner all, others read/execute)

/**
 * Sets secure permissions on a directory (700 - owner read/write/execute only).
 */
export async function setSecureDirectoryPermissions(
  path: string
): Promise<void> {
  try {
    await chmodAsync(path, SECURE_DIRECTORY_MODE);
  } catch (error) {
    logException(
      error,
      '[Security] Failed to set directory permissions (updater)',
      {
        path,
      }
    );
    // Don't throw - we don't want to break functionality due to permission issues
  }
}

/**
 * Sets executable permissions on a file (755 - owner all, others read/execute).
 * Used for the binary after updates.
 */
export async function setExecutablePermissions(path: string): Promise<void> {
  try {
    await chmodAsync(path, EXECUTABLE_MODE);
  } catch (error) {
    logException(error, '[Security] Failed to set executable permissions', {
      path,
    });
    // Don't throw for executable permissions - the file might still work
  }
}
