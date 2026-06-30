/**
 * Unified credentials storage for Industry CLI, Desktop, and Daemon.
 *
 * Storage strategy:
 * 1. Credentials are ALWAYS encrypted with AES-256-GCM
 * 2. Encryption key is stored in OS keyring (preferred for new logins) or auth.v2.key file (fallback)
 * 3. Keyring and keyfile credentials are stored in SEPARATE files to avoid conflicts
 *    between binaries that can/cannot access keyring
 *
 * Files (new format):
 * - ~/.industry/auth.v2.file - Encrypted credentials (key in auth.v2.key)
 * - ~/.industry/auth.v2.key - Fallback encryption key (only when keyring unavailable)
 * - ~/.industry/auth.v2.keyring - Encrypted credentials (key in OS keyring)
 *
 * Load order prefers auth.v2.file over auth.v2.keyring to avoid OS keychain
 * prompts when file-based credentials are available.
 *
 * Legacy support:
 * - ~/.industry/auth.encrypted - Old CLI format (encrypted with keyring key, or plain JSON)
 *   Read from if v2 files don't exist. Writes go back to same file/format.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { writeFile as writeFileAtomic } from 'atomically';

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { logInfo, logWarn } from '@industry/logging';
import { loadCachedFlagsFromDisk } from '@industry/runtime/feature-flags';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { getErrorCode } from '@industry/utils/errors';

import { CredentialsSource } from './enums';
import { StoredCredentialsSchema } from './schemas';
import { ENCRYPTION_KEY_LENGTH } from '../storage/common/constants';
import {
  decrypt,
  encrypt,
  generateEncryptionKey,
} from '../storage/common/encryption';
import { EncryptionKeyFile } from '../storage/file/EncryptionKeyFile';
import { KeyringClient } from '../storage/keyring/KeyringClient';

import type {
  CredentialsStorageConfig,
  KeyFileStorageAdapter,
  KeyringStorageAdapter,
  StoredCredentials,
} from '../storage/common/types';

const DEFAULT_KEYRING_SERVICE = 'Industry CLI';
const DEFAULT_KEYRING_ACCOUNT = 'auth-encryption-key';
const KEYRING_CREDENTIALS_FILE = 'auth.v2.keyring';
const PLAINTEXT_CREDENTIALS_FILE = 'auth.v2.file';
const PLAINTEXT_KEY_FILE = 'auth.v2.key';
const LEGACY_CREDENTIALS_FILE = 'auth.encrypted';

/**
 * CredentialsStorage provides unified secure storage for Industry credentials.
 *
 * Features:
 * - Schema validation for credentials
 * - Legacy file migration (auth.encrypted)
 * - Separate files for keyring vs keyfile storage (isolation)
 * - Typed StoredCredentials interface
 */
export class CredentialsStorage {
  private readonly baseDir: string;

  private readonly keyringCredentialsPath: string;

  private readonly keyfileCredentialsPath: string;

  private readonly legacyCredentialsPath: string;

  private readonly keyringStorage: KeyringStorageAdapter;

  private readonly keyFileStorage: KeyFileStorageAdapter;

  private readonly keyringAccount: string;

  /** Tracks which file the credentials were loaded from */
  private source: CredentialsSource | null = null;

  /** Tracks the last logged credential source to avoid noisy repeated logs */
  private lastLoggedSource: CredentialsSource | null = null;

  /** Cached encryption key (for writes) */
  private encryptionKey: Buffer | null = null;

  /**
   * Tracks whether keyring is known to be unavailable for this session.
   * Once set to true, we skip all keyring operations to avoid repeated prompts.
   * This is set at runtime when the keyring actually fails (e.g., user denied access).
   */
  private keyringUnavailable = false;

  /**
   * Cached keyring key to avoid repeated keyring prompts within the same session.
   * On macOS, each keyring access can prompt unless user clicks "Always Allow".
   */
  private cachedKeyringKey: Buffer | null = null;

