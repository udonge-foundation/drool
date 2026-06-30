import fs from 'fs';
import path from 'path';

import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import type {
  CodingSubscriptionAuthRecord,
  CodingSubscriptionGateData,
  CodingSubscriptionProvider,
} from './types';

const GATE_FILE_NAME = 'coding-subs.json';
const CODING_SUBSCRIPTION_PROVIDERS: CodingSubscriptionProvider[] = [
  'codex',
  'claude',
  'xai',
  'kimi',
  'antigravity',
];

function oauthDir(): string {
  return path.join(getIndustryHome(), getIndustryDirName(), 'oauth');
}

function ensureOAuthDir(): void {
  fs.mkdirSync(oauthDir(), { recursive: true });
}

function providerPath(provider: CodingSubscriptionProvider): string {
  return path.join(oauthDir(), `${provider}.json`);
}

function gatePath(): string {
  return path.join(oauthDir(), GATE_FILE_NAME);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureOAuthDir();
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

function normalizeGate(value: unknown): CodingSubscriptionGateData {
  const record =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return {
    version: 1,
    codingSubscriptionsAllowed: record.codingSubscriptionsAllowed === true,
  };
}

export class CodingSubscriptionAuthStore {
  getAuthSync(
    provider: CodingSubscriptionProvider
  ): CodingSubscriptionAuthRecord | null {
    const auth = readJson<CodingSubscriptionAuthRecord>(providerPath(provider));
    return auth?.type === provider ? auth : null;
  }

  async isAllowed(): Promise<boolean> {
    return normalizeGate(readJson<CodingSubscriptionGateData>(gatePath()))
      .codingSubscriptionsAllowed;
  }

  async enableOnce(): Promise<boolean> {
    const current = normalizeGate(
      readJson<CodingSubscriptionGateData>(gatePath())
    );
    if (current.codingSubscriptionsAllowed) return false;
    writeJson(gatePath(), {
      version: 1,
      codingSubscriptionsAllowed: true,
    });
    return true;
  }

  async getAuth(
    provider: CodingSubscriptionProvider
  ): Promise<CodingSubscriptionAuthRecord | null> {
    const auth = readJson<CodingSubscriptionAuthRecord>(providerPath(provider));
    return auth?.type === provider ? auth : null;
  }

  async getConfiguredProviders(): Promise<CodingSubscriptionProvider[]> {
    return CODING_SUBSCRIPTION_PROVIDERS.filter((provider) => {
      const auth = readJson<CodingSubscriptionAuthRecord>(
        providerPath(provider)
      );
      return auth?.type === provider;
    });
  }

  async saveAuth(auth: CodingSubscriptionAuthRecord): Promise<void> {
    writeJson(providerPath(auth.type), auth);
  }
}

let defaultStore: CodingSubscriptionAuthStore | null = null;

export function getCodingSubscriptionAuthStore(): CodingSubscriptionAuthStore {
  defaultStore ??= new CodingSubscriptionAuthStore();
  return defaultStore;
}

export async function isCodingSubscriptionOAuthAllowed(): Promise<boolean> {
  return getCodingSubscriptionAuthStore().isAllowed();
}

export async function enableCodingSubscriptionOAuthOnce(): Promise<boolean> {
  return getCodingSubscriptionAuthStore().enableOnce();
}

export function getCodingSubscriptionAccessTokenSync(
  provider: CodingSubscriptionProvider
): string | null {
  return getCodingSubscriptionAuthStore().getAuthSync(provider)?.access_token ?? null;
}
