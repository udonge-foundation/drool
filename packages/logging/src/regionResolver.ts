import { IndustryRegion } from '@industry/common/shared';

import { getRequestStore } from './requestLocal';

// Process-global region pin for callers without per-request AsyncLocalStorage
// (CLI/daemon). `RequestLocalContext.orgRegion` wins when set.
let regionResolver: (() => IndustryRegion | undefined) | undefined;

export function setRegionResolver(
  resolver: (() => IndustryRegion | undefined) | undefined
): void {
  regionResolver = resolver;
}

export function getCurrentOrgRegion(): IndustryRegion | undefined {
  return getRequestStore()?.orgRegion ?? regionResolver?.();
}

export function isEuResidencyRequest(): boolean {
  return getCurrentOrgRegion() === IndustryRegion.Eu;
}
