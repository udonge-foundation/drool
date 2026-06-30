import * as fs from 'fs/promises';
import * as path from 'path';

import { writeFile as writeFileAtomic } from 'atomically';

import { logWarn } from '@industry/logging';
import { getErrorCode } from '@industry/utils/errors';

import {
  decrypt,
  encrypt,
  generateEncryptionKey,
} from '../storage/common/encryption';
import { ensureDirectoryExists } from '../storage/common/fs';
import { EncryptionKeyFile } from '../storage/file/EncryptionKeyFile';

export class EncryptedMcpOAuthFileStore {
  private readonly dataPath: string;

  private readonly keyStorage: EncryptionKeyFile;

  constructor(dataPath: string, keyPath: string) {
    this.dataPath = dataPath;
    this.keyStorage = new EncryptionKeyFile(keyPath);
  }

  private get fileName(): string {
    return path.basename(this.dataPath);
  }

  private async getOrCreateKey(): Promise<Buffer> {
    const key = await this.keyStorage.load();
    if (key) {
      return key;
    }

    // A missing key makes any existing ciphertext unreadable; the next save
    // re-keys the store and replaces that ciphertext with the new payload.
    const created = generateEncryptionKey();
    await this.keyStorage.save(created);
    return created;
  }

  /**
   * Load the decrypted payload, or null when no readable payload exists.
   *
   * Unreadable ciphertext (missing key or failed decryption) is reported as
   * missing rather than thrown: it is never quarantined or deleted, and the
   * next successful save replaces it.
   */
  async load(): Promise<string | null> {
    let encrypted: string;
    try {
      encrypted = await fs.readFile(this.dataPath, 'utf8');
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }

    const key = await this.keyStorage.load();
    if (!key) {
      logWarn(
        'Cannot decrypt MCP OAuth storage because its file key is unavailable',
        { fileName: this.fileName }
      );
      return null;
    }

    try {
      return decrypt(encrypted, key);
    } catch (error) {
      logWarn(
        'Cannot decrypt MCP OAuth storage because its ciphertext is unreadable',
        { fileName: this.fileName, cause: error }
      );
      return null;
    }
  }

  async save(data: string): Promise<void> {
    const key = await this.getOrCreateKey();
    await ensureDirectoryExists(path.dirname(this.dataPath));
    await writeFileAtomic(this.dataPath, encrypt(data, key), { mode: 0o600 });
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.dataPath);
      return true;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
}
