import { UsageMode } from '@industry/common/billing';

import type {
  BucketData,
  BucketTiersData,
  LimitPreference,
  UsageLimitInfo,
  UsageStatusParams,
  UsageStatusResult,
} from '@industry/common/billing';

export function isBucketActive(windowEnd: string | null): boolean {
  if (!windowEnd) return false;
  return new Date(windowEnd).getTime() >= Date.now();
}

function isBucketExhausted(bucket: BucketData | undefined): boolean {
  if (!bucket) return false;
  if (!isBucketActive(bucket.windowEnd)) return false;
  return bucket.usedPercent >= 100;
}

export function computeIsStandardExhausted(
  standardLimits: BucketTiersData | undefined
): boolean {
  if (!standardLimits) return false;
  return (
    isBucketExhausted(standardLimits.fiveHour) ||
    isBucketExhausted(standardLimits.weekly) ||
    isBucketExhausted(standardLimits.monthly)
  );
}

export function computeUsageMode(
  isExhausted: boolean,
  limitPreference: LimitPreference
): UsageMode {
  if (isExhausted) {
    if (limitPreference === 'extraUsage') return UsageMode.ExtraUsage;
    if (limitPreference === 'droolCore') return UsageMode.DroolCore;
    return UsageMode.Blocked;
  }
  return UsageMode.Standard;
}

export function getHighestUsageLimitForPool(
  limits: BucketTiersData | undefined
): UsageLimitInfo | undefined {
  if (!limits) return undefined;

  const buckets = [
    {
      label: '5-hour usage',
      percentage: limits.fiveHour.usedPercent,
      active: isBucketActive(limits.fiveHour.windowEnd),
    },
    {
      label: 'weekly usage',
      percentage: limits.weekly.usedPercent,
      active: isBucketActive(limits.weekly.windowEnd),
    },
    {
      label: 'monthly usage',
      percentage: limits.monthly.usedPercent,
      active: isBucketActive(limits.monthly.windowEnd),
    },
  ].filter((l) => l.active);

  if (buckets.length === 0) return undefined;

  const highest = buckets.reduce((max, curr) =>
    curr.percentage > max.percentage ? curr : max
  );

  return highest.percentage > 0
    ? { label: highest.label, percentage: highest.percentage }
    : undefined;
}

function formatResetTime(diffMs: number): string {
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

function formatResetDate(date: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

export function getStandardResetDate(
  standardLimits: BucketTiersData | undefined
): string | undefined {
  if (!standardLimits) return undefined;

  const now = Date.now();

  const exhaustedBuckets = [
    { bucket: standardLimits.fiveHour },
    { bucket: standardLimits.weekly },
    { bucket: standardLimits.monthly },
  ].filter(
    ({ bucket }) =>
      bucket.usedPercent >= 100 &&
      bucket.windowEnd &&
      new Date(bucket.windowEnd).getTime() > now
  );

  if (exhaustedBuckets.length === 0) return undefined;

  const soonest = exhaustedBuckets.reduce((min, curr) =>
    new Date(curr.bucket.windowEnd!).getTime() <
    new Date(min.bucket.windowEnd!).getTime()
      ? curr
      : min
  );

  const resetTime = new Date(soonest.bucket.windowEnd!).getTime();
  const diffMs = resetTime - now;
  const diffHours = diffMs / (1000 * 60 * 60);

  if (diffHours < 24) {
    return formatResetTime(diffMs);
  }

  return formatResetDate(new Date(resetTime));
}

export function getUsageStatus({
  tokenLimits,
  limitPreference,
  extraUsageBalanceDollars,
}: UsageStatusParams): UsageStatusResult {
  const standardLimits = tokenLimits?.limits?.standard;
  const coreLimits = tokenLimits?.limits?.core;
  const isStandardExhausted = computeIsStandardExhausted(standardLimits);
  const usageMode = computeUsageMode(isStandardExhausted, limitPreference);

  const getActivePoolUsageLimit = (): UsageLimitInfo | undefined => {
    if (usageMode === UsageMode.DroolCore) {
      return getHighestUsageLimitForPool(coreLimits);
    }
    if (usageMode === UsageMode.ExtraUsage) {
      return undefined;
    }
    return getHighestUsageLimitForPool(standardLimits);
  };

  return {
    isStandardExhausted,
    highestUsageLimit: getActivePoolUsageLimit(),
    usageMode,
    standardResetDate: getStandardResetDate(standardLimits),
    extraUsageBalance: extraUsageBalanceDollars,
  };
}

export function getUsageStatusText({
  mode,
  highestUsageLimit,
  standardResetDate,
  extraUsageBalance,
}: {
  mode: UsageMode;
  highestUsageLimit?: UsageLimitInfo;
  standardResetDate?: string;
  extraUsageBalance?: number;
}): string {
  if (mode === UsageMode.Blocked) {
    const resetText = standardResetDate
      ? ` Standard resets ${standardResetDate}.`
      : '';
    return `Standard Usage limit reached. Select an option below to continue using Drool.${resetText}`;
  }

  if (mode === UsageMode.Standard) {
    if (highestUsageLimit && highestUsageLimit.percentage >= 70) {
      return `You are using Standard Usage, but ${highestUsageLimit.label} is at ${highestUsageLimit.percentage}%.`;
    }
    return 'You are using Standard Usage.';
  }

  if (mode === UsageMode.DroolCore) {
    const resetText = standardResetDate
      ? ` Standard resets ${standardResetDate}.`
      : '';
    if (highestUsageLimit && highestUsageLimit.percentage >= 70) {
      return `You are using Drool Core, ${highestUsageLimit.label} is at ${highestUsageLimit.percentage}%.${resetText}`;
    }
    return `You are using Drool Core.${resetText}`;
  }

  if (mode === UsageMode.ExtraUsage) {
    const balance = extraUsageBalance ?? 0;
    const balanceText = `$${balance.toFixed(2)} remaining`;
    if (balance < 10) {
      return `You are using Extra Usage. ${balanceText} — buy more to continue using all models.`;
    }
    return `You are using Extra Usage. ${balanceText}.`;
  }

  return 'You are using Standard Usage.';
}
