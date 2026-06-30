/**
 * File-based encryption key storage.
 *
 * This is used as a fallback when the OS keyring is unavailable.
 * The encryption key is stored in a file with secure permissions (0600).
 *
 * IMPORTANT: Once this file exists, we skip keyring access entirely to avoid
 * prompting the user for keychain access on every startup.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { writeFile as writeFileAtomic } from 'atomically';

import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getErrorCode } from '@industry/utils/errors';

import { ENCRYPTION_KEY_LENGTH } from '../common/constants';
import { ensureDirectoryExists } from '../common/fs';

import type { KeyFileStorageAdapter } from '../common/types';

/**
 * KeyFileStorage stores the encryption key in a file when keyring is unavailable.
 *
 * The key is stored as raw base64 with secure file permissions (0600).
 */
export class EncryptionKeyFile implements KeyFileStorageAdapter {
  private readonly filePath: string;

  /** Cached key to avoid repeated file reads */
  private cachedKey: Buffer | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private get fileName(): string {
    return path.basename(this.filePath);
  }

  /**
   * Load the encryption key from file.
   * @returns The encryption key buffer, or null if file doesn't exist
   */
  async load(): Promise<Buffer | null> {
    if (this.cachedKey) {
      return this.cachedKey;
    }

    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const key = Buffer.from(content.trim(), 'base64');

      if (key.length !== ENCRYPTION_KEY_LENGTH) {
        // eslint-disable-next-line industry/structured-logging
        logWarn(
          `Invalid key length in key file (expected ${ENCRYPTION_KEY_LENGTH}, got ${key.length}), will regenerate`
        );
        return null;
      }

      this.cachedKey = key;
      return key;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return null;
      }
      logWarn('Encryption key file read failed with unexpected error', {
        cause: error,
        fileName: this.fileName,
      });
      throw error;
    }
  }

  /**
   * Save the encryption key to file.
   * @param key The encryption key buffer to save
   */
  async save(key: Buffer): Promise<void> {
    if (key.length !== ENCRYPTION_KEY_LENGTH) {
      // eslint-disable-next-line industry/structured-logging
      throw new MetaError(
        `Invalid key length: expected ${ENCRYPTION_KEY_LENGTH}, got ${key.length}`
      );
    }

    await ensureDirectoryExists(path.dirname(this.filePath));
    await writeFileAtomic(this.filePath, key.toString('base64'), {
      mode: 0o600,
    });

    // Set secure permissions (in case atomically doesn't respect mode on all platforms)
    try {
      await fs.chmod(this.filePath, 0o600);
    } catch (err) {
      logWarn('Failed to set file permissions on key file', { cause: err });
    }

    // Verify the file was actually persisted to disk
    try {
      const stat = await fs.stat(this.filePath);
      logInfo('Encryption key saved to file', {
        fileName: this.fileName,
        size: stat.size,
      });
    } catch (err) {
      logWarn('Encryption key file missing immediately after write', {
        cause: err,
        fileName: this.fileName,
      });
    }

    this.cachedKey = key;
  }

  /**
   * Delete the key file.
   */
  async delete(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
      this.cachedKey = null;
    } catch (error) {
      if (getErrorCode(error) !== 'ENOENT') {
        logWarn('Failed to delete key file', { error });
      }
    }
  }

  /**
   * Check if the key file exists.
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch (err) {
      logWarn('Key file not accessible', { cause: err });
      return false;
    }
  }
}