  constructor(config: CredentialsStorageConfig = {}) {
    this.baseDir =
      config.baseDir ?? path.join(getIndustryHome(), getIndustryDirName());

    this.keyringCredentialsPath = path.join(
      this.baseDir,
      KEYRING_CREDENTIALS_FILE
    );
    this.keyfileCredentialsPath = path.join(
      this.baseDir,
      PLAINTEXT_CREDENTIALS_FILE
    );
    this.legacyCredentialsPath = path.join(
      this.baseDir,
      LEGACY_CREDENTIALS_FILE
    );
    this.keyringAccount = config.keyringAccount ?? DEFAULT_KEYRING_ACCOUNT;

    this.keyringStorage =
      config.keyringStorage ??
      new KeyringClient({
        serviceName: config.keyringService ?? DEFAULT_KEYRING_SERVICE,
        keytarLoader: config.keytarLoader,
        disableKeyring: config.disableKeyring,
      });

    this.keyFileStorage =
      config.keyFileStorage ??
      new EncryptionKeyFile(path.join(this.baseDir, PLAINTEXT_KEY_FILE));
  }

  /**
   * Parse and validate decrypted JSON as StoredCredentials.
   */
  private parseCredentials(json: string): StoredCredentials | null {
    try {
      const parsed = JSON.parse(json);
      const result = StoredCredentialsSchema.safeParse(parsed);
      if (!result.success) {
        logWarn('Invalid credentials data in storage', { error: result.error });
        return null;
      }
      return result.data;
    } catch (err) {
      logWarn('Failed to parse credentials JSON', { cause: err });
      return null;
    }
  }

  /**
   * Read file contents, returning null if file doesn't exist.
   */
  private async readFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Write file atomically with secure permissions.
   */
  private async writeFile(filePath: string, data: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(filePath, data, { mode: 0o600 });
  }

  /**
   * Get encryption key from keyring.
   * Returns null if keyring is unavailable or key doesn't exist.
   * Marks keyring as unavailable on error (e.g., user denied access).
   * Caches the key in memory to avoid repeated keyring prompts.
   *
   * Note: Concurrent-call deduplication is handled by KeyringClient, so
   * multiple callers hitting this method in parallel will not trigger
   * multiple OS keychain prompts.
   */
  private async getKeyringKey(): Promise<Buffer | null> {
    // Return cached key if available (avoids repeated keyring prompts)
    if (this.cachedKeyringKey) {
      return this.cachedKeyringKey;
    }

    if (this.keyringUnavailable) {
      return null;
    }

    try {
      const existingKey = await this.keyringStorage.get(this.keyringAccount);
      if (existingKey) {
        const keyBuffer = Buffer.from(existingKey, 'base64');
        if (keyBuffer.length !== ENCRYPTION_KEY_LENGTH) {
          // eslint-disable-next-line industry/structured-logging
          logWarn(
            `Invalid keyring key length (expected ${ENCRYPTION_KEY_LENGTH}, got ${keyBuffer.length}), will regenerate`
          );
          return null;
        }
        this.cachedKeyringKey = keyBuffer;
        return this.cachedKeyringKey;
      }
    } catch (err) {
      // Keyring unavailable (user denied access or other error)
      logWarn('Keyring unavailable for reading encryption key', { cause: err });
      this.keyringUnavailable = true;
    }
    return null;
  }

  /**
   * Get or create encryption key from keyring.
   * Returns null if keyring is unavailable (e.g., user denied access).
   *
   * Important: If getKeyringKey() fails, we mark keyring as unavailable and
   * do NOT attempt to create a new key. This prevents creating auth.v2.keyring
   * when the user has denied keychain access.
   */
  private async getOrCreateKeyringKey(): Promise<Buffer | null> {
    // Skip if keyring is already known to be unavailable
    if (this.keyringUnavailable) {
      return null;
    }

    // Try to get existing key
    const existingKey = await this.getKeyringKey();
    if (existingKey) {
      return existingKey;
    }

    // If getKeyringKey() marked keyring as unavailable (user denied), don't try to create
    if (this.keyringUnavailable) {
      return null;
    }

    // Try to create new key in keyring
    try {
      const newKey = generateEncryptionKey();
      await this.keyringStorage.set(
        this.keyringAccount,
        newKey.toString('base64')
      );
      logInfo('Generated new encryption key and stored in keyring');
      // Cache the new key to avoid repeated keyring prompts
      this.cachedKeyringKey = newKey;
      return newKey;
    } catch (err) {
      // Keyring unavailable (user denied or other error)
      logWarn('Keyring unavailable for creating encryption key', {
        cause: err,
      });
      this.keyringUnavailable = true;
    }
    return null;
  }

