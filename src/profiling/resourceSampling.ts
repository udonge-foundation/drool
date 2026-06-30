import { logException } from '@industry/logging';

import type { ResourceSample } from '@/profiling/types';
import {
  clearPerformanceAndHintGC,
  getResourceSnapshot,
} from '@/services/ResourceMonitorService';

type BunLike = {
  version?: string;
};

type JscHeapStats = {
  heapSize?: number;
  heapCapacity?: number;
  objectCount?: number;
};

let hasLoggedJscHeapStatsError = false;

export function getBunVersion(): string | undefined {
  const bun = (globalThis as { Bun?: BunLike }).Bun;
  return bun?.version;
}

export function forceGarbageCollection(): void {
  clearPerformanceAndHintGC({ forceGc: true });
}

async function getJscHeapStats(): Promise<JscHeapStats | undefined> {
  if (!getBunVersion()) {
    return undefined;
  }

  try {
    const bunJscSpecifier = 'bun:jsc';
    const module = (await import(bunJscSpecifier)) as {
      heapStats?: () => JscHeapStats;
    };
    return module.heapStats?.();
  } catch (error) {
    if (!hasLoggedJscHeapStatsError) {
      hasLoggedJscHeapStatsError = true;
      logException(error, '[Profiler] Failed to read Bun JSC heap stats');
    }
    return undefined;
  }
}

export async function getResourceSample(options: {
  reason: string;
  phase?: string;
  previousSample?: ResourceSample;
  intervalMs?: number;
  includeJsc?: boolean;
}): Promise<ResourceSample> {
  const snapshot = getResourceSnapshot();
  const jscStats = options.includeJsc ? await getJscHeapStats() : undefined;

  const cpuUserDeltaMicros = options.previousSample
    ? snapshot.cpuUserMicros - options.previousSample.cpuUserMicros
    : undefined;
  const cpuSystemDeltaMicros = options.previousSample
    ? snapshot.cpuSystemMicros - options.previousSample.cpuSystemMicros
    : undefined;
  const intervalMs = options.intervalMs;
  const cpuUtilization =
    cpuUserDeltaMicros !== undefined &&
    cpuSystemDeltaMicros !== undefined &&
    intervalMs !== undefined &&
    intervalMs > 0
      ? ((cpuUserDeltaMicros + cpuSystemDeltaMicros) / 1000 / intervalMs) * 100
      : undefined;

  return {
    ...snapshot,
    reason: options.reason,
    phase: options.phase,
    cpuUserDeltaMicros,
    cpuSystemDeltaMicros,
    cpuUtilization,
    jscHeapSize: jscStats?.heapSize,
    jscHeapCapacity: jscStats?.heapCapacity,
    jscObjectCount: jscStats?.objectCount,
  };
}
