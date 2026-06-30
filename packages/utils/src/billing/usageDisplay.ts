import type { BillingLimitsBucketData } from '@industry/common/billing';

export function formatRateLimitUsagePercent(
  bucket: BillingLimitsBucketData | null | undefined,
  fallback = '—'
): string {
  if (!bucket || !Number.isFinite(bucket.usedPercent)) return fallback;
  const percent = Math.max(0, Math.min(100, Math.ceil(bucket.usedPercent)));
  return `${percent}%`;
}

export function formatRateLimitReset(
  bucket: BillingLimitsBucketData | null | undefined,
  nowMs = Date.now()
): string | null {
  if (!bucket) return null;

  const secondsRemaining =
    typeof bucket.secondsRemaining === 'number'
      ? bucket.secondsRemaining
      : bucket.windowEnd
        ? Math.ceil((new Date(bucket.windowEnd).getTime() - nowMs) / 1000)
        : null;

  if (
    secondsRemaining === null ||
    !Number.isFinite(secondsRemaining) ||
    secondsRemaining <= 0
  ) {
    return null;
  }

  const totalMinutes = Math.ceil(secondsRemaining / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (hours <= 0) {
    return `${minutes}min`;
  }
  return `${hours}h ${minutes}min`;
}
