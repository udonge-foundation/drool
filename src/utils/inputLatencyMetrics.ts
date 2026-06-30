import { Metrics, type MetricLabels } from '@industry/logging';

import type { KeyEvent } from '@/contexts/types';
import { getCliRuntimeMetricLabels } from '@/utils/startupLatency';

const FLUSH_INTERVAL_MS = 1_000;
const MAX_SAMPLES_PER_BATCH = 50;

type InputKind =
  | 'standard'
  | 'at'
  | 'slash'
  | 'navigation'
  | 'paste'
  | 'control';

interface Batch {
  metric: string;
  labels: MetricLabels;
  values: number[];
}

const batches = new Map<string, Batch>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getBatchKey(metric: string, labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return `${metric}:${JSON.stringify(entries)}`;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((pct / 100) * sorted.length) - 1
  );
  return sorted[index] ?? 0;
}

function flushBatch(batch: Batch): void {
  if (batch.values.length === 0) return;
  Metrics.addToCounter(batch.metric, percentile(batch.values, 95), {
    ...batch.labels,
    aggregation: 'batch_p95',
    count: batch.values.length,
  });
}

export function flushInputLatencyMetrics(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (const batch of batches.values()) {
    flushBatch(batch);
  }
  batches.clear();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushInputLatencyMetrics();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

function getStartupAgeBucket(): string {
  const ageMs = process.uptime() * 1000;
  if (ageMs < 5_000) return '0_5s';
  if (ageMs < 20_000) return '5_20s';
  return '20s_plus';
}

export function recordInputLatency(
  metric: string,
  durationMs: number,
  labels: MetricLabels = {}
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const fullLabels = {
    ...getCliRuntimeMetricLabels(),
    startupAgeBucket: getStartupAgeBucket(),
    ...labels,
  };
  const key = getBatchKey(metric, fullLabels);
  let batch = batches.get(key);
  if (!batch) {
    batch = { metric, labels: fullLabels, values: [] };
    batches.set(key, batch);
  }
  batch.values.push(durationMs);
  if (batch.values.length >= MAX_SAMPLES_PER_BATCH) {
    batches.delete(key);
    flushBatch(batch);
  } else {
    scheduleFlush();
  }
}

export function getQueryLengthBucket(query: string): string {
  const length = query.length;
  if (length === 0) return '0';
  if (length <= 2) return '1_2';
  if (length <= 5) return '3_5';
  return '6_plus';
}

export function getResultCountBucket(count: number): string {
  if (count === 0) return '0';
  if (count <= 5) return '1_5';
  if (count <= 20) return '6_20';
  if (count <= 100) return '21_100';
  return '100_plus';
}

export function classifyKeyEvent(event: KeyEvent): InputKind {
  if (event.isPaste) return 'paste';
  if (event.input === '@') return 'at';
  if (event.input === '/') return 'slash';
  if (
    event.key.upArrow ||
    event.key.downArrow ||
    event.key.leftArrow ||
    event.key.rightArrow ||
    event.key.pageUp ||
    event.key.pageDown ||
    event.key.home ||
    event.key.end
  ) {
    return 'navigation';
  }
  if (
    event.key.ctrl ||
    event.key.meta ||
    event.key.tab ||
    event.key.return ||
    event.key.escape ||
    event.key.backspace ||
    event.key.delete
  ) {
    return 'control';
  }
  return 'standard';
}