  /**
   * Get or create encryption key from keyfile.
   */
  private async getOrCreateKeyfileKey(): Promise<Buffer> {
    const existingKey = await this.keyFileStorage.load();
    if (existingKey) {
      return existingKey;
    }

    const newKey = generateEncryptionKey();
    await this.keyFileStorage.save(newKey);
    logInfo('Generated new encryption key and stored in keyfile');
    return newKey;
  }

  /**
   * Try loading from auth.v2.keyring (key in keyring).
   */
  private async loadFromKeyringV2(): Promise<StoredCredentials | null> {
    const content = await this.readFile(this.keyringCredentialsPath);
    if (!content) return null;

    const key = await this.getKeyringKey();
    if (!key) {
      logWarn('Auth credentials keyring-v2 key unavailable', {
        source: CredentialsSource.KeyringV2,
        reason: 'keyring_unavailable',
      });
      return null;
    }

    try {
      const decrypted = decrypt(content, key);
      const creds = this.parseCredentials(decrypted);
      if (creds) {
        this.source = CredentialsSource.KeyringV2;
        this.encryptionKey = key;
        return creds;
      }
    } catch (err) {
      logWarn('Auth credentials keyring-v2 decrypt failed', {
        source: CredentialsSource.KeyringV2,
        reason: 'decrypt_failed',
        cause: err,
      });
    }
    return null;
  }

  /**
   * Try loading from auth.v2.file (key in auth.v2.key).
   */
  private async loadFromKeyfileV2(): Promise<StoredCredentials | null> {
    const content = await this.readFile(this.keyfileCredentialsPath);
    if (!content) return null;

    const key = await this.keyFileStorage.load();
    if (!key) {
      logWarn('auth.v2.file exists but auth.v2.key is missing', {
        fileName: PLAINTEXT_KEY_FILE,
        source: CredentialsSource.KeyfileV2,
        reason: 'missing_keyfile_key',
      });
      return null;
    }

    try {
      const decrypted = decrypt(content, key);
      const creds = this.parseCredentials(decrypted);
      if (creds) {
        this.source = CredentialsSource.KeyfileV2;
        this.encryptionKey = key;
        return creds;
      }
    } catch (err) {
      logWarn('Auth credentials keyfile-v2 decrypt failed', {
        source: CredentialsSource.KeyfileV2,
        reason: 'decrypt_failed',
        cause: err,
      });
    }
    return null;
  }

  /**
   * Try loading from legacy auth.encrypted.
   */
  private async loadFromLegacy(): Promise<StoredCredentials | null> {
    const content = await this.readFile(this.legacyCredentialsPath);
    if (!content) return null;

    // Try plain JSON first (no keychain prompt)
    const plainCreds = this.parseCredentials(content);
    if (plainCreds) {
      this.source = CredentialsSource.LegacyPlain;
      return plainCreds;
    }

    // Try decrypting with keyring key
    const key = await this.getKeyringKey();
    if (key) {
      try {
        const decrypted = decrypt(content, key);
        const creds = this.parseCredentials(decrypted);
        if (creds) {
          this.source = CredentialsSource.LegacyEncrypted;
          this.encryptionKey = key;
          return creds;
        }
      } catch (err) {
        logWarn('Legacy encrypted auth credentials decrypt failed', {
          source: CredentialsSource.LegacyEncrypted,
          reason: 'decrypt_failed',
          cause: err,
        });
      }
    }

    logWarn('Legacy auth credentials unreadable', {
      source: 'legacy',
      reason: 'invalid_schema_or_keyring_unavailable',
    });
    return null;
  }

  /**
   * Load credentials from storage.
   *
   * Load order:
   * 1. auth.v2.file (key in auth.v2.key) — no OS prompts
   * 2. auth.v2.keyring (key in keyring) — may trigger OS keychain prompt
   * 3. auth.encrypted (legacy)
   */
  async load(): Promise<StoredCredentials | null> {
    // Try v2 keyfile first (silent, no OS prompts)
    const keyfileCreds = await this.loadFromKeyfileV2();
    if (keyfileCreds) {
      this.logSourceChangeIfNeeded();
      return keyfileCreds;
    }

    // Try v2 keyring (may prompt on macOS)
    const keyringCreds = await this.loadFromKeyringV2();
    if (keyringCreds) {
      this.logSourceChangeIfNeeded();
      return keyringCreds;
    }

    // Try legacy
    const legacyCreds = await this.loadFromLegacy();
    if (legacyCreds) {
      this.logSourceChangeIfNeeded();
      return legacyCreds;
    }

    logWarn('No credentials found in any storage source');
    return null;
  }

