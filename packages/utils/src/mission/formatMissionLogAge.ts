import type { FormatMissionLogAgeOptions } from './types';

export function formatMissionLogAge(
  timestamp: string,
  options?: FormatMissionLogAgeOptions
): string {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) {
    return '';
  }

  const elapsedMs = Math.max(0, Date.now() - time);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  const withAgoSuffix = options?.withAgoSuffix ?? false;
  const suffix = withAgoSuffix ? ' ago' : '';

  if (elapsedMinutes < 1) {
    return withAgoSuffix ? '<1m ago' : 'now';
  }
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m${suffix}`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h${suffix}`;
  }

  return `${Math.floor(elapsedHours / 24)}d${suffix}`;
}
