import { RESOLUTION_REGISTRY } from './constants';

import type { ResolutionEventId } from './types';
import type { SettingsResolutionEvent } from '@industry/common/settings';

export function createResolutionEvent(
  registryId: ResolutionEventId,
  params: Omit<SettingsResolutionEvent, 'timestamp' | 'location'>
): SettingsResolutionEvent {
  return {
    timestamp: new Date().toISOString(),
    ...params,
    location: RESOLUTION_REGISTRY[registryId],
  };
}