  /**
   * Log the credential source only when it changes (including first resolution).
   * The check-and-set is synchronous (no awaits) so concurrent load() calls
   * cannot both pass the guard in the same microtask.
   */
  private logSourceChangeIfNeeded(): void {
    if (this.source !== null && this.source !== this.lastLoggedSource) {
      this.lastLoggedSource = this.source;
      logInfo('Credentials source resolved', { source: this.source });
    }
  }

  /**
   * Get the log message for a given credentials source.
   */
  private getLogMessageForSource(source: CredentialsSource): string {
    switch (source) {
      case CredentialsSource.KeyringV2:
        return 'Saved credentials to auth.v2.keyring';
      case CredentialsSource.KeyfileV2:
        return 'Saved credentials to auth.v2.file';
      case CredentialsSource.LegacyPlain:
        return 'Saved credentials to legacy auth.encrypted (plain JSON)';
      case CredentialsSource.LegacyEncrypted:
        return 'Saved credentials to legacy auth.encrypted (encrypted)';
      default:
        return 'Saved credentials';
    }
  }

  /**
   * Encrypt and write credentials to a file, updating instance state.
   * @param json Serialized credentials JSON
   * @param filePath Target file path
   * @param key Encryption key (null for plain JSON)
   * @param source Credentials source to set
   * @param updateState Whether to update this.source and this.encryptionKey
   */
  private async encryptAndSave(
    json: string,
    filePath: string,
    key: Buffer | null,
    source: CredentialsSource,
    updateState: boolean
  ): Promise<void> {
    const content = key ? encrypt(json, key) : json;
    await this.writeFile(filePath, content);
    if (updateState) {
      this.source = source;
      this.encryptionKey = key;
    }
    logInfo(this.getLogMessageForSource(source));
  }

  /**
   * Save credentials to storage.
   *
   * By default, writes back to the same file/format that was read from.
   * Pass `forceNew: true` to write to the appropriate v2 file (for new logins).
   * Pass `sourceOverride` and `encryptionKeyOverride` to write to a specific
   * source with a specific key (for in-flight refresh that started before login).
   */
  async save(
    credentials: StoredCredentials,
    options?: {
      forceNew?: boolean;
      sourceOverride?: CredentialsSource;
      encryptionKeyOverride?: Buffer;
    }
  ): Promise<void> {
    const json = JSON.stringify(credentials);

    if (options?.forceNew) {
      const cachedFlags = loadCachedFlagsFromDisk();
      const enableKeyringForNewLogins =
        cachedFlags?.[
          IndustryFeatureFlags.EnableKeyringForNewLogins.statsigName
        ] ?? IndustryFeatureFlags.EnableKeyringForNewLogins.defaultValue;

      if (enableKeyringForNewLogins) {
        // Keyring enabled for new logins (EnableKeyringForNewLogins FF on):
        // prefer existing keyfile if available (avoids keyring prompt),
        // otherwise try keyring, then fall back to keyfile
        const existingKeyfileKey = await this.keyFileStorage.load();
        if (existingKeyfileKey) {
          await this.encryptAndSave(
            json,
            this.keyfileCredentialsPath,
            existingKeyfileKey,
            CredentialsSource.KeyfileV2,
            true
          );
        } else {
          const keyringKey = await this.getOrCreateKeyringKey();
          if (keyringKey) {
            await this.encryptAndSave(
              json,
              this.keyringCredentialsPath,
              keyringKey,
              CredentialsSource.KeyringV2,
              true
            );
          } else {
            const keyfileKey = await this.getOrCreateKeyfileKey();
            await this.encryptAndSave(
              json,
              this.keyfileCredentialsPath,
              keyfileKey,
              CredentialsSource.KeyfileV2,
              true
            );
          }
        }
      } else {
        const keyfileKey = await this.getOrCreateKeyfileKey();
        await this.encryptAndSave(
          json,
          this.keyfileCredentialsPath,
          keyfileKey,
          CredentialsSource.KeyfileV2,
          true
        );
      }
      return;
    }

    // Refresh: write back to same source (or explicit override for in-flight refresh)
    const targetSource = options?.sourceOverride ?? this.source;
    const targetKey = options?.encryptionKeyOverride ?? this.encryptionKey;
    const updateState = !options?.sourceOverride;

    switch (targetSource) {
      case CredentialsSource.KeyringV2:
        if (targetKey) {
          await this.encryptAndSave(
            json,
            this.keyringCredentialsPath,
            targetKey,
            CredentialsSource.KeyringV2,
            updateState
          );
        }
        break;

      case CredentialsSource.KeyfileV2:
        if (targetKey) {
          await this.encryptAndSave(
            json,
            this.keyfileCredentialsPath,
            targetKey,
            CredentialsSource.KeyfileV2,
            updateState
          );
        }
        break;

      case CredentialsSource.LegacyPlain:
        await this.encryptAndSave(
          json,
          this.legacyCredentialsPath,
          null,
          CredentialsSource.LegacyPlain,
          updateState
        );
        break;

      case CredentialsSource.LegacyEncrypted:
        if (targetKey) {
          await this.encryptAndSave(
            json,
            this.legacyCredentialsPath,
            targetKey,
            CredentialsSource.LegacyEncrypted,
            updateState
          );
        }
        break;

      default:
        // No prior load - use new format (same as forceNew)
        await this.save(credentials, { forceNew: true });
        break;
    }
  }

