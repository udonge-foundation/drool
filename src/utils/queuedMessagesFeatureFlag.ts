import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { QueuePlacement } from '@industry/drool-sdk-ext/protocol/drool';
import { getFlag } from '@industry/runtime/feature-flags';

export function isQueuedMessagesFeatureEnabled(): boolean {
  return getFlag(IndustryFeatureFlags.CliQueuedMessages);
}

export function getEnabledQueuePlacement(
  queuePlacement?: QueuePlacement
): QueuePlacement {
  if (!isQueuedMessagesFeatureEnabled()) {
    return QueuePlacement.EndOfTurn;
  }

  return queuePlacement ?? QueuePlacement.EndOfTurn;
}
