import { useEffect, useState } from 'react';

import { IndustryFeatureFlag } from '@industry/common/feature-flags';
import { fetchFeatureFlags, getFlag } from '@industry/runtime/feature-flags';

/**
 * Hook to get the value of a feature flag.
 *
 * Delegates to `@industry/runtime/feature-flags` for all flag resolution.
 * The hook only adds React-specific glue: re-rendering when the remote
 * fetch completes and cancellation on unmount / dependency change.
 *
 * @param flag The feature flag to check
 * @returns The current value of the feature flag
 */
export function useFeatureFlagValue(flag: IndustryFeatureFlag): boolean {
  const [value, setValue] = useState<boolean>(() => getFlag(flag));

  useEffect(() => {
    let cancelled = false;

    const fetchPromise = fetchFeatureFlags();
    setValue(getFlag(flag));

    // Update state when the remote fetch resolves
    void fetchPromise.then(() => {
      if (cancelled) return;
      setValue(getFlag(flag));
    });

    return () => {
      cancelled = true;
    };
  }, [flag]);

  return value;
}
