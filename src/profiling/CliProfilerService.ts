import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProfileEventKind, ProfilerMode } from '@/profiling/enums';
import {
  forceGarbageCollection,
  getBunVersion,
  getResourceSample,
} from '@/profiling/resourceSampling';
import type {
  InkRenderSample,
  LiveProfilerStats,
  ProfileEvent,
  ProfilerRunMetadata,
  ProfileRunSnapshot,
  ReactCommitSample,
  ResourceSample,
} from '@/profiling/types';
import {
  clearDisplayWidthCache,
  getDisplayWidthCacheStats,
} from '@/utils/displayWidth';
import {
  clearStaticRenderCache,
  getStaticRenderCacheStats,
  resetStaticRenderCacheStats,
} from '@/utils/staticRenderCache';

type Listener = () => void;

type ReactProfilerPhase = 'mount' | 'update' | 'nested-update';

const DISABLED_LIVE_STATS: LiveProfilerStats = Object.freeze({
  enabled: false,
  frames: 0,
});

interface StartRunOptions {
  mode: ProfilerMode;
  runId?: string;
  outputDir?: string;
  writeArtifacts?: boolean;
  includeJsc?: boolean;
}

const DEFAULT_INTERACTIVE_SAMPLE_INTERVAL_MS = 1000;

