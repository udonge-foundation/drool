/**
 * Shared file system utilities for secure storage.
 */

import * as fs from 'fs/promises';

import { getErrorCode } from '@industry/utils/errors';

/**
 * Ensure a directory exists with secure permissions (0700).
 */
export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (getErrorCode(error) === 'EEXIST') {
      return;
    }
    throw error;
  }
}
