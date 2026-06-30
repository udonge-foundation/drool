import { useEffect, useState } from 'react';

import { MissionState } from '@industry/drool-sdk-ext/protocol/drool';
import { logException } from '@industry/logging';

import { fetchBillingLimitsRaw } from '@/services/TokenLimitService';
import { canViewTokenUsage } from '@/utils/tokenUsageVisibility';

import type { BillingLimitsBucketData } from '@industry/common/billing';

const RATE_LIMIT_USAGE_REFRESH_MS = 60_000;

function isMissionActive(missionState: MissionState | undefined): boolean {
  return (
    missionState === MissionState.Running ||
    missionState === MissionState.OrchestratorTurn
  );
}

export function useMissionRateLimitUsage(
  missionState: MissionState | undefined
): BillingLimitsBucketData | null {
  const [rateLimitUsage, setRateLimitUsage] =
    useState<BillingLimitsBucketData | null>(null);
  const hasMission = missionState !== undefined;
  const missionIsActive = isMissionActive(missionState);
  const showRateLimitUsage = !canViewTokenUsage() && hasMission;

  useEffect(() => {
    if (!showRateLimitUsage) {
      setRateLimitUsage(null);
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      try {
        const result = await fetchBillingLimitsRaw();
        if (cancelled) return;

        setRateLimitUsage(
          result.type === 'ok' && result.data.usesTokenRateLimitsBilling
            ? (result.data.limits?.standard.fiveHour ?? null)
            : null
        );
      } catch (err) {
        if (!cancelled) {
          logException(err, 'Mission Control billing limits refresh failed');
        }
      }
    };

    void refresh();

    const interval = missionIsActive
      ? setInterval(() => {
          void refresh();
        }, RATE_LIMIT_USAGE_REFRESH_MS)
      : undefined;

    return () => {
      cancelled = true;
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [showRateLimitUsage, missionIsActive]);

  return rateLimitUsage;
}
