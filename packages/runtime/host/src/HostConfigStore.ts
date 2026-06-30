import fs from 'fs/promises';
import path from 'path';

import { writeFile as writeFileAtomic } from 'atomically';

import { COMPUTER_CONFIG_FILENAME } from '@industry/common/api/v0/computers';
import { HOST_CONFIG_FILENAME } from '@industry/common/host/constants';
import {
  HostConfigSchema,
  LegacyComputerConfigSchema,
} from '@industry/drool-sdk-ext/protocol/host';
import { MetaError } from '@industry/logging/errors';
import { getErrorCode } from '@industry/utils/errors';

import type {
  HostConfig,
  LegacyComputerConfig,
} from '@industry/drool-sdk-ext/protocol/host';

const HOST_CONFIG_LOCK_TIMEOUT_MS = 5_000;
const HOST_CONFIG_LOCK_RETRY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function removeStaleLock(
  lockPath: string,
  staleMs: number
): Promise<boolean> {
  try {
    const stats = await fs.stat(lockPath);
    if (Date.now() - stats.mtimeMs < staleMs) {
      return false;
    }
    await fs.rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

async function tryCreateLockDirectory(lockPath: string): Promise<boolean> {
  return fs.mkdir(lockPath, { mode: 0o700 }).then(
    () => true,
    (error: unknown) => {
      if (getErrorCode(error) === 'EEXIST') {
        return false;
      }
      throw error;
    }
  );
}

async function acquireLock(
  lockPath: string,
  options: { stale: number; wait: number; pollPeriod: number }
): Promise<void> {
  const deadline = Date.now() + options.wait;

  while (true) {
    if (await tryCreateLockDirectory(lockPath)) {
      return;
    }

    if (await removeStaleLock(lockPath, options.stale)) {
      continue;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new MetaError('Timed out waiting for host config lock:', {
        targetPath: lockPath,
      });
    }
    await sleep(Math.min(options.pollPeriod, remainingMs));
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { recursive: true, force: true });
}

export class HostConfigStore {
  readonly hostConfigPath: string;

  readonly legacyComputerConfigPath: string;

  constructor(private readonly industryDir: string) {
    this.hostConfigPath = path.join(industryDir, HOST_CONFIG_FILENAME);
    this.legacyComputerConfigPath = path.join(
      industryDir,
      COMPUTER_CONFIG_FILENAME
    );
  }

  async loadHostConfig(): Promise<HostConfig | null> {
    const raw = await this.readFileIfExists(this.hostConfigPath);
    if (raw === null) return null;

    try {
      const parsed = HostConfigSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async saveHostConfig(config: HostConfig): Promise<void> {
    await this.writeJsonAtomically(this.hostConfigPath, config);
  }

  async withHostConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.hostConfigPath), {
      recursive: true,
      mode: 0o700,
    });
    const lockPath = `${this.hostConfigPath}.lock`;
    await acquireLock(lockPath, {
      stale: HOST_CONFIG_LOCK_TIMEOUT_MS,
      wait: HOST_CONFIG_LOCK_TIMEOUT_MS,
      pollPeriod: HOST_CONFIG_LOCK_RETRY_MS,
    });

    try {
      return await fn();
    } finally {
      await releaseLock(lockPath);
    }
  }

  async quarantineHostConfig(suffix: string): Promise<void> {
    try {
      await fs.rename(this.hostConfigPath, `${this.hostConfigPath}.${suffix}`);
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') return;
      throw error;
    }
  }

  async loadLegacyComputerConfig(): Promise<LegacyComputerConfig | null> {
    const raw = await this.readFileIfExists(this.legacyComputerConfigPath);
    if (raw === null) return null;

    try {
      const parsed = LegacyComputerConfigSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async saveLegacyComputerConfig(config: LegacyComputerConfig): Promise<void> {
    await this.writeJsonAtomically(this.legacyComputerConfigPath, config);
  }

  async removeLegacyComputerConfig(): Promise<void> {
    try {
      await fs.unlink(this.legacyComputerConfigPath);
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') return;
      throw error;
    }
  }

  private async readFileIfExists(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async writeJsonAtomically(
    filePath: string,
    data: unknown
  ): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(filePath, JSON.stringify(data, null, 2), {
      mode: 0o600,
    });
  }
}
