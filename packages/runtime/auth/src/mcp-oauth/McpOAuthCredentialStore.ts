import crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getErrorCode } from '@industry/utils/errors';

import {
  MCP_OAUTH_FILE_DATA_FILE_NAME,
  MCP_OAUTH_FILE_KEY_FILE_NAME,
} from './constants';
import { EncryptedMcpOAuthFileStore } from './EncryptedMcpOAuthFileStore';
import {
  McpOAuthCredentialStorageSchema,
  McpOAuthServerCredentialSchema,
  type McpOAuthClientInformation,
  type McpOAuthCredentialEntry,
  type McpOAuthCredentialStorage,
  type McpOAuthServerCredential,
} from './schema';
import {
  acquireFileLock,
  releaseFileLock,
  withFileLock,
} from '../storage/common/fileLock';

// Held across the refresh POST; dead owners are reclaimed immediately.
const MCP_OAUTH_REFRESH_LOCK_OPTIONS = {
  waitMs: 30_000,
  staleMs: 30_000,
  reclaimStaleWhileAlive: false,
} as const;

interface OverwriteMcpOAuthServerCredentialInput {
  credential: McpOAuthServerCredential;
  allowUnreadable?: boolean;
}

interface OverwriteMcpOAuthServerCredentialIfCurrentInput
  extends OverwriteMcpOAuthServerCredentialInput {
  expectedRevision: number;
}

interface McpOAuthServerCredentialSnapshot {
  credential?: McpOAuthServerCredential;
  revision: number;
}

type StorageReadMode =
  | 'best-effort-read'
  | 'strict-update'
  | 'replace-unreadable';

function emptyStorage(): McpOAuthCredentialStorage {
  return { mcpOAuth: {}, mcpOAuthTombstones: {} };
}

function normalizeIssuer(issuer: string): string {
  return new URL(issuer).href;
}

function computeStorageKey(serverName: string, serverUrl: string): string {
  const payload = JSON.stringify({ type: 'http', url: serverUrl });
  const hash = crypto
    .createHash('sha256')
    .update(payload)
    .digest('hex')
    .substring(0, 16);
  return `${serverName}|${hash}`;
}

/**
 * Project a stored entry to the client-registration fields the MCP SDK reads
 * back. Single source for this mapping so the persisted shape and what we hand
 * the SDK cannot drift (callers guarantee `clientId` is present).
 */
function toClientInformation(
  entry: McpOAuthCredentialEntry,
  clientId: string
): McpOAuthClientInformation {
  return {
    client_id: clientId,
    client_secret: entry.clientSecret,
    client_id_issued_at: entry.clientIdIssuedAt,
    client_secret_expires_at: entry.clientSecretExpiresAt,
    redirect_uris: entry.registeredRedirectUris,
    token_endpoint_auth_method: entry.tokenEndpointAuthMethod,
    grant_types: entry.grantTypes,
    response_types: entry.responseTypes,
  };
}

function toServerCredential(
  entry: McpOAuthCredentialEntry
): McpOAuthServerCredential {
  return {
    serverName: entry.serverName,
    serverUrl: entry.serverUrl,
    authorizationServerIssuer: entry.authorizationServerIssuer,
    authorizationServerMetadata: entry.authorizationServerMetadata,
    clientInformation: toClientInformation(entry, entry.clientId),
    resource: entry.resource,
    tokens: entry.accessToken
      ? {
          access_token: entry.accessToken,
          refresh_token: entry.refreshToken,
          token_type: entry.tokenType,
          expiresAt: entry.expiresAt,
          scope: entry.scope,
        }
      : undefined,
  };
}

function toCredentialEntry(
  credential: McpOAuthServerCredential,
  revision: number
): McpOAuthCredentialEntry {
  return {
    serverName: credential.serverName,
    serverUrl: credential.serverUrl,
    authorizationServerIssuer: credential.authorizationServerIssuer
      ? normalizeIssuer(credential.authorizationServerIssuer)
      : undefined,
    authorizationServerMetadata: credential.authorizationServerMetadata,
    clientId: credential.clientInformation.client_id,
    clientSecret: credential.clientInformation.client_secret,
    clientIdIssuedAt: credential.clientInformation.client_id_issued_at,
    clientSecretExpiresAt:
      credential.clientInformation.client_secret_expires_at,
    registeredRedirectUris: credential.clientInformation.redirect_uris,
    tokenEndpointAuthMethod:
      credential.clientInformation.token_endpoint_auth_method,
    grantTypes: credential.clientInformation.grant_types,
    responseTypes: credential.clientInformation.response_types,
    resource: credential.resource,
    accessToken: credential.tokens?.access_token,
    refreshToken: credential.tokens?.refresh_token,
    tokenType: credential.tokens?.token_type ?? 'Bearer',
    expiresAt: credential.tokens?.expiresAt,
    scope: credential.tokens?.scope,
    revision,
    updatedAt: Date.now(),
  };
}