function createRunId(mode: ProfilerMode): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${mode}-${timestamp}-${process.pid}`;
}

function getDefaultProfileRoot(): string {
  return path.join(os.homedir(), '.industry-dev', 'profiles');
}

function getDefaultOutputDir(mode: ProfilerMode, runId: string): string {
  if (mode === ProfilerMode.Benchmark) {
    return path.join(process.cwd(), '.perf-results', runId);
  }
  return path.join(getDefaultProfileRoot(), runId);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return Number(sorted[index]!.toFixed(3));
}

export class CliProfilerService {
  private metadata: ProfilerRunMetadata | null = null;

  private writeArtifacts = false;

  private includeJsc = false;

  private currentPhase: string | undefined;

  private startedAtMs = 0;

  private resourceSamples: ResourceSample[] = [];

  private inkRenderSamples: InkRenderSample[] = [];

  private reactCommitSamples: ReactCommitSample[] = [];

  private listeners = new Set<Listener>();

  private resourceIntervalId: NodeJS.Timeout | null = null;

  private lastResourceSample: ResourceSample | undefined;

  private lastResourceSampleAt: number | undefined;

  private liveStatsSnapshot: LiveProfilerStats | undefined;

  isEnabled(): boolean {
    return this.metadata !== null;
  }

  getMetadata(): ProfilerRunMetadata | null {
    return this.metadata;
  }

  startRun(options: StartRunOptions): ProfilerRunMetadata {
    if (this.isEnabled()) {
      return this.metadata!;
    }

    const runId = options.runId ?? createRunId(options.mode);
    const outputDir =
      options.outputDir ?? getDefaultOutputDir(options.mode, runId);
    this.writeArtifacts = options.writeArtifacts ?? true;
    this.includeJsc = options.includeJsc ?? true;
    this.startedAtMs = Date.now();
    this.resourceSamples = [];
    this.inkRenderSamples = [];
    this.reactCommitSamples = [];
    clearDisplayWidthCache();
    clearStaticRenderCache();
    resetStaticRenderCacheStats();
    this.lastResourceSample = undefined;
    this.lastResourceSampleAt = undefined;
    clearStaticRenderCache();
    resetStaticRenderCacheStats();

    this.metadata = {
      runId,
      mode: options.mode,
      startedAt: new Date(this.startedAtMs).toISOString(),
      outputDir,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      bunVersion: getBunVersion(),
      ci: process.env.CI === 'true',
    };

    if (this.writeArtifacts) {
      fs.mkdirSync(outputDir, { recursive: true });
      writeJson(path.join(outputDir, 'metadata.json'), this.metadata);
    }

    this.recordEvent({
      kind: ProfileEventKind.RunStart,
      timestamp: Date.now(),
      runId,
      metadata: this.metadata,
    });
    this.notify();
    return this.metadata;
  }

  async stopRun(): Promise<ProfileRunSnapshot | null> {
    if (!this.isEnabled()) {
      return null;
    }

    this.stopResourceSampling();
    await this.takeResourceSample('final', { forceGc: true });
    const snapshot = this.getRunSnapshot();
    if (!snapshot) {
      return null;
    }

    this.recordEvent({
      kind: ProfileEventKind.RunStop,
      timestamp: Date.now(),
      runId: snapshot.metadata.runId,
      endedAt: snapshot.endedAt,
      durationMs: snapshot.durationMs,
    });

    if (this.writeArtifacts) {
      writeJson(
        path.join(snapshot.metadata.outputDir, 'snapshot.json'),
        snapshot
      );
    }

    this.metadata = null;
    this.currentPhase = undefined;
    this.notify();
    return snapshot;
  }

  getRunSnapshot(): ProfileRunSnapshot | null {
    if (!this.isEnabled()) {
      return null;
    }

    return {
      metadata: this.metadata!,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - this.startedAtMs,
      resourceSamples: [...this.resourceSamples],
      inkRenderSamples: [...this.inkRenderSamples],
      reactCommitSamples: [...this.reactCommitSamples],
      staticRenderCacheStats: getStaticRenderCacheStats(),
      displayWidthCacheStats: getDisplayWidthCacheStats(),
    };
  }

  startPhase(phase: string): void {
    if (!this.isEnabled()) return;
    this.currentPhase = phase;
    this.recordEvent({
      kind: ProfileEventKind.PhaseStart,
      timestamp: Date.now(),
      runId: this.metadata!.runId,
      phase,
    });
  }

  stopPhase(phase = this.currentPhase): void {
    if (!this.isEnabled() || !phase) return;
    this.recordEvent({
      kind: ProfileEventKind.PhaseStop,
      timestamp: Date.now(),
      runId: this.metadata!.runId,
      phase,
    });
    if (this.currentPhase === phase) {
      this.currentPhase = undefined;
    }
  }

  startResourceSampling(
    intervalMs = DEFAULT_INTERACTIVE_SAMPLE_INTERVAL_MS
  ): void {
    if (!this.isEnabled() || this.resourceIntervalId) {
      return;
    }

    void this.takeResourceSample('initial', { forceGc: false });
    this.resourceIntervalId = setInterval(() => {
      void this.takeResourceSample('periodic', { forceGc: false });
    }, intervalMs);
    this.resourceIntervalId.unref?.();
  }

  stopResourceSampling(): void {
    if (!this.resourceIntervalId) return;
    clearInterval(this.resourceIntervalId);
    this.resourceIntervalId = null;
  }

  async takeResourceSample(
    reason: string,
    options: { forceGc?: boolean } = {}
  ): Promise<ResourceSample | null> {
    if (!this.isEnabled()) return null;

    if (options.forceGc) {
      forceGarbageCollection();
    }

    const now = Date.now();
    const intervalMs = this.lastResourceSampleAt
      ? now - this.lastResourceSampleAt
      : undefined;
    const sample = await getResourceSample({
      reason,
      phase: this.currentPhase,
      previousSample: this.lastResourceSample,
      intervalMs,
      includeJsc: this.includeJsc,
    });

    this.resourceSamples.push(sample);
    this.lastResourceSample = sample;
    this.lastResourceSampleAt = sample.timestamp;
    this.recordEvent({
      kind: ProfileEventKind.Resource,
      timestamp: sample.timestamp,
      runId: this.metadata!.runId,
      sample,
    });
    this.notify();
    return sample;
  }

  recordInkRender(metrics: { renderTime?: number }): void {
    if (!this.isEnabled()) return;
    const sample: InkRenderSample = {
      timestamp: Date.now(),
      phase: this.currentPhase,
      renderTime: Number((metrics.renderTime ?? 0).toFixed(3)),
    };
    this.inkRenderSamples.push(sample);
    this.invalidateLiveStats();
    this.recordEvent({
      kind: ProfileEventKind.InkRender,
      timestamp: sample.timestamp,
      runId: this.metadata!.runId,
      sample,
    });
  }

  recordReactCommit = (
    id: string,
    phase: ReactProfilerPhase,
    actualDuration: number,
    baseDuration: number,
    startTime: number,
    commitTime: number
  ): void => {
    if (!this.isEnabled()) return;
    const sample: ReactCommitSample = {
      timestamp: Date.now(),
      phase: this.currentPhase,
      id,
      commitPhase: phase,
      actualDuration: Number(actualDuration.toFixed(3)),
      baseDuration: Number(baseDuration.toFixed(3)),
      startTime: Number(startTime.toFixed(3)),
      commitTime: Number(commitTime.toFixed(3)),
    };
    this.reactCommitSamples.push(sample);
    this.invalidateLiveStats();
    this.recordEvent({
      kind: ProfileEventKind.ReactCommit,
      timestamp: sample.timestamp,
      runId: this.metadata!.runId,
      sample,
    });
  };

  getLiveStats(): LiveProfilerStats {
    if (this.liveStatsSnapshot) {
      return this.liveStatsSnapshot;
    }

    if (!this.isEnabled()) {
      this.liveStatsSnapshot = DISABLED_LIVE_STATS;
      return this.liveStatsSnapshot;
    }

    const latestResource =
      this.resourceSamples[this.resourceSamples.length - 1];
    const latestInk = this.inkRenderSamples[this.inkRenderSamples.length - 1];
    const recentByRegion = new Map<string, number>();
    for (const sample of this.reactCommitSamples.slice(-50)) {
      recentByRegion.set(
        sample.id,
        Math.max(recentByRegion.get(sample.id) ?? 0, sample.actualDuration)
      );
    }
    const hottest = [...recentByRegion.entries()].sort(
      (a, b) => b[1] - a[1]
    )[0];

    this.liveStatsSnapshot = {
      enabled: true,
      runId: this.metadata!.runId,
      mode: this.metadata!.mode,
      outputDir: this.metadata!.outputDir,
      frames: this.inkRenderSamples.length,
      rss: latestResource?.rss,
      heapUsed: latestResource?.heapUsed,
      external: latestResource?.external,
      arrayBuffers: latestResource?.arrayBuffers,
      cpuUtilization: latestResource?.cpuUtilization,
      inkRenderP95: percentile(
        this.inkRenderSamples.map((sample) => sample.renderTime),
        95
      ),
      inkRenderLast: latestInk?.renderTime,
      hottestReactRegion: hottest?.[0],
      hottestReactCommitMs: hottest?.[1],
      staticRenderCacheStats: getStaticRenderCacheStats(),
      displayWidthCacheStats: getDisplayWidthCacheStats(),
    };
    return this.liveStatsSnapshot;
  }

  subscribe(listener: Listener): () => void {
    const listeners = this.listeners;
    let isSubscribed = true;

    listeners.add(listener);
    return () => {
      if (!isSubscribed) {
        return;
      }

      isSubscribed = false;
      listeners.delete(listener);
    };
  }

  resetForTesting(): void {
    this.stopResourceSampling();
    this.metadata = null;
    this.currentPhase = undefined;
    this.startedAtMs = 0;
    this.resourceSamples = [];
    this.inkRenderSamples = [];
    this.reactCommitSamples = [];
    clearDisplayWidthCache();
    clearStaticRenderCache();
    resetStaticRenderCacheStats();
    this.lastResourceSample = undefined;
    this.lastResourceSampleAt = undefined;
    this.writeArtifacts = false;
    this.includeJsc = false;
    clearStaticRenderCache();
    resetStaticRenderCacheStats();
    this.notify();
  }

  private recordEvent(event: ProfileEvent): void {
    if (!this.isEnabled() || !this.writeArtifacts) {
      return;
    }
    fs.appendFileSync(
      path.join(this.metadata!.outputDir, 'profile.jsonl'),
      `${JSON.stringify(event)}\n`
    );
  }

  private notify(): void {
    this.invalidateLiveStats();
    for (const listener of this.listeners) {
      listener();
    }
  }

  private invalidateLiveStats(): void {
    this.liveStatsSnapshot = undefined;
  }
}

const cliProfilerService = new CliProfilerService();

export function getCliProfilerService(): CliProfilerService {
  return cliProfilerService;
}

export function shouldEnableCliProfilerFromEnv(): boolean {
  return (
    process.env.DROOL_PROFILE === '1' ||
    process.env.DROOL_PROFILE === 'true' ||
    process.env.DROOL_PROFILE_OVERLAY === '1' ||
    process.env.DROOL_PROFILE_OVERLAY === 'true' ||
    process.env.DROOL_REACT_DEVTOOLS === '1' ||
    process.env.DROOL_REACT_DEVTOOLS === 'true'
  );
}

export function shouldShowProfilerOverlayFromEnv(): boolean {
  return (
    process.env.DROOL_PROFILE_OVERLAY === '1' ||
    process.env.DROOL_PROFILE_OVERLAY === 'true'
  );
}
