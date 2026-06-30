import { logError, logInfo } from '@industry/logging';

import { getResourceMonitorService } from '@/services/getResourceMonitorService';
import type { ResourceSnapshot } from '@/services/types';

const DEFAULT_INTERVAL_MS = 600_000; // Log every 10 minutes (reduced from 60s to lower log volume)

export function formatBytes(bytes: number): string {
  const absBytes = Math.abs(bytes);
  const sign = bytes < 0 ? '-' : '';
  if (absBytes < 1024) return `${sign}${absBytes}B`;
  if (absBytes < 1024 * 1024) return `${sign}${(absBytes / 1024).toFixed(1)}KB`;
  if (absBytes < 1024 * 1024 * 1024)
    return `${sign}${(absBytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${sign}${(absBytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function formatMicroseconds(us: number): string {
  if (us < 1000) return `${us}µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}

export function getResourceSnapshot(): ResourceSnapshot {
  const memUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();

  return {
    timestamp: Date.now(),
    rss: memUsage.rss,
    heapTotal: memUsage.heapTotal,
    heapUsed: memUsage.heapUsed,
    external: memUsage.external,
    arrayBuffers: memUsage.arrayBuffers,
    cpuUserMicros: cpuUsage.user,
    cpuSystemMicros: cpuUsage.system,
  };
}

// Limit Performance API resource timing buffer to prevent unbounded memory growth
// This is a primary defense against the "object:url" memory leak in Bun/JSC
const RESOURCE_TIMING_BUFFER_SIZE = 100;

/**
 * Clear Performance API entries and hint garbage collection to Bun/JSC.
 * This helps prevent memory leaks from:
 * - Resource timing entries accumulating from HTTP requests
 * - Performance marks/measures not being cleared
 * - JSC holding onto objects longer than necessary
 */
export function clearPerformanceAndHintGC(options?: {
  forceGc?: boolean;
}): void {
  try {
    if (typeof performance !== 'undefined') {
      if (performance.setResourceTimingBufferSize) {
        // Set buffer size limit to prevent Performance API memory leak.
        // This caps the number of resource timing entries that can accumulate.
        performance.setResourceTimingBufferSize(RESOURCE_TIMING_BUFFER_SIZE);
      }
      // Clear any existing entries that may have accumulated before this limit was set.
      if (performance.clearResourceTimings) {
        performance.clearResourceTimings();
      }
      if (performance.clearMarks) {
        performance.clearMarks();
      }
      if (performance.clearMeasures) {
        performance.clearMeasures();
      }
    }

    // Hint to Bun's JSC garbage collector to run.
    // This helps JSC release memory more promptly than its default heuristics
    const bunGlobal = globalThis as { Bun?: { gc?: (sync: boolean) => void } };
    if (bunGlobal.Bun?.gc) {
      bunGlobal.Bun.gc(Boolean(options?.forceGc));
    } else if (options?.forceGc) {
      (globalThis as { gc?: () => void }).gc?.();
    }
  } catch {
    // Ignore errors - these APIs may not be available in all environments
  }
}

export class ResourceMonitorService {
  private intervalId: NodeJS.Timeout | null = null;

  private intervalMs: number = DEFAULT_INTERVAL_MS;

  private startTime: number = 0;

  private initialSnapshot: ResourceSnapshot | null = null;

  private lastSnapshot: ResourceSnapshot | null = null;