interface StorageSnapshot {
  mtimeNs: bigint;
  size: bigint;
  data: McpOAuthCredentialStorage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function migrateLegacyClearAuthPlaceholders(parsed: unknown): unknown {
  if (!isRecord(parsed)) {
    return parsed;
  }

  const rawEntries = parsed.mcpOAuth;
  if (!isRecord(rawEntries)) {
    return parsed;
  }

  const migratedEntries = Object.fromEntries(
    Object.entries(rawEntries).filter(([, entry]) => {
      if (!isRecord(entry)) {
        return true;
      }

      const hasClientId =
        typeof entry.clientId === 'string' && entry.clientId.length > 0;

      return hasClientId;
    })
  );

  // Early clear-auth writes could leave an entry shell with no clientId. Treat
  // those shells as delete tombstones so one old clear-auth record cannot make
  // the whole credential file unreadable under the current schema.
  const migratedTombstones = Object.fromEntries(
    Object.entries(rawEntries)
      .filter((entry): entry is [string, Record<string, unknown>] =>
        isRecord(entry[1])
      )
      .filter(([, entry]) => {
        const hasClientId =
          typeof entry.clientId === 'string' && entry.clientId.length > 0;
        return !hasClientId;
      })
      .map(([key, entry]) => [
        key,
        {
          serverName:
            typeof entry.serverName === 'string' ? entry.serverName : key,
          serverUrl:
            typeof entry.serverUrl === 'string'
              ? entry.serverUrl
              : 'https://legacy.invalid/',
          revision:
            typeof entry.revision === 'number' && entry.revision >= 0
              ? Math.trunc(entry.revision)
              : 1,
          deletedAt:
            typeof entry.updatedAt === 'number' && entry.updatedAt > 0
              ? Math.trunc(entry.updatedAt)
              : Date.now(),
        },
      ])
  );

  return {
    ...parsed,
    mcpOAuth: migratedEntries,
    mcpOAuthTombstones: {
      ...(isRecord(parsed.mcpOAuthTombstones) ? parsed.mcpOAuthTombstones : {}),
      ...migratedTombstones,
    },
  };
}

function getCredentialRevision(
  data: McpOAuthCredentialStorage,
  key: string
): number {
  return Math.max(
    data.mcpOAuth[key]?.revision ?? 0,
    data.mcpOAuthTombstones[key]?.revision ?? 0
  );
}

export class McpOAuthCredentialStore {
  private readonly fileStore: EncryptedMcpOAuthFileStore;

  private readonly dataPath: string;

  private readonly keyPath: string;

  private readonly writeLockPath: string;

  /** Parsed snapshot of the data file, keyed by its stat fingerprint. */
  private cachedSnapshot: StorageSnapshot | null = null;

  constructor(storageDir: string) {
    this.dataPath = path.join(storageDir, MCP_OAUTH_FILE_DATA_FILE_NAME);
    this.keyPath = path.join(storageDir, MCP_OAUTH_FILE_KEY_FILE_NAME);
    this.fileStore = new EncryptedMcpOAuthFileStore(
      this.dataPath,
      this.keyPath
    );
    this.writeLockPath = `${this.dataPath}.write.lock`;
  }

  getStoragePaths(): { dataPath: string; keyPath: string } {
    return {
      dataPath: this.dataPath,
      keyPath: this.keyPath,
    };
  }

  private refreshLockPath(serverName: string, serverUrl: string): string {
    const keyHash = crypto
      .createHash('sha256')
      .update(computeStorageKey(serverName, serverUrl))
      .digest('hex')
      .substring(0, 16);
    return `${this.dataPath}.${keyHash}.refresh.lock`;
  }

