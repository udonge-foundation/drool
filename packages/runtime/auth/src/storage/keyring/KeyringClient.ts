/**
 * Portions of this file are adapted from google-gemini/gemini-cli
 * https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/mcp/token-storage/keychain-token-storage.ts
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import type {
  KeyringStorageAdapter,
  KeyringStorageOptions,
  KeytarLoader,
  KeytarModule,
} from '../common/types';

/**
 * KeyringStorage provides secure credential storage using the OS keyring.
 *
 * Platform support:
 * - macOS: Keychain
 * - Windows: Credential Manager
 * - Linux: Secret Service (libsecret)
 *
 * This implementation uses the keytar library to interface with OS keychains.
 * Credentials stored here are encrypted and require OS-level authentication to access.
 *
 * Note: keytar is an optional native module. If it fails to load (e.g., in SEA builds
 * on unsupported platforms), all operations will gracefully fail and return unavailable.
 *
 * Concurrency: All operations are deduplicated per key so that concurrent callers
 * share a single in-flight OS keyring call. On macOS, each keytar call can trigger
 * a Keychain permission prompt; deduplication ensures at most one prompt per
 * operation even when multiple call-sites race (e.g. React StrictMode double-
 * firing effects in the Desktop renderer).
 */
export class KeyringClient implements KeyringStorageAdapter {
  private serviceName: string;

  private keytar: KeytarModule | null = null;

  private keytarLoader: KeytarLoader | undefined;

  private disableKeyring: boolean;

  /** In-flight promise for loadKeytar() (deduplication) */
  private keytarLoadPromise: Promise<boolean> | null = null;

  /**
   * In-flight promises for get operations, keyed by account key.
   * Concurrent get() calls for the same key share a single keyring access.
   */
  private inflightGets = new Map<string, Promise<string | undefined>>();

  /**
   * In-flight promises for set operations, keyed by account key.
   * Concurrent set() calls for the same key share a single keyring access.
   */
  private inflightSets = new Map<string, Promise<void>>();

  /**
   * In-flight promises for delete operations, keyed by account key.
   * Concurrent delete() calls for the same key share a single keyring access.
   */
  private inflightDeletes = new Map<string, Promise<boolean>>();

  constructor(options: KeyringStorageOptions = {}) {
    this.serviceName = options.serviceName ?? 'Industry CLI';
    this.keytarLoader = options.keytarLoader;
    this.disableKeyring = options.disableKeyring ?? false;
    if (options.keytar) {
      this.keytar = options.keytar;
      // Mark as resolved immediately so loadKeytar() short-circuits
      this.keytarLoadPromise = Promise.resolve(true);
    }
  }

  /**
   * Attempt to load the keytar native module.
   * Uses promise deduplication so concurrent callers share a single load attempt.
   * @returns true if keytar loaded successfully, false otherwise
   */
  private async loadKeytar(): Promise<boolean> {
    if (this.keytarLoadPromise) {
      return this.keytarLoadPromise;
    }

    this.keytarLoadPromise = this.doLoadKeytar();
    return this.keytarLoadPromise;
  }

  private async doLoadKeytar(): Promise<boolean> {
    if (this.disableKeyring) {
      logInfo('Keyring disabled via runtime auth config');
      return false;
    }

    // Try custom loader first (e.g., embedded keytar for CLI SEA builds)
    if (this.keytarLoader) {
      try {
        const loaded = await this.keytarLoader();
        if (loaded) {
          this.keytar = loaded;
          logInfo('Keyring storage enabled (custom loader)');
          return true;
        }
      } catch (error) {
        logWarn('Custom keytar loader failed', { error });
      }
    }

    // Fall back to standard import
    try {
      this.keytar = await import('keytar');
      logInfo('Keyring storage enabled');
      return true;
    } catch (error) {
      logWarn(
        'Failed to load keytar native module, keyring will be unavailable. Falling back to file-based key storage.',
        { error }
      );
      return false;
    }
  }

  /**
   * Run `fn` at most once per in-flight key in `map`.
   * Concurrent callers with the same key share a single promise.
   */
  private dedup<T>(
    map: Map<string, Promise<T>>,
    key: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const existing = map.get(key);
    if (existing) {
      return existing;
    }

    const promise = fn();
    map.set(key, promise);

    const cleanup = () => {
      map.delete(key);
    };
    promise.then(cleanup, cleanup);

    return promise;
  }

  /**
   * Retrieve a value from the keyring.
   * Concurrent calls for the same key share a single keyring access.
   * @param key The key to retrieve
   * @returns The value, or undefined if not found
   * @throws Error if keyring access fails
   */
  async get(key: string): Promise<string | undefined> {
    return this.dedup(this.inflightGets, key, async () => {
      const loaded = await this.loadKeytar();
      if (!loaded || !this.keytar) {
        return undefined;
      }

      const value = await this.keytar.getPassword(this.serviceName, key);
      return value ?? undefined;
    });
  }

  /**
   * Store a value in the keyring.
   * Concurrent calls for the same key share a single keyring access.
   * @param key The key to store under
   * @param value The value to store
   * @throws Error if keyring write fails
   */
  async set(key: string, value: string): Promise<void> {
    return this.dedup(this.inflightSets, key, async () => {
      const loaded = await this.loadKeytar();
      if (!loaded || !this.keytar) {
        throw new MetaError(
          'Cannot save to keyring: keytar module unavailable. Credentials cannot be stored securely.'
        );
      }

      await this.keytar.setPassword(this.serviceName, key, value);
    });
  }

  /**
   * Delete a value from the keyring.
   * Concurrent calls for the same key share a single keyring access.
   * @param key The key to delete
   * @returns true if the key was deleted, false if it didn't exist
   */
  async delete(key: string): Promise<boolean> {
    return this.dedup(this.inflightDeletes, key, async () => {
      const loaded = await this.loadKeytar();
      if (!loaded || !this.keytar) {
        return false;
      }

      return await this.keytar.deletePassword(this.serviceName, key);
    });
  }
}
