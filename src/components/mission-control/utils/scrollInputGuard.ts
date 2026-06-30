import { MISSION_CONTROL_SCROLL_INPUT_STALE_AFTER_MS } from '@/components/mission-control/constants';
import { getLastActualScrollInputAt } from '@/contexts/KeypressProvider';

export function shouldProcessMissionControlScroll({
  now = Date.now(),
  lastActualScrollInputAt = getLastActualScrollInputAt(),
}: {
  now?: number;
  lastActualScrollInputAt?: number;
} = {}): boolean {
  return (
    lastActualScrollInputAt === 0 ||
    now - lastActualScrollInputAt <= MISSION_CONTROL_SCROLL_INPUT_STALE_AFTER_MS
  );
}
