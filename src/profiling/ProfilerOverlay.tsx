import { Box, Text } from 'ink';
import { useMemo, useSyncExternalStore } from 'react';

import { COLORS } from '@/components/chat/themedColors';
import {
  getCliProfilerService,
  shouldShowProfilerOverlayFromEnv,
} from '@/profiling/CliProfilerService';
import { formatBytes } from '@/services/ResourceMonitorService';

function formatNumber(
  value: number | undefined,
  suffix: string,
  emptyLabel: string
): string {
  if (value === undefined || Number.isNaN(value)) return emptyLabel;
  return `${value.toFixed(1)}${suffix}`;
}

const LABELS = {
  prof: 'prof',
  rss: 'rss',
  heap: 'heap',
  external: 'ext',
  cpu: 'cpu',
  frames: 'frames',
  inkP95: 'ink p95',
  last: 'last',
  hot: 'hot',
  cache: 'cache',
  hit: 'hit',
  miss: 'miss',
  entries: 'entries',
  evict: 'evict',
} as const;

const EMPTY_LABEL = '-';
const MILLISECOND_SUFFIX = 'ms';
const PERCENT_SUFFIX = '%';

function ProfilerOverlayContent() {
  const profiler = getCliProfilerService();
  const { getSnapshot, subscribe } = useMemo(
    () => ({
      getSnapshot: () => profiler.getLiveStats(),
      subscribe: (listener: () => void) => profiler.subscribe(listener),
    }),
    [profiler]
  );
  const stats = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (!stats.enabled) {
    return null;
  }

  return (
    <Box marginLeft={1} marginBottom={0} flexDirection="column">
      <Text color={COLORS.text.muted}>
        {LABELS.prof} {LABELS.rss}{' '}
        {stats.rss === undefined ? EMPTY_LABEL : formatBytes(stats.rss)}{' '}
        {LABELS.heap}{' '}
        {stats.heapUsed === undefined
          ? EMPTY_LABEL
          : formatBytes(stats.heapUsed)}{' '}
        {LABELS.external}{' '}
        {stats.external === undefined
          ? EMPTY_LABEL
          : formatBytes(stats.external)}{' '}
        {LABELS.cpu}{' '}
        {formatNumber(stats.cpuUtilization, PERCENT_SUFFIX, EMPTY_LABEL)}{' '}
        {LABELS.frames} {stats.frames} {LABELS.inkP95}{' '}
        {formatNumber(stats.inkRenderP95, MILLISECOND_SUFFIX, EMPTY_LABEL)}{' '}
        {LABELS.last}{' '}
        {formatNumber(stats.inkRenderLast, MILLISECOND_SUFFIX, EMPTY_LABEL)}
      </Text>
      {stats.hottestReactRegion && (
        <Text color={COLORS.text.muted}>
          {LABELS.hot} {stats.hottestReactRegion}{' '}
          {formatNumber(
            stats.hottestReactCommitMs,
            MILLISECOND_SUFFIX,
            EMPTY_LABEL
          )}
        </Text>
      )}
      {stats.staticRenderCacheStats && (
        <Text color={COLORS.text.muted}>
          {LABELS.cache} {LABELS.hit} {stats.staticRenderCacheStats.hits}{' '}
          {LABELS.miss} {stats.staticRenderCacheStats.misses} {LABELS.entries}{' '}
          {stats.staticRenderCacheStats.entries} {LABELS.evict}{' '}
          {stats.staticRenderCacheStats.evictions}
        </Text>
      )}
    </Box>
  );
}

export function ProfilerOverlay() {
  if (!shouldShowProfilerOverlayFromEnv()) {
    return null;
  }

  return <ProfilerOverlayContent />;
}