  /** Serialize one server's refresh token rotation across processes. */
  async acquireRefreshLock({
    serverName,
    serverUrl,
  }: {
    serverName: string;
    serverUrl: string;
  }): Promise<() => Promise<void>> {
    const lockPath = this.refreshLockPath(serverName, serverUrl);
    const token = await acquireFileLock(
      lockPath,
      MCP_OAUTH_REFRESH_LOCK_OPTIONS
    );
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        await releaseFileLock(lockPath, token);
      } catch (error) {
        logWarn('Failed to release MCP OAuth refresh lock', {
          targetPath: lockPath,
          cause: error,
        });
      }
    };
  }

  private async readStorage(
    mode: StorageReadMode = 'strict-update'
  ): Promise<McpOAuthCredentialStorage> {
    const raw = await this.fileStore.load();
    if (!raw) {
      if (mode === 'strict-update' && (await this.fileStore.exists())) {
        throw new MetaError('Failed to update unreadable MCP OAuth storage');
      }
      return emptyStorage();
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      return McpOAuthCredentialStorageSchema.parse(
        migrateLegacyClearAuthPlaceholders(parsed)
      );
    } catch (error) {
      // Unparseable storage is treated as missing credentials: it is never
      // quarantined or deleted. Mutations fail closed so a malformed entry
      // cannot erase unrelated credentials.
      logWarn('Failed to parse MCP OAuth storage payload', { cause: error });
      if (mode === 'best-effort-read') {
        return emptyStorage();
      }
      throw new MetaError('Failed to update malformed MCP OAuth storage', {
        cause: error,
      });
    }
  }

  /**
   * Reads never take a lock: the data and key files are written atomically
   * (temp file + rename), so a reader always sees a complete payload, and
   * unreadable content already degrades to "missing credentials". A stat
   * fingerprint caches the parsed snapshot so the per-request token reads
   * issued by the MCP SDK do not re-decrypt an unchanged file.
   */
  private async load(): Promise<McpOAuthCredentialStorage> {
    const stats = await fs
      .stat(this.dataPath, { bigint: true })
      .catch((error: unknown) => {
        if (getErrorCode(error) === 'ENOENT') {
          return null;
        }
        throw error;
      });
    if (!stats) {
      this.cachedSnapshot = null;
      return emptyStorage();
    }

    if (
      this.cachedSnapshot &&
      this.cachedSnapshot.mtimeNs === stats.mtimeNs &&
      this.cachedSnapshot.size === stats.size
    ) {
      return this.cachedSnapshot.data;
    }

    const data = await this.readStorage('best-effort-read');
    this.cachedSnapshot = { mtimeNs: stats.mtimeNs, size: stats.size, data };
    return data;
  }

  /**
   * Read-modify-write under a short-lived write lock so concurrent writers in
   * other processes cannot drop each other's entries.
   */
  private async update(
    mutator: (data: McpOAuthCredentialStorage) => void,
    { allowUnreadable = false }: { allowUnreadable?: boolean } = {}
  ): Promise<void> {
    await withFileLock(this.writeLockPath, async () => {
      const data = await this.readStorage(
        allowUnreadable ? 'replace-unreadable' : 'strict-update'
      );
      mutator(data);
      const validated = McpOAuthCredentialStorageSchema.parse(data);
      await this.fileStore.save(JSON.stringify(validated));
    });
    this.cachedSnapshot = null;
  }

  async readServerCredential(
    serverName: string,
    serverUrl: string
  ): Promise<McpOAuthServerCredential | undefined> {
    return (await this.readServerCredentialSnapshot(serverName, serverUrl))
      .credential;
  }

  async readServerCredentialSnapshot(
    serverName: string,
    serverUrl: string
  ): Promise<McpOAuthServerCredentialSnapshot> {
    const key = computeStorageKey(serverName, serverUrl);
    const data = await this.load();
    const entry = data.mcpOAuth[key];
    return {
      credential: entry ? toServerCredential(entry) : undefined,
      revision: getCredentialRevision(data, key),
    };
  }

  async overwriteServerCredential({
    credential,
    allowUnreadable = false,
  }: OverwriteMcpOAuthServerCredentialInput): Promise<void> {
    const parsedCredential = McpOAuthServerCredentialSchema.parse(credential);
    const key = computeStorageKey(
      parsedCredential.serverName,
      parsedCredential.serverUrl
    );
    await this.update(
      (data) => {
        const revision = getCredentialRevision(data, key) + 1;
        data.mcpOAuth[key] = toCredentialEntry(parsedCredential, revision);
        delete data.mcpOAuthTombstones[key];
      },
      { allowUnreadable }
    );
  }

  async overwriteServerCredentialIfCurrent({
    credential,
    expectedRevision,
    allowUnreadable = false,
  }: OverwriteMcpOAuthServerCredentialIfCurrentInput): Promise<boolean> {
    const parsedCredential = McpOAuthServerCredentialSchema.parse(credential);
    const key = computeStorageKey(
      parsedCredential.serverName,
      parsedCredential.serverUrl
    );
    let didWrite = false;
    await this.update(
      (data) => {
        if (getCredentialRevision(data, key) !== expectedRevision) {
          return;
        }
        data.mcpOAuth[key] = toCredentialEntry(
          parsedCredential,
          expectedRevision + 1
        );
        delete data.mcpOAuthTombstones[key];
        didWrite = true;
      },
      { allowUnreadable }
    );
    return didWrite;
  }

  async deleteServerCredential({
    serverName,
    serverUrl,
  }: {
    serverName: string;
    serverUrl: string;
  }): Promise<void> {
    const key = computeStorageKey(serverName, serverUrl);
    await this.update((data) => {
      const revision = getCredentialRevision(data, key) + 1;
      delete data.mcpOAuth[key];
      data.mcpOAuthTombstones[key] = {
        serverName,
        serverUrl,
        revision,
        deletedAt: Date.now(),
      };
    });
  }
}