  start(intervalMs?: number): void {
    if (this.intervalId) {
      return; // Already running
    }

    if (intervalMs !== undefined) {
      this.intervalMs = intervalMs;
    }

    clearPerformanceAndHintGC();

    this.startTime = Date.now();
    this.initialSnapshot = getResourceSnapshot();
    this.lastSnapshot = this.initialSnapshot;

    // Log initial resource state
    this.logResourceUsage('initial');

    this.intervalId = setInterval(() => {
      this.logResourceUsage('periodic');
    }, this.intervalMs);

    // Don't prevent process exit
    if (typeof this.intervalId.unref === 'function') {
      this.intervalId.unref();
    }
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  logResourceUsage(reason: 'initial' | 'periodic' | 'manual' = 'manual'): void {
    try {
      // Clear Performance API entries and hint GC to prevent memory leaks
      clearPerformanceAndHintGC();

      const snapshot = getResourceSnapshot();
      const uptimeMs = Date.now() - this.startTime;
      const intervalMs =
        this.lastSnapshot && reason !== 'initial'
          ? snapshot.timestamp - this.lastSnapshot.timestamp
          : this.intervalMs;

      const heapDelta =
        this.initialSnapshot && reason !== 'initial'
          ? snapshot.heapUsed - this.initialSnapshot.heapUsed
          : undefined;
      const rssDelta =
        this.initialSnapshot && reason !== 'initial'
          ? snapshot.rss - this.initialSnapshot.rss
          : undefined;

      // CPU time consumed since last snapshot (in microseconds)
      const cpuUserDelta =
        this.lastSnapshot && reason !== 'initial'
          ? snapshot.cpuUserMicros - this.lastSnapshot.cpuUserMicros
          : undefined;
      const cpuSystemDelta =
        this.lastSnapshot && reason !== 'initial'
          ? snapshot.cpuSystemMicros - this.lastSnapshot.cpuSystemMicros
          : undefined;

      // Calculate CPU utilization as percentage of wall clock time
      // (cpuDelta is in microseconds, intervalMs is in milliseconds)
      const cpuUtilization =
        cpuUserDelta !== undefined &&
        cpuSystemDelta !== undefined &&
        intervalMs > 0
          ? ((cpuUserDelta + cpuSystemDelta) / 1000 / intervalMs) * 100
          : undefined;

      logInfo('[ResourceMonitor] Resource usage snapshot', {
        reason,
        durationMs: uptimeMs,
        // eslint-disable-next-line industry/no-nested-log-metadata -- process memory snapshot (raw + human-formatted variants + deltas) consumed as a unit
        value: {
          // RSS: Total memory allocated to the process (heap + stack + code + buffers)
          rss: snapshot.rss,
          rssFormatted: formatBytes(snapshot.rss),
          // Heap: V8 JavaScript heap memory
          heapUsed: snapshot.heapUsed,
          heapTotal: snapshot.heapTotal,
          heapFormatted: `${formatBytes(snapshot.heapUsed)}/${formatBytes(snapshot.heapTotal)}`,
          // External: C++ objects bound to JS (includes arrayBuffers)
          external: snapshot.external,
          externalFormatted: formatBytes(snapshot.external),
          // ArrayBuffers: Subset of external, useful for tracking Buffer/TypedArray usage
          arrayBuffers: snapshot.arrayBuffers,
          arrayBuffersFormatted: formatBytes(snapshot.arrayBuffers),
          // Deltas from initial snapshot (only for periodic/manual)
          ...(heapDelta !== undefined
            ? {
                heapDelta,
                heapDeltaFormatted: `${heapDelta >= 0 ? '+' : ''}${formatBytes(heapDelta)}`,
              }
            : {}),
          ...(rssDelta !== undefined
            ? {
                rssDelta,
                rssDeltaFormatted: `${rssDelta >= 0 ? '+' : ''}${formatBytes(rssDelta)}`,
              }
            : {}),
          // CPU time consumed since last snapshot (user = JS execution, system = OS calls)
          ...(cpuUserDelta !== undefined
            ? {
                cpuUserDelta,
                cpuUserDeltaFormatted: formatMicroseconds(cpuUserDelta),
                cpuSystemDelta,
                cpuSystemDeltaFormatted: formatMicroseconds(cpuSystemDelta!),
                // CPU utilization: percentage of wall clock time spent on CPU
                // e.g., 50% means half the interval was spent executing, 200% means 2 cores fully utilized
                ...(cpuUtilization !== undefined
                  ? { cpuUtilization: `${cpuUtilization.toFixed(1)}%` }
                  : {}),
              }
            : {}),
        },
      });

      // Update last snapshot for next delta calculation
      this.lastSnapshot = snapshot;
    } catch (error) {
      logError('[ResourceMonitor] Failed to log resource usage', { error });
    }
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }
}

export function startResourceMonitoring(intervalMs?: number): void {
  getResourceMonitorService().start(intervalMs);
}

export function stopResourceMonitoring(): void {
  getResourceMonitorService().stop();
}
