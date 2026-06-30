/**
 * File permission utilities for securing sensitive CLI data.
 *
 * Sets restrictive permissions on configuration files, auth tokens,
 * session data, and other sensitive information to prevent unauthorized access.
 */

import * as fs from 'fs';
import { promisify } from 'util';

import { logException, logInfo } from '@industry/logging';

// Create chmodAsync only if fs.chmod exists (might not exist in test mocks)
const chmodAsync = fs.chmod ? promisify(fs.chmod) : async () => {};

// Permission constants
const SECURE_FILE_MODE = 0o600; // rw------- (owner read/write only)
const SECURE_DIRECTORY_MODE = 0o700; // rwx------ (owner read/write/execute only)

/**
 * Sets secure permissions on a file (600 - owner read/write only).
 */
export async function setSecureFilePermissions(path: string): Promise<void> {
  try {
    await chmodAsync(path, SECURE_FILE_MODE);
  } catch (error) {
    logException(error, '[Security] Failed to set file permissions (async)', {
      path,
    });
    // Don't throw - we don't want to break functionality due to permission issues
  }
}

/**
 * Sets secure permissions on a directory (700 - owner read/write/execute only).
 */
async function setSecureDirectoryPermissions(path: string): Promise<void> {
  try {
    await chmodAsync(path, SECURE_DIRECTORY_MODE);
  } catch (error) {
    logException(
      error,
      '[Security] Failed to set directory permissions (async)',
      {
        path,
      }
    );
    // Don't throw - we don't want to break functionality due to permission issues
  }
}

/**
 * Synchronously sets secure permissions on a file (600 - owner read/write only).
 */
export function setSecureFilePermissionsSync(path: string): void {
  try {
    if (fs.chmodSync) {
      fs.chmodSync(path, SECURE_FILE_MODE);
    }
  } catch (error) {
    logException(error, '[Security] Failed to set file permissions (sync)', {
      path,
    });
    // Don't throw - we don't want to break functionality due to permission issues
  }
}

/**
 * Synchronously sets secure permissions on a directory (700 - owner read/write/execute only).
 */
export function setSecureDirectoryPermissionsSync(path: string): void {
  try {
    if (fs.chmodSync) {
      fs.chmodSync(path, SECURE_DIRECTORY_MODE);
    }
  } catch (error) {
    logException(
      error,
      '[Security] Failed to set directory permissions (sync)',
      {
        path,
      }
    );
    // Don't throw - we don't want to break functionality due to permission issues
  }
}

/**
 * Ensures all Industry CLI files and directories have secure permissions.
 * This should be called on startup to fix permissions for existing installations.
 * Runs silently and logs warnings if permissions can't be set.
 */
export async function ensureAllSecurePermissions(): Promise<void> {
  const { promises: fsPromises } = await import('fs');
  const path = await import('path');
  const { getIndustryDirName } = await import('@industry/utils/environment');
  const { getIndustryHome } = await import('@industry/utils/cli');

  const industryDir = path.join(getIndustryHome(), getIndustryDirName());

  // Check if .industry exists
  try {
    await fsPromises.access(industryDir);
  } catch {
    // Directory doesn't exist yet, nothing to fix
    return;
  }

  try {
    // Fix directory permissions
    await setSecureDirectoryPermissions(industryDir);

    // Fix subdirectory permissions
    const subdirs = ['sessions', 'updates', 'logs', 'drools'];
    for (const subdir of subdirs) {
      const subdirPath = path.join(industryDir, subdir);
      try {
        await fsPromises.access(subdirPath);
        await setSecureDirectoryPermissions(subdirPath);
      } catch {
        // Subdirectory doesn't exist, skip
      }
    }

    // Fix file permissions for root-level files
    const rootFiles = [
      'auth.json',
      'config.json',
      'history.json',
      'mcp.json',
      'settings.json',
    ];

    for (const file of rootFiles) {
      const filePath = path.join(industryDir, file);
      try {
        await fsPromises.access(filePath);
        await setSecureFilePermissions(filePath);
      } catch {
        // File doesn't exist, skip
      }
    }

    // Fix session files
    const sessionsDir = path.join(industryDir, 'sessions');
    try {
      const files = await fsPromises.readdir(sessionsDir);
      for (const file of files) {
        if (file.endsWith('.jsonl') || file.endsWith('.settings.json')) {
          const filePath = path.join(sessionsDir, file);
          await setSecureFilePermissions(filePath);
        }
      }
    } catch {
      // Sessions directory doesn't exist or can't be read, skip
    }

    // Fix drool files
    const droolsDir = path.join(industryDir, 'drools');
    try {
      const files = await fsPromises.readdir(droolsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(droolsDir, file);
          await setSecureFilePermissions(filePath);
        }
      }
    } catch {
      // Drools directory doesn't exist or can't be read, skip
    }

    logInfo('[Security] File permissions secured on startup');
  } catch (error) {
    logException(error, '[Security] Could not fully secure file permissions');
  }
}