  /**
   * Clear credentials from the current auth source only.
   * Only deletes the file that credentials were loaded from.
   * If no source is set, does nothing (no credentials loaded).
   */
  async clear(): Promise<void> {
    // Determine which file to delete based on current source
    let filePath: string | null = null;
    switch (this.source) {
      case CredentialsSource.KeyringV2:
        filePath = this.keyringCredentialsPath;
        break;
      case CredentialsSource.KeyfileV2:
        filePath = this.keyfileCredentialsPath;
        break;
      case CredentialsSource.LegacyPlain:
      case CredentialsSource.LegacyEncrypted:
        filePath = this.legacyCredentialsPath;
        break;
      default:
        // No source set - nothing to clear
        break;
    }

    if (filePath) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (getErrorCode(error) !== 'ENOENT') {
          logWarn('Failed to delete credentials file', { error });
        }
      }
    }

    this.source = null;
    this.encryptionKey = null;
  }

  /**
   * Check if credentials exist in storage.
   */
  async exists(): Promise<boolean> {
    const files = [
      this.keyringCredentialsPath,
      this.keyfileCredentialsPath,
      this.legacyCredentialsPath,
    ];

    const checks = await Promise.all(
      files.map(async (file) => {
        try {
          await fs.access(file);
          return true;
        } catch (err) {
          logWarn('Credentials file not accessible', { cause: err });
          return false;
        }
      })
    );
    return checks.some((exists) => exists);
  }

  /**
   * Get the current credentials source (for testing/debugging).
   */
  getSource(): CredentialsSource | null {
    return this.source;
  }

  /**
   * Get the current encryption key (for in-flight refresh).
   * Returns null if no key is available (e.g., legacy plain format).
   */
  getEncryptionKey(): Buffer | null {
    return this.encryptionKey;
  }
}

// Singleton instance
let credentialsStorageInstance: CredentialsStorage | null = null;

// Stored config for deferred singleton initialization
let pendingConfig: CredentialsStorageConfig | null = null;

/**
 * Configure the CredentialsStorage singleton before it's created.
 * Must be called before any getCredentialsStorage() call.
 * This is used by CLI SEA builds to inject the embedded keytar loader.
 */
export function configureCredentialsStorage(
  config: CredentialsStorageConfig
): void {
  if (credentialsStorageInstance) {
    logWarn(
      'configureCredentialsStorage called after singleton already created'
    );
    return;
  }
  pendingConfig = config;
}

/**
 * Get the singleton CredentialsStorage instance.
 */
export function getCredentialsStorage(
  config?: CredentialsStorageConfig
): CredentialsStorage {
  if (!credentialsStorageInstance) {
    credentialsStorageInstance = new CredentialsStorage({
      ...(pendingConfig ?? {}),
      ...(config ?? {}),
    });
  }
  return credentialsStorageInstance;
}
