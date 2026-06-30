import { createHash } from 'node:crypto';

import type {
  CacheEntry,
  StaticRenderCacheOptions,
  StaticRenderCacheStats,
} from '@/utils/staticRenderCache/types';

const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_RETAINED_CHARACTERS = 5 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_CHARACTERS = 512 * 1024;

class StaticRenderCache {
  private entries = new Map<string, CacheEntry<unknown>>();

  private retainedCharacters = 0;

  private hits = 0;

  private misses = 0;

  private evictions = 0;

  private clears = 0;

  private skippedOversized = 0;

  private maxEntries: number;

  private maxRetainedCharacters: number;

  private maxEntryCharacters: number;

  constructor(options: StaticRenderCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxRetainedCharacters =
      options.maxRetainedCharacters ?? DEFAULT_MAX_RETAINED_CHARACTERS;
    this.maxEntryCharacters =
      options.maxEntryCharacters ?? DEFAULT_MAX_ENTRY_CHARACTERS;
  }

  getOrCompute<T>(
    key: string,
    retainedCharacters: number,
    compute: () => T
  ): T {
    const cached = this.entries.get(key);
    if (cached) {
      this.hits++;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.value as T;
    }

    this.misses++;
    const value = compute();
    const boundedRetainedCharacters = Math.max(
      0,
      Math.ceil(retainedCharacters)
    );

    if (boundedRetainedCharacters > this.maxEntryCharacters) {
      this.skippedOversized++;
      return value;
    }

    this.entries.set(key, {
      value,
      retainedCharacters: boundedRetainedCharacters,
    });
    this.retainedCharacters += boundedRetainedCharacters;
    this.evictIfNeeded();
    return value;
  }

  clear(): void {
    if (this.entries.size > 0 || this.retainedCharacters > 0) {
      this.clears++;
    }
    this.entries.clear();
    this.retainedCharacters = 0;
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.clears = 0;
    this.skippedOversized = 0;
  }

  getStats(): StaticRenderCacheStats {
    return {
      entries: this.entries.size,
      retainedCharacters: this.retainedCharacters,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      clears: this.clears,
      skippedOversized: this.skippedOversized,
    };
  }

  configureForTesting(options: StaticRenderCacheOptions): void {
    this.maxEntries = options.maxEntries ?? this.maxEntries;
    this.maxRetainedCharacters =
      options.maxRetainedCharacters ?? this.maxRetainedCharacters;
    this.maxEntryCharacters =
      options.maxEntryCharacters ?? this.maxEntryCharacters;
    this.evictIfNeeded();
  }

  resetForTesting(): void {
    this.entries.clear();
    this.retainedCharacters = 0;
    this.maxEntries = DEFAULT_MAX_ENTRIES;
    this.maxRetainedCharacters = DEFAULT_MAX_RETAINED_CHARACTERS;
    this.maxEntryCharacters = DEFAULT_MAX_ENTRY_CHARACTERS;
    this.resetStats();
  }

  private evictIfNeeded(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.retainedCharacters > this.maxRetainedCharacters
    ) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.retainedCharacters -= oldest?.retainedCharacters ?? 0;
      this.evictions++;
    }
  }
}

const staticRenderCache = new StaticRenderCache();

function stableStringify(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item) ?? 'null').join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => {
      const nested = stableStringify(record[key]);
      return nested === undefined
        ? undefined
        : `${JSON.stringify(key)}:${nested}`;
    })
    .filter((item): item is string => item !== undefined)
    .join(',')}}`;
}

export function createStaticRenderFingerprint(value: unknown): string {
  const serialized =
    typeof value === 'string' ? value : (stableStringify(value) ?? '');
  return `${serialized.length}:${createHash('sha256')
    .update(serialized)
    .digest('hex')
    .slice(0, 24)}`;
}

export function getOrComputeStaticRenderCache<T>(
  key: string,
  retainedCharacters: number,
  compute: () => T
): T {
  return staticRenderCache.getOrCompute(key, retainedCharacters, compute);
}

export function getStaticRenderCacheStats(): StaticRenderCacheStats {
  return staticRenderCache.getStats();
}

export function clearStaticRenderCache(): void {
  staticRenderCache.clear();
}

export function resetStaticRenderCacheStats(): void {
  staticRenderCache.resetStats();
}

export function configureStaticRenderCacheForTesting(
  options: StaticRenderCacheOptions
): void {
  staticRenderCache.configureForTesting(options);
}

export function resetStaticRenderCacheForTesting(): void {
  staticRenderCache.resetForTesting();
}
